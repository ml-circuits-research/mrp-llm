import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../../sop/parser.mjs';
import {ORDER_SAMPLING, ORDER_WORDS} from '../../sop/enums.mjs';
import {validateProgram, parse as parseKnowledge} from '../../sop/knowledge/index.mjs';
import {Repository} from '../../memory/repository.mjs';
import {ingestFacts} from '../../lib/chat-data/memories.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {Theory, askMemory} from '../../reasoning/slice/wire.mjs';
import {routedAsk} from '../../reasoning/router/index.mjs';
import {shuffled, sampleAnswers} from '../../reasoning/sample.mjs';
import {AuthorRuntime} from '../../lib/query-author/runtime.mjs';
import {validateQuery} from '../../lib/query-author/index.mjs';
import {tempDir} from '../helpers.mjs';

const PEOPLE = ['ada', 'bea', 'cal', 'dan', 'eva', 'fay', 'gus', 'hal'];
const KNOWLEDGE = `@likes predicate
  args subject:entity object:entity
  label en "like"
@tea entity
  kind entity
  label en "tea"
${PEOPLE.map(p => `@${p} entity\n  kind person\n  label en "${p[0].toUpperCase() + p.slice(1)}"\n`).join('')}${PEOPLE.map(p => `@f_${p} fact\n  holds likes ${p} tea\n`).join('')}`;

function memory(t) {
  const circuits = [{name: 'test-memory', text: KNOWLEDGE}];
  const repo = new Repository(tempDir(t, 'order-random-'), {memory: {engine: 'sqlite'}});
  repo.init('base');
  ingestFacts(repo, 'base', KNOWLEDGE, {knownAt: Date.parse('2020-01-01')});
  const session = repo.session('base', 'test', 'turn');
  const lexicon = Lexicon.fromCircuits(circuits), theory = new Theory(circuits);
  return {repo, session, lexicon, theory, circuits,
    ask: (extra, options = {}) => askMemory({repo, session, lexicon, theory, query: `@q query\n  select ?p\n  where likes ?p tea\n${extra}`, ...options})};
}
const names = rows => rows.map(r => r['?p'] ?? r.p ?? Object.values(r)[0]);

test('order random is one closed word beside the temporal order words', () => {
  assert.deepEqual([...ORDER_SAMPLING], ['random']);
  assert.ok(!ORDER_WORDS.includes('random'));
  const model = q => parse(`@q query\n${q}  where match\n    relation "like"\n    role subject ?p\n    role object "tea"\n    polarity affirmed\n  end\n  order random\n  limit 2\n`);
  assert.equal(model('  select ?p\n').wires[0].fields.order[0], 'random');
  for (const mode of ['exists', 'count', 'explain']) assert.throws(() => model(`  mode ${mode}\n`), /order_random_mode/);
  assert.throws(() => parse('@q query\n  select ?p\n  where likes ?p tea\n  order sideways\n'), /order_form/);
  const check = q => validateProgram([{name: 'k.sop', text: KNOWLEDGE}, {name: 'q.sop', role: 'query', text: q}]).problems.map(p => p.code);
  assert.ok(!check('@q query\n  select ?p\n  where likes ?p tea\n  order random\n  limit 3\n').some(c => c.startsWith('order_random')));
  assert.ok(check('@q query\n  mode count\n  where likes ?p tea\n  order random\n').includes('order_random_mode'));
  assert.ok(check('@q query\n  select ?p\n  where likes ?p tea\n  order random\n  order random\n').includes('order_random_repeated'));
});

test('the seeded shuffle is a deterministic permutation', () => {
  const items = [...Array(20).keys()];
  assert.deepEqual(shuffled(items, 7), shuffled(items, 7));
  assert.deepEqual([...shuffled(items, 7)].sort((a, b) => a - b), items);
  assert.notDeepEqual(shuffled(items, 7), shuffled(items, 8));
  assert.deepEqual(sampleAnswers(items, {limit: 3, seed: 1}).sample, {order: 'random', limit: 3, of: 20, seed: 1});
});

test('the sample is drawn from the same answer set, sized by limit and fixed by the seed', t => {
  const m = memory(t);
  const full = m.ask('');
  assert.equal(full.status, 'supported');
  const all = names(full.rows).sort();
  assert.deepEqual(all, [...PEOPLE].sort());
  const everything = m.ask('  order random\n', {seed: 42});
  assert.deepEqual(names(everything.rows).sort(), all);
  assert.deepEqual(everything.sample, {order: 'random', limit: null, of: PEOPLE.length, seed: 42});
  const sample = m.ask('  order random\n  limit 3\n', {seed: 42});
  assert.equal(sample.rows.length, 3);
  assert.equal(sample.truncated, true);
  assert.deepEqual(sample.sample, {order: 'random', limit: 3, of: PEOPLE.length, seed: 42});
  assert.ok(names(sample.rows).every(p => all.includes(p)));
  assert.deepEqual(m.ask('  order random\n  limit 3\n', {seed: 42}).rows, sample.rows);
  const seeds = new Set([1, 2, 3, 4, 5, 6].map(seed => JSON.stringify(names(m.ask('  order random\n  limit 3\n', {seed}).rows))));
  assert.ok(seeds.size > 1, 'different seeds draw different samples');
  // limit without order random keeps its behaviour
  const plain = m.ask('  limit 3\n');
  assert.equal(plain.rows.length, 3);
  assert.equal(plain.sample, undefined);
});

test('order random is applied after the route, also for an explicit engine, and rejected in a wrong mode', () => {
  const handle = {kind: 'js-reference-handle', knowledge: '', wires: parseKnowledgeWires()};
  const query = '@q query\n  select ?p\n  where likes ?p tea\n  order random\n  limit 2\n';
  const packet = routedAsk({handle, query, requested: 'js-reference', verify: 'never', seed: 'fixed'});
  assert.equal(packet.rows.length, 2);
  assert.deepEqual(packet.sample, {order: 'random', limit: 2, of: PEOPLE.length, seed: 'fixed'});
  assert.deepEqual(routedAsk({handle, query, verify: 'never', seed: 'fixed'}).rows, packet.rows);
  assert.throws(() => routedAsk({handle, query: '@q query\n  mode exists\n  where likes ?p tea\n  order random\n', verify: 'never'}), e => e.code === 'order_random_mode');
});

test('a random sample through the chat path (AuthorRuntime -> askMemory -> router)', async t => {
  const m = memory(t);
  const sop = '@q query\n  select ?who\n  where match\n    relation "like"\n    role subject ?who\n    role object "tea"\n    polarity affirmed\n  end\n  order random\n  limit 2\n';
  const run = seed => new AuthorRuntime({repo: m.repo, session: m.session, lexicon: m.lexicon, schema: m.lexicon.predicates, circuits: m.circuits, policy: {reinforce: false, sampleSeed: seed}})
    .run(sop, {origin: 'model', inputText: 'Name two random people who like tea.'});
  const first = await run(5);
  const packet = Object.values(first.values).find(v => v?.sample && v.answers);
  assert.ok(packet, 'the solve packet reports the sample');
  assert.equal(packet.answers.length, 2);
  assert.deepEqual(packet.sample, {order: 'random', limit: 2, of: PEOPLE.length, seed: 5});
  const again = Object.values((await run(5)).values).find(v => v?.sample && v.answers);
  assert.deepEqual(again.answers, packet.answers);
});

const parseKnowledgeWires = () => parseKnowledge(KNOWLEDGE).wires;

test('the coding agent validator admits order random in mode select and rejects it in mode count', t => {
  const m = memory(t);
  const sop = mode => `@q query\n${mode}  where match\n    relation "like"\n    role subject ?who\n    role object "tea"\n    polarity affirmed\n  end\n  order random\n  limit 2\n`;
  const ok = validateQuery({...m, sop: sop('  select ?who\n'), message: 'Name two random people who like tea.', mode: 'phrase'});
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  const bad = validateQuery({...m, sop: sop('  mode count\n'), message: 'How many people like tea?', mode: 'phrase'});
  assert.equal(bad.ok, false);
  assert.ok(JSON.stringify(bad.problems).includes('order_random_mode'));
});
