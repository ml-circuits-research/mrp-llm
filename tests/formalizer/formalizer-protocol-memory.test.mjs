// The protocol memory of InternalReasoningStepByStep (config/knowledge/formalizer-protocol-v1, DS022 "InternalReasoningStepByStep"):
// the lint (validator, compiled by the JS oracle, every question complete, every slot read, a dry run from each kind reaches the goal),
// a planted contradiction enables the re-ask action, no route means no plan before any question, the memory has its own namespace and
// is not a chat base memory, and a decision of the controller takes less than 50 ms.
import test from 'node:test';
import assert from 'node:assert/strict';
import {checkProtocol, dryRunFacts} from '../../tools/formalizer-protocol/check.mjs';
import {loadProtocol, decide} from '../../lib/formalize/internal-reasoning/reasoner.mjs';
import {Facts} from '../../lib/formalize/internal-reasoning/state.mjs';
import {seedIds, seedCircuits} from '../../lib/knowledge-seeds.mjs';
import {internalReasoningQuery, createReasoningOracle} from '../../lib/formalize/internal-reasoning/index.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';

const protocol = loadProtocol();

test('the protocol memory passes its lint, and a dry run from every kind of answer reaches the goal formalized without a model', () => {
  const r = checkProtocol(protocol);
  assert.deepEqual(r.problems, []);
  assert.ok(r.actions >= 50 && r.questions >= r.actions, `${r.actions} actions, ${r.questions} questions`);
  for (const [kind, run] of Object.entries(r.dryRuns)) assert.ok(run.ok, `kind ${kind}: ${run.reason}`);
  assert.deepEqual(r.dryRuns.list.path.slice(-2), ['ask_statements q', 'assemble none'], 'a list question asks its statements, then the system assembles');
  assert.ok(r.dryRuns.puzzle.path.includes('ask_puzzle_conditions none') && !r.dryRuns.puzzle.path.some(s => s.startsWith('ask_statements')), 'a puzzle needs no statement');
  assert.deepEqual(r.dryRuns.none.path, ['ask_acts none', 'assemble none'], 'nothing to look up: what the message also does, then assembly');
});

test('a planted contradiction (a name in a number place) is a violation that enables the re-ask action, and the plan takes it first', () => {
  const facts = dryRunFacts('value');
  for (const a of ['answered ask_acts none', 'answered ask_own_data none', 'answered ask_aspects none', 'answered ask_statements q', 'uses q i1', 'instance_of i1 st2', 'main_instance q i1', 'answered ask_places i1',
    'place i1 subject unknown_x', 'place i1 object n2']) facts.add(...a.split(' '));
  const d = decide(protocol, facts);
  assert.deepEqual(d.violations, [['name_in_number_place', 'i1']]);
  assert.equal(d.kind, 'act');
  assert.equal(`${d.action} ${d.arg}`, 'ask_places_again i1');
  assert.ok(d.plan.length >= 2 && d.plan.at(-1) === 'assemble none', JSON.stringify(d.plan));
  assert.ok(d.why.some(line => /violation name_in_number_place i1/.test(line)), d.why.join('\n'));
  // Once asked again, the instance is not asked a third time: the violation no longer holds (absent reasked).
  facts.add('reasked', 'i1');
  facts.add('answered', 'ask_places_again', 'i1');
  assert.deepEqual(decide(protocol, facts).violations, []);
});

test('without a statement or a number there is no plan, and the strategy answers unclear without asking the model', async () => {
  const facts = new Facts();
  for (const a of ['start', 'budget_left', 'budget_ample', 'date_count 0']) facts.add(...a.split(' '));
  const d = decide(protocol, facts);
  assert.equal(d.kind, 'stuck');
  assert.equal(d.reason, 'no_plan');
  let calls = 0;
  const chat = async () => { calls++; return {ok: true, text: '1', ms: 0, usage: {}}; };
  const r = await internalReasoningQuery({message: 'Tell me something.', lexicon: Lexicon.fromCircuits([{name: 't', text: '@ana entity\n  kind entity\n  label en "Ana"\n'}]), oracle: createReasoningOracle({chat, protocol}), protocol});
  assert.equal(calls, 0);
  assert.equal(r.status, 'validated');
  assert.equal(r.unclear, 'relation_not_in_memory');
  assert.equal(JSON.parse(r.report).no_route, true);
});

test('the protocol memory has its own namespace and is not a chat base memory', () => {
  assert.ok(!seedIds().includes('formalizer-protocol-v1'));
  assert.ok(seedIds({all: true}).includes('formalizer-protocol-v1'));
  const ids = seedCircuits('formalizer-protocol-v1').flatMap(c => [...c.text.matchAll(/^@([a-z_0-9]+) /gm)].map(m => m[1]));
  assert.ok(ids.length > 900);
  assert.deepEqual(ids.filter(id => !id.startsWith('fp_')), []);
});

test('a decision of the controller (closure and plan over the protocol memory) takes less than 50 ms', () => {
  const facts = dryRunFacts('list');
  for (const a of ['answered ask_acts none', 'answered ask_aspects none']) facts.add(...a.split(' '));
  decide(protocol, facts); // warm-up
  // The bound is on the CPU time of this process (process.cpuUsage), not on wall time: under a loaded machine (npm test runs the files
  // in parallel) wall time includes waiting for a core, while a slower decision still costs more CPU time and fails the bound.
  const cpu = [], wall = [];
  for (let k = 0; k < 9; k++) {
    const c = process.cpuUsage(), t = performance.now();
    decide(protocol, facts);
    wall.push(performance.now() - t);
    const d = process.cpuUsage(c);
    cpu.push((d.user + d.system) / 1000);
  }
  const median = xs => [...xs].sort((a, b) => a - b)[4];
  assert.ok(median(cpu) < 50, `median ${median(cpu).toFixed(1)} ms CPU per decision (wall ${median(wall).toFixed(1)} ms)`);
});
