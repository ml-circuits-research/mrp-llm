#!/usr/bin/env node
/**
 * Smoke harness for the proposed reasoning wires.
 *
 *   node eval/smoke-reasoning/run.mjs                 run every available adapter on every case
 *   node eval/smoke-reasoning/run.mjs --adapter js-oracle,prolog-tabling --case 05
 *   node eval/smoke-reasoning/run.mjs --with-reference-engines   add the reference engines (datalog-soplab); --with-frozen adds the frozen strategies (golog-swi)
 *   node eval/smoke-reasoning/run.mjs --validate-only validate circuits and invalid fixtures, run nothing
 *   node eval/smoke-reasoning/run.mjs --list          list adapters and cases
 *   node eval/smoke-reasoning/run.mjs --markdown      print the result table as Markdown
 *   node eval/smoke-reasoning/run.mjs --verbose       print the reason of every non-pass
 *
 * Steps: (1) validate every circuit against the proposed grammar (validator.mjs) and every invalid fixture against its
 * expected error code; (2) for each adapter and case report pass, fail, not expressible, planned or unavailable.
 * A strategy that cannot state a feature must say "not expressible"; it may never weaken the circuit. The harness
 * reads sop/ and reasoning/ only through the adapters; it changes nothing outside eval/ and eval/reports/current/.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateProgram, FEATURES} from './validator.mjs';
import {desugarText} from './lib/desugar.mjs';
import {selectInForce} from './lib/governance.mjs';
import {runConditional} from './lib/conditional.mjs';
import {applyClosedPolicy} from './lib/closed.mjs';
import {parse} from './validator.mjs';
import {compare} from './lib/compare.mjs';
import {adapters as defaultAdapters, referenceEngineAdapters, frozenAdapters} from './adapters/index.mjs';
import {NotExpressible} from './adapters/common.mjs';
import {runWithRetrieval} from './lib/widen.mjs';
import {hostUsed, replayUsed} from './lib/used.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const flag = name => args.includes(name);
// the default columns, plus the opt-in pools (an adapter named with --adapter always runs)
const adapters = [...defaultAdapters, ...(flag('--with-reference-engines') ? referenceEngineAdapters : []), ...(flag('--with-frozen') ? frozenAdapters : [])];
const pool = [...defaultAdapters, ...referenceEngineAdapters, ...frozenAdapters];

export function loadCases(filter = null) {
  const root = path.join(here, 'cases');
  return fs.readdirSync(root).filter(d => fs.statSync(path.join(root, d)).isDirectory() && (!filter || d.includes(filter))).sort().map(dir => {
    const p = n => path.join(root, dir, n);
    return {dir, knowledge: fs.readFileSync(p('knowledge.sop'), 'utf8'), query: fs.readFileSync(p('query.sop'), 'utf8'), expected: JSON.parse(fs.readFileSync(p('expected.json'), 'utf8')), memory: fs.existsSync(p('memory.json')) ? JSON.parse(fs.readFileSync(p('memory.json'), 'utf8')) : null, readme: fs.existsSync(p('README.md'))};
  });
}

function validateAll(cases) {
  const problems = [], warnings = [];
  for (const c of cases) {
    const r = validateProgram([{name: c.dir + '/knowledge.sop', text: c.knowledge, role: 'knowledge'}, {name: c.dir + '/query.sop', text: c.query, role: 'query'}]);
    for (const p of r.problems) if (p.severity !== 'warning') problems.push(`${p.file}:${p.line ?? '?'} ${p.code} ${p.message}`);
    // warnings must be exactly those the case declares (a case about an open predicate declares its warning)
    const gotW = r.problems.filter(p => p.severity === 'warning').map(p => p.code).sort().join(','), wantW = [...(c.expected.warnings ?? [])].sort().join(',');
    if (gotW !== wantW) problems.push(`${c.dir}: validator warnings [${gotW}], expected.json declares [${wantW}]`);
    if (!c.readme) problems.push(c.dir + ': missing README.md');
    if (!c.expected.status || !Array.isArray(c.expected.requires) || !c.expected.requires.length || !c.expected.feature) problems.push(c.dir + ': expected.json needs status, feature and requires');
    for (const f of c.expected.requires ?? []) if (f !== 'retrieval' && !FEATURES.includes(f)) problems.push(`${c.dir}: unknown feature "${f}" in requires (validator.mjs FEATURES)`);
    // the validator also checks the DESUGARED program: sugar must desugar into valid, stratified core
    if (r.ok) {
      const core = desugarText(c.knowledge, {include: []});
      const rd = validateProgram([{name: c.dir + '/knowledge.desugared', text: core, role: 'knowledge'}, {name: c.dir + '/query.sop', text: c.query, role: 'query'}]);
      for (const p of rd.problems) if (p.severity !== 'warning' && !['wrong_file_role', 'unknown_ref', 'reserved_prefix'].includes(p.code)) problems.push(`${p.file}:${p.line ?? '?'} ${p.code} (desugared) ${p.message}`);
    }
  }
  const invalidRoot = path.join(here, 'invalid');
  let invalidChecked = 0;
  for (const f of fs.existsSync(invalidRoot) ? fs.readdirSync(invalidRoot) : []) {
    const text = fs.readFileSync(path.join(invalidRoot, f), 'utf8');
    const expect = (/# expect: (.*)/.exec(text)?.[1] ?? '').split(/\s+/).filter(Boolean);
    const got = new Set(validateProgram([{name: f, text, role: 'any'}]).problems.map(p => p.code));
    invalidChecked++;
    for (const e of expect) if (!got.has(e)) problems.push(`invalid/${f}: validator did not report ${e} (got ${[...got].join(', ') || 'nothing'})`);
  }
  return {problems, warnings, invalidChecked};
}

async function runOne(adapter, c) {
  const missing = c.expected.requires.filter(f => f !== 'retrieval' && !adapter.supports.has(f));
  if (adapter.status === 'planned') return {result: 'planned', detail: adapter.supports.has('x') ? '' : (missing.length ? 'expected gap: ' + missing.join(', ') : 'expected to cover')};
  const avail = await adapter.available();
  if (!avail.ok) return {result: 'unavailable', detail: avail.reason};
  if (missing.length) return {result: 'not_expressible', detail: 'declared unsupported: ' + missing.join(', ')};
  const ctx = {};
  try {
    const runner = c2 => (c2.memory ? runWithRetrieval(adapter, c2, ctx, {policy: opt('--widen') ?? 'targeted'}) : adapter.run(c2, ctx));
    // host rules around every strategy alike: the two-run conditional list (MUST-FIX 7) and the closed-world policy (R-P2)
    // a `raw` adapter (the advisory llm-agent baseline) is asked for the final answer itself: no conditional re-runs, closed policy or retrieval widening
    const exec = adapter.raw ? Promise.resolve(adapter.run(c, ctx)) : runConditional(runner, c).then(r => applyClosedPolicy(c, r));
    const limitMs = adapter.timeoutMs ?? 60000;
    const got = await Promise.race([exec, new Promise((_, rej) => setTimeout(() => rej(new Error(`adapter timeout ${limitMs / 1000} s`)), limitMs))]);
    // `used` (round 3): a strategy that returns it is checked by REPLAY in the oracle; for the others the host computes one sufficient set by
    // deletion, verified by a replay (used_incomplete when the replay fails). Only cases that state used_support pay for the extra runs.
    if (c.expected.used_support && !c.memory) {
      if (!got.used && !adapter.raw) Object.assign(got, await hostUsed(c2 => adapter.run(c2, ctx), c, got));
      const oracle = defaultAdapters.find(a => a.id === 'js-oracle');
      const canReplay = (await oracle.available()).ok && c.expected.requires.every(f => f === 'retrieval' || oracle.supports.has(f));
      got.used_replay = canReplay ? await replayUsed(c2 => oracle.run(c2, ctx), c, got) : {ok: true, skipped: true};
    }
    const cmp = compare(c.expected, got);
    let extra = '';
    if (c.memory) {
      const r = got.retrieval;
      extra = ` [steps ${r?.steps}, wires ${r?.wires}/${r?.storeWires}, probes ${r?.probes}, needed recall ${r ? Math.round(100 * r.neededRecall) : '-'}%]`;
      if (r && c.expected.retrieval) {
        const e = c.expected.retrieval;
        if (e.max_wires !== undefined && r.wires > e.max_wires) cmp.why.push(`retrieved ${r.wires} wires, more than ${e.max_wires}`);
        if (e.needed_recall !== undefined && r.neededRecall < e.needed_recall) cmp.why.push(`needed-wire recall ${r.neededRecall}, expected ${e.needed_recall}`);
        if (e.min_steps !== undefined && r.steps < e.min_steps) cmp.why.push(`only ${r.steps} retrieval step(s); the case expects widening (at least ${e.min_steps})`);
        if (e.flagged_first_step && !r.trace?.[0]?.validatorFlags?.includes('absent_over_incomplete_rules')) cmp.why.push('the validator did not flag absent over a derived predicate whose rule set was cut in the first slice');
      }
      cmp.ok = cmp.why.length === 0;
    }
    return {result: cmp.ok ? 'pass' : 'fail', detail: cmp.why.join('; ') + extra, got, route: got.route, retrieval: got.retrieval};
  } catch (e) {
    if (e instanceof NotExpressible) return {result: 'not_expressible', detail: e.message};
    return {result: 'fail', detail: 'error: ' + e.message.split('\n')[0]};
  }
}

const SYMBOL = {pass: 'pass', fail: 'FAIL', not_expressible: 'n/e', planned: 'plan', unavailable: 'unav'};

/** Executable evidence for the Z3 lowering claims: two relations for polarity, and the completion caveat for recursion. */
/** The authoring mode of the validator, the default `binding strict` and the standing-obligation marker. */
function authoringSelfTest() {
  const out = [];
  const codes = (text, opts) => validateProgram([{name: 't', text, role: 'knowledge'}], opts).problems.map(p => p.code);
  const gov = '@r1 rule\n  when a ?x\n  then b ?x\n  approval approved\n  approved_at 2026-01-15\n';
  if (!codes(gov).includes('approval_incomplete')) out.push('ingestion mode must report approval_incomplete');
  const a = codes(gov, {authoring: true});
  if (a.includes('approval_incomplete') || !a.includes('governance_ignored')) out.push('authoring mode must ignore governance with a warning and skip approval_incomplete');
  if (codes('@r1 rule\n  when a ?x\n  then b ?x\n  version 2\n  supersedes $r0\n@r0 rule\n  when a ?x\n  then b ?x\n', {authoring: true}).includes('governance_ignored')) out.push('version and supersedes are author fields');
  const m = '@p predicate\n  args subject:entity\n@q predicate\n  args subject:entity\n@act action\n  params ?x\n  requires p ?x\n  adds q ?x\n';
  if (!codes(m + '@m method\n  achieves q ?x\n  step ~act ?x\n@n norm\n  forbid ~act ?x\n').includes('strict_forbid_conflicts_method')) out.push('an absent binding must default to strict');
  if (codes(m + '@m method\n  achieves q ?x\n  step ~act ?x\n@n norm\n  forbid ~act ?x\n  binding advisory\n').includes('strict_forbid_conflicts_method')) out.push('an explicit advisory norm must not conflict');
  return out;
}

async function solverProbes() {
  const {spawnSync} = await import('node:child_process');
  const {solverEnv} = await import('./adapters/common.mjs');
  const z3 = solverEnv().Z3_BIN;
  if (!z3 || !fs.existsSync(z3)) return 'skipped (no Z3 binary)';
  const dir = path.join(here, 'probes'), bad = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.smt2'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const expect = /; expect: (.*)/.exec(text)?.[1].trim();
    const out = spawnSync(z3, [path.join(dir, f)], {encoding: 'utf8'}).stdout.trim().split(/\s+/).join(' ');
    if (out !== expect) bad.push(`${f}: got "${out}", expected "${expect}"`);
  }
  return bad.length ? 'FAILED ' + bad.join('; ') : `ok (${fs.readdirSync(dir).filter(x => x.endsWith('.smt2')).length} files with the private Z3)`;
}

/** Governance must have teeth: only approved wires bind, asof picks the version, proposed wires bind only when supposed. */
function governanceSelfTest() {
  const bad = [];
  const w = parse(`@v1 rule
  when a ?x
  then b ?x
  version 1
  approval superseded
  approved_by "o"
  approved_at 2025-01-01
@v2 rule
  when a ?x
  then c ?x
  version 2
  supersedes $v1
  approval approved
  approved_by "o"
  approved_at 2026-06-01
@v3 rule
  when a ?x
  then d ?x
  version 3
  supersedes $v2
  approval proposed
@legacy rule
  when a ?x
  then e ?x
@cont rule
  when a ?x
  then f ?x
  approval contested
@nope rule
  when a ?x
  then g ?x
  approval rejected
`).wires;
  const ids = x => selectInForce(w, x).map(r => r.id).sort().join(',');
  if (ids({}) !== 'cont,legacy,v2') bad.push('now: ' + ids({}));
  if (ids({asof: '2026-01-01'}) !== 'cont,legacy,v1') bad.push('asof old: ' + ids({asof: '2026-01-01'}));
  if (ids({asof: '2026-09-01'}) !== 'cont,legacy,v2') bad.push('asof new: ' + ids({asof: '2026-09-01'}));
  if (ids({include: ['v3']}) !== 'cont,legacy,v3') bad.push('supposed proposed wire: ' + ids({include: ['v3']}));
  if (ids({include: ['nope']}).includes('nope') === false) bad.push('a supposed rejected wire should join the query');
  return bad;
}

/** The comparison itself must have teeth: wrong answers must fail. */
function selfTest() {
  const bad = [];
  const mustFail = (name, expected, got) => { if (compare(expected, got).ok) bad.push(name); };
  const mustPass = (name, expected, got) => { if (!compare(expected, got).ok) bad.push(name); };
  mustFail('wrong status', {status: 'supported'}, {status: 'unknown', complete: true});
  mustFail('missing row', {status: 'supported', rows: [{x: 'a'}, {x: 'b'}]}, {status: 'supported', rows: [{x: 'a'}]});
  mustFail('extra row', {status: 'supported', rows: [{x: 'a'}]}, {status: 'supported', rows: [{x: 'a'}, {x: 'b'}]});
  mustFail('incomplete read as unknown', {status: 'supported', acceptable_if_incomplete: ['budget_exhausted']}, {status: 'unknown', complete: false});
  mustFail('silent short list', {status: 'supported', complete: false, rows_subset_of: [{t: 1}, {t: 2}], budget: {must_exhaust: true}}, {status: 'supported', complete: true, rows: [{t: 1}]});
  mustFail('invented row in partial', {status: 'supported', complete: false, rows_subset_of: [{t: 1}]}, {status: 'supported', complete: false, rows: [{t: 9}]});
  mustFail('unexpected conditional', {status: 'supported'}, {status: 'supported', conditional: true, complete: true});
  mustFail('wrong count', {status: 'supported', count: 3}, {status: 'supported', count: 2, complete: true});
  mustFail('wrong assumption list', {status: 'supported', conditional: ['s1']}, {status: 'supported', conditional: ['s2'], complete: true});
  mustFail('horizon cut read as no_plan', {status: 'plan_found'}, {status: 'no_plan', reason: 'horizon', complete: false});
  mustFail('open count read as exact', {status: 'supported', count: 3}, {status: 'supported', count: 3, bound: 'at_least', complete: true});
  mustFail('wrong blocked_by', {status: 'blocked', blocked_by: ['n1']}, {status: 'blocked', blocked_by: ['n2'], complete: true});
  mustFail('wrong used version', {status: 'plan_found', used: [{id: 'm', version: 2}]}, {status: 'plan_found', used: [{id: 'm', version: 1}], complete: true});
  mustFail('wrong compliance', {status: 'non_compliant', compliance: {hard: 'violated', violated: ['n1']}}, {status: 'non_compliant', compliance: {hard: 'ok'}, complete: true});
  mustFail('deletion-based used is empty for two sufficient facts and not flagged', {status: 'supported', used_support: [['fa'], ['fb']]}, {status: 'supported', used: [], complete: true});
  mustFail('used that does not replay', {status: 'supported'}, {status: 'supported', used: [{id: 'fa'}], used_replay: {ok: false, why: 'x'}, complete: true});
  mustFail('missing relaxed', {status: 'plan_found', relaxed: ['n1']}, {status: 'plan_found', complete: true});
  mustFail('inexact row list', {status: 'supported', row_conditional: [{row: {x: 'a'}, conditional: ['s1']}]}, {status: 'supported', row_conditional: [{row: {x: 'a'}, conditional: ['s1'], conditional_unknown: true}], complete: true});
  mustPass('one proof leaves are enough', {status: 'supported', used_support: [['fa'], ['fb']]}, {status: 'supported', used: [{id: 'fb'}, {id: 'extra'}], used_replay: {ok: true}, complete: true});
  mustPass('used_incomplete is an honest flag', {status: 'supported', used_support: [['fa'], ['fb']]}, {status: 'supported', used: [], used_incomplete: true, complete: true});
  mustPass('assumption list as a set', {status: 'supported', conditional: ['s1', 's2']}, {status: 'supported', conditional: ['s2', 's1'], complete: true});
  mustPass('order-insensitive rows', {status: 'supported', rows: [{x: 'a'}, {x: 'b'}]}, {status: 'supported', complete: true, rows: [{x: 'b'}, {x: 'a'}]});
  mustPass('honest budget status', {status: 'supported', acceptable_if_incomplete: ['budget_exhausted']}, {status: 'budget_exhausted', complete: false});
  return bad;
}

async function main() {
  const selfBad = selfTest();
  console.log('compare self-test: ' + (selfBad.length ? 'FAILED ' + selfBad.join(', ') : 'ok (23 checks)'));
  if (selfBad.length) return 1;
  const cases = loadCases(opt('--case'));
  if (flag('--list')) {
    for (const a of adapters) console.log(`${a.status.padEnd(9)} ${a.id.padEnd(26)} ${a.origin}`);
    for (const c of cases) console.log(c.dir.padEnd(40) + c.expected.feature);
    return 0;
  }
  const v = validateAll(cases);
  console.log(`validation: ${cases.length} cases, ${v.invalidChecked} invalid fixtures, ${v.problems.length} problem(s), ${v.warnings.length} warning(s)`);
  for (const p of v.problems) console.log('  ' + p);
  for (const p of v.warnings) console.log('  warning ' + p);
  const probes = await solverProbes();
  console.log('solver probes: ' + probes);
  if (probes.startsWith('FAILED')) return 1;
  const gov = governanceSelfTest();
  console.log('governance self-test: ' + (gov.length ? 'FAILED ' + gov.join(', ') : 'ok'));
  if (gov.length) return 1;
  const auth = authoringSelfTest();
  console.log('authoring self-test: ' + (auth.length ? 'FAILED ' + auth.join(', ') : 'ok'));
  if (auth.length) return 1;
  if (v.problems.length) return 1;
  if (flag('--validate-only')) return 0;
  const wanted = opt('--adapter')?.split(',');
  const chosen = (wanted ? pool : adapters).filter(a => !wanted || wanted.includes(a.id));
  const live = chosen.filter(a => a.status !== 'planned');
  const results = {};
  for (const a of chosen) {
    results[a.id] = {};
    for (const c of cases) results[a.id][c.dir] = await runOne(a, c);
  }
  // Table
  const w = Math.max(...cases.map(c => c.dir.length)) + 2;
  const cols = live.map(a => a.id);
  const md = flag('--markdown');
  const row = cells => md ? '| ' + cells.join(' | ') + ' |' : cells.map((x, i) => i === 0 ? String(x).padEnd(w) : String(x).padEnd(Math.max(cols[i - 1]?.length ?? 6, 6) + 2)).join('');
  console.log(row(['case', ...cols]));
  if (md) console.log(row(['---', ...cols.map(() => '---')]));
  for (const c of cases) console.log(row([c.dir, ...cols.map(id => SYMBOL[results[id][c.dir].result])]));
  // Declared coverage of the PLANNED strategies: "exp" = every required feature is declared, "n/e" = a required feature is declared unsupported
  // a wrapper (dreaming-session) has no coverage of its own: it inherits the coverage of the engine it wraps, so it gets no column (round 3)
  const plannedCols = chosen.filter(a => a.status === 'planned' && !a.wrapper);
  if (plannedCols.length) {
    console.log('\ndeclared coverage of planned strategies (exp = expected to cover, n/e = a required feature is not declared)');
    const pcols = plannedCols.map(a => a.id);
    const prow = cells => md ? '| ' + cells.join(' | ') + ' |' : cells.map((x, i) => i === 0 ? String(x).padEnd(w) : String(x).padEnd(Math.max(pcols[i - 1]?.length ?? 6, 6) + 2)).join('');
    console.log(prow(['case', ...pcols]));
    if (md) console.log(prow(['---', ...pcols.map(() => '---')]));
    for (const c of cases) console.log(prow([c.dir, ...plannedCols.map(a => c.expected.requires.filter(f => f !== 'retrieval').every(f => a.supports.has(f)) ? 'exp' : 'n/e')]));
    const totals = plannedCols.map(a => `${a.id} ${cases.filter(c => c.expected.requires.filter(f => f !== 'retrieval').every(f => a.supports.has(f))).length}/${cases.length}`);
    console.log('declared coverage (cases expected to be covered): ' + totals.join(', '));
  }
  console.log('');
  for (const a of chosen) {
    const tally = {pass: 0, fail: 0, not_expressible: 0, planned: 0, unavailable: 0};
    for (const c of cases) tally[results[a.id][c.dir].result]++;
    const expressible = tally.pass + tally.fail;
    console.log(`${a.id.padEnd(26)} [${a.status}] pass ${tally.pass}  fail ${tally.fail}  not expressible ${tally.not_expressible}` + (tally.planned ? `  planned ${tally.planned}` : '') + (tally.unavailable ? `  unavailable ${tally.unavailable}` : '') + (expressible ? `  (of the ${expressible} it can express: ${Math.round(100 * tally.pass / expressible)}% pass)` : ''));
  }
  if (flag('--verbose')) for (const a of live) for (const c of cases) { const r = results[a.id][c.dir]; if (r.result !== 'pass') console.log(`  ${a.id} ${c.dir}: ${r.result}${r.detail ? ' - ' + r.detail : ''}`); }
  // Retrieval study: wires retrieved against wires needed, widening policies, and the cost of unsafe negation.
  const retrievalStudy = [];
  const memCases = cases.filter(c => c.memory);
  if (memCases.length) {
    console.log('\nretrieval study (strategy: first live adapter that can express the case)');
    console.log('case'.padEnd(w) + 'policy'.padEnd(10) + 'steps  wires  stored  probes  recall  answer (strategy in report.json)');
    for (const c of memCases) {
      const a = live.find(x => c.expected.requires.every(f => f === 'retrieval' || x.supports.has(f)) && x.status === 'available');
      if (!a) continue;
      for (const [policy, unsafe] of [['targeted', false], ['blind', false], ['whole', false], ['targeted', true]]) {
        try {
          const r = await runWithRetrieval(a, c, {}, {policy, unsafeNaf: unsafe});
          const ok = compare(c.expected, r).ok;
          const label = policy + (unsafe ? '+unsafe' : '');
          const line = {case: c.dir, strategy: a.id, policy: label, steps: r.retrieval.steps, wires: r.retrieval.wires, stored: r.retrieval.storeWires, probes: r.retrieval.probes, neededRecall: r.retrieval.neededRecall, correct: ok};
          retrievalStudy.push(line);
          console.log(c.dir.padEnd(w) + label.padEnd(16) + String(line.steps).padEnd(7) + String(line.wires).padEnd(7) + String(line.stored).padEnd(8) + String(line.probes).padEnd(8) + (Math.round(100 * line.neededRecall) + '%').padEnd(8) + (ok ? 'correct' : 'WRONG (' + r.status + ')') + (unsafe ? '  <- guard disabled' : ''));
        } catch (e) { const label = policy + (unsafe ? '+unsafe' : ''); retrievalStudy.push({case: c.dir, strategy: a.id, policy: label, refused: e.message}); console.log(c.dir.padEnd(w) + label.padEnd(16) + `engine ${a.id} refused the slice: ${e.message}`); }
      }
    }
  }
  const outDir = path.join(repo, 'eval/reports/current/smoke-reasoning');
  fs.mkdirSync(outDir, {recursive: true});
  const report = {generated: new Date().toISOString(), note: 'Regenerable observation of the smoke harness (eval/smoke-reasoning/run.mjs).', adapters: Object.fromEntries(chosen.map(a => [a.id, {status: a.status, origin: a.origin, description: a.description, lowering: a.lowering ?? null, supports: [...a.supports]}])), results: Object.fromEntries(Object.entries(results).map(([id, byCase]) => [id, Object.fromEntries(Object.entries(byCase).map(([k, r]) => [k, {result: r.result, detail: r.detail, route: r.route, retrieval: r.retrieval ? {steps: r.retrieval.steps, wires: r.retrieval.wires, probes: r.retrieval.probes, neededRecall: r.retrieval.neededRecall} : undefined}]))])), retrievalStudy};
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('\nreport: ' + path.relative(repo, path.join(outDir, 'report.json')));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
