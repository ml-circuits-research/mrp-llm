#!/usr/bin/env node
/**
 * Evaluation of ChatSOPAdapter on book problems (owner decision 2026-10-03: the chat and every evaluation answer through the same
 * adapter, lib/adapter). Thin CLI: the adapter answers, this file only loads the problems and scores against the book answers with
 * the asked-parts scorer (tools/eval/routed/structure/asked.mjs). Offline evaluation harness; book text stays local under state/.
 *
 *   node tools/eval/routed/adapter/run.mjs --run <name> --ids-from js-fresh-50 --mode routed|direct-verified|all-paths
 *     [--tier tiny] [--structure structure-tiny] [--formalizer formalizer-tiny] [--second jsEval,engineCode] [--langs js,smt]
 *     [--no-early-stop] [--no-fallback-fol] [--cache use|strict] [--concurrency 4] [--limit N] [--score-only]
 *
 * --ids-from: a run folder of state/structure-formalizer whose ids.json lists the problems. Tiers name Ploinky tiers; the structure and
 * formalizer roles default to their explicit variants (structure-tiny, formalizer-tiny), whose earlier answers the Ploinky cache holds.
 * `all-paths` (registered here, an evaluation mode): the structure route, then on a compute problem B, jsEval and engineCode in all
 * --langs, and FOL on every problem, with no early stop: the per-path numbers of the 2026-10-03 harnesses through the adapter.
 * `--cache strict` refuses any call the Ploinky cache cannot answer (no model is called). Writes state/adapter-eval/<run>/{rows.jsonl,
 * summary.md}; rows are resumable (one per problem).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadItems} from '../../books/sample.mjs';
import {goldOf} from '../structure/gold.mjs';
import {askedVerdict} from '../structure/asked.mjs';
import {createChatSOPAdapter, registerMode, structureRoute, pathB, pathJsEval, pathEngineCode, pathFol, decideAgreement} from '../../../../lib/adapter/index.mjs';
import {registryOf} from '../../../../lib/formalize/expression-program.mjs';
import {yesNoOf, numberOf, timeOf} from '../../../../lib/formalize/equivalence.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = n => process.argv.includes(`--${n}`);
const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const run = arg('run', 'adapter-1'), mode = arg('mode', 'routed'), tier = arg('tier', 'tiny');
const OUT = path.join(ROOT, 'state/adapter-eval', run);
const list = v => v.split(',').map(s => s.trim()).filter(Boolean);
const langs = list(arg('langs', mode === 'all-paths' ? 'js,asp,smt,prolog' : 'js,smt'));

/** The evaluation mode `all-paths`: every path on the problem, no early stop; the chosen answer is the compute agreement's or FOL's. */
registerMode('all-paths', async (ctx, message) => {
  const {settings, clients, executor} = ctx;
  const route = await structureRoute({message, structure: clients.structure(settings.tiers.structure)});
  const registry = registryOf(message), results = [];
  if (route.route === 'js') {
    results.push(await pathB({message, chat: clients.chat(settings.tiers.compute), executor, registry}));
    results.push(await pathJsEval({message, chat: clients.chat(settings.tiers.compute), executor, registry}));
    results.push(...(await pathEngineCode({message, chat: clients.chat(settings.tiers.compute), registry, langs: settings.routed.engineCodeLanguages})).results);
  }
  results.push(await pathFol({message, fol: clients.fol(settings.tiers.formalizer), executor, names: route.names, registry, tier: settings.tiers.formalizer}));
  const d = decideAgreement(results.filter(r => r.path !== 'fol'));
  return {route: {route: route.route, reason: route.reason}, results, chosen: d.chosen ?? results.at(-1), verification: {status: d.status === 'none' ? 'unverified' : d.status, paths: d.paths}, timings: {}, tiers: settings.tiers};
});

/**
 * A direct answer's parts as scorable values (eval-side reading of the FINAL ANSWER line, structure only): parts split at semicolons
 * by the model and at ", " (a thousands separator has no space); yes/no as booleans, a clock time h:mm as hours, numbers as numbers
 * (a unit after the number dropped), anything else as text.
 */
const scorable = answers => answers.flatMap(a => (typeof a.value === 'string' ? a.value.split(/,\s+/) : [a.value])).map(value => {
  if (typeof value !== 'string') return {kind: 'value', value};
  const yn = yesNoOf(value);
  if (yn !== null) return {kind: 'value', value: yn};
  const t = timeOf(value);
  if (t !== null) return {kind: 'value', value: t / 60};
  const n = numberOf(value) ?? numberOf(value.replace(/^[$€£]\s*/, ''));
  return {kind: 'value', value: n ? n.value : value};
});
const verdictOf = (item, gold, p) => (p ? askedVerdict(item, gold, p.path === 'direct' ? scorable(p.answers) : p.answers).verdict : 'not_run');

async function fetchPhase(items, ids) {
  fs.mkdirSync(OUT, {recursive: true});
  const file = path.join(OUT, 'rows.jsonl');
  const done = new Set(readJsonl(file).map(r => r.id));
  const adapter = createChatSOPAdapter({config: JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtime.json'), 'utf8'))});
  const options = {tiers: {structure: arg('structure', 'structure-tiny'), formalizer: arg('formalizer', 'formalizer-tiny'), compute: tier, direct: arg('direct-tier', tier)},
    routed: {second: list(arg('second', 'jsEval,engineCode')), engineCodeLanguages: langs, earlyStop: !flag('no-early-stop'), fallbackToFol: !flag('no-fallback-fol')}, noFallback: true};
  const todo = ids.filter(id => !done.has(id));
  let next = 0;
  const one = async id => {
    const item = items.get(id), t0 = Date.now();
    let a;
    try { a = await adapter.answer({message: item.question, mode, options, run, cache: arg('cache', null)}); }
    catch (error) { a = {error: error.message}; }
    const {packet, ...rest} = a;
    void packet;
    fs.appendFileSync(file, JSON.stringify({id, book: item.book, ms: Date.now() - t0, ...rest}) + '\n');
    process.stdout.write(a.error ? 'x' : '.');
  };
  const worker = async () => { while (next < todo.length) await one(todo[next++]); };
  await Promise.all(Array.from({length: Math.min(Number(arg('concurrency', 4)), todo.length)}, worker));
  adapter.dispose();
  console.log(` ${todo.length} problems`);
}

const V = ['correct', 'partial', 'wrong', 'no_answer', 'gold_defect'];
const cell = vs => V.map(v => vs.filter(x => x === v).length).join(' / ');

function scorePhase(items, ids) {
  const rows = readJsonl(path.join(OUT, 'rows.jsonl')).filter(r => ids.includes(r.id));
  const L = [`# ChatSOPAdapter: ${run} (mode ${mode}, tier ${tier}; ${rows.length} problems)`, '',
    'Asked parts (tools/eval/routed/structure/asked.mjs): correct / partial / wrong / no answer / gold defect. Every answer comes from `lib/adapter` (`createChatSOPAdapter().answer`).', ''];
  const scored = [];
  for (const r of rows) {
    const item = items.get(r.id), gold = goldOf(item);
    if (!gold || r.error) { scored.push({id: r.id, unscorable: true, error: r.error ?? null}); continue; }
    const per = Object.fromEntries(Object.entries(r.paths ?? {}).map(([k, p]) => [k, verdictOf(item, gold, p)]));
    const chosen = r.path ? verdictOf(item, gold, r.paths[r.path]) : 'no_answer';
    scored.push({id: r.id, route: r.route?.route ?? null, path: r.path, status: r.verification?.status, paths: r.verification?.paths ?? [], per, chosen, cached: Object.values(r.paths ?? {}).every(p => p.cached !== false)});
  }
  const S = scored.filter(s => !s.unscorable);
  L.push(`Scorable: ${S.length}; errors: ${scored.filter(s => s.error).length}; every path served from the Ploinky cache: ${S.filter(s => s.cached).length}/${S.length}.`,
    `Route: compute ${S.filter(s => s.route === 'js').length}, FOL ${S.filter(s => s.route === 'fol').length}. Paths whose tier did not answer (unavailable; with --cache strict: not in the cache): ${rows.flatMap(r => Object.values(r.paths ?? {})).filter(p => p.status === 'unavailable').length}.`, '');
  L.push('## Per path (where it ran)', '', '| path | ran | asked parts |', '|---|---|---|');
  const names = [...new Set(S.flatMap(s => Object.keys(s.per)))];
  for (const n of names) { const vs = S.filter(s => s.per[n] && s.per[n] !== 'not_run').map(s => s.per[n]); L.push(`| ${n} | ${vs.length} | ${cell(vs)} |`); }
  // engineCode verified: two languages of the engineCode reply agree (the measure of tools/eval/routed/engine-code/run.mjs).
  const ec = rows.filter(r => !r.error && Object.keys(r.paths ?? {}).some(k => k.startsWith('engineCode:'))).map(r => {
    const item = items.get(r.id), gold = goldOf(item);
    const d = decideAgreement(Object.values(r.paths).filter(p => p.path.startsWith('engineCode:')).map(p => ({...p, values: p.values})));
    return gold ? {verified: d.status === 'verified', verdict: d.status === 'verified' ? askedVerdict(item, gold, d.chosen.answers).verdict : null} : null;
  }).filter(Boolean);
  if (ec.length) L.push('', `engineCode verified (two languages of one reply agree): ${ec.filter(x => x.verified).length}/${ec.length}; asked parts ${cell(ec.filter(x => x.verified).map(x => x.verdict))}.`);
  L.push('', '## The adapter\'s answer', '', `Asked parts of the answered path: ${cell(S.map(s => s.chosen))}.`, '', '| verification | n | asked parts | answering paths |', '|---|---|---|---|');
  for (const st of ['verified', 'contradicted', 'unverified', 'unresolved']) {
    const g = S.filter(s => s.status === st);
    if (!g.length) continue;
    const by = {};
    for (const s of g) by[s.path ?? 'none'] = (by[s.path ?? 'none'] ?? 0) + 1;
    L.push(`| ${st} | ${g.length} | ${cell(g.map(s => s.chosen))} | ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
  }
  if (mode === 'direct-verified') {
    const d = S.map(s => s.per.direct ?? 'not_run');
    L.push('', `Direct answer alone (tier ${arg('direct-tier', tier)}): ${cell(d)}.`);
    const contradicted = S.filter(s => s.status === 'contradicted');
    L.push(`Contradicted: ${contradicted.length}; the symbolic value right in ${contradicted.filter(s => s.chosen === 'correct').length}, the model's right in ${contradicted.filter(s => s.per.direct === 'correct').length}.`);
    const ver = S.filter(s => s.status === 'verified');
    L.push(`Verified: ${ver.length}/${S.length}; precision ${ver.filter(s => s.chosen === 'correct').length}/${ver.filter(s => s.chosen !== 'gold_defect').length} (gold defects apart).`);
    const unv = S.filter(s => s.status === 'unverified');
    L.push(`Unverified: ${unv.length}; correct ${unv.filter(s => s.chosen === 'correct').length}.`);
    const other = arg('compare');
    if (other) {
      const o = new Map(readJsonl(path.join(ROOT, 'state/adapter-eval', other, 'scored.jsonl')).map(x => [x.id, x]));
      const both = S.filter(s => o.has(s.id) && !o.get(s.id).unscorable);
      const c = (s, x) => s.chosen === 'correct', oc = s => o.get(s.id).chosen === 'correct';
      L.push('', `Paired with ${other} (${both.length} problems, asked-parts correct): both ${both.filter(s => c(s) && oc(s)).length}, only this mode ${both.filter(s => c(s) && !oc(s)).length}, only ${other} ${both.filter(s => !c(s) && oc(s)).length}; wrong here ${both.filter(s => s.chosen === 'wrong').length}, wrong there ${both.filter(s => o.get(s.id).chosen === 'wrong').length}.`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'scored.jsonl'), scored.map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'summary.md'), L.join('\n') + '\n');
  console.log(L.join('\n'));
}

const items = new Map(loadItems(ROOT).map(i => [i.id, i]));
let ids = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/structure-formalizer', arg('ids-from', 'js-fresh-50'), 'ids.json'), 'utf8')).ids;
if (arg('limit')) ids = ids.slice(0, Number(arg('limit')));
if (!flag('score-only')) await fetchPhase(items, ids);
scorePhase(items, ids);
