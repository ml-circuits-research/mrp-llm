import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Lexicon} from '../../sop/lexicon.mjs';
import {Repository} from '../../memory/repository.mjs';
import {ingestFacts} from '../../lib/chat-data/memories.mjs';
import {collectNeighbourhood} from '../../lib/query-author/neighbourhood.mjs';

const schema = `@connected predicate
  args from:station to:station
  closed true
@blocked predicate
  args station:station
@reached predicate
  args from:station to:station
@secondary predicate
  args from:station to:station
@tertiary predicate
  args from:station to:station
@x entity
  label en "X"
  kind station
@y entity
  label en "Y"
  kind station
@z entity
  label en "Z"
  kind station
@w entity
  label en "W"
  kind station
@f1 fact
  holds connected x y
@f2 fact
  holds secondary y z
@f3 fact
  holds tertiary z w
@r1 rule
  when connected ?from ?to
  then reached ?from ?to
`;
const circuits = [{name: 'network', text: schema}];
const lexicon = Lexicon.fromCircuits(circuits);

test('entity-first reverse index finds lexically missed relations, preserves role order and indexed related rules', () => {
  const got = collectNeighbourhood({message: 'What happened at X?', lexicon, circuits, terms: ['blocked']});
  assert.deepEqual(got.entities, ['x']);
  const connected = got.predicates.find(p => p.id === 'connected');
  assert.ok(connected, 'connected was not a lexical candidate');
  assert.deepEqual(connected.roles, [{name: 'from', type: 'station'}, {name: 'to', type: 'station'}]);
  assert.equal(connected.closed, true);
  assert.equal(connected.factCount, 1);
  assert.equal(connected.factCountExact, true);
  assert.deepEqual(connected.examples[0].atom.a, ['x', 'y']);
  assert.match(connected.examples[0].sop, /holds connected x y/);
  assert.match(connected.examples[0].english, /connected\(x, y\)/);
  assert.equal(connected.rules[0].id, 'r1');
  assert.match(connected.rules[0].english, /then reached\(/);
  assert.ok(got.predicates.some(p => p.id === 'reached'), 'a body-linked derived predicate must be offered');
  assert.equal(got.predicates.find(p => p.id === 'blocked').closed, false);
});

test('second hop expands only from discovered entities, with honest count and byte bounds', () => {
  const first = collectNeighbourhood({message: 'X', lexicon, circuits, terms: []});
  assert.ok(first.predicates.some(p => p.id === 'connected'));
  assert.ok(!first.predicates.some(p => p.id === 'secondary'));
  const second = collectNeighbourhood({message: 'X', lexicon, circuits, terms: [], hops: 2});
  assert.ok(second.predicates.some(p => p.id === 'secondary'));
  assert.ok(!second.predicates.some(p => p.id === 'tertiary'));
  const bounded = collectNeighbourhood({message: 'X', lexicon, circuits, terms: [], hops: 2, maxEntities: 1, maxPredicates: 1, maxBytes: 400});
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.predicates.length <= 1);
  assert.ok(bounded.diagnostics.reasons.includes('entity_limit'));
});

test('a namesake is not chosen by notability and causes no entity-keyed lookup', () => {
  const ambiguous = Lexicon.fromCircuits([{name: 'network', text: schema + '@other entity\n  label en "X"\n  kind station\n  notability 99\n'}]);
  let calls = 0;
  const repo = {recall() { calls++; throw Error('ambiguous entity must not be looked up'); }};
  const result = collectNeighbourhood({message: 'X', lexicon: ambiguous, circuits, repo, session: {}, terms: []});
  assert.deepEqual(result.entities, []);
  assert.ok(result.diagnostics.ambiguous.some(x => x.surface === 'X'));
  assert.equal(calls, 0);
});

test('SQLite repository retrieval uses bounded keyed reads and never writes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-neighbourhood-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = new Repository(root, {memory: {engine: 'sqlite'}});
  ingestFacts(repo, 'base', schema, {knownAt: Date.parse('2024-01-01')});
  const session = repo.session('base', 'alice', 'neighbourhood');
  const revision = session.revision, initial = repo.meta.bases.base;
  const recall = repo.recall.bind(repo), patterns = [];
  repo.recall = (s, pattern, query, options) => {
    assert.ok(pattern.a.includes('x'), 'repository lookups must be keyed by an entity');
    assert.ok(options.limit <= 2);
    assert.ok(options.maxProbes <= 60);
    patterns.push(pattern);
    return recall(s, pattern, query, options);
  };
  const got = collectNeighbourhood({message: 'X', lexicon, circuits, repo, session, terms: [],
    maxFactsPerLookup: 2, maxProbes: 60, maxLookups: 3});
  assert.ok(patterns.length <= 3);
  assert.equal(got.truncated, true);
  assert.ok(got.diagnostics.reasons.includes('lookup_limit'));
  assert.equal(got.predicates.find(p => p.id === 'connected').factCountExact, false);
  assert.equal(got.predicates.find(p => p.id === 'connected').factCountBound, 'at_least');
  assert.equal(session.revision, revision);
  assert.equal(repo.meta.bases.base, initial);
});

test('negative-only relations around an entity remain visible with their explicit polarity', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-negative-neighbourhood-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const text = schema + '@denial fact\n  holds not blocked x\n';
  const localCircuits = [{name: 'negative-network', text}];
  const localLexicon = Lexicon.fromCircuits(localCircuits);
  const repo = new Repository(root, {memory: {engine: 'sqlite'}});
  ingestFacts(repo, 'base', text, {knownAt: Date.parse('2024-01-01')});
  const session = repo.session('base', 'alice', 'negative-neighbourhood');
  const got = collectNeighbourhood({message: 'What happened at X?', lexicon: localLexicon, circuits: localCircuits, repo, session, terms: ['connected']});
  const blocked = got.predicates.find(p => p.id === 'blocked');
  assert.ok(blocked, 'an explicit denial still uses its relation');
  assert.equal(blocked.examples[0].atom.neg, true);
  assert.match(blocked.examples[0].sop, /holds not blocked/);
});

test('byte bounds also cover large namesake diagnostics, not just predicate rows', () => {
  const names = Array.from({length: 6}, (_, i) => `Namesake ${i} ${'Long '.repeat(12)}Surname`);
  const entities = names.flatMap((name, i) => [0, 1].map(j => `@namesake_${i}_${j} entity\n  kind entity\n  label en ${JSON.stringify(name)}\n`)).join('');
  const localLexicon = Lexicon.fromCircuits([{name: 'namesakes', text: entities}]);
  const got = collectNeighbourhood({message: names.join(' and '), lexicon: localLexicon, maxBytes: 400});
  assert.ok(Buffer.byteLength(JSON.stringify(got), 'utf8') <= 400);
  assert.equal(got.truncated, true);
});
