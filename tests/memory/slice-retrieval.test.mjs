/**
 * Slice retrieval and the completeness guard of the product path from memory to the reasoner (reasoning/slice/, DS005, DS006
 * "Completeness under partial retrieval", proposal section 11, R-P1 to R-P5), on fixture memories held in real repositories.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Repository} from '../../memory/repository.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {publishKnowledge} from '../../sop/ingest.mjs';
import {StrategyRegistry} from '../../memory/strategies.mjs';
import {Demand, alternatives, SliceRetrieval, ArraySource, judge, answerOverSlice} from '../../reasoning/slice/index.mjs';

const KNOWN = Date.parse('2024-01-01');
const NOW = Date.parse('2026-09-26T12:00:00Z');

const fact = (p, ...terms) => `@f_${p}_${terms.join('_')} fact\n  holds ${p} ${terms.join(' ')}\n  valid timeless\n  source test\n`;
const negFact = (p, ...terms) => `@n_${p}_${terms.join('_')} fact\n  holds not ${p} ${terms.join(' ')}\n  valid timeless\n  source test\n`;
const rule = (id, head, ...body) => `@${id} rule\n${body.map(b => `  when ${b}\n`).join('')}  then ${head}\n`;

/** A repository (default engine SQLite) holding the given SOP, a session on it, and a runtime factory. Removed with `dispose`. */
function memory(sop, {engine = 'sqlite', policy = {}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-test-'));
  const repo = new Repository(root, {memory: {engine}});
  // a circuit is published in pieces, as a base memory is built circuit by circuit
  const wires = sop.split(/\n(?=@)/);
  for (let i = 0; i < wires.length; i += 1000) publishKnowledge(repo, 'base', wires.slice(i, i + 1000).join('\n') + '\n', {reviewed: true, knownAt: KNOWN});
  const session = repo.session('base', 'alice', 's1');
  const calls = [];
  const registry = new StrategyRegistry();
  const retrieve = registry.retrieve.bind(registry);
  registry.retrieve = (name, request) => { calls.push(request.pattern); return retrieve(name, request); };
  return {
    repo, session, calls,
    run: (program, options = {}) => new Runtime({repo, session, now: NOW, policy, strategies: registry, ...options}).run(program),
    dispose: () => fs.rmSync(root, {recursive: true, force: true}),
  };
}

const ask = (where, {select = '?x', mode = null, extra = ''} = {}) =>
  `@q query\n${mode ? `  mode ${mode}\n` : ''}${select ? `  select ${select}\n` : ''}  where ${where}\n${extra}  at 2026-09-26\n@m recall\n  query $q\n@r reason\n  query $q\n  memory $m\n`;

const distractors = (predicate, n, prefix = 'd') => Array.from({length: n}, (_, i) => fact(predicate, `${prefix}${i}`, `${prefix}${(i * 7 + 1) % n}`)).join('');
const names = r => r.values.r.answers.map(a => a.binding['?x']).sort();

// ---------------------------------------------------------------------------------------------------- the cases of the proposal

test('R-P1 look-alike facts: a join is answered from a slice of a few facts out of thousands, and the slice is complete', async () => {
  const m = memory(
    rule('anc1', 'ancestor ?x ?y', 'parent ?x ?y') + rule('anc2', 'ancestor ?x ?z', 'parent ?x ?y', 'ancestor ?y ?z') +
    fact('parent', 'bob', 'carina') + fact('parent', 'dora', 'bob') + fact('parent', 'eve', 'dora') + distractors('parent', 3000));
  try {
    const r = await m.run(ask('ancestor ?x carina'));
    assert.deepEqual(names(r), ['bob', 'dora', 'eve']);
    const packet = r.values.r;
    assert.equal(packet.status, 'supported');
    assert.equal(packet.complete, true);
    assert.equal(packet.retrieval.complete, true);
    assert.ok(packet.retrieval.facts < 30, `the slice holds ${packet.retrieval.facts} facts of 3003`);
    assert.ok(packet.retrieval.probes < 60);
    assert.equal(packet.retrieval.keyed, true);
    assert.deepEqual(packet.retrieval.scans, []);
    // no lookup was an all-variable pattern: nothing scanned the 3003 parents
    assert.ok(m.calls.every(p => p.a.some(t => !String(t).startsWith('?'))), 'every lookup carries a key');
  } finally { m.dispose(); }
});

test('a recursive rule asked from its first argument walks the chain with keyed lookups only', async () => {
  const m = memory(
    rule('anc1', 'ancestor ?x ?y', 'parent ?x ?y') + rule('anc2', 'ancestor ?x ?z', 'parent ?x ?y', 'ancestor ?y ?z') +
    fact('parent', 'eve', 'dora') + fact('parent', 'dora', 'bob') + fact('parent', 'bob', 'carina') + distractors('parent', 2500));
  try {
    const r = await m.run(ask('ancestor eve ?x'));
    assert.deepEqual(names(r), ['bob', 'carina', 'dora']);
    assert.equal(r.values.r.retrieval.complete, true);
    assert.deepEqual(r.values.r.retrieval.scans, []);
    assert.ok(r.values.r.retrieval.facts < 30);
  } finally { m.dispose(); }
});

test('missing premise two rule levels deep is found without widening by hand', async () => {
  const m = memory(
    rule('cousin1', 'cousin ?x ?y', 'parent ?p ?x', 'sibling ?p ?q', 'parent ?q ?y') + rule('sib', 'sibling ?a ?b', 'brother ?a ?b') +
    fact('parent', 'ana', 'mihai') + fact('brother', 'ana', 'ion') + fact('parent', 'ion', 'vlad') + distractors('parent', 1500) + distractors('brother', 500, 'z'));
  try {
    const r = await m.run(ask('cousin mihai ?x'));
    assert.deepEqual(names(r), ['vlad']);
    assert.equal(r.values.r.retrieval.complete, true);
  } finally { m.dispose(); }
});

test('R-P2 a count over a hub larger than the first cap widens until the slice is complete, then counts exactly', async () => {
  const members = Array.from({length: 600}, (_, i) => fact('member', `m${i}`, 'club')).join('');
  const m = memory(members + distractors('member', 800, 'o'));
  try {
    const r = await m.run(ask('member ?x club', {mode: 'count'}));
    const packet = r.values.r;
    assert.equal(packet.status, 'supported');
    assert.equal(packet.count, 600);
    assert.equal(packet.retrieval.complete, true);
    assert.ok(packet.retrieval.steps > 1, 'the first cap truncated the hub, so the retrieval widened');
    assert.ok(packet.retrieval.trail[0].complete === false);
  } finally { m.dispose(); }
});

test('R-P2 a count that cannot be completed within the fact budget is incomplete with its lower bound, never a wrong count', async () => {
  const members = Array.from({length: 600}, (_, i) => fact('member', `m${i}`, 'club')).join('');
  const m = memory(members, {policy: {maxFacts: 100}});
  try {
    const r = await m.run(ask('member ?x club', {mode: 'count'}));
    const packet = r.values.r;
    assert.equal(packet.status, 'incomplete');
    assert.equal(packet.reason, 'partial_retrieval');
    assert.equal(packet.complete, false);
    assert.equal(packet.count, undefined);
    assert.ok(packet.at_least > 0 && packet.at_least <= 100);
    assert.equal(packet.retrieval.complete, false);
    assert.ok(packet.retrieval.reasons.some(x => x.startsWith('truncated:member') || x === 'fact_budget'));
    assert.match(r.values.r.retrieval.reasons.join(' '), /member/);
  } finally { m.dispose(); }
});

test('R-P2 a universal question that no counterexample decided is withheld over a truncated slice', async () => {
  const members = Array.from({length: 400}, (_, i) => fact('member', `m${i}`, 'club') + fact('adult', `m${i}`)).join('');
  const m = memory(members, {policy: {maxFacts: 150}});
  try {
    const r = await m.run(ask('member ?x club', {mode: 'every', select: '', extra: '  scope adult ?x\n'}));
    const packet = r.values.r;
    assert.equal(packet.status, 'incomplete');
    assert.equal(packet.reason, 'partial_retrieval');
    assert.equal(packet.retrieval.complete, false);
  } finally { m.dispose(); }
});

test('R-P1 a counterexample found over a truncated slice stays valid (evidence is monotone)', async () => {
  const members = Array.from({length: 400}, (_, i) => fact('member', `m${i}`, 'club') + (i === 0 ? negFact('adult', 'm0') : fact('adult', `m${i}`))).join('');
  const m = memory(members, {policy: {maxFacts: 600}});
  try {
    const r = await m.run(ask('member ?x club', {mode: 'every', select: '', extra: '  scope adult ?x\n'}));
    const packet = r.values.r;
    assert.equal(packet.status, 'refuted');
    assert.ok(packet.counterexamples.some(b => b['?x'] === 'm0'));
  } finally { m.dispose(); }
});

test('R-P2 negation by failure is not invented: an unknown over a truncated slice is reported incomplete, not no', async () => {
  const members = Array.from({length: 500}, (_, i) => fact('member', `m${i}`, 'club')).join('');
  const m = memory(members, {policy: {maxFacts: 100}});
  try {
    // m499 is stored, but the capped slice of the hub cannot reach it by the club key; it is reached by its own key, so ask something the slice cannot know
    const r = await m.run(ask('member ?x club', {extra: ''}));
    const packet = r.values.r;
    assert.equal(packet.complete, false);
    assert.equal(packet.retrieval.complete, false);
    assert.ok(packet.answers.length <= 100, 'a partial select is flagged, never presented as the whole answer');
  } finally { m.dispose(); }
});

test('case 22: a closed-world count over a hub with a few hidden negatives sees them through keyed retrieval', async () => {
  const nodes = Array.from({length: 300}, (_, i) => (i === 7 ? '' : fact('node', `n${i}`))).join('');
  const m = memory(nodes + negFact('node', 'n7'));
  try {
    const r = await m.run(ask('node n7', {select: '', mode: 'exists'}));
    assert.equal(r.values.r.status, 'refuted', 'the explicit negative fact is found by its key');
  } finally { m.dispose(); }
});

// ---------------------------------------------------------------------------------------------------- R-P3, R-P4, R-P5, rule 7

test('R-P3 an associative memory answers a select as before but never settles a count', async () => {
  const sop = fact('parent', 'bob', 'carina') + fact('parent', 'dora', 'carina');
  const m = memory(sop, {engine: 'recall-memory'});
  try {
    const select = await m.run(ask('parent ?x carina'));
    assert.deepEqual(names(select), ['bob', 'dora']);
    assert.equal(select.values.r.retrieval.exact, false);
    const count = await m.run(ask('parent ?x carina', {mode: 'count'}));
    assert.equal(count.values.r.status, 'incomplete');
    assert.deepEqual(count.values.r.retrieval_reasons, ['inexact_view']);
  } finally { m.dispose(); }
});

test('R-P4 closedness is declared: under closedWorld declared a count over an undeclared predicate is a lower bound', async () => {
  const sop = fact('parent', 'bob', 'carina') + fact('parent', 'dora', 'carina');
  const open = memory(sop, {policy: {closedWorld: 'declared'}});
  const closed = memory(sop, {policy: {closedWorld: 'declared'}});
  try {
    const a = await open.run(ask('parent ?x carina', {mode: 'count'}));
    assert.equal(a.values.r.count, 2);
    assert.equal(a.values.r.bound, 'at_least');
    const b = await closed.run(ask('parent ?x carina', {mode: 'count'}), {closed: p => p === 'parent'});
    assert.equal(b.values.r.count, 2);
    assert.equal(b.values.r.bound, undefined);
    const every = await open.run(ask('parent ?x carina', {mode: 'every', select: '', extra: '  scope parent ?x carina\n'}));
    assert.equal(every.values.r.status, 'unknown');
    assert.equal(every.values.r.reason, 'open_domain');
  } finally { open.dispose(); closed.dispose(); }
});

test('R-P5 every reasoned answer carries the retrieval report with the slice size, predicates, bounds and reasons', async () => {
  const m = memory(rule('gp', 'grandparent ?x ?z', 'parent ?x ?y', 'parent ?y ?z') + fact('parent', 'a', 'b') + fact('parent', 'b', 'c'));
  try {
    const r = await m.run(ask('grandparent ?x c'));
    const report = r.values.r.retrieval;
    for (const key of ['complete', 'truncated', 'keyed', 'steps', 'wires', 'probes', 'facts', 'rules', 'predicates', 'bound', 'exact', 'reasons', 'guard', 'trail']) assert.ok(key in report, key);
    assert.deepEqual(report.predicates.sort(), ['grandparent/2', 'parent/2']);
    assert.equal(report.rules, 1);
    assert.deepEqual(Object.keys(report.bound).sort(), ['cap', 'facts', 'lookups', 'ms', 'probes']);
    assert.deepEqual(report.reasons, []);
  } finally { m.dispose(); }
});

test('rule 7: retrieval never writes: the session revision and the stored strengths are unchanged by a recall', async () => {
  const m = memory(fact('parent', 'bob', 'carina'));
  try {
    const before = JSON.stringify(m.repo.visible(m.session).map(x => x.layer.export?.().config));
    const revision = m.session.revision;
    await m.run(`@q query\n  select ?x\n  where parent ?x carina\n  at 2026-09-26\n@m recall\n  query $q\n`);
    assert.equal(m.session.revision, revision);
    assert.equal(JSON.stringify(m.repo.visible(m.session).map(x => x.layer.export?.().config)), before);
  } finally { m.dispose(); }
});

test('an explicit unknown retrieval strategy fails closed', async () => {
  const m = memory(fact('parent', 'bob', 'carina'));
  try {
    await assert.rejects(m.run(ask('parent ?x carina').replace('@m recall\n', '@m recall\n  strategy magic\n')), /Unknown retrieval strategy/);
  } finally { m.dispose(); }
});

// ---------------------------------------------------------------------------------------------------- the demand plan

const atom = (p, ...a) => ({p, a, neg: false});

test('demand: an atom with a constant is keyed, an atom with only variables is scanned', () => {
  const d = new Demand({conjunctions: [[atom('parent', '?x', 'carina')]]});
  assert.equal(d.atoms[0].key, 1);
  assert.deepEqual(d.scans(), []);
  const free = new Demand({conjunctions: [[atom('parent', '?x', '?y')]]});
  assert.deepEqual(free.scans().map(s => s.p), ['parent']);
});

test('demand: a join variable keys the later atom by the values the earlier atom returns', () => {
  const d = new Demand({conjunctions: [[atom('parent', '?x', 'carina'), atom('mother', '?w', '?x')]]});
  const [parent, mother] = d.atoms;
  assert.equal(parent.key, 1);
  assert.equal(mother.key, 1, 'mother is keyed by its second position, the variable of parent');
  d.feed({atom: atom('parent', 'bob', 'carina')});
  assert.deepEqual(d.obligations().map(o => `${o.p}#${o.i}=${o.value}`).sort(), ['mother#1=bob', 'parent#1=carina']);
});

test('demand: a rule whose head is called with no bound position is scanned through its body (the stored head facts do not bound it)', () => {
  const d = new Demand({conjunctions: [[atom('parent', '?p', '?c')]], rules: [{id: 'mp', if: [atom('mother', '?x', '?y')], then: atom('parent', '?x', '?y')}]});
  assert.deepEqual(d.scans().map(s => s.p).sort(), ['mother', 'parent']);
});

test('demand: a recursive rule is seeded by the constant of the question and by the variables its own body binds', () => {
  const rules = [
    {id: 'a1', if: [atom('parent', '?x', '?y')], then: atom('ancestor', '?x', '?y')},
    {id: 'a2', if: [atom('parent', '?x', '?y'), atom('ancestor', '?y', '?z')], then: atom('ancestor', '?x', '?z')},
  ];
  const d = new Demand({conjunctions: [[atom('ancestor', 'a', '?w')]], rules});
  assert.deepEqual(d.scans(), [], 'nothing needs a scan: every atom is reached from the constant a');
  assert.ok(d.atoms.every(a => a.key !== null));
});

test('demand: any groups are alternatives, each its own conjunction', () => {
  const leaf = a => a;
  const alts = alternatives([{kind: 'any', children: [leaf(atom('p', '?x', 'a')), {kind: 'all', children: [leaf(atom('q', '?x')), leaf(atom('r', '?x', 'b'))]}]}]);
  assert.equal(alts.length, 2);
  assert.deepEqual(alts.map(c => c.length).sort(), [1, 2]);
  assert.equal(alternatives([{kind: 'any', children: Array.from({length: 40}, (_, i) => atom('p', '?x', 'c' + i))}]), null);
});

// ---------------------------------------------------------------------------------------------------- the retrieval and the guard

const typed = (p, id, ...a) => ({id, atom: {p, a, neg: false}, valid: {from: -Infinity, until: Infinity}, kind: 'observed'});

test('retrieval: widening raises the cap of a truncated lookup and then reaches the fixpoint', () => {
  const facts = Array.from({length: 1000}, (_, i) => typed('member', 'f' + i, 'm' + i, 'club'));
  const source = new ArraySource(facts);
  const r = new SliceRetrieval({source, conjunctions: [[atom('member', '?x', 'club')]], limits: {maxFacts: 5000}});
  r.expand();
  assert.equal(r.complete(), false);
  assert.ok(r.why().some(x => x.startsWith('truncated:member')));
  let steps = 0;
  while (!r.complete() && r.widen()) steps++;
  assert.equal(r.complete(), true);
  assert.equal(r.facts.size, 1000);
  assert.ok(steps >= 1);
});

test('retrieval: a fact budget is a hard bound, never raised', () => {
  const facts = Array.from({length: 1000}, (_, i) => typed('member', 'f' + i, 'm' + i, 'club'));
  const r = new SliceRetrieval({source: new ArraySource(facts), conjunctions: [[atom('member', '?x', 'club')]], limits: {maxFacts: 300}});
  r.expand();
  while (r.widen());
  assert.equal(r.complete(), false);
  assert.equal(r.facts.size, 300);
  assert.ok(r.why().includes('truncated:member[1="club"]') || r.why().some(x => x.startsWith('truncated:member')));
});

test('recursive demand over 10k facts reaches a complete count; an explicit smaller fact cap never becomes a closed-world count', () => {
  const size = 11001;
  const facts = Array.from({length: size}, (_, i) => typed('parent', 'edge' + i, 'n' + i, 'root'));
  const rules = [
    {id: 'base', if: [atom('parent', '?x', '?y')], then: atom('ancestor', '?x', '?y')},
    {id: 'step', if: [atom('parent', '?x', '?y'), atom('ancestor', '?y', '?z')], then: atom('ancestor', '?x', '?z')},
  ];
  const conjunctions = [[atom('ancestor', '?x', 'root')]];
  const solve = memory => {
    const edges = new Map();
    for (const f of memory.facts) {
      const [child, parent] = f.atom.a;
      if (!edges.has(parent)) edges.set(parent, []);
      edges.get(parent).push(child);
    }
    const reached = new Set(), queue = ['root'];
    for (let at = 0; at < queue.length; at++) for (const child of edges.get(queue[at]) ?? []) {
      if (!reached.has(child)) { reached.add(child); queue.push(child); }
    }
    return {status: 'supported', count: reached.size, complete: true};
  };
  const answer = limits => {
    const retrieval = new SliceRetrieval({source: new ArraySource(facts), conjunctions, rules, limits});
    retrieval.expand();
    const widen = () => retrieval.widen() ? Object.defineProperty(retrieval.result(), 'widen', {value: widen}) : null;
    return answerOverSlice({memory: Object.defineProperty(retrieval.result(), 'widen', {value: widen}), query: {mode: 'count', where: conjunctions[0], scope: []}, solve});
  };
  const full = answer({});
  assert.equal(full.count, size);
  assert.equal(full.status, 'supported');
  assert.equal(full.retrieval.complete, true);
  assert.equal(full.retrieval.class, 'recursive');
  assert.equal(full.retrieval.bound.facts, 100000);
  assert.ok(full.retrieval.lookups < 3000, 'a complete scan discharges the many downstream recursive keys');

  const clipped = answer({maxFacts: 12000, maxLookups: 3000});
  assert.equal(clipped.count, size, 'the final clipped scan cap remains reachable');
  assert.equal(clipped.retrieval.complete, true);

  const oneLookup = answer({maxLookups: 1});
  assert.equal(oneLookup.status, 'incomplete');
  assert.equal(oneLookup.count, undefined);
  assert.equal(oneLookup.retrieval.lookups, 1, 'both polarities together must not exceed the hard lookup bound');

  const capped = answer({maxFacts: 500});
  assert.equal(capped.status, 'incomplete');
  assert.equal(capped.reason, 'partial_retrieval');
  assert.equal(capped.count, undefined);
  assert.ok(capped.at_least > 0 && capped.at_least <= 500);
  assert.equal(capped.retrieval.complete, false);
  assert.equal(capped.retrieval.class, 'recursive');
  assert.equal(capped.retrieval.bound.facts, 500);
});

test('retrieval: a join over many values reads the small relation once instead of looking it up value by value', () => {
  const members = Array.from({length: 120}, (_, i) => typed('member', 'm' + i, 'm' + i, 'club'));
  const lives = Array.from({length: 120}, (_, i) => typed('lives_in', 'l' + i, 'm' + i, 'city' + (i % 7)));
  const source = new ArraySource([...members, ...lives]);
  const r = new SliceRetrieval({source, conjunctions: [[atom('member', '?x', 'club'), atom('lives_in', '?x', '?c')]]});
  r.expand();
  assert.equal(r.complete(), true);
  assert.ok(r.scans.has('lives_in/2'), 'lives_in was read whole');
  assert.ok(source.calls.length < 20, `${source.calls.length} reads instead of about 240 keyed lookups`);
  assert.equal(r.facts.size, 240);
});

test('retrieval: a join over a relation too large to read whole falls back to keyed lookups and wastes nothing', () => {
  const members = Array.from({length: 120}, (_, i) => typed('member', 'm' + i, 'm' + i, 'club'));
  const lives = Array.from({length: 5000}, (_, i) => typed('lives_in', 'l' + i, 'm' + i, 'city' + (i % 7)));
  const source = new ArraySource([...members, ...lives]);
  const r = new SliceRetrieval({source, conjunctions: [[atom('member', '?x', 'club'), atom('lives_in', '?x', '?c')]]});
  r.expand();
  while (!r.complete() && r.widen());
  assert.equal(r.complete(), true);
  assert.ok(!r.scans.has('lives_in/2'));
  assert.equal(r.facts.size, 240, 'only the 120 members and their 120 residences are in the slice');
});

test('retrieval: a wall-clock budget stops the expansion and the slice says so; it is never widened', () => {
  const members = Array.from({length: 120}, (_, i) => typed('member', 'm' + i, 'm' + i, 'club'));
  const lives = Array.from({length: 5000}, (_, i) => typed('lives_in', 'l' + i, 'm' + i, 'city' + (i % 7)));
  const source = new ArraySource([...members, ...lives]);
  const slow = {lookup(pattern, o) { const until = performance.now() + 2; while (performance.now() < until); return source.lookup(pattern, o); }};
  const r = new SliceRetrieval({source: slow, conjunctions: [[atom('member', '?x', 'club'), atom('lives_in', '?x', '?c')]], limits: {retrievalMs: 5}});
  r.expand();
  assert.equal(r.complete(), false);
  assert.ok(r.why().includes('time_budget'));
  assert.equal(r.widen(), false);
});

test('retrieval: a predicate the schema does not know is not looked up and makes the slice incomplete', () => {
  const source = new ArraySource([]);
  const r = new SliceRetrieval({source, conjunctions: [[atom('flies', '?x')]], schema: {parent: {}}});
  r.expand();
  assert.equal(source.calls.length, 0);
  assert.ok(r.why().includes('unknown_predicate:flies'));
});

test('retrieval: an inexact source gives a complete but unsettled slice (R-P3)', () => {
  const r = new SliceRetrieval({source: new ArraySource([typed('p', 'f1', 'a', 'b')], {exact: false}), conjunctions: [[atom('p', 'a', '?y')]]});
  r.expand();
  assert.equal(r.complete(), true);
  assert.equal(r.exact(), false);
  assert.equal(r.settled(), false);
});

const slice = (over = {}) => ({complete: false, settled: false, exact: true, reasons: ['truncated:member'], ...over});
const q = (mode, extra = {}) => ({mode, where: [atom('member', '?x', 'club')], scope: [], ...extra});

test('guard: a supported exists over a partial slice is accepted and flagged incomplete (R-P1)', () => {
  const v = judge({query: q('exists'), output: {status: 'supported', complete: true}, slice: slice()});
  assert.equal(v.accept, true);
  assert.equal(v.output.complete, false);
});

test('guard: a select over a partial slice asks for widening, then returns the partial rows flagged', () => {
  const v = judge({query: q('select'), output: {status: 'supported', answers: [1], complete: false}, slice: slice()});
  assert.equal(v.accept, false);
  assert.equal(v.output.complete, false);
  assert.equal(v.output.reason, 'partial_retrieval');
  assert.equal(v.output.status, 'supported');
});

test('guard: unknown, count, ranked select and a non-decided every are never accepted over a partial slice', () => {
  assert.equal(judge({query: q('exists'), output: {status: 'unknown'}, slice: slice()}).accept, false);
  assert.equal(judge({query: q('count'), output: {status: 'supported', count: 3}, slice: slice()}).accept, false);
  assert.equal(judge({query: q('select', {rank: {direction: 'highest', variable: '?x'}}), output: {status: 'supported'}, slice: slice()}).accept, false);
  assert.equal(judge({query: q('every'), output: {status: 'supported'}, slice: slice()}).accept, false);
  assert.equal(judge({query: q('every', {quantifier: {word: 'most'}}), output: {status: 'refuted'}, slice: slice()}).accept, false);
  assert.equal(judge({query: q('every', {quantifier: {word: 'not_all'}}), output: {status: 'supported'}, slice: slice()}).accept, true);
  assert.equal(judge({query: q('every'), output: {status: 'refuted'}, slice: slice()}).accept, true);
});

test('guard: a withheld count keeps its lower bound and loses its count', () => {
  const v = judge({query: q('count'), output: {status: 'supported', count: 3, proof: [{id: 'c_1'}]}, slice: slice()});
  assert.equal(v.output.status, 'incomplete');
  assert.equal(v.output.at_least, 3);
  assert.equal('count' in v.output, false);
  assert.deepEqual(v.output.proof, [], 'a withheld answer proves nothing, so nothing is reinforced on its account');
});
test('guard: absence cannot support a definite answer or even a count lower bound on an unsettled slice', () => {
  const where = [{p: 'member', a: ['missing', 'club'], neg: 'absent'}];
  const existence = judge({query: q('exists', {where}), output: {status: 'supported', complete: true, proof: [{id: 'absence'}]}, slice: slice()});
  assert.equal(existence.accept, false);
  assert.equal(existence.output.status, 'incomplete');
  assert.deepEqual(existence.output.proof, []);
  const count = judge({query: q('count', {where}), output: {status: 'supported', count: 3, complete: true}, slice: slice({complete: true, settled: false, exact: false})});
  assert.equal(count.accept, false);
  assert.equal(count.output.status, 'incomplete');
  assert.equal(count.output.count, undefined);
  assert.equal(count.output.at_least, undefined, 'future positive evidence may shrink an absence count');
});

test('guard: a settled slice accepts everything as the reasoner answered it', () => {
  const output = {status: 'supported', count: 3, complete: true};
  const v = judge({query: q('count'), output, slice: slice({complete: true, settled: true, reasons: []})});
  assert.equal(v.accept, true);
  assert.equal(v.output, output);
});

test('answerOverSlice widens until the answer is accepted and reports every step', () => {
  const memories = [1, 2, 3].map(n => ({slice: {complete: n === 3, settled: n === 3, exact: true, reasons: n === 3 ? [] : ['truncated:p'], facts: n * 10, rules: 0, lookups: n, probes: n, predicates: ['p/1'], bound: {}, scans: [], keyed: true, truncated: n < 3}}));
  memories.forEach((m, i) => Object.defineProperty(m, 'widen', {enumerable: false, value: () => memories[i + 1] ?? null}));
  const solved = [];
  const out = answerOverSlice({memory: memories[0], query: q('count'), solve: m => { solved.push(m); return {status: 'supported', count: solved.length}; }});
  assert.equal(solved.length, 3);
  assert.equal(out.count, 3);
  assert.equal(out.retrieval.steps, 3);
  assert.deepEqual(out.retrieval.trail.map(t => t.accepted), [false, false, true]);
});

// ---------------------------------------------------------------------------------------------------- the knowledge-wire path

import {Theory, askMemory} from '../../reasoning/slice/index.mjs';
import {ingestFacts} from '../../lib/chat-data/memories.mjs';

const wf = (p, ...terms) => `@w_${p}_${terms.join('_')} fact\n  holds ${p} ${terms.join(' ')}\n`;
const wn = (p, ...terms) => `@wn_${p}_${terms.join('_')} fact\n  holds not ${p} ${terms.join(' ')}\n`;
const wr = (id, then, ...when) => `@${id} rule\n${when.map(x => `  when ${x}\n`).join('')}  then ${then}\n`;
const pred = (id, args, closed = false) => `@${id} predicate\n  args ${args}\n${closed ? '  closed true\n' : ''}`;

/** A base memory from circuit text: the facts go to the repository (as the base memory store does), the rest stays the theory. */
function world(circuit, {policy = {}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-wire-'));
  const repo = new Repository(root, {memory: {engine: 'sqlite'}});
  const wires = circuit.split(/\n(?=@)/);
  for (let i = 0; i < wires.length; i += 1000) ingestFacts(repo, 'base', wires.slice(i, i + 1000).join('\n') + '\n', {knownAt: KNOWN});
  const session = repo.session('base', 'alice', 's1');
  const theory = new Theory([{name: 'circuit', text: circuit}]);
  return {repo, session, theory, ask: (query, limits = {}) => askMemory({theory, repo, session, query, limits: {...policy, ...limits}}), dispose: () => fs.rmSync(root, {recursive: true, force: true})};
}
const rowsOf = answer => answer.rows.map(r => Object.values(r)[0]).sort();

test('wire path: the oracle gets a slice of the memory, not its theory, and answers rules with joins and recursion', () => {
  const w = world(
    pred('parent', 'entity entity') + pred('ancestor', 'entity entity') +
    wr('a1', 'ancestor ?x ?y', 'parent ?x ?y') + wr('a2', 'ancestor ?x ?z', 'parent ?x ?y', 'ancestor ?y ?z') +
    wf('parent', 'eve', 'dora') + wf('parent', 'dora', 'bob') + wf('parent', 'bob', 'carina') +
    Array.from({length: 2500}, (_, i) => wf('parent', 'd' + i, 'd' + ((i * 7 + 1) % 2500))).join(''));
  try {
    const answer = w.ask('@q query\n  select ?x\n  where ancestor eve ?x\n');
    assert.equal(answer.status, 'supported');
    assert.deepEqual(rowsOf(answer), ['bob', 'carina', 'dora']);
    assert.equal(answer.retrieval.complete, true);
    assert.ok(answer.retrieval.facts < 30);
    assert.deepEqual(answer.retrieval.scans, []);
    assert.equal(answer.retrieval.rules, 2);
  } finally { w.dispose(); }
});

test('wire path case 24: a default is judged only after the strict contrary and the exceptions of each candidate are looked up', () => {
  const birds = Array.from({length: 400}, (_, i) => wf('bird', 'b' + i) + wn('flies', 'd' + i)).join('');
  const w = world(
    pred('bird', 'entity') + pred('flies', 'entity') + pred('penguin', 'entity') +
    '@d1 default\n  when bird ?x\n  except penguin ?x\n  then flies ?x\n' +
    wf('bird', 'tweety') + wf('bird', 'pingu') + wn('flies', 'pingu') + birds);
  try {
    const answer = w.ask('@q query\n  select ?x\n  where flies ?x\n');
    const rows = rowsOf(answer);
    assert.ok(rows.includes('tweety') && !rows.includes('pingu'), 'pingu is a bird with a strict contrary: the default is withheld for it');
    assert.equal(answer.retrieval.complete, true);
    assert.ok(answer.retrieval.lookups > 0);
  } finally { w.dispose(); }
});

test('wire path case 22: absent over a closed predicate sees the few hidden negatives, and a truncated slice is not mistaken for an open node', () => {
  const nodes = Array.from({length: 400}, (_, i) => wf('node', 'n' + i)).join('');
  const w = world(
    pred('node', 'entity', true) + pred('blocked', 'entity', true) + pred('open', 'entity', true) +
    wr('o1', 'open ?x', 'node ?x', 'absent blocked ?x') + nodes + wf('blocked', 'n7') + wf('blocked', 'n9'));
  try {
    const ok = w.ask('@q query\n  mode count\n  where open ?x\n');
    assert.equal(ok.status, 'supported');
    assert.equal(ok.count, 398);
    assert.equal(ok.retrieval.complete, true);
    const cut = w.ask('@q query\n  mode count\n  where open ?x\n', {maxFacts: 120});
    assert.equal(cut.status, 'incomplete');
    assert.equal(cut.reason, 'partial_retrieval');
    assert.equal(cut.retrieval.complete, false);
    assert.notEqual(cut.count, 398);
    const exists = w.ask('@q query\n  mode exists\n  where open n7\n');
    assert.equal(exists.status, 'refuted', 'n7 is blocked, and open is a closed predicate, so n7 is not open');
  } finally { w.dispose(); }
});

test('wire path R-P4: a count over an open predicate is a lower bound, over a closed one it is exact', () => {
  const open = world(pred('member', 'entity entity') + wf('member', 'a', 'club') + wf('member', 'b', 'club'));
  const closed = world(pred('member', 'entity entity', true) + wf('member', 'a', 'club') + wf('member', 'b', 'club'));
  try {
    const a = open.ask('@q query\n  mode count\n  where member ?x club\n');
    assert.equal(a.count, 2);
    assert.equal(a.bound, 'at_least');
    const b = closed.ask('@q query\n  mode count\n  where member ?x club\n');
    assert.equal(b.count, 2);
    assert.equal(b.bound, undefined);
  } finally { open.dispose(); closed.dispose(); }
});

test('wire path R-P1: an exists proved from a partial slice is accepted and flagged, a select of a partial slice is flagged, a count is withheld', () => {
  const members = Array.from({length: 600}, (_, i) => wf('member', 'm' + i, 'club')).join('');
  const w = world(pred('member', 'entity entity') + members);
  try {
    const exists = w.ask('@q query\n  mode exists\n  where member m3 club\n', {maxFacts: 100});
    assert.equal(exists.status, 'supported');
    const select = w.ask('@q query\n  select ?x\n  where member ?x club\n', {maxFacts: 100});
    assert.equal(select.complete, false);
    assert.equal(select.reason, 'partial_retrieval');
    assert.ok(select.rows.length <= 100);
    const count = w.ask('@q query\n  mode count\n  where member ?x club\n', {maxFacts: 100});
    assert.equal(count.status, 'incomplete');
    assert.ok(count.at_least > 0 && count.at_least <= 100);
    const full = w.ask('@q query\n  mode count\n  where member ?x club\n');
    assert.equal(full.count, 600);
    assert.equal(full.retrieval.complete, true);
  } finally { w.dispose(); }
});

test('wire path: retrieval writes nothing', () => {
  const w = world(pred('p', 'entity entity') + wf('p', 'a', 'b'));
  try {
    const revision = w.session.revision;
    w.ask('@q query\n  select ?x\n  where p a ?x\n');
    assert.equal(w.session.revision, revision);
  } finally { w.dispose(); }
});

test('converse recursive demands retain forward keys instead of scanning unrelated members of the same hub', () => {
  const w = world(
    pred('kind', 'entity entity') + pred('inside', 'entity entity') + pred('contains', 'entity entity') +
    wr('transitive', 'inside ?x ?z', 'inside ?x ?y', 'inside ?y ?z') +
    wr('converse', 'inside ?x ?y', 'contains ?y ?x') +
    wr('inverse', 'contains ?y ?x', 'inside ?x ?y') +
    wf('kind', 'a', 'country') + wf('contains', 'b', 'a') + wf('inside', 'b', 'europe') +
    Array.from({length: 1000}, (_, i) => wf('inside', 'd' + i, 'europe')).join(''));
  try {
    const answer = w.ask('@q query\n  select ?x\n  where all\n    kind ?x country\n    inside ?x europe\n  end\n');
    assert.equal(answer.status, 'supported');
    assert.deepEqual(rowsOf(answer), ['a']);
    assert.equal(answer.retrieval.complete, true);
    assert.ok(answer.retrieval.facts < 10, `unrelated hub members entered the slice: ${answer.retrieval.facts}`);
    const bounded = w.ask('@q query\n  mode count\n  where all\n    kind ?x country\n    inside ?x europe\n  end\n', {maxFacts: 2});
    assert.equal(bounded.status, 'incomplete');
    assert.equal(bounded.count, undefined);
  } finally { w.dispose(); }
});

test('new recursive input domains revisit facts that were already admitted for a different demand', () => {
  const source = new ArraySource([
    typed('seed', 's', 'a'), typed('edge', 'ab', 'a', 'b'), typed('edge', 'bc', 'b', 'c')
  ]);
  const retrieval = new SliceRetrieval({
    source, localFacts: [typed('edge', 'bc', 'b', 'c')],
    conjunctions: [[atom('seed', '?start'), atom('reach', '?start', '?end')]],
    rules: [
      {id: 'base', if: [atom('edge', '?x', '?y')], then: atom('reach', '?x', '?y')},
      {id: 'step', if: [atom('edge', '?x', '?y'), atom('reach', '?y', '?z')], then: atom('reach', '?x', '?z')}
    ]
  });
  retrieval.expand();
  while (retrieval.widen());
  assert.equal(retrieval.complete(), true);
  assert.deepEqual([...retrieval.facts.keys()].sort(), ['ab', 'bc', 's']);
  assert.ok(source.calls.some(p => p.p === 'edge' && p.a[0] === 'c'), 'the cached b→c row must propagate the next recursive input');
});

test('SQLite selectivity keeps a scoped ranking complete within a budget smaller than the global type relation', () => {
  const w = world(
    pred('kind', 'entity entity') + pred('inside', 'entity entity') + pred('population', 'entity integer') +
    wf('kind', 'paris', 'city') + wf('kind', 'lyon', 'city') +
    wf('inside', 'paris', 'france') + wf('inside', 'lyon', 'france') +
    wf('population', 'paris', 200) + wf('population', 'lyon', 100) +
    Array.from({length: 600}, (_, i) => wf('kind', 'other' + i, 'city')).join(''));
  try {
    const query = '@q query\n  select ?x\n  where all\n    kind ?x city\n    inside ?x france\n    population ?x ?n\n  end\n  rank highest ?n\n';
    const answer = w.ask(query, {maxFacts: 20});
    assert.equal(answer.status, 'supported');
    assert.deepEqual(rowsOf(answer), ['paris']);
    assert.equal(answer.retrieval.complete, true);
    assert.equal(answer.retrieval.facts, 6);
    const cut = w.ask(query, {maxFacts: 4});
    assert.equal(cut.status, 'incomplete');
    assert.equal(cut.retrieval.complete, false);
  } finally { w.dispose(); }
});

test('SQLite cardinalities do not interrupt a bound multi-hop prefix with a global class lookup', () => {
  const w = world(
    pred('born', 'entity entity') + pred('inside', 'entity entity') + pred('kind', 'entity entity') +
    wf('born', 'person', 'town') + wf('inside', 'town', 'nation') + wf('kind', 'nation', 'country') +
    Array.from({length: 600}, (_, i) => wf('kind', 'other' + i, 'country')).join(''));
  try {
    const answer = w.ask('@q query\n  select ?x\n  where all\n    born person ?p\n    inside ?p ?x\n    kind ?x country\n  end\n', {maxFacts: 20});
    assert.equal(answer.status, 'supported');
    assert.deepEqual(rowsOf(answer), ['nation']);
    assert.equal(answer.retrieval.complete, true);
    assert.equal(answer.retrieval.facts, 3);
  } finally { w.dispose(); }
});
