import test from 'node:test';
import assert from 'node:assert/strict';
import {prologTabling, solveCompiled, NotExpressibleError, capabilities} from '../../reasoning/strategies/prolog-tabling/index.mjs';
import {jsReference} from '../../reasoning/strategies/js-reference/index.mjs';
import {parse} from '../../reasoning/strategies/js-reference/wires.mjs';
import {Budget} from '../../reasoning/strategies/js-reference/budget.mjs';
import {readQuery, readPolicy} from '../../reasoning/strategies/prolog-tabling/front.mjs';
import {probeSwipl, swiplCommand} from '../../reasoning/strategies/prolog-tabling/swipl.mjs';
import {loadCases} from '../../eval/smoke-reasoning/run.mjs';
import {compare} from '../../eval/smoke-reasoning/lib/compare.mjs';
import {circuitsOfPl} from './helpers-vrc-pl.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const swi = probeSwipl();
const FUZZ_N = Number(process.env.PROLOG_FUZZ_N ?? 80);
const opts = {skip: swi.ok ? false : 'private swipl not available'};

const ask = (knowledge, query, budget = {}) => prologTabling.ask({theory: {knowledge}, query}, budget);
const oracle = (knowledge, query, budget = {}) => jsReference.ask({theory: {knowledge}, query}, budget);
const rowsOf = r => (r.rows ?? []).map(x => JSON.stringify(Object.entries(x).sort())).sort();
const q = text => `@q query\n${text}\n`;

const CHAIN = (n) => {
  let k = '@edge predicate\n  args source:entity destination:entity\n';
  for (let i = 0; i < n; i++) k += `@e${i} fact\n  holds edge n${i} n${i + 1}\n`;
  return k + '@r1 rule\n  when edge ?x ?y\n  then reach ?x ?y\n@r2 rule\n  when reach ?x ?m\n  when edge ?m ?y\n  then reach ?x ?y\n';
};

test('capabilities declare what is not covered and never claim planning or constraints', opts, () => {
  assert.equal(capabilities.id, 'prolog-tabling');
  for (const f of ['recursion', 'naf', 'aggregate', 'why_not', 'abduce', 'budget']) assert.ok(capabilities.features.includes(f), f);
  for (const f of ['plan', 'constraint', 'method', 'norms_hard']) assert.ok(!capabilities.features.includes(f), f);
  assert.ok(capabilities.provides.includes('proof'));
  assert.equal(capabilities.guarantee, 'exact');
});

test('left recursion over a cycle terminates and is complete (tabling)', opts, () => {
  const k = '@edge predicate\n  args source:entity destination:entity\n@e1 fact\n  holds edge a b\n@e2 fact\n  holds edge b a\n@e3 fact\n  holds edge a c\n' +
    '@r1 rule\n  when edge ?x ?y\n  then reach ?x ?y\n@r2 rule\n  when reach ?x ?m\n  when edge ?m ?y\n  then reach ?x ?y\n';
  const r = ask(k, q('  where reach a ?t\n  select ?t'));
  assert.equal(r.status, 'supported');
  assert.deepEqual(rowsOf(r), ['[["t","a"]]', '[["t","b"]]', '[["t","c"]]']);
  assert.equal(r.complete, true);
});

test('goal-directed: a long chain is answered where the naive oracle runs out of probes', opts, () => {
  const k = CHAIN(150), query = q('  where reach n0 ?t\n  select ?t');
  const r = ask(k, query);
  assert.equal(r.status, 'supported');
  assert.equal(r.rows.length, 150);
  assert.equal(r.complete, true);
});

test('well-founded negation over a stratified program equals the perfect model; polarity is independent', opts, () => {
  const k = `@blocked predicate
  args subject:entity
  closed true
@f1 fact
  holds node a
@f2 fact
  holds node b
@f3 fact
  holds blocked b
@f4 fact
  holds not node a
@r1 rule
  when node ?x
  when absent blocked ?x
  then free ?x
`;
  const r = ask(k, q('  where free ?x\n  select ?x'));
  assert.deepEqual(rowsOf(r), ['[["x","a"]]']);
  // node a has both P and N evidence: the row stays supported only by its other derivations; the status is reported, not hidden
  assert.equal(ask(k, q('  mode exists\n  where node a')).status, 'both');
  assert.equal(ask(k, q('  mode exists\n  where node b')).status, 'supported');
});

test('the well-founded model of a program that is not stratified: undefined is neither a row nor a refutation', opts, () => {
  // p :- r, tnot q.  q :- r, tnot p.  Both are undefined; the compiler would refuse the program (not_stratifiable), so it is built by hand.
  const lit = (p, mode, ...args) => ({kind: 'atom', mode, p, args});
  const x = {var: '?x'};
  const rule = (id, head, ...leaves) => ({id, source: {id, version: 1}, head: {neg: false, p: head, args: [x]}, alts: [{leaves}]});
  const program = {
    predicates: new Map(), closed: new Set(['p', 'q']),
    facts: [{id: 'f1', claim: {id: 'f1', version: 1}, neg: false, p: 'r', args: ['a'], status: 'observed', speaker: null, valid: null}],
    rules: [rule('rp', 'p', lit('r', 'pos', x), lit('q', 'absent', x)), rule('rq', 'q', lit('r', 'pos', x), lit('p', 'absent', x))],
    aggregates: [], actions: [], hypotheses: [], strata: [], unsupported: [],
    edges: [{from: 'r', to: 'p', strict: false}, {from: 'q', to: 'p', strict: true}, {from: 'r', to: 'q', strict: false}, {from: 'p', to: 'q', strict: true}]
  };
  const wire = parse('@q query\n  where p ?x\n  select ?x\n').wires[0];
  const qq = readQuery(wire, new Set(), {modes: ['select', 'exists'], id: 'test'});
  const out = solveCompiled({program, q: qq, policy: readPolicy([], null), budget: new Budget({})});
  assert.equal(out.status, 'unknown');
  assert.equal(out.reason, 'well_founded_undefined');
  assert.deepEqual(out.rows, []);
});

test('aggregates have set semantics; compute and compare are integer arithmetic', opts, () => {
  const k = `@s1 fact
  holds salary ann dev 100
@s2 fact
  holds salary bob dev 100
@s3 fact
  holds salary cy ops 80
@payroll aggregate
  over salary ?p ?d ?s
  group ?d
  sum ?s as ?total
  yields dept_payroll ?d ?total
@r_half rule
  when dept_payroll ?d ?t
  when compute ?h ?t whole_divided_by 3
  when compare ?h above 60
  then big ?d ?h
`;
  const r = ask(k, q('  where dept_payroll ?d ?t\n  select ?d ?t'));
  assert.deepEqual(rowsOf(r), ['[["d","dev"],["t",200]]', '[["d","ops"],["t",80]]']);
  assert.deepEqual(rowsOf(ask(k, q('  where big ?d ?h\n  select ?d ?h'))), ['[["d","dev"],["h",66]]']);
});

test('explain returns the shortest derivation and used replays in the oracle', opts, () => {
  let k = '@edge predicate\n  args source:entity destination:entity\n';
  for (let i = 0; i < 5; i++) k += `@c${i} fact\n  holds edge n${i} n${i + 1}\n`;
  k += '@sc fact\n  holds edge n0 n3\n@r1 rule\n  when edge ?x ?y\n  then reach ?x ?y\n@r2 rule\n  when edge ?x ?m\n  when reach ?m ?y\n  then reach ?x ?y\n';
  const r = ask(k, q('  mode explain\n  where reach n0 n5'));
  assert.equal(r.explain.depth, 3); // n0 n3, then n3 to n5 (two more edges): height 3, not 5
  assert.ok(r.explain.uses.includes('edge n0 n3'));
  assert.ok(!r.explain.uses.includes('edge n0 n1'));
  const replay = jsReference.ask({theory: {knowledge: k.split('@').filter(b => !/^(c\d|sc|r\d)/.test(b) || r.used.some(u => b.startsWith(u.id + ' '))).map(b => (b ? '@' + b : b)).join('')}, query: q('  mode exists\n  where reach n0 n5')});
  assert.equal(replay.status, 'supported');
});

test('why_not: minimal missing base atoms plus blockers, by the abductive meta-interpreter', opts, () => {
  const k = `@suspended predicate
  args subject:entity
  closed true
@f1 fact
  holds badge ann b7
@f2 fact
  holds suspended ann
@r1 rule
  when badge ?u ?b
  when door_ok ?b ?d
  when absent suspended ?u
  then can_enter ?u ?d
@r2 rule
  when guard ?g
  when approves ?g ?d
  then can_enter ?u ?d
`;
  // r2 has an unsafe head (?u unbound): use a safe second route instead
  const k2 = k.replace('when guard ?g\n  when approves ?g ?d', 'when escort ?u ?g\n  when approves ?g ?d') + '@f3 fact\n  holds escort ann cy\n';
  const query = q('  mode why_not\n  where can_enter ann vault');
  const r = ask(k2, query), o = oracle(k2, query);
  assert.equal(r.status, 'unknown');
  assert.deepEqual(r.missing, [['approves cy vault']]);
  assert.deepEqual(r.missing, o.missing);
  assert.deepEqual(r.blockers.map(b => b.atom), ['suspended ann']);
  assert.deepEqual(r.blockers.map(b => b.atom), o.blockers.map(b => b.atom));
  assert.equal(r.blockers[0].why, 'absent_fails');
});

test('abduction returns ALL inclusion-minimal explanations', opts, () => {
  const k = `@r1 rule
  when rained ?x
  then wet ?x
@r2 rule
  when sprinkler_on ?x
  then wet ?x
@r3 rule
  when wet ?x
  when cold ?x
  then ice ?x
@h1 hypothesis
  holds rained grass
@h2 hypothesis
  holds sprinkler_on grass
@h3 hypothesis
  holds cold grass
`;
  const r = ask(k, q('  mode abduce\n  where ice grass'));
  assert.equal(r.status, 'hypotheses');
  assert.deepEqual(r.hypotheses.map(h => [...h].sort().join('+')).sort(), ['cold grass+rained grass', 'cold grass+sprinkler_on grass']);
  assert.equal(r.complete, true);
  assert.deepEqual(r.hypotheses.map(h => h.join('+')).sort(), oracle(k, q('  mode abduce\n  where ice grass')).hypotheses.map(h => h.join('+')).sort());
});

test('budgets: a wall limit, a probe limit and a round ceiling are budget_exhausted, never unknown', opts, () => {
  const query = q('  where reach n0 ?t\n  select ?t');
  const wall = ask(CHAIN(2500), q('  mode count\n  where reach ?x ?y\n  select ?x ?y'), {timeoutMs: 400});
  assert.equal(wall.status, 'budget_exhausted');
  assert.equal(wall.reason, 'wall');
  assert.equal(wall.complete, false);
  const probes = ask(CHAIN(30), query, {maxJoins: 40});
  assert.equal(probes.status, 'budget_exhausted');
  assert.equal(probes.reason, 'probes');
  const rounds = ask(CHAIN(12), '@p policy\n  maxRounds 3\n\n@q query\n  where reach n0 ?t\n  select ?t\n  policy $p\n');
  assert.equal(rounds.status, 'supported');
  assert.equal(rounds.complete, false);
  assert.equal(rounds.reason, 'rounds');
  assert.deepEqual(rowsOf(rounds), ['[["t","n1"]]', '[["t","n2"]]', '[["t","n3"]]']);
  const none = ask(CHAIN(12), '@p policy\n  maxRounds 3\n\n@q query\n  mode exists\n  where reach n0 n12\n  policy $p\n');
  assert.equal(none.status, 'budget_exhausted');
});

test('a circuit the strategy does not cover is not_expressible, never weakened', opts, () => {
  assert.throws(() => ask('@a action\n  params ?x\n  requires p ?x\n  adds q ?x\n', q('  mode plan\n  where q a')), NotExpressibleError);
  assert.throws(() => ask('@c constraint\n  var ?x int 0 5\n  claim ?x at_most 5\n', '@c2 constraint\n  var ?x int 0 5\n  claim ?x at_most 5\n  task prove\n'), NotExpressibleError);
  assert.throws(() => ask('@f1 fact\n  holds p a\n', q('  mode conform\n  trace $t')), NotExpressibleError);
});

// ---------------------------------------------------------------------------------------------- differential fuzz

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const ENT = ['e0', 'e1', 'e2', 'e3', 'e4'];

function randomProgram(seed) {
  const r = rng(seed), pick = xs => xs[Math.floor(r() * xs.length)], chance = p => r() < p;
  let k = '@blk predicate\n  args subject:entity\n  closed true\n@node predicate\n  args subject:entity\n  closed true\n@cnt predicate\n  args subject:entity object:integer\n';
  let n = 0;
  const fact = (s) => { k += `@f${n++} fact\n  holds ${s}\n`; };
  for (const e of ENT) fact(`node ${e}`);
  for (let i = 0; i < 4 + Math.floor(r() * 5); i++) fact(`b ${pick(ENT)} ${pick(ENT)}`);
  for (let i = 0; i < 3 + Math.floor(r() * 3); i++) fact(`c ${pick(ENT)} ${pick(ENT)}`);
  for (const e of ENT) if (chance(0.7)) fact(`v ${e} ${1 + Math.floor(r() * 6)}`);
  for (let i = 0; i < Math.floor(r() * 3); i++) fact(`blk ${pick(ENT)}`);
  if (chance(0.4)) fact(`not b ${pick(ENT)} ${pick(ENT)}`);
  let rn = 0;
  const rule = (when, then) => { k += `@r${rn++} rule\n${when.map(w => `  when ${w}\n`).join('')}  then ${then}\n`; };
  rule(['b ?x ?y'], 'r1 ?x ?y');
  if (chance(0.5)) rule(['b ?x ?m', 'r1 ?m ?y'], 'r1 ?x ?y'); else rule(['r1 ?x ?m', 'b ?m ?y'], 'r1 ?x ?y');
  if (chance(0.7)) rule(['r1 ?x ?m', 'c ?m ?y'], 'r2 ?x ?y');
  if (chance(0.5)) { rule(['b ?x ?y'], 'm1 ?x ?y'); rule(['m2 ?x ?m', 'b ?m ?y'], 'm1 ?x ?y'); rule(['m1 ?x ?m', 'c ?m ?y'], 'm2 ?x ?y'); }
  rule(['node ?x', 'absent blk ?x'], 'free ?x');
  if (chance(0.7)) rule(['r1 ?x ?y', 'absent blk ?y'], 'safe ?x ?y');
  if (chance(0.5)) rule(['v ?x ?a', 'compute ?w ?a plus 2', 'compare ?w above 4'], 'hi ?x ?w');
  if (chance(0.4)) rule(['not b ?x ?y'], 'nb ?x ?y');
  if (chance(0.4)) { k += '@ag aggregate\n  over b ?x ?y\n  group ?x\n  count as ?n\n  yields cnt ?x ?n\n'; rule(['cnt ?x ?n', 'compare ?n at_least 2'], 'multi ?x'); }
  if (chance(0.3)) k += '@d1 default\n  when node ?x\n  then ok ?x\n  except blk ?x\n';
  const preds = ['r1 ?x ?y', 'free ?x', 'node ?x', 'b ?x ?y'];
  if (/ r2 /.test(k) || k.includes('then r2')) preds.push('r2 ?x ?y');
  if (k.includes('then m1')) preds.push('m1 ?x ?y');
  if (k.includes('then safe')) preds.push('safe ?x ?y');
  if (k.includes('then hi')) preds.push('hi ?x ?w');
  if (k.includes('then nb')) preds.push('nb ?x ?y');
  if (k.includes('yields cnt')) preds.push('multi ?x', 'cnt ?x ?n');
  if (k.includes('then ok')) preds.push('ok ?x');
  const atom = pick(preds);
  const vars = [...new Set(atom.match(/\?\w+/g))];
  const bound = atom.replace(/\?x/, chance(0.5) ? pick(ENT) : '?x');
  const free = [...new Set(bound.match(/\?\w+/g) ?? [])];
  const mode = pick(['select', 'select', 'count', 'exists', 'explain', 'every', 'select']);
  let query;
  if (mode === 'select' || mode === 'count') query = free.length ? q(`  ${mode === 'count' ? 'mode count\n  ' : ''}where ${bound}\n  select ${free.join(' ')}`) : q(`  mode exists\n  where ${bound}`);
  else if (mode === 'every') query = q(`  mode every\n  where node ?x\n  scope free ?x`);
  else query = q(`  mode ${mode}\n  where ${free.length ? atom.replace(/\?(\w+)/g, (m, v) => pick(ENT)) : bound}`);
  return {k, query};
}

const normalise = p => ({
  status: p.status, complete: p.complete, rows: rowsOf(p), count: p.count, bound: p.bound, reason: p.reason,
  explain: p.explain ? {depth: p.explain.depth, uses: [...p.explain.uses].sort()} : undefined
});

test('differential fuzz: random programs (80 by default, PROLOG_FUZZ_N) agree with the oracle on status, rows, counts and explanations', opts, () => {
  let compared = 0;
  const failures = [], tally = {};
  for (let seed = 1; seed <= FUZZ_N; seed++) {
    if (process.env.PROLOG_FUZZ_ONLY && Number(process.env.PROLOG_FUZZ_ONLY) !== seed) continue;
    const {k, query} = randomProgram(seed * 7919);
    let o;
    try { o = oracle(k, query); } catch (e) { continue; } // an invalid random circuit is skipped (both would refuse it)
    const p = ask(k, query);
    compared++;
    if (process.env.PROLOG_FUZZ_VERBOSE) tally[`${query.match(/mode (\w+)/)?.[1] ?? 'select'}:${o.status}${o.rows?.length ? '+rows' : ''}`] = (tally[`${query.match(/mode (\w+)/)?.[1] ?? 'select'}:${o.status}${o.rows?.length ? '+rows' : ''}`] ?? 0) + 1;
    const a = JSON.stringify(normalise(o)), b = JSON.stringify(normalise(p));
    if (a !== b) failures.push({seed, query, oracle: a, prolog: b});
    // used: replay in the oracle re-derives the answer
    if (p.used?.length && !p.used_incomplete && ['supported', 'refuted', 'both'].includes(p.status) && !['count', 'every'].includes(query.match(/mode (\w+)/)?.[1])) {
      const ids = new Set(p.used.map(u => u.id));
      const blocks = k.split(/(?=^@)/m).filter(b => !/^@\w+ (fact|rule|default|aggregate)/.test(b) || ids.has(/^@(\w+)/.exec(b)[1]));
      const replay = oracle(blocks.join(''), query);
      if (replay.status !== p.status || JSON.stringify(rowsOf(replay)) !== JSON.stringify(rowsOf(p))) failures.push({seed, why: 'used does not replay', used: [...ids], replay: replay.status});
    }
  }
  if (process.env.PROLOG_FUZZ_VERBOSE) console.log(JSON.stringify(tally));
  assert.ok(compared >= FUZZ_N * 0.85, `only ${compared} programs compared`);
  assert.deepEqual(failures, []);
});

// ------------------------------------------------------------------------------------------------ the smoke cases and VRC's programs

test('shadow gate: every smoke case the strategy declares agrees with the oracle (status, rows, counts, explanations) and with expected.json', opts, () => {
  const bad = [];
  let compared = 0;
  for (const c of loadCases()) {
    if (c.memory) continue;
    let p;
    try { p = ask(c.knowledge, c.query); } catch (e) { if (e instanceof NotExpressibleError) continue; throw e; }
    let o;
    try { o = oracle(c.knowledge, c.query); } catch (e) { o = null; }
    compared++;
    // a probe cut returns no partial rows here (the oracle returns a prefix); both are honest budget answers
    if (o && !/budget-probe/.test(c.dir) && JSON.stringify(normalise(o)) !== JSON.stringify(normalise(p))) bad.push(`${c.dir}: oracle ${JSON.stringify(normalise(o))} prolog ${JSON.stringify(normalise(p))}`);
    const cmp = compare(c.expected, {...p, rows: p.rows, used: p.used});
    if (!cmp.ok && !c.expected.used_support) bad.push(`${c.dir}: ${cmp.why.join('; ')}`);
  }
  assert.ok(compared >= 50, `only ${compared} cases compared`);
  assert.deepEqual(bad, []);
});

const VRC = path.resolve(import.meta.dirname, '../../datasets_sources/experiments_unpacked/vrc03r/vrc03/exports');
test('the nine VRC exports (SWI-Prolog tabled programs) give the same row counts when read back as circuits', {skip: swi.ok && fs.existsSync(VRC) ? false : 'private swipl or the unpacked VRC zip not available', timeout: 240000}, () => {
  const mismatches = [];
  for (const f of fs.readdirSync(VRC).filter(x => x.endsWith('.pl'))) {
    const c = circuitsOfPl(fs.readFileSync(path.join(VRC, f), 'utf8'));
    const ref = spawnSync(swiplCommand(), ['-q', '-f', 'none', path.join(VRC, f)], {encoding: 'utf8', timeout: 120000, maxBuffer: 1e9});
    const expected = JSON.parse(ref.stdout).rows.length;
    const r = ask(c.knowledge, c.query);
    if (r.status !== 'supported' || r.rows.length !== expected) mismatches.push(`${f}: file ${expected}, strategy ${r.status} ${r.rows?.length}`);
  }
  assert.deepEqual(mismatches, []);
});
