#!/usr/bin/env node
/**
 * A/B of the PSM and LFM backends on the same book problems (owner, 2026-10-03: before any training, test `tiny` with role prompts and
 * off-the-shelf NL-to-FOL models). Every arm calls a Ploinky tier with the same role contract; the converters and the
 * scoring are those of the zero-shot probe (./score.mjs). Offline evaluation harness; book text stays local.
 *
 *   node tools/eval/routed/structure/ab.mjs fetch --run ab-1 --ids-from probe-1 [--arms a,b,...]
 *   node tools/eval/routed/structure/ab.mjs score --run ab-1 [--into <run>]
 *   node tools/eval/routed/structure/ab.mjs sample --run <run> --n 50 [--seed <seed>]
 * `sample` draws n fresh scorable book problems stratified by book (never a seen item, never one of the strict held-out split of
 * train-psm-lfm-v1), marks them seen and writes <run>/ids.json; `fetch` then reads the run's own ids.json when there is one.
 * `score --into <run>` scores the raw outputs of --run with the current converters into another run folder (the earlier results stay).
 *
 * Arms
 *   psm:<tier>              the structure tier on the problem text (schema config/formalize/psm-schema-v1.json)
 *   lfm:<tier>[:k]          the formalizer tier on the problem's sentences, k candidates (default 1), no inventory
 *   combo:<psmTier>+<lfmTier>   the formalizer with the inventory rendered from that structure tier's extraction
 *   expr:<tier>             the compute path B (lib/formalize/expression-program.mjs) asked of that chat tier: one closed question,
 *                           static analysis (the answer must reach the problem's numbers through the dataflow), lowering to SOP,
 *                           executed by the engines; prompt variant a, no exemplars (the same question for every model)
 *   expr:<tier>:reason      the same for a cloud tier with reasoning (OpenRouter effort medium, a 32000-token budget)
 *   expr:<tier>:think       the same with thinking on (the models' recommended thinking sampling: temperature 0.6, top_p 0.95,
 *                           top_k 20); a reply cut by its budget is asked again with four times the budget, up to 32000 tokens
 * `--limit N` takes the first N problems only. `--concurrency N` keeps N problems of an arm in flight, `--parallel-arms` runs the arms side by side (seconds per problem are then
 * measured under that load and the rows carry `load`).
 * Calls are tagged job:psm-lfm-ab (or `--purpose job:<name>`) and cached by Ploinky except where `--fresh` is given (then timed
 * uncached: cache record). The model A/B of 2026-10-03 (MoE vs tiny) uses `--run moe-ab --purpose job:moe-ab`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadItems, loadSeen, sampleItems, markSeen} from '../../books/sample.mjs';
import {heldoutUnits, unitOf} from './heldout.mjs';
import {extractStructure, formalizeFol} from '../../../../lib/formalize/small-models.mjs';
import {sentencesOf} from '../../../../lib/formalize/fol/input.mjs';
import {loadSchema, schemaRequest, inventoryText} from '../../../../lib/formalize/structure/schema.mjs';
import {registryOf} from '../../../../lib/formalize/expression-program.mjs';
import {pathB, executeCircuit} from '../../../../lib/adapter/paths/compute.mjs';
import {decide} from '../../../../lib/formalize/equivalence.mjs';
import {psmScore, lfmArm} from './score.mjs';
import {goldOf} from './gold.mjs';
import {engines} from './engines.mjs';
import {tierChat} from './chat.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const run = arg('run', 'ab-1');
const OUT = path.join(ROOT, 'state/structure-formalizer', run);
// The roles Ploinky serves (the GLiNER and T5 arms lost the A/B of 2026-10-03 and their tiers are archived; earlier raw rows keep them).
const DEFAULT_ARMS = ['psm:structure-tiny', 'lfm:formalizer-tiny', 'combo:structure-tiny+formalizer-tiny'];

async function fetchPhase() {
  // `--limit N`: only the first N problems (a staged or capped run of a slow candidate).
  const own = path.join(OUT, 'ids.json');
  // A run's raw.jsonl holds one row per arm and problem: its ids are taken once each.
  const ids = [...new Set(fs.existsSync(own) && !arg('ids-from') ? JSON.parse(fs.readFileSync(own, 'utf8')).ids : readJsonl(path.join(ROOT, 'state/structure-formalizer', arg('ids-from', 'probe-1'), 'raw.jsonl')).map(r => r.id))].slice(0, Number(arg('limit', Infinity)));
  const items = new Map(loadItems(ROOT).map(i => [i.id, i]));
  const arms = (arg('arms') ?? DEFAULT_ARMS.join(',')).split(',');
  const opts = {purpose: arg('purpose', 'job:psm-lfm-ab'), run, cache: process.argv.includes('--fresh') ? 'record' : null, timeoutMs: 1_800_000};
  const schema = loadSchema();
  fs.mkdirSync(OUT, {recursive: true});
  const file = path.join(OUT, 'raw.jsonl');
  const done = new Set(readJsonl(file).map(r => `${r.arm}|${r.id}`));
  // `--concurrency N`: N problems of an arm in flight at once; `--parallel-arms`: the arms run side by side (e.g. a cloud tier next to
  // a local one). Rows are appended as they complete; seconds per problem are then measured under that load.
  const concurrency = Math.max(1, Number(arg('concurrency', 1))), parallelArms = process.argv.includes('--parallel-arms');
  const psmCache = new Map();
  const psm = (tier, item) => {
    const k = `${tier}|${item.id}`;
    if (!psmCache.has(k)) psmCache.set(k, extractStructure({...schemaRequest(schema, item.question), model: tier}, opts));
    return psmCache.get(k);
  };
  const runArm = async arm => {
    const [kind, spec, k] = arm.split(':');
    const todo = ids.filter(id => !done.has(`${arm}|${id}`));
    let next = 0;
    const one = async id => {
      const item = items.get(id), units = sentencesOf(item.question);
      let row;
      if (kind === 'psm') { const r = await psm(spec, item); row = {psm: r.ok ? r.body : {error: r.reason}, ms: r.ms, cached: r.cached}; }
      else if (kind === 'expr') {
        // Path B through ChatSOPAdapter (lib/adapter/paths/compute.mjs): the same closed question, analysis, lowering and execution.
        const chat = tierChat(spec, {...opts, thinking: k ?? null}), t0 = Date.now();
        const b = await pathB({message: item.question, chat, executor: await engines(), exemplars: []});
        row = {expr: {status: b.detail.status, attempts: b.detail.attempts, sop: b.detail.sop ?? null,
          answers: b.detail.program ?? null}, usage: chat.usage, ms: Date.now() - t0, cached: chat.calls > 0 && chat.hits === chat.calls};
      } else {
        const [psmTier, lfmTier] = kind === 'combo' ? spec.split('+') : [null, spec];
        const p = psmTier ? await psm(psmTier, item) : null;
        const context = p?.ok ? {inventory: inventoryText(p.body)} : undefined;
        const r = await formalizeFol({model: lfmTier, inputs: units.map(u => u.text), candidates: Number(k ?? 1), ...(context ? {context} : {})}, opts);
        row = {lfm: r.ok ? r.body.results : {error: r.reason}, ms: r.ms + (p?.ok && !p.cached ? p.ms : 0), cached: r.cached, psm: p?.ok ? p.body : null, extra: r.ok ? {dropped: r.body.dropped, unresolved: r.body.unresolved, reasks: r.body.reasks, usage: r.body.usage ?? null} : null};
      }
      fs.appendFileSync(file, JSON.stringify({arm, id, units, ...row, ...(concurrency > 1 || parallelArms ? {load: {concurrency, parallelArms}} : {})}) + '\n');
      process.stdout.write('.');
    };
    const worker = async () => { while (next < todo.length) await one(todo[next++]); };
    await Promise.all(Array.from({length: Math.min(concurrency, todo.length)}, worker));
    console.log(` ${arm}`);
  };
  if (parallelArms) await Promise.all(arms.map(runArm));
  else for (const arm of arms) await runArm(arm);
  if (arms.some(a => a.startsWith('expr:'))) (await engines()).dispose();
}

/** Path B of one problem: the lowered circuit executed query by query (ChatSOPAdapter's executeCircuit), compared with the book answer. */
async function exprArm(r, item, gold) {
  if (r.expr?.status !== 'ok' || !r.expr.sop) return {status: r.expr?.status ?? 'error', compiled: false, verdict: 'no_answer'};
  const x = await executeCircuit(r.expr.sop, registryOf(item.question), await engines());
  const qs = x.queries;
  const got = qs.filter(q => q.values.length).map(q => q.values[0]);
  if (!got.length) return {status: 'ok', compiled: true, executed: qs.some(q => q.status !== 'error'), queries: qs, verdict: 'no_answer'};
  const g = gold.kind === 'yes_no' ? gold.values[0] : gold.values.join(', ');
  // As in the logic arm: a numeric gold is compared with the answered numbers (a yes/no check next to them is not an asked value).
  const nums = got.filter(v => typeof v === 'number'), sys = gold.kind === 'number' && nums.length ? nums : got;
  const d = await decide(sys.length > 1 ? sys.join(', ') : sys[0], g, {problem: item.question, ordered: false});
  return {status: 'ok', compiled: true, executed: true, queries: qs, got, verdict: d.verdict === 'equivalent' ? 'correct' : 'wrong'};
}

/** n fresh scorable problems, stratified by book, outside the strict held-out split; marked seen. */
function samplePhase() {
  const n = Number(arg('n', 50)), seed = arg('seed', run), held = heldoutUnits();
  const own = path.join(OUT, 'ids.json');
  if (fs.existsSync(own)) { console.error(`${own} exists: a sample is drawn once`); process.exit(1); }
  const items = loadItems(ROOT).filter(i => goldOf(i) && !held.has(unitOf(i)));
  const picked = sampleItems(items, {n, seed, seen: loadSeen(ROOT)});
  fs.mkdirSync(OUT, {recursive: true});
  fs.writeFileSync(own, JSON.stringify({run, seed, n: picked.length, drawn_at: new Date().toISOString(), ids: picked.map(i => i.id),
    by_book: Object.fromEntries([...new Set(picked.map(i => i.book))].map(b => [b, picked.filter(i => i.book === b).length]))}, null, 1) + '\n');
  markSeen(ROOT, picked.map(i => i.id), `structure-formalizer-${run}`);
  console.log(`${picked.length} fresh problems → ${path.relative(ROOT, own)}`);
}

async function scorePhase() {
  const raw = readJsonl(path.join(OUT, 'raw.jsonl'));
  // --into <run>: the results of the current converters go to another folder; the raw outputs are read, never changed.
  const INTO = arg('into') ? path.join(ROOT, 'state/structure-formalizer', arg('into')) : OUT;
  fs.mkdirSync(INTO, {recursive: true});
  const items = new Map(loadItems(ROOT).map(i => [i.id, i]));
  // Names for linking FOL constants: the arm's own PSM (combo), else GLiNER's extraction of the same problem (as in the probe).
  const gliner = new Map(raw.filter(r => r.arm === 'psm:structure-gliner' && r.psm && !r.psm.error).map(r => [r.id, r.psm]));
  const byArm = new Map();
  for (const r of raw) { if (!byArm.has(r.arm)) byArm.set(r.arm, []); byArm.get(r.arm).push(r); }
  const table = [], rows = [];
  for (const [arm, list] of byArm) {
    const kind = arm.split(':')[0];
    const ms = list.filter(r => !r.cached).map(r => r.ms).sort((a, b) => a - b);
    const sec = ms.length ? (ms[Math.floor(ms.length / 2)] / 1000).toFixed(1) : 'cached';
    if (kind === 'psm') {
      const P = list.map(r => ({id: r.id, ...psmScore(r, items.get(r.id))})).filter(p => !p.error);
      const sum = f => P.reduce((s, p) => s + f(p), 0);
      table.push({arm, n: list.length, qRecall: `${sum(p => p.covered)}/${sum(p => p.numbers)}`, qPrec: `${sum(p => p.digitSpansOnRegistry)}/${sum(p => p.digitSpans)}`, goal: `${P.filter(p => p.goalFound).length}/${P.length}`, sec});
      continue;
    }
    if (kind === 'expr') {
      let compiled = 0, correct = 0, wrong = 0, accepted = 0;
      for (const r of list) {
        const item = items.get(r.id), gold = goldOf(item);
        if (!gold) continue;
        const a = await exprArm(r, item, gold);
        rows.push({arm, id: r.id, ...a});
        if (r.expr?.status === 'ok') accepted++;
        if (a.compiled) compiled++;
        if (a.verdict === 'correct') correct++;
        if (a.verdict === 'wrong') wrong++;
      }
      table.push({arm, n: list.length, expr: true, accepted, compiled, correct, wrong, sec});
      continue;
    }
    let queries = 0, compiled = 0, executed = 0, correct = 0, weak = 0, wrong = 0, convertedUnits = 0, units = 0;
    const fixed = {correct: 0, partial: 0, wrong: 0, gold_defect: 0};
    for (const r of list) {
      const item = items.get(r.id), registry = registryOf(item.question);
      const names = psmScore({psm: r.psm ?? gliner.get(r.id) ?? {entities: {}}}, item).names ?? new Map();
      const a = await lfmArm(r.units, r.lfm, {registry, names, gold: goldOf(item), item});
      rows.push({arm, id: r.id, ...a});
      if (a.error) continue;
      units += a.units.length; convertedUnits += a.units.filter(u => u.converted).length;
      if (a.queriesInIr) queries++;
      if (a.circuits) compiled++;
      if (a.executed) executed++;
      if (a.verdict === 'correct') correct++;
      if (a.verdict === 'correct' && a.weak) weak++;
      if (a.verdict === 'wrong') wrong++;
      if (a.asked && Object.hasOwn(fixed, a.asked.verdict)) fixed[a.asked.verdict]++;
    }
    table.push({arm, n: list.length, unitsConverted: `${convertedUnits}/${units}`, queries: `${queries}/${list.length}`, compiled, executed, correct, real: correct - weak, wrong, fixed, sec});
  }
  (await engines()).dispose();
  fs.writeFileSync(path.join(INTO, 'results.jsonl'), rows.map(x => JSON.stringify(x)).join('\n') + '\n');
  if (INTO !== OUT) fs.copyFileSync(path.join(OUT, 'raw.jsonl'), path.join(INTO, 'raw.jsonl'));
  const L = [`# PSM/LFM A/B: ${arg('into') ?? run} (raw outputs of ${run}; ${new Set(raw.map(r => r.id)).size} book problems)`, '', '## Structure (PSM)', '',
    '| arm | quantity recall | quantity precision | goal found | s/problem (median, uncached) |', '|---|---|---|---|---|'];
  for (const t of table.filter(t => t.qRecall)) L.push(`| ${t.arm} | ${t.qRecall} | ${t.qPrec} | ${t.goal} | ${t.sec} |`);
  L.push('', '## Logic (LFM)', '', 'A weak correct answer is a yes/no gold decided by an empty `which` list (the closed world), not by a derivation; "real" excludes them.', '',
    '| arm | units converted | problems with a query | compiled | executed | correct (real) | wrong | s/problem |', '|---|---|---|---|---|---|---|---|');
  for (const t of table.filter(t => t.queries)) L.push(`| ${t.arm} | ${t.unitsConverted} | ${t.queries} | ${t.compiled}/${t.n} | ${t.executed} | ${t.correct} (${t.real}) | ${t.wrong} | ${t.sec} |`);
  L.push('', 'Asked-parts scorer (./asked.mjs: inputs and check values removed from the gold list, clock pairs joined, partial answers apart, gold defects apart):', '',
    '| arm | correct | partial | wrong | gold defect |', '|---|---|---|---|---|');
  for (const t of table.filter(t => t.queries)) L.push(`| ${t.arm} | ${t.fixed.correct} | ${t.fixed.partial} | ${t.fixed.wrong} | ${t.fixed.gold_defect} |`);
  const E = table.filter(t => t.expr);
  if (E.length) {
    L.push('', '## Compute path B (expression program)', '', '| arm | program accepted | executed circuit | correct | wrong | s/problem |', '|---|---|---|---|---|---|');
    for (const t of E) L.push(`| ${t.arm} | ${t.accepted}/${t.n} | ${t.compiled} | ${t.correct} | ${t.wrong} | ${t.sec} |`);
  }
  fs.writeFileSync(path.join(INTO, 'summary.md'), L.join('\n') + '\n');
  console.log(L.join('\n'));
}

const cmd = process.argv[2];
if (cmd === 'fetch') await fetchPhase();
else if (cmd === 'score') await scorePhase();
else if (cmd === 'sample') samplePhase();
else { console.error('usage: ab.mjs fetch|score|sample --run <id> [--ids-from probe-1] [--arms ...] [--fresh] [--into <run>] [--n 50]'); process.exit(2); }
