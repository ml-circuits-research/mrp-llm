import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Runtime} from '../../sop/runtime.mjs';
import {ReasoningRegistry} from '../../reasoning/registry.mjs';
import {closure} from '../../reasoning/bridge/index.mjs';
import {Repository} from '../../memory/repository.mjs';
import {publishKnowledge} from '../../sop/ingest.mjs';
import {createBank} from '../../memory/banks/factory.mjs';
import {withEnv} from '../helpers.mjs';

const run = (s, opts = {}) => new Runtime({now: Date.parse('2026-09-26'), ...opts}).run(s);
const f = (id, a) => `@${id} fact\n  holds ${a}\n  valid timeless\n`;
const r = (id, body, head, mode = 'logical') => `@${id} rule\n${body.map(a => '  when ' + a + '\n').join('')}  then ${head}\n  mode ${mode}\n`;
const h = (id, a, cost = 1) => `@${id} hypothesis\n  holds ${a}\n  cost ${cost}\n`;
const q = a => `@q query\n  where ${a}\n  at 2026-09-26\n`;
const modelOnly = type => new RegExp(`Model authors stated, assumed, unclear, query, constraint, unparsed, pragmatic or instruction; ${type} belongs to symbolic execution`);

/** Runs `body` with a throwaway repository directory that is always removed. */
async function withTempDir(prefix, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    await body(root);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

const abduction = r('r1', ['network_down s1'], 'outage s1')
  + r('r2', ['disk_full s1'], 'outage s1')
  + h('n', 'network_down s1', 2)
  + h('d', 'disk_full s1', 1)
  + '@data pack\n  items $r1 $r2\n@possible pack\n  items $n $d\n'
  + q('outage s1');

test('v3: hypotheses are explicit, minimal, sorted by cost and never facts', async () => {
  const x = await run(abduction + '@a abduce\n  query $q\n  data $data\n  candidates $possible\n  output ?causes many\n@c cnl\n  result $a');
  assert.equal(x.values.a.status, 'hypotheses');
  assert.equal(x.values.causes.length, 2);
  assert.equal(x.values.causes[0].hypotheses[0], 'd');
  assert.deepEqual(x.values.causes[0].atoms, ['disk_full s1']);
  assert.equal(x.values.a.guarantee, 'exact');
  assert.deepEqual(x.values.a.hypotheses, [['disk_full s1'], ['network_down s1']]);
});

test('v3: hypotheses are not silently asserted as facts', () => withTempDir('hyp-', async root => {
  const repo = new Repository(root);
  repo.init('b');
  const session = repo.session('b', 'u', 's');
  await assert.rejects(run(h('h', 'likes ana book') + '@a remember\n  input $h', {repo, session}), /reviewed/);
}));

test('v3: patterns cannot serve as deductive rules', async () => {
  const x = await run('@p pattern\n  when bird ?x\n  then flies ?x\n  support 0.9\n' + f('f', 'bird a') + '@k pack\n  items $f $p\n' + q('flies a') + '@r reason\n  query $q\n  data $k');
  assert.equal(x.result.status, 'unknown');
  assert.ok(x.result.ignored.some(x => x.kind === 'pattern'));
});

test('v3: explicit opposing evidence rejects an abductive assumption', async () => {
  const x = await run(abduction.replace('items $r1 $r2', 'items $r1 $r2 $op') + f('op', 'not disk_full s1') + '@a abduce\n  query $q\n  data $data\n  candidates $possible');
  assert.equal(x.result.explanations.length, 1);
  assert.equal(x.result.explanations[0].hypotheses[0], 'n');
  assert.deepEqual(x.result.rejected, [{id: 'd', reason: 'contradicts_an_observed_fact'}]);
});

test('v3: abduction cannot explain observation with itself', async () => {
  const x = await run(f('f', 'outage s1') + h('h', 'outage s1') + '@data pack\n  items $f\n' + q('outage s1') + '@a abduce\n  query $q\n  data $data\n  candidates $h');
  assert.equal(x.result.explanations.length, 0);
});

test('v3: budget exhaustion reports incomplete, not exhaustive absence', async () => {
  const x = await run(abduction + '@budget policy\n  maxCandidates 1\n@a abduce\n  query $q\n  data $data\n  candidates $possible\n  policy $budget\n  output ?causes many');
  assert.equal(x.result.complete, false);
  assert.equal(x.result.status, 'budget_exhausted');
  assert.equal(x.result.reason, 'candidates');
  assert.equal(x.outputs.causes.status, 'incomplete');
});

test('v3: diagnostic test is recommended but never executed', async () => {
  const x = await run(abduction + '@test query\n  where network_down s1\n@a diagnose\n  query $q\n  data $data\n  candidates $possible\n  tests $test');
  assert.ok(x.result.next_test);
  assert.equal(x.result.next_test.separated_pairs, 1);
  assert.equal(x.result.executed_tests, false);
});

const planning = f('f', 'at robot room_a')
  + f('ab', 'connected room_a room_b')
  + f('bc', 'connected room_b room_c')
  + '@move action\n  params ?r ?from ?to\n  requires at ?r ?from\n  requires connected ?from ?to\n  removes at ?r ?from\n  adds at ?r ?to\n  cost 1\n@data pack\n  items $f $ab $bc\n@g goal\n  where at robot room_c\n';

test('v3: minimum cost plan with explicit add/remove effects', async () => {
  const x = await run(planning + '@p plan\n  data $data\n  actions $move\n  goal $g\n  output ?steps one\n@a cnl\n  result $p');
  assert.equal(x.values.p.status, 'plan_found');
  assert.equal(x.values.p.plan.cost, 2);
  assert.equal(x.values.p.plan.steps, 2);
  assert.deepEqual(x.values.p.plan.sequence.map(step => [step.action, step.adds, step.removes]), [['move', ['at robot room_b'], ['at robot room_a']], ['move', ['at robot room_c'], ['at robot room_b']]]);
  assert.deepEqual(x.values.p.used.map(u => u.id), ['move']);
  assert.equal(x.values.steps.cost, 2);
});

test('v3: zero-cost loop is bounded and does not prevent plan discovery', async () => {
  const x = await run(planning + '@stay action\n  requires at ?r ?p\n  adds at ?r ?p\n  cost 0\n@as pack\n  items $move $stay\n@p plan\n  data $data\n  actions $as\n  goal $g');
  assert.equal(x.result.plan.cost, 2);
});

test('v3: model cannot define actions or policy grants', async () => {
  await assert.rejects(new Runtime().run('@p policy\n  maxNodes 10000', {origin: 'model'}), modelOnly('policy'));
  await assert.rejects(new Runtime().run('@m action\n  requires p ?x\n  adds q ?x', {origin: 'model'}), modelOnly('action'));
});

test('v3: action cannot introduce an unbound variable', async () => {
  await assert.rejects(run('@m action\n  requires p ?x\n  adds q ?y'), /range-restricted/);
});

test('v3: what-if does not change the observed fact or live memory', async () => {
  const x = await run(f('on', 'switch_on s') + r('r', ['switch_on ?x'], 'light_on ?x', 'causal') + '@data pack\n  items $on $r\n' + h('off', 'not switch_on s') + q('light_on s') + '@sim simulate\n  query $q\n  data $data\n  intervention $off\n  mode counterfactual');
  assert.equal(x.result.whatif.factual_status, 'supported');
  assert.equal(x.result.status, 'unknown');
  assert.equal(x.result.whatif.source_memory_modified, false);
  assert.equal(x.values.on.atom.neg, false);
});

test('v3: causal intervention cuts incoming rule and recomputes downstream observations', async () => {
  const x = await run(f('a', 'battery s') + f('measured', 'light_on s') + r('r1', ['battery ?x'], 'switch_on ?x', 'causal') + r('r2', ['switch_on ?x'], 'light_on ?x', 'causal') + '@data pack\n  items $a $measured $r1 $r2\n' + h('off', 'not switch_on s') + q('light_on s') + '@sim simulate\n  query $q\n  data $data\n  intervention $off\n  mode counterfactual');
  assert.equal(x.result.status, 'unknown');
  assert.equal(x.result.whatif.factual_status, 'supported');
});

test('v3: a correlation is not silently treated as a causal law', async () => {
  const x = await run(f('a', 'rain s') + r('r', ['rain ?x'], 'wet ?x') + '@data pack\n  items $a $r\n' + h('h', 'not rain s') + q('wet s') + '@sim simulate\n  query $q\n  data $data\n  intervention $h\n  mode counterfactual');
  assert.equal(x.result.status, 'not_expressible');
  assert.equal(x.result.reason, 'causal_model_required');
});

test('v3: conflicting intervention fails without explosion', async () => {
  const x = await run(h('a', 'p x') + h('b', 'not p x') + '@both pack\n  items $a $b\n' + q('p x') + '@sim simulate\n  query $q\n  intervention $both');
  assert.equal(x.result.status, 'inconsistent');
});

const traces = '@t1 trace\n  feature hot a\n  feature dry a\n  closed true\n@t2 trace\n  feature hot b\n  closed true\n@t3 trace\n  feature hot c\n@cases pack\n  items $t1 $t2 $t3\n@candidate pattern\n  when hot ?x\n  then dry ?x\n';

test('v3: induction separates observed counterexamples from unknowns', async () => {
  const x = await run(traces + '@i induce\n  data $cases\n  candidates $candidate\n  output ?patterns many');
  const p = x.result.patterns[0];
  assert.equal(p.training.supportCount, 1);
  assert.equal(p.training.counterexamples, 1);
  assert.equal(p.training.unknown, 1);
  assert.equal(p.status, 'candidate');
  assert.equal(x.outputs.patterns.status, 'bound');
});

test('v3: automatic pattern generator produces candidates, not accepted rules', async () => {
  const x = await run(traces + '@i induce\n  data $cases');
  assert.ok(x.result.patterns.length > 0);
  assert.ok(x.result.patterns.every(p => p.kind === 'pattern'));
});

test('v3: heldout IDs must not overlap training cases', async () => {
  await assert.rejects(run(traces + '@i induce\n  data $cases\n  holdout $t1'), /overlap/);
});

for (const mode of ['lexical', 'relational', 'recall-memory']) {
  test('v3: ' + mode + ' association produces scores, not proofs', async () => {
    const x = await run('@cue trace\n  text "roată ruptă"\n  feature broken wheel\n@hit trace\n  text "roată ruptă"\n  feature broken wheel\n@other trace\n  text "carte nouă"\n  feature new book\n@cs pack\n  items $hit $other\n@a associate\n  cue $cue\n  data $cs\n  mode ' + mode);
    assert.equal(x.result.candidates[0].id, 'hit');
    assert.equal(x.result.status, 'approximate');
    assert.equal(x.result.guarantee, 'approximate');
    assert.deepEqual(x.result.used, []);
    assert.equal(x.result.proof, undefined);
  });
}

test('v3: structural analogy transfers a hypothesis only', async () => {
  const x = await run('@s trace\n  feature connected a b\n@t trace\n  feature connected c d\n@extra trace\n  feature useful b\n@a analogize\n  source $s\n  target $t\n  transfer $extra');
  assert.equal(x.result.mappings[0].score, 1);
  assert.deepEqual(x.result.mappings[0].proposed[0].assumptions[0].a, ['d']);
  assert.equal(x.result.mappings[0].proposed[0].kind, 'hypothesis');
});

test('v3: finite optimization finds true minimum and materializes unique optimum', async () => {
  const x = await run('@c constraint\n  var ?x int 0 10\n  var ?y int 0 10\n  require ?x + ?y >= 5\n  claim ?x >= 0\n  task optimize\n  objective 2 * ?x + ?y\n  direction min\n@r solve\n  constraint $c\n  output ?x one\n  output ?y one');
  assert.equal(x.result.status, 'optimal');
  assert.equal(x.result.objective, 5);
  assert.equal(x.values.x, 0);
  assert.equal(x.values.y, 5);
});

test('v3: tied optimum does not become a unique scalar', async () => {
  const x = await run('@c constraint\n  var ?x int 0 2\n  var ?y int 0 2\n  require ?x + ?y == 2\n  claim ?x >= 0\n  task optimize\n  objective ?x + ?y\n@r solve\n  constraint $c\n  output ?x one');
  assert.equal(x.outputs.x.status, 'ambiguous');
});

test('v3: unsupported theory is not silently ignored', async () => {
  const x = await run('@t theory\n  dialect probabilistic-scm-v99\n  body "custom specification"\n' + q('p x') + '@r reason\n  query $q\n  data $t');
  assert.equal(x.result.status, 'unsupported');
});

test('v3: reference strategy never invokes an external solver', async () => {
  let calls = 0;
  const reasoningStrategies = new ReasoningRegistry({availability: () => {
    calls++;
    throw Error('must not probe external');
  }});
  const x = await run('@c constraint\n  var ?x int 0 2\n  claim ?x <= 2\n@r solve\n  constraint $c', {reasoningStrategies});
  assert.equal(x.result.status, 'entailed');
  assert.equal(calls, 0);
});

test('v3: an explicit z3 backend that is unavailable is unsupported, names z3 and has no fallback (AGENTS.md rule 8)', async () => {
  const x = await withEnv('Z3_BIN', '/nonexistent/z3', () => run('@c constraint\n  var ?x int 0 2\n  claim ?x <= 2\n@r solve\n  constraint $c\n  backend z3'));
  assert.equal(x.result.status, 'unsupported');
  assert.equal(x.result.code, 'backend_unavailable');
  assert.equal(x.result.route.backend, 'z3');
  assert.equal(x.result.route.fallback, null);
});

test('v3: required numeric data cannot be dispatched as a Horn fact', async () => {
  const x = await run('@c constraint\n  var ?x int 0 2\n  claim ?x < 1\n' + q('p x') + '@r reason\n  query $q\n  data $c');
  assert.equal(x.result.status, 'unsupported');
});

test('v3: partial join under a budget never derives a conclusion', () => {
  const facts = [{id: 'f', atom: {p: 'p', a: ['x'], neg: false}, valid: {from: -Infinity, until: Infinity}, kind: 'observed'}];
  const rules = [{id: 'r', if: [{p: 'p', a: ['?x'], neg: false}, {p: 'q', a: ['?x'], neg: false}], then: {p: 'answer', a: ['?x'], neg: false}}];
  const x = closure(facts, rules, {maxJoins: 1});
  assert.equal(x.facts.length, 1);
  assert.equal(x.complete, false);
});

for (const engine of ['recall-memory', 'holo-memory', 'sqlite', 'scan', 'hybrid']) {
  test('v3: ' + engine + ' memory is independent from reasoning strategy', () => withTempDir('cross-', async root => {
    const repo = new Repository(root, {memory: {engine, power: 8, holoMemory: {rows: 128, banks: 4, dimension: 64, ageStepsPerNovel: 0}}});
    publishKnowledge(repo, 'b', f('a', 'parent ana bogdan') + f('b', 'parent bogdan carina') + r('rule', ['parent ?x ?y', 'parent ?y ?z'], 'grandparent ?x ?z'), {reviewed: true, knownAt: 1});
    const session = repo.session('b', 'u', 's');
    for (const reasoningStrategy of ['reference', 'js-reference', 'js-oracle']) {
      const x = await run(q('grandparent ana carina') + '@r solve\n  query $q', {
        repo,
        session,
        policy: {retrievalStrategy: 'auto', reasoningStrategy},
        reasoningStrategies: new ReasoningRegistry({availability: () => false}),
      });
      assert.equal(x.result.status, 'supported');
      assert.equal(x.result.reasoningStrategy, 'reference', reasoningStrategy + ' is an id of the oracle');
    }
  }));
}

test('v3: hybrid bank preserves exact evidence even after associative erasure', () => {
  const b = createBank({engine: 'hybrid', power: 8});
  const a = {p: 'p', a: ['x'], neg: false};
  try {
    b.add(a);
    b.associative.decay(15);
    assert.equal(b.recall(a).rows.length, 1);
    assert.equal(b.hints(a).rows.length, 0);
    const restored = createBank({}, b.export());
    assert.equal(restored.recall(a).rows.length, 1);
    restored.close();
  } finally {
    b.close();
  }
});

test('v3: approved action/hypothesis/trace definitions can be persisted and used by handle', () => withTempDir('lib-v3-', async root => {
  const repo = new Repository(root, {memory: {engine: 'sqlite'}});
  publishKnowledge(repo, 'b', h('cause', 'network_down s1') + r('explanation', ['network_down s1'], 'outage s1'), {reviewed: true, knownAt: 1});
  const session = repo.session('b', 'u', 's');
  const x = await run(q('outage s1') + '@a abduce\n  query $q\n  candidates ~cause', {repo, session});
  assert.equal(x.result.explanations.length, 1);
}));

test('v3: automatic backward abduction proposes a two-hop missing condition', async () => {
  const x = await run(r('disk_process', ['disk_full ?x'], 'process_crashed ?x') + r('process_outage', ['process_crashed ?x'], 'outage ?x') + '@kb pack\n  items $disk_process $process_outage\n' + q('outage server') + '@a abduce\n  query $q\n  data $kb');
  assert.equal(x.result.explanations.length, 1);
  assert.deepEqual(x.result.explanations[0].atoms, ['disk_full server']);
  assert.equal(x.result.generator.semantics.startsWith('ground missing leaves'), true);
});

test('v3: automatic abduction binds hidden variables over a finite known domain', async () => {
  const x = await run(f('known', 'connected a b') + r('rule', ['connected ?x ?y', 'blocked ?y'], 'unavailable ?x') + '@kb pack\n  items $known $rule\n' + q('unavailable a') + '@a abduce\n  query $q\n  data $kb');
  assert.ok(x.result.explanations.some(e => e.atoms.length === 1 && e.atoms[0] === 'blocked b'));
});

test('v3: model cannot certify a trace as closed-world ground truth', async () => {
  // The model-authorship guard rejects any model-authored trace, closed or not.
  await assert.rejects(new Runtime().run('@t trace\n  feature p x\n  closed true', {origin: 'model'}), modelOnly('trace'));
});

test('v3: induction generator truncation cannot masquerade as exhaustive', async () => {
  const x = await run('@t trace\n  feature p a\n  feature q a\n  feature r a\n@i induce\n  data $t', {policy: {maxCandidates: 1}});
  assert.equal(x.result.complete, false);
  assert.equal(x.result.generator_truncated, true);
});

test('v3: approved procedures compose new operation and transitive action handle', () => withTempDir('procedure3-', async root => {
  const repo = new Repository(root, {memory: {engine: 'sqlite'}});
  const defs = fs.readFileSync(new URL('../fixtures/reasoning-procedures.sop', import.meta.url), 'utf8');
  publishKnowledge(repo, 'b', defs + f('start', 'located_in r1 a') + f('road', 'connected a b'), {reviewed: true, knownAt: 1});
  const session = repo.session('b', 'u', 's');
  const x = await run('@answer expand\n  using ~plan_route\n  with robot r1\n  with destination b', {repo, session});
  assert.equal(x.result.packet.status, 'plan_found');
  assert.equal(x.result.packet.plan.cost, 1);
  const d = await run('@answer expand\n  using ~diagnose_outage\n  with device server', {repo, session});
  assert.equal(d.result.packet.explanations.length, 2);
}));
