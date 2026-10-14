#!/usr/bin/env node
/**
 * The jsEval route against path B and FOL v2 (owner decision 2026-10-03, proposal P-6). Offline evaluation harness; book text stays
 * local under state/.
 *
 *   node tools/eval/routed/structure/js-route.mjs fetch --run js-30 [--tiers tiny,good:reason] [--concurrency 4]
 *   node tools/eval/routed/structure/js-route.mjs score --run js-30 --fol fol-v2-30
 *
 * fetch: the run's raw.jsonl must hold the structure role's rows (`psm:structure-tiny`, fetched by ./ab.mjs on the run's ids.json).
 * Each problem is routed by lib/formalize/structure/route.mjs; for every routed problem and tier it asks the jsEval route
 * (lib/formalize/js-program.mjs, role prompt config/prompts/js-v1.md) and path B (lib/formalize/expression-program.mjs, the
 * question of ./ab.mjs's `expr` arm) and appends rows `js:<tier>` and `expr:<tier>`.
 * score: the lowered circuits run on the engines (./engines.mjs), the others on the oracle (the trusted runtime's jsEval); every
 * answer is scored by the old scorer (lib/formalize/equivalence.mjs, a numeric gold against all answered numbers) and by the
 * asked-parts scorer (./asked.mjs); FOL v2's verdicts are read from the scored results of the `--fol` run (same models, same problems).
 * Writes <run>/results.jsonl and <run>/summary.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadItems} from '../../books/sample.mjs';
import {routeOf} from '../../../../lib/formalize/structure/route.mjs';
import {registryOf} from '../../../../lib/formalize/expression-program.mjs';
import {pathB, pathJsEval, executeCircuit, executeJs} from '../../../../lib/adapter/paths/compute.mjs';
import {decide} from '../../../../lib/formalize/equivalence.mjs';
import {goldOf} from './gold.mjs';
import {askedVerdict} from './asked.mjs';
import {engines} from './engines.mjs';
import {tierChat} from './chat.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const run = arg('run', 'js-30');
const OUT = path.join(ROOT, 'state/structure-formalizer', run);
const STRUCTURE_ARM = arg('structure', 'psm:structure-tiny');
const firstBy = (rows, key) => { const m = new Map(); for (const r of rows) if (!m.has(key(r))) m.set(key(r), r); return m; };

function routes(raw, items) {
  const psm = firstBy(raw.filter(r => r.arm === STRUCTURE_ARM), r => r.id);
  const ids = JSON.parse(fs.readFileSync(path.join(OUT, 'ids.json'), 'utf8')).ids;
  return ids.map(id => ({id, ...routeOf(psm.get(id)?.psm ?? null, items.get(id).question), structureMs: psm.get(id)?.ms ?? null, structureCached: psm.get(id)?.cached ?? null}));
}

async function fetchPhase() {
  const items = new Map(loadItems(ROOT).map(i => [i.id, i]));
  const file = path.join(OUT, 'raw.jsonl'), raw = readJsonl(file);
  const routed = routes(raw, items).filter(r => r.route === 'js');
  const done = new Set(raw.map(r => `${r.arm}|${r.id}`));
  const opts = {purpose: arg('purpose', 'job:js-route'), run, cache: process.argv.includes('--fresh') ? 'record' : null, timeoutMs: 1_800_000};
  const concurrency = Math.max(1, Number(arg('concurrency', 4)));
  const arms = (arg('tiers', 'tiny,good:reason')).split(',').flatMap(t => [`js:${t}`, `expr:${t}`]);
  console.log(`${routed.length} routed problems; arms ${arms.join(', ')}`);
  const runArm = async arm => {
    const [kind, tier, mode] = arm.split(':');
    const todo = routed.filter(r => !done.has(`${arm}|${r.id}`));
    let next = 0;
    const one = async ({id}) => {
      const item = items.get(id), chat = tierChat(tier, {...opts, thinking: mode ?? null}), t0 = Date.now();
      let row;
      // Both arms through ChatSOPAdapter's compute paths (lib/adapter/paths/compute.mjs); the raw rows keep their earlier shape.
      if (kind === 'js') {
        const r = await pathJsEval({message: item.question, chat, executor: await engines()});
        row = {js: {status: r.detail.status, attempts: r.detail.attempts, wires: r.detail.wires, answers: r.detail.answers, values: r.detail.values,
          lowered: r.detail.lowered, why: r.detail.why, sop: r.detail.sop ?? null}};
      } else {
        const b = await pathB({message: item.question, chat, executor: await engines(), exemplars: []});
        row = {expr: {status: b.detail.status, attempts: b.detail.attempts, sop: b.detail.sop ?? null, answers: b.detail.program ?? null}};
      }
      fs.appendFileSync(file, JSON.stringify({arm, id, ...row, usage: chat.usage, ms: Date.now() - t0, cached: chat.calls > 0 && chat.hits === chat.calls}) + '\n');
      process.stdout.write('.');
    };
    const worker = async () => { while (next < todo.length) await one(todo[next++]); };
    await Promise.all(Array.from({length: Math.min(concurrency, todo.length)}, worker));
    console.log(` ${arm}`);
  };
  await Promise.all(arms.map(runArm));
  (await engines()).dispose();
}

/** The answers of a lowered circuit on the engines: [{kind, value}] (one per answered query), by ChatSOPAdapter's executeCircuit. */
async function engineAnswers(sop, registry) {
  return (await executeCircuit(sop, registry, await engines())).answers;
}

/** Old scorer: a numeric gold against all answered numbers (unordered), otherwise the first answer. */
async function oldVerdict(answers, gold, item) {
  const got = answers.filter(a => a.value !== null && a.value !== undefined).flatMap(a => [a.value].flat(Infinity)).map(v => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
  if (!got.length) return 'no_answer';
  const nums = got.filter(v => typeof v === 'number'), sys = gold.kind === 'number' && nums.length ? nums : got;
  const g = gold.kind === 'yes_no' ? gold.values[0] : gold.values.join(', ');
  const d = await decide(sys.length > 1 ? sys.join(', ') : sys[0], g, {problem: item.question, ordered: false});
  return d.verdict === 'equivalent' ? 'correct' : 'wrong';
}


async function scorePhase() {
  const items = new Map(loadItems(ROOT).map(i => [i.id, i]));
  const raw = readJsonl(path.join(OUT, 'raw.jsonl'));
  const R = routes(raw, items), routeById = new Map(R.map(r => [r.id, r]));
  const folRun = arg('fol');
  const fol = folRun ? readJsonl(path.join(ROOT, 'state/structure-formalizer', folRun, 'results.jsonl')) : [];
  const rows = [];
  for (const r of firstBy(raw.filter(x => x.arm.startsWith('js:') || x.arm.startsWith('expr:')), x => `${x.arm}|${x.id}`).values()) {
    const item = items.get(r.id), gold = goldOf(item), registry = registryOf(item.question);
    if (!gold) { rows.push({arm: r.arm, id: r.id, verdict: 'unscorable', asked: 'unscorable'}); continue; }
    let answers = [], executed = null, agree = null;
    if (r.js?.status === 'ok') {
      const admitted = {wires: r.js.wires.map(w => ({...w})), answers: r.js.answers};
      const {parseExpression} = await import('../../../../sop/expression.mjs');
      for (const w of admitted.wires) w.ast = parseExpression(w.expr);
      const x = await executeJs(admitted, r.js.lowered ? {lowered: true, sop: r.js.sop} : null, registry, await engines());
      ({answers, executed, agree} = x);
    } else if (r.expr?.status === 'ok' && r.expr.sop) { answers = await engineAnswers(r.expr.sop, registry); executed = 'engines'; }
    const verdict = await oldVerdict(answers, gold, item), asked = askedVerdict(item, gold, answers);
    rows.push({arm: r.arm, id: r.id, status: r.js?.status ?? r.expr?.status, executed, lowered: r.js ? r.js.lowered : null, why: r.js?.why ?? null, agree, answers: answers.map(a => a.value), verdict, asked: asked.verdict, ms: r.ms, cached: r.cached});
  }
  (await engines()).dispose();
  fs.writeFileSync(path.join(OUT, 'results.jsonl'), rows.map(x => JSON.stringify(x)).join('\n') + '\n');
  const L = [`# jsEval route: ${run} (${R.length} problems; route from ${STRUCTURE_ARM}; FOL v2 from ${folRun ?? 'none'})`, ''];
  const routedIds = new Set(R.filter(r => r.route === 'js').map(r => r.id));
  L.push(`Routed to jsEval: ${routedIds.size}/${R.length}. FOL: ${R.length - routedIds.size} (no goal in a question unit: ${R.filter(r => r.route === 'fol' && !r.goal).length}; goal but no registry quantity: ${R.filter(r => r.route === 'fol' && r.goal).length}).`, '');
  const tiers = [...new Set(rows.map(r => r.arm.split(':').slice(1).join(':')))];
  const folArm = t => `lfm:formalizer-${t.split(':')[0]}`;
  const folRow = (t, id) => fol.find(f => f.arm === folArm(t) && f.id === id);
  const folVerdicts = (t, id) => { const f = folRow(t, id); return f ? {verdict: f.verdict ?? 'no_answer', asked: f.asked?.verdict ?? 'no_answer'} : null; };
  const count = (list, k, v) => list.filter(x => x[k] === v).length;
  const askedCell = list => ['correct', 'partial', 'wrong', 'no_answer', 'gold_defect'].map(v => count(list, 'asked', v)).join(' / ');
  const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s[Math.floor(s.length / 2)] / 1000).toFixed(1) : 'cached'; };
  L.push('## On the routed problems', '', 'Asked parts: correct / partial / wrong / no answer / gold defect. Old: correct / wrong. Seconds: median per problem of the route call, uncached only (the structure call is apart).', '',
    '| tier | arm | old: correct / wrong | asked parts | lowered / oracle-only | lowered agree with oracle | s/problem |', '|---|---|---|---|---|---|---|');
  for (const t of tiers) {
    for (const kind of ['js', 'expr']) {
      const list = rows.filter(r => r.arm === `${kind}:${t}` && routedIds.has(r.id));
      if (!list.length) continue;
      const low = list.filter(r => r.executed === 'engines').length, orc = list.filter(r => r.executed === 'oracle').length;
      L.push(`| ${t} | ${kind === 'js' ? 'jsEval route' : 'path B'} | ${count(list, 'verdict', 'correct')} / ${count(list, 'verdict', 'wrong')} | ${askedCell(list)} | ${kind === 'js' ? `${low} / ${orc}` : `${low} / -`} | ${kind === 'js' ? `${list.filter(r => r.agree === true).length}/${low}` : '-'} | ${median(list.filter(r => !r.cached).map(r => r.ms))} |`);
    }
    const F = [...routedIds].map(id => folVerdicts(t, id)).filter(Boolean);
    if (F.length) L.push(`| ${t} | FOL v2 | ${count(F, 'verdict', 'correct')} / ${count(F, 'verdict', 'wrong')} | ${askedCell(F)} | - | - | (see its run) |`);
  }
  L.push('', '## Combined system (all problems)', '', 'jsEval on the routed problems, FOL v2 on the others, against FOL v2 on every problem.', '',
    '| tier | system | old: correct / wrong | asked parts |', '|---|---|---|---|');
  for (const t of tiers) {
    if (!fol.length) break;
    const js = new Map(rows.filter(r => r.arm === `js:${t}`).map(r => [r.id, r]));
    const combined = R.map(r => (r.route === 'js' ? (js.get(r.id) ? {verdict: js.get(r.id).verdict, asked: js.get(r.id).asked} : {verdict: 'no_answer', asked: 'no_answer'}) : folVerdicts(t, r.id) ?? {verdict: 'no_answer', asked: 'no_answer'}));
    const folAll = R.map(r => folVerdicts(t, r.id) ?? {verdict: 'no_answer', asked: 'no_answer'});
    L.push(`| ${t} | jsEval + FOL | ${count(combined, 'verdict', 'correct')} / ${count(combined, 'verdict', 'wrong')} | ${askedCell(combined)} |`);
    L.push(`| ${t} | FOL v2 only | ${count(folAll, 'verdict', 'correct')} / ${count(folAll, 'verdict', 'wrong')} | ${askedCell(folAll)} |`);
  }
  const why = {};
  for (const r of rows.filter(x => x.arm.startsWith('js:') && x.executed === 'oracle')) { const k = String(r.why).replace(/: .*/, '').slice(0, 70); why[k] = (why[k] ?? 0) + 1; }
  L.push('', `Why a program stayed oracle-only: ${Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join('; ') || 'none'}.`);
  const rej = {};
  for (const r of raw.filter(x => x.arm.startsWith('js:') && x.js?.status === 'rejected')) for (const v of r.js.attempts.at(-1)?.violations ?? []) rej[v.code] = (rej[v.code] ?? 0) + 1;
  L.push(`Rejections after the second ask, by code: ${Object.entries(rej).map(([k, v]) => `${k} (${v})`).join('; ') || 'none'}.`);
  fs.writeFileSync(path.join(OUT, 'summary.md'), L.join('\n') + '\n');
  console.log(L.join('\n'));
}

const cmd = process.argv[2];
if (cmd === 'fetch') await fetchPhase();
else if (cmd === 'score') await scorePhase();
else { console.error('usage: js-route.mjs fetch|score --run <id> [--tiers tiny,good:reason] [--fol <run>]'); process.exit(2); }
