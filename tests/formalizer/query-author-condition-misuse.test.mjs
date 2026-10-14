import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Repository} from '../../memory/repository.mjs';
import {ingestFacts} from '../../lib/chat-data/memories.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {Theory, askMemory} from '../../reasoning/slice/wire.mjs';
import {AuthorRuntime} from '../../lib/query-author/runtime.mjs';
import {validateQuery} from '../../lib/query-author/index.mjs';
import {tempDir} from '../helpers.mjs';

function memory(t, knowledge) {
  const circuits = [{name: 'test-memory', text: knowledge}];
  const repo = new Repository(tempDir(t, 'condition-misuse-'), {memory: {engine: 'sqlite'}});
  repo.init('base');
  ingestFacts(repo, 'base', knowledge, {knownAt: Date.parse('2020-01-01')});
  const session = repo.session('base', 'test', 'turn');
  const lexicon = Lexicon.fromCircuits(circuits), theory = new Theory(circuits);
  return {repo, session, lexicon, theory, circuits,
    ask: (condition, extra = '', options = {}) => askMemory({repo, session, lexicon, theory,
      query: `@q query\n  mode exists\n  where ${condition}\n${extra}`, ...options}),
    run: (sop, message) => new AuthorRuntime({repo, session, lexicon, schema: lexicon.predicates, circuits, policy: {reinforce: false}})
      .run(sop, {origin: 'model', inputText: message})};
}

for (const id of ['f2-dev-096', 'f2-dev-048', 'f2-dev-090']) {
  test(`saved ${id} circuit is repairable misuse, never a confident negative`, async t => {
    const read = file => fs.readFileSync(new URL(`../fixtures/condition-misuse/${id}/${file}`, import.meta.url), 'utf8');
    const m = memory(t, read('knowledge.sop')), authored = read('authored.sop'), message = read('question.txt');
    const admitted = validateQuery({...m, sop: authored, message});
    assert.equal(admitted.ok, false);
    assert.ok(admitted.problems.some(p => p.code === 'condition_misuse' && p.predicate === 'department_pay'));
    const result = await m.run(authored, message);
    const packet = result.result.packet;
    assert.equal(packet.status, 'unknown');
    assert.equal(packet.reason, 'condition_misuse');
    assert.ok(packet.misuses.some(p => p.predicate === 'department_pay' && p.position === 2 && p.values.length));
    const gold = askMemory({...m, query: read('query.sop')});
    assert.equal(gold.status, 'supported');
    assert.deepEqual(gold.rows, JSON.parse(read('expected.json')).rows);
  });
}

const KNOWLEDGE = `@assigned predicate
  args subject:entity object:entity
  closed true
  label en "assigned to"
@pay predicate
  args subject:entity object:integer
  closed true
@ada entity
  kind person
  label en "Ada"
@bea entity
  kind person
  label en "Bea"
@cal entity
  kind person
  label en "Cal"
@lab entity
  kind organization
  label en "Lab"
@office entity
  kind organization
  label en "Office"
@a fact
  holds assigned ada lab
@b fact
  holds assigned bea office
@p fact
  holds pay ada 10
@derived predicate
  args subject:entity object:entity
@derived_rule rule
  when assigned ?x ?y
  then derived ?x ?y
`;

test('position typing preserves missing closed tuples, absence and unseen numeric values', t => {
  const m = memory(t, KNOWLEDGE);
  assert.equal(m.ask('assigned ada office').status, 'refuted');
  assert.equal(m.ask('absent assigned ada office').status, 'supported');
  assert.equal(m.ask('absent assigned ada lab').status, 'refuted');
  assert.equal(m.ask('pay ada 11').status, 'refuted');
  assert.equal(m.ask('derived ada lab').status, 'supported');
  assert.equal(m.ask('assigned cal lab').status, 'refuted'); // Cal's class occurs in the subject position.
});

test('explicit absence ranges over registered generic entities, not positive membership only', t => {
  const m = memory(t, `@known entity
  kind entity
@unlisted entity
  kind entity
@listed predicate
  args subject:entity
  closed true
@linked predicate
  args subject:entity object:entity
  closed true
@open_list predicate
  args subject:entity
@f1 fact
  holds listed raw_member
@f2 fact
  holds linked raw_member known
@f3 fact
  holds open_list raw_member
`);
  assert.equal(m.ask('absent listed unlisted').status, 'supported');
  assert.equal(m.ask('absent linked unlisted known').status, 'supported');
  assert.equal(m.ask('absent linked known unlisted').status, 'supported');
  const open = m.ask('open_list unlisted');
  assert.equal(open.status, 'unknown');
  assert.equal(open.complete, true);
});

test('swapped constants and nested scope misuse cannot prove a closed negative or absence', t => {
  const m = memory(t, KNOWLEDGE);
  for (const condition of ['assigned lab ada', 'absent assigned lab ada']) {
    const r = m.ask(condition);
    assert.equal(r.status, 'unknown');
    assert.equal(r.reason, 'condition_misuse');
    assert.ok(r.misuses.some(p => p.position === 1 && p.value === 'lab' && p.values.includes('ada')));
  }
  const scoped = askMemory({...m, query: '@q query\n  mode every\n  where assigned ?p lab\n  scope all\n    assigned lab ?p\n  end\n'});
  assert.equal(scoped.status, 'unknown');
  assert.equal(scoped.reason, 'condition_misuse');
});

test('phrase authoring uses the compiler linking semantics before misuse repair', t => {
  const m = memory(t, KNOWLEDGE);
  const sop = '@q query\n  where match\n    relation "assigned to"\n    role subject "Lab"\n    role object "Ada"\n    polarity affirmed\n  end\n';
  const checked = validateQuery({...m, sop, message: 'Is Ada assigned to Lab?', mode: 'phrase'});
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some(p => p.code === 'condition_misuse' && p.predicate === 'assigned'));
});

test('direct positional arity errors are withheld and query-local evidence retains conditional support', t => {
  const m = memory(t, KNOWLEDGE);
  assert.throws(() => m.ask('assigned ada'), error => error.code === 'arity_mismatch');
  const local = m.ask('assigned cal office', '@temporary fact\n  holds assigned cal office\n  status supposed\n  source assumption\n');
  assert.equal(local.status, 'supported');
  assert.ok(local.conditional?.includes('temporary'));
  assert.equal(m.ask('assigned cal office').status, 'refuted');
});

test('domain checks use vocabulary classes beyond a sparse position sample and respect bounds', t => {
  const knowledge = KNOWLEDGE + Array.from({length: 40}, (_, i) => `@extra${i} fact\n  holds assigned ada loc${i}\n`).join('');
  const m = memory(t, knowledge);
  const r = m.ask('assigned cal lab');
  assert.equal(r.status, 'refuted');
  assert.ok(r.condition_guard.lookups <= 128);
  assert.ok(r.condition_guard.probes <= 2048);
  const capped = m.ask('assigned cal lab', '', {limits: {maxLookups: 1, maxProbes: 1}});
  assert.ok(capped.condition_guard.lookups <= 1);
  assert.ok(capped.condition_guard.probes <= 1);
});

