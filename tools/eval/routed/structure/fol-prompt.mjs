#!/usr/bin/env node
/**
 * A/B of formalizer role prompts (fol-v2 vs fol-v3, 2026-10-03) on book problems, before any Ploinky tier names the new prompt: the
 * prompted backend of Ploinky (Ploinky/lib/prompted.mjs `serveprompted`: the same template, validation, re-ask and merge as a
 * prompted tier) runs in this process over a Ploinky chat tier (tiny: the model of formalizer-tiny; good: the model of
 * formalizer-good), so the only difference between two arms is the prompt. Scoring is `ab.mjs score` (the converters, the engines,
 * the asked-parts scorer). Offline evaluation harness; book text stays local (datasets_sources/, state/).
 *
 *   node tools/eval/routed/structure/fol-prompt.mjs sample --run <run> --n 30 [--seed <seed>]
 *   node tools/eval/routed/structure/fol-prompt.mjs fetch --run <run> --arms lfmp:tiny:fol-v2,lfmp:tiny:fol-v3 [--ids-from <run>]
 *        [--limit N] [--concurrency N] [--purpose job:<name>]
 *   node tools/eval/routed/structure/ab.mjs score --run <run>
 *   node tools/eval/routed/structure/fol-prompt.mjs compare --run <scored run> --a <arm> --b <arm> [--exclude id,id]
 * `compare` pairs two arms problem by problem on the asked-parts verdicts (correct +1, wrong -1, anything else 0) and gives the
 * difference b - a of correct, wrong and that score with a paired bootstrap 95% interval (10000 resamples, seeded); `--exclude`
 * leaves out problems (reviewed gold defects), reported.
 *
 * `sample` draws n fresh scorable problems of the logic book's argument and critical-thinking sections (ARGUMENT_SECTIONS: the
 * argument forms of chapter 2, induction, analogy, cause, fallacies, biases and the combined chapter; abduction has no scorable gold),
 * stratified by chapter, never a seen item, never one of the strict held-out split; marks them seen and writes <run>/ids.json.
 * Arms: `lfmp:<chatTier>:<prompt>` (the prompted formalizer), `psm:<structure tier>` (the names for linking constants).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadItems, loadSeen, sampleItems, markSeen} from '../../books/sample.mjs';
import {heldoutUnits, unitOf} from './heldout.mjs';
import {goldOf} from './gold.mjs';
import {sentencesOf} from '../../../../lib/formalize/fol/input.mjs';
import {extractStructure} from '../../../../lib/formalize/small-models.mjs';
import {loadSchema, schemaRequest} from '../../../../lib/formalize/structure/schema.mjs';
import {pworker} from '../../../../lib/pworker.mjs';
import {loadTemplate, serveprompted} from 'pworker/prompted';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
// The role prompts of ChatSOP's prompted tiers (the Ploinky user configuration (~/.pworker/config.json) promptsDir).
const promptsDir = () => path.join(ROOT, 'config/prompts');
const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const run = arg('run');
const OUT = path.join(ROOT, 'state/structure-formalizer', run ?? '');

/** The argument and critical-thinking sections of the logic book, by section number (chapter 6, abduction, has no scorable gold). */
export const ARGUMENT_SECTIONS = Object.freeze(['2.6', '2.7', '2.8', '2.9', '2.10', '3.', '4.', '5.', '8.', '9.', '10.']);
const isArgument = item => item.book === 'logic' && ARGUMENT_SECTIONS.some(s => (s.endsWith('.') ? item.section.startsWith(s) : item.section.split(/\s+/)[0] === s));

/** The chat function of `serveprompted` over a Ploinky chat tier: greedy as the template says, no thinking locally, no fallback. */
export function promptedChat(tier, {purpose, run: runId, timeoutMs = 1_800_000}) {
  const local = ['nano', 'micro', 'supertiny', 'tiny'].includes(tier);
  // Ploinky's library talks node:http, so a thinking model that answers after more than 300 s is not cut by a header timeout.
  const ta = pworker({purpose, run: runId});
  const chat = async (messages, {temperature, maxTokens}) => {
    const r = await ta.chat({tier, messages, temperature, maxTokens, stream: false, noFallback: true, timeoutMs, ...(local ? {extraBody: {chat_template_kwargs: {enable_thinking: false}}} : {})});
    chat.calls++;
    if (r.cached) chat.hits++;
    if (!r.ok) return {ok: false, status: r.status || 502, error: String(r.error ? JSON.stringify(r.error) : r.reason ?? '').slice(0, 200)};
    const m = r.body?.choices?.[0]?.message ?? {};
    return {ok: true, text: r.raw, finish: r.finish, usage: {output_tokens: r.usage.out, reasoning_tokens: r.body?.usage?.completion_tokens_details?.reasoning_tokens ?? null, reasoning_chars: (m.reasoning_content ?? '').length, content_chars: r.raw.length}};
  };
  chat.calls = 0; chat.hits = 0;
  return chat;
}

function samplePhase() {
  const n = Number(arg('n', 30)), seed = arg('seed', run), held = heldoutUnits();
  const own = path.join(OUT, 'ids.json');
  if (fs.existsSync(own)) { console.error(`${own} exists: a sample is drawn once`); process.exit(1); }
  const items = loadItems(ROOT).filter(i => isArgument(i) && goldOf(i) && !held.has(unitOf(i)));
  const picked = sampleItems(items, {n, seed, seen: loadSeen(ROOT)});
  fs.mkdirSync(OUT, {recursive: true});
  const by = k => Object.fromEntries([...new Set(picked.map(k))].map(v => [v, picked.filter(i => k(i) === v).length]));
  fs.writeFileSync(own, JSON.stringify({run, seed, n: picked.length, drawn_at: new Date().toISOString(), stratum: 'logic book, argument and critical-thinking sections', sections: ARGUMENT_SECTIONS,
    ids: picked.map(i => i.id), by_chapter: by(i => i.section.split('.')[0]), by_gold: by(i => goldOf(i).kind)}, null, 1) + '\n');
  markSeen(ROOT, picked.map(i => i.id), `structure-formalizer-${run}`);
  console.log(`${picked.length} fresh problems → ${path.relative(ROOT, own)}`);
}

async function fetchPhase() {
  const own = path.join(OUT, 'ids.json');
  const from = arg('ids-from');
  const source = from ? path.join(ROOT, 'state/structure-formalizer', from) : OUT;
  const ids = [...new Set(fs.existsSync(path.join(source, 'ids.json')) ? JSON.parse(fs.readFileSync(path.join(source, 'ids.json'), 'utf8')).ids : readJsonl(path.join(source, 'raw.jsonl')).map(r => r.id))].slice(0, Number(arg('limit', Infinity)));
  if (!ids.length) { console.error(`no ids in ${source}`); process.exit(1); }
  fs.mkdirSync(OUT, {recursive: true});
  if (!fs.existsSync(own)) fs.writeFileSync(own, JSON.stringify({run, from, ids}, null, 1) + '\n');
  const items = new Map(loadItems(ROOT).map(i => [i.id, i]));
  const opts = {purpose: arg('purpose', 'job:fol-v3-ab'), run};
  const file = path.join(OUT, 'raw.jsonl');
  const done = new Set(readJsonl(file).map(r => `${r.arm}|${r.id}`));
  const concurrency = Math.max(1, Number(arg('concurrency', 1)));
  const schema = loadSchema();
  for (const arm of arg('arms', 'lfmp:tiny:fol-v2,lfmp:tiny:fol-v3').split(',')) {
    const [kind, tier, prompt] = arm.split(':');
    const template = kind === 'lfmp' ? loadTemplate(promptsDir(prompt), prompt) : null;
    const todo = ids.filter(id => !done.has(`${arm}|${id}`));
    let next = 0;
    const one = async id => {
      const item = items.get(id), units = sentencesOf(item.question);
      let row;
      if (kind === 'psm') {
        const r = await extractStructure({...schemaRequest(schema, item.question), model: tier}, opts);
        row = {psm: r.ok ? r.body : {error: r.reason}, ms: r.ms, cached: r.cached};
      } else {
        const chat = promptedChat(tier, opts), t0 = Date.now();
        // A cloud thinking model (good: GLM-5.3) spends ~7k reasoning tokens on a short problem and can run away to any cap; Ploinky ends a call after about 300 s: 12k,
        // and a reply cut there is used as it is (counted in usage.cut), never asked again with a larger budget.
        const entry = {model: tier, ...(tier === 'tiny' ? {maxTokensCap: 32000} : {maxTokens: 12000, maxTokensCap: 12000})};
        const r = await serveprompted({path: '/v1/fol', body: {inputs: units.map(u => u.text), candidates: 1}, entry, template, chat});
        row = {lfm: r.status === 200 ? r.body.results : {error: r.body?.error?.message ?? `status ${r.status}`}, ms: Date.now() - t0, cached: chat.calls > 0 && chat.hits === chat.calls,
          extra: r.status === 200 ? {dropped: r.body.dropped, unresolved: r.body.unresolved, reasks: r.body.reasks, usage: r.body.usage, prompt: `${prompt}@${template.hash}`} : null};
      }
      fs.appendFileSync(file, JSON.stringify({arm, id, units, ...row}) + '\n');
      process.stdout.write('.');
    };
    const worker = async () => { while (next < todo.length) await one(todo[next++]); };
    await Promise.all(Array.from({length: Math.min(concurrency, todo.length)}, worker));
    console.log(` ${arm}`);
  }
}

/** A seeded generator (mulberry32) for the bootstrap. */
const rng = seed => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

function comparePhase() {
  const rows = readJsonl(path.join(OUT, 'results.jsonl'));
  const exclude = new Set((arg('exclude') ?? '').split(',').filter(Boolean));
  const a = arg('a'), b = arg('b');
  const verdict = arm => new Map(rows.filter(r => r.arm === arm && !exclude.has(r.id)).map(r => [r.id, r.asked?.verdict ?? 'no_answer']));
  const va = verdict(a), vb = verdict(b), ids = [...va.keys()].filter(id => vb.has(id));
  const score = v => (v === 'correct' ? 1 : v === 'wrong' ? -1 : 0);
  const stats = list => ({correct: list.filter(id => vb.get(id) === 'correct').length - list.filter(id => va.get(id) === 'correct').length,
    wrong: list.filter(id => vb.get(id) === 'wrong').length - list.filter(id => va.get(id) === 'wrong').length,
    score: list.reduce((s, id) => s + score(vb.get(id)) - score(va.get(id)), 0)});
  const count = (v, m) => [...m.values()].filter(x => x === v).length;
  const point = stats(ids), random = rng(20261003), boot = {correct: [], wrong: [], score: []};
  for (let k = 0; k < 10000; k++) {
    const sample = ids.map(() => ids[Math.floor(random() * ids.length)]);
    const s = stats(sample);
    for (const key of Object.keys(boot)) boot[key].push(s[key]);
  }
  const ci = list => { const x = [...list].sort((p, q) => p - q); return [x[Math.floor(0.025 * x.length)], x[Math.floor(0.975 * x.length)]]; };
  const out = {run, a, b, n: ids.length, excluded: [...exclude],
    a_counts: {correct: count('correct', va), wrong: count('wrong', va), partial: count('partial', va), gold_defect: count('gold_defect', va)},
    b_counts: {correct: count('correct', vb), wrong: count('wrong', vb), partial: count('partial', vb), gold_defect: count('gold_defect', vb)},
    difference_b_minus_a: Object.fromEntries(Object.keys(point).map(key => [key, {value: point[key], ci95: ci(boot[key])}]))};
  console.log(JSON.stringify(out, null, 1));
}

const cmd = process.argv[2];
if (!run && ['sample', 'fetch', 'compare'].includes(cmd)) { console.error('--run is required'); process.exit(2); }
if (cmd === 'sample') samplePhase();
else if (cmd === 'fetch') await fetchPhase();
else if (cmd === 'compare') comparePhase();
else { console.error('usage: fol-prompt.mjs sample|fetch|compare --run <id> [--n 30] [--arms lfmp:tiny:fol-v3,...] [--ids-from <run>]'); process.exit(2); }
