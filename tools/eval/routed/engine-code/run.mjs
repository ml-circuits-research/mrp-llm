#!/usr/bin/env node
/**
 * Multi-engine code formalization (proposal P-7, owner authorization 2026-10-03): for each problem routed to computation, one call asks
 * the model for the solution in several engine languages at once (JS, ASP, SMT-LIB, Prolog), each program is run in its sandbox
 * (lib/formalize/engine-code), and two DIFFERENT languages that give the same answers count as a verified answer. Evaluation harness
 * only; book text stays local under state/.
 *
 *   node tools/eval/routed/engine-code/run.mjs --run engine-fresh-50 --from js-fresh-50 [--tier tiny] [--limit 10] [--concurrency 4]
 *
 * --from: a structure-formalizer run whose ids.json and structure rows (psm:structure-tiny) give the problems and their route.
 * Writes state/engine-code/<run>/{raw.jsonl,results.jsonl,summary.md}; raw rows are resumable (one per problem and tier).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadItems} from '../../books/sample.mjs';
import {routeOf} from '../../../../lib/formalize/structure/route.mjs';
import {registryOf} from '../../../../lib/formalize/expression-program.mjs';
import {pathEngineCode, runProgram} from '../../../../lib/adapter/paths/engine-code.mjs';
import {valuesAgree} from '../../../../lib/adapter/agreement.mjs';
import {goldOf} from '../structure/gold.mjs';
import {askedVerdict} from '../structure/asked.mjs';
import {tierChat} from '../structure/chat.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const run = arg('run', 'engine-fresh-50'), from = arg('from', 'js-fresh-50'), tier = arg('tier', 'tiny');
const OUT = path.join(ROOT, 'state/engine-code', run), FROM = path.join(ROOT, 'state/structure-formalizer', from);
const LANGS = (arg('langs', 'js,asp,smt,prolog')).split(',');

// Two languages agree as ChatSOPAdapter's verification decides it (lib/adapter/agreement.mjs).
const agree = valuesAgree;

async function fetchPhase(items, problems) {
  fs.mkdirSync(OUT, {recursive: true});
  const file = path.join(OUT, 'raw.jsonl');
  const done = new Set(readJsonl(file).map(r => `${r.tier}|${r.id}`));
  const todo = problems.filter(p => !done.has(`${tier}|${p.id}`));
  let next = 0;
  const one = async ({id}) => {
    // ChatSOPAdapter's engineCode path (lib/adapter/paths/engine-code.mjs): the same question, the sandboxes, the same raw row.
    const item = items.get(id), chat = tierChat(tier, {purpose: 'job:engine-code', run, cache: null, timeoutMs: 1_800_000});
    const t0 = Date.now();
    const x = await pathEngineCode({message: item.question, chat, langs: LANGS});
    fs.appendFileSync(file, JSON.stringify({tier, id, ok: x.ok, reason: x.reason, code: x.code, runs: x.runs, usage: chat.usage, ms: Date.now() - t0}) + '\n');
    process.stdout.write('.');
  };
  const worker = async () => { while (next < todo.length) await one(todo[next++]); };
  await Promise.all(Array.from({length: Math.min(Number(arg('concurrency', 4)), todo.length)}, worker));
  console.log(` fetched ${todo.length}`);
}

function score(items, problems) {
  const raw = readJsonl(path.join(OUT, 'raw.jsonl')).filter(r => r.tier === tier);
  const rows = [];
  for (const r of raw) {
    const item = items.get(r.id), gold = goldOf(item);
    if (!gold) continue;
    const per = {};
    for (const lang of LANGS) {
      const x = r.runs[lang];
      per[lang] = x?.ok ? askedVerdict(item, gold, x.values.map(value => ({kind: 'value', value}))).verdict : x?.code === 'code_missing' ? 'missing' : 'failed';
    }
    // Verified: the first pair of different languages whose answers agree; its answer is scored.
    let verified = null;
    for (let i = 0; i < LANGS.length && !verified; i++) for (let j = i + 1; j < LANGS.length && !verified; j++) {
      const a = r.runs[LANGS[i]], b = r.runs[LANGS[j]];
      if (a?.ok && b?.ok && agree(a.values, b.values)) verified = {pair: `${LANGS[i]}+${LANGS[j]}`, verdict: askedVerdict(item, gold, a.values.map(value => ({kind: 'value', value}))).verdict};
    }
    rows.push({id: r.id, book: item.book, per, verified, failures: Object.fromEntries(LANGS.map(l => [l, r.runs[l]?.ok ? null : r.runs[l]?.code ?? null]))});
  }
  fs.writeFileSync(path.join(OUT, 'results.jsonl'), rows.map(x => JSON.stringify(x)).join('\n') + '\n');
  const V = ['correct', 'partial', 'wrong', 'no_answer', 'gold_defect'];
  const cell = list => V.map(v => list.filter(x => x === v).length).join(' / ');
  const L = [`# Multi-engine code formalization: ${run} (tier ${tier}; ${rows.length} scorable routed problems from ${from})`, '',
    'Asked parts: correct / partial / wrong / no answer / gold defect; "failed" = refused or crashed in the sandbox, "missing" = no block.', '',
    '| language | asked parts | ran ok | failed | missing |', '|---|---|---|---|---|'];
  for (const lang of LANGS) {
    const vs = rows.map(r => r.per[lang]);
    L.push(`| ${lang} | ${cell(vs)} | ${vs.filter(v => V.includes(v)).length} | ${vs.filter(v => v === 'failed').length} | ${vs.filter(v => v === 'missing').length} |`);
  }
  const ver = rows.filter(r => r.verified), vc = ver.filter(r => r.verified.verdict === 'correct').length;
  const anyCorrect = rows.filter(r => LANGS.some(l => r.per[l] === 'correct')).length;
  L.push('', `Verified (two different languages agree): ${ver.length}/${rows.length}; of these correct ${vc}, partial ${ver.filter(r => r.verified.verdict === 'partial').length}, wrong ${ver.filter(r => r.verified.verdict === 'wrong').length}.`);
  L.push(`At least one language correct: ${anyCorrect}/${rows.length}.`);
  const pairs = {};
  for (const r of ver) pairs[r.verified.pair] = (pairs[r.verified.pair] ?? 0) + 1;
  L.push(`Agreeing pairs: ${Object.entries(pairs).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`);
  const reasons = {};
  for (const r of rows) for (const [l, c] of Object.entries(r.failures)) if (c && c !== 'code_missing') reasons[`${l}:${c}`] = (reasons[`${l}:${c}`] ?? 0) + 1;
  L.push(`Sandbox failures: ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`);
  fs.writeFileSync(path.join(OUT, 'summary.md'), L.join('\n') + '\n');
  console.log(L.join('\n'));
}

const items = new Map(loadItems(ROOT).map(i => [i.id, i]));
const ids = JSON.parse(fs.readFileSync(path.join(FROM, 'ids.json'), 'utf8')).ids;
const psm = new Map(readJsonl(path.join(FROM, 'raw.jsonl')).filter(r => r.arm === 'psm:structure-tiny').map(r => [r.id, r]));
let problems = ids.map(id => ({id, ...routeOf(psm.get(id)?.psm ?? null, items.get(id).question)})).filter(p => p.route === 'js');
if (arg('limit')) problems = problems.slice(0, Number(arg('limit')));
async function rerunPhase(items) {
  const file = path.join(OUT, 'raw.jsonl'), rows = readJsonl(file);
  for (const r of rows) {
    const registry = registryOf(items.get(r.id).question);
    for (const lang of LANGS) if (r.code[lang]) r.runs[lang] = await runProgram(lang, r.code[lang], registry);
  }
  fs.writeFileSync(file, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
}
if (process.argv.includes('--rerun')) await rerunPhase(items);
else if (!process.argv.includes('--score-only')) await fetchPhase(items, problems);
score(items, problems);
