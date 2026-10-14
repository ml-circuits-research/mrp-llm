#!/usr/bin/env node
/**
 * Scoring of a books-eval run (tools/eval/books/run.mjs): deterministic first, an LLM judge for the rest.
 *   node tools/eval/books/score.mjs --run <dir>          writes scored.jsonl and judge-input-K.json (blind batches) for the answers a rule cannot decide
 *   (every final scoring appends the run's formalization failures to state/formalization-errors/inbox.jsonl once, unless --no-inbox)
 *   node tools/eval/books/score.mjs --run <dir> --merge   adds judge-output-K.json ({j, verdict: correct|partial|wrong|unanswered, reason}) and finalises scored.jsonl
 *   node tools/eval/books/score.mjs --run <dir> --judge   scores, then judges the batches itself with the remote default model (llmProviders.openference,
 *       Qwen3.8 27b through Ploinky), writes judge-output-K.json and merges; --judge-model <name>, --judge-provider <name>, --per-call <n> (default 10)
 * Outcomes: correct | wrong | unknown (honest: the system declined, or said the data are insufficient) | invalid (no valid circuit)
 * | failed (infrastructure). `partial` judge verdicts count as wrong in the strict accuracy and are reported separately.
 * Deterministic rules: yes/no polarity, numbers with a 0.5 % tolerance (all gold numbers must occur), normalised entity strings.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {numbersOf} from './extract.mjs';
import {providerChat} from '../../../lib/llm-providers.mjs';
import {reportFormalizationError} from '../../../lib/formalization-errors.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const readJsonl = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const INSUFFICIENT = /\b(not enough (information|data|facts)|insufficient|cannot be determined|can(?:'|no)t be (determined|decided|known)|no way to (know|tell)|data do(?:es)? not (decide|say|determine)|not (given|stated|specified|determinable)|unknown|undetermined)\b/i;
const DECLINES = new Set(['unknown', 'unclear', 'not_computable', 'unsupported', 'courtesy', 'clarify']);

const clean = t => String(t ?? '').replace(/\*\*/g, '').replace(/\(memory:[^)]*\)/g, '').replace(/^Sources used:.*$/gm, '').trim();
const words = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
const near = (a, b) => Math.abs(a - b) <= Math.max(1e-9, 0.005 * Math.abs(b));

/** The answer text the score reads, and whether the system declined. */
export function responseOf(rec) {
  if (rec.arm === 'direct') {
    if (!rec.ok) return {declined: false, failed: rec.error?.message ?? 'direct failed'};
    const text = rec.final ?? String(rec.text ?? '').slice(-400);
    return {text: clean(text), missing_final: rec.final == null, declined: INSUFFICIENT.test(text) && !/\d/.test(text.replace(INSUFFICIENT, ''))};
  }
  const s = rec.system ?? {};
  if (!rec.ok) {
    const code = s.error?.code ?? rec.error?.code, msg = s.error?.message ?? rec.error?.message ?? '';
    return {declined: false, outcome: code === 'parse_failed' || /could not be read/.test(msg) ? 'invalid' : 'failed', failed: `${code}: ${msg}`};
  }
  if (DECLINES.has(s.status) || s.status == null) return {declined: true, text: clean(rec.text), status: s.status};
  return {declined: false, text: clean(rec.text), status: s.status, answers: s.answers ?? []};
}

/** Deterministic verdict, or null when only the judge can decide. */
export function deterministic(rec, resp) {
  if (resp.outcome) return {outcome: resp.outcome, by: 'rule', reason: resp.failed};
  if (rec.gold_kind === 'unknown') return resp.declined || INSUFFICIENT.test(resp.text ?? '') ? {outcome: 'correct', by: 'rule', reason: 'the data are insufficient and the system said so'} : null;
  if (resp.failed) return {outcome: 'failed', by: 'rule', reason: resp.failed};
  if (resp.declined) return {outcome: 'unknown', by: 'rule', reason: `declined (${resp.status ?? 'no answer'})`};
  const text = resp.text ?? '', gold = rec.gold_value;
  if (rec.gold_kind === 'yes_no') {
    let polarity = null;
    if (rec.arm !== 'direct') polarity = resp.status === 'supported' ? true : resp.status === 'refuted' ? false : null;
    const m = text.match(/^\W*(yes|no|true|false)\b/i) ?? (rec.arm === 'direct' ? text.match(/\b(yes|no|true|false)\b/i) : null);
    if (polarity == null && m) polarity = /^(yes|true)$/i.test(m[1]);
    if (polarity == null) return null;
    if (polarity !== gold) return {outcome: 'wrong', by: 'rule', reason: `answered ${polarity ? 'yes' : 'no'}, gold ${gold ? 'yes' : 'no'}`};
    // A gold that also gives numbers the question does not contain ("Yes, overlap 28 years"): with those numbers the rule decides,
    // without them only the judge can tell whether the number was part of what was asked.
    const extra = rec.gold_numbers ?? [];
    const have = [...numbersOf(text), ...(resp.answers ?? []).flatMap(a => numbersOf(Object.values(a).join(' ')))];
    if (extra.length && !extra.every(g => have.some(h => near(h, g)))) return null;
    return {outcome: 'correct', by: 'rule', reason: `answered ${polarity ? 'yes' : 'no'}, gold ${gold ? 'yes' : 'no'}${extra.length ? ` with ${extra.join(', ')}` : ''}`};
  }
  if (['number', 'list', 'number_text'].includes(rec.gold_kind)) {
    const have = [...numbersOf(text), ...(resp.answers ?? []).flatMap(a => numbersOf(Object.values(a).join(' ')))];
    const need = [].concat(gold);
    if (need.every(g => have.some(h => near(h, g)))) return {outcome: 'correct', by: 'rule', reason: `all gold numbers present (${need.join(', ')})`};
    return null;
  }
  if (rec.gold_kind === 'entity') {
    const g = words(gold).join(' ');
    if (g && ` ${words(text).join(' ')} `.includes(` ${g} `)) return {outcome: 'correct', by: 'rule', reason: `entity "${g}" present`};
    return null;
  }
  return null;
}

export function scoreRun(dir, {judgeSize = 40} = {}) {
  const records = readJsonl(path.join(dir, 'records.jsonl'));
  const pending = [];
  const scored = records.map(rec => {
    const resp = responseOf(rec), det = deterministic(rec, resp);
    const out = {...rec, response: resp.text ?? null, ...(resp.missing_final ? {missing_final: true} : {}), verdict: det};
    if (!det) pending.push(out);
    return out;
  });
  // Blind judge batches: no arm, no model names, the gold answer and the system's answer.
  const map = {};
  const batches = [];
  pending.forEach((rec, k) => {
    const j = `j${String(k + 1).padStart(3, '0')}`;
    map[j] = {arm: rec.arm, id: rec.id};
    const b = Math.floor(k / judgeSize);
    (batches[b] ??= []).push({j, problem: rec.question.slice(0, 1800), gold_answer: rec.gold.slice(0, 600), candidate_answer: String(rec.response ?? '').slice(0, 900)});
  });
  fs.writeFileSync(path.join(dir, 'judge-map.json'), JSON.stringify(map, null, 1));
  batches.forEach((b, k) => fs.writeFileSync(path.join(dir, `judge-input-${k + 1}.json`), JSON.stringify(b, null, 1)));
  fs.writeFileSync(path.join(dir, 'scored.jsonl'), scored.map(r => JSON.stringify(r)).join('\n') + '\n');
  return {scored, pending: pending.length, batches: batches.length};
}

/** Merges the judge outputs into scored.jsonl; an item without a verdict stays `pending`. */
export function mergeJudgments(dir) {
  const scored = readJsonl(path.join(dir, 'scored.jsonl')), map = JSON.parse(fs.readFileSync(path.join(dir, 'judge-map.json'), 'utf8'));
  const verdicts = new Map();
  for (const f of fs.readdirSync(dir).filter(f => /^judge-output-\d+\.json$/.test(f))) for (const v of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) verdicts.set(v.j, v);
  const byKey = new Map(Object.entries(map).map(([j, v]) => [`${v.arm}/${v.id}`, j]));
  let merged = 0;
  for (const r of scored) {
    if (r.verdict) continue;
    const v = verdicts.get(byKey.get(`${r.arm}/${r.id}`));
    if (!v) { r.verdict = {outcome: 'pending', by: 'judge', reason: 'no judge verdict yet'}; continue; }
    const outcome = {correct: 'correct', partial: 'wrong', wrong: 'wrong', unanswered: 'unknown'}[v.verdict] ?? 'wrong';
    r.verdict = {outcome, by: 'judge', judge: v.verdict, reason: v.reason}; merged++;
  }
  fs.writeFileSync(path.join(dir, 'scored.jsonl'), scored.map(r => JSON.stringify(r)).join('\n') + '\n');
  return {merged, pending: scored.filter(r => r.verdict.outcome === 'pending').length};
}

/**
 * The formalization failures of a scored run go to the formalization error inbox (lib/formalization-errors.mjs), once per row
 * (`inbox-reported.json` in the run folder): a refused or invalid circuit, a question asked back (unclear, clarify), a circuit that
 * executed to a wrong answer, and a problem answered from the memory alone (no stated data). Not reported: infrastructure failures,
 * engine errors and honest unknowns over modelled data (missing knowledge or an engine limit, not the formalization), the direct arm.
 */
export function reportFailures(dir, {report = reportFormalizationError} = {}) {
  const file = path.join(dir, 'inbox-reported.json');
  const done = new Set(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
  const run = fs.existsSync(path.join(dir, 'run.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) : {};
  let n = 0;
  for (const r of readJsonl(path.join(dir, 'scored.jsonl'))) {
    const key = `${r.arm}/${r.id}`, o = r.verdict?.outcome, s = r.system ?? {};
    // The ceiling arm (a strong tier writes the circuit) is reported by tools/eval/books/triage.mjs, with the layer it judged.
    if (r.arm === 'direct' || r.arm === 'ceiling' || done.has(key) || !o || ['correct', 'pending', 'failed'].includes(o)) continue;
    const circuit = s.formalization?.sop ?? null, modelled = /^@\S+\s+stated\b/m.test(circuit ?? '');
    const kind = o === 'invalid' ? (r.error?.code === 'parse_failed' ? 'parse_failed' : 'invalid') : o === 'wrong' ? 'wrong'
      : ['unclear', 'clarify', 'courtesy'].includes(s.status) ? 'unclear' : !modelled ? 'wrong' : null;
    if (!kind) continue;
    report({source: 'problem-agent', kind, message: r.question, strategy: s.understanding?.strategy ?? null, tier: r.arm === 'remote-direct' ? 'small' : String(run.model ?? '').startsWith('tier:') ? run.model.slice(5) : 'tiny', circuit,
      expected: r.gold, detail: [o, s.status, r.verdict?.reason, kind === 'wrong' && !modelled && o !== 'wrong' ? 'a problem answered from the memory alone (no stated data)' : null,
        ...(r.error?.problems ?? []).map(p => `${p.code}: ${p.message}`)].filter(Boolean).join(' | ').slice(0, 1200), ref: {run: path.basename(dir), id: r.id, book: r.book, arm: r.arm}});
    done.add(key); n++;
  }
  fs.writeFileSync(file, JSON.stringify([...done], null, 1));
  return n;
}

export const JUDGE_SYSTEM = `You are a strict, blind grader. For each item you get a problem, the gold answer and a candidate answer. Decide whether the candidate gives the same final answer as the gold answer (same number within rounding, same yes/no, same entity); an explanation is not required. Verdicts: "correct" (same final answer), "partial" (right idea, a wrong or missing part of the final answer), "wrong", "unanswered" (the candidate declines or gives no answer). Reply with ONLY a JSON array [{"j": "<item id>", "verdict": "<verdict>", "reason": "<one short sentence>"}] with one entry per item.`;

/**
 * Judges the batches of a scored run with a remote chat model (default: openference Qwen3.8 27b through Ploinky), `perCall` items per request
 * (Ploinky's queue keeps the provider's 15 requests/minute). Writes judge-output-K.json per batch; an item without a parsable verdict stays pending.
 */
export async function judgeBatches(dir, {provider = 'openference', model = null, perCall = 10, chat = providerChat, config = {}} = {}) {
  const inputs = fs.readdirSync(dir).filter(f => /^judge-input-\d+\.json$/.test(f)).sort();
  let calls = 0, judged = 0, failed = 0;
  for (const f of inputs) {
    const items = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), out = [];
    for (let i = 0; i < items.length; i += perCall) {
      const part = items.slice(i, i + perCall);
      const run = await chat({system: JUDGE_SYSTEM, prompt: JSON.stringify(part), provider, model, config}); calls++;
      let verdicts = [];
      try { verdicts = JSON.parse(run.text.slice(run.text.indexOf('['), run.text.lastIndexOf(']') + 1)); } catch { /* stays pending */ }
      if (!run.ok || !Array.isArray(verdicts)) { failed += part.length; continue; }
      for (const v of verdicts) if (part.some(p => p.j === v.j) && ['correct', 'partial', 'wrong', 'unanswered'].includes(v.verdict)) { out.push({j: v.j, verdict: v.verdict, reason: String(v.reason ?? '').slice(0, 300), judge_model: run.model}); judged++; }
    }
    fs.writeFileSync(path.join(dir, f.replace('input', 'output')), JSON.stringify(out, null, 1));
  }
  return {calls, judged, failed};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), dir = path.resolve(ROOT, opt(args, '--run', ''));
  if (args.includes('--merge')) console.log(JSON.stringify({...mergeJudgments(dir), ...(args.includes('--no-inbox') ? {} : {inbox: reportFailures(dir)})}));
  else if (args.includes('--judge')) {
    const r = scoreRun(dir);
    const j = await judgeBatches(dir, {provider: opt(args, '--judge-provider', 'openference'), model: opt(args, '--judge-model', null), perCall: Number(opt(args, '--per-call', 10))});
    const merged = mergeJudgments(dir);
    console.log(JSON.stringify({scored: r.scored.length, queued: r.pending, ...j, ...merged, ...(args.includes('--no-inbox') ? {} : {inbox: reportFailures(dir)})}));
  } else { const r = scoreRun(dir); console.log(`${r.scored.length} records scored by rule or queued: ${r.pending} for the judge in ${r.batches} batch(es) (judge-input-K.json)`); }
}
