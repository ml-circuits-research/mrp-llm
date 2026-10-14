import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parse} from '../../sop/knowledge/index.mjs';
import {routedAsk} from '../../reasoning/router/index.mjs';
import {Theory, askMemory} from '../../reasoning/slice/index.mjs';
import {Repository} from '../../memory/repository.mjs';
import {ingestFacts} from '../../lib/chat-data/memories.mjs';
import {cnl} from '../../sop/cnl.mjs';
import {renderAnswer} from '../../sop/answer-text.mjs';

const facts = '@f1 fact\n  holds member ana club\n@f2 fact\n  holds member bob club\n';
const handle = {kind: 'js-reference-handle', wires: parse(facts).wires, knowledge: facts};
const ask = query => routedAsk({handle, query, verify: 'never'});

// These packets come from the public reasoning entry point, rather than resembling typed Runtime packets.
test('routed list and existential answers render the actual wire rows and sufficient evidence', () => {
  const selected = ask('@q query\n  where member ?who club\n  select ?who\n');
  assert.equal(selected.status, 'supported');
  assert.deepEqual(selected.rows, [{who: 'ana'}, {who: 'bob'}]);
  assert.equal(cnl(selected).text, 'Answers: Ana and Bob.\nSources used: memory (f1) and memory (f2).');
  const exists = ask('@q query\n  mode exists\n  where member ana club\n');
  assert.equal(renderAnswer(exists), 'Yes.\nSources used: memory (f1).');
  const absent = ask('@q query\n  mode exists\n  where member carina club\n');
  assert.equal(absent.status, 'unknown');
  assert.match(renderAnswer(absent), /I don't know/);
  assert.doesNotMatch(renderAnswer(absent), /^No\./);
});

test('a wh-question with zero bindings cannot become Yes, even if its status says supported', () => {
  const empty = {...ask('@q query\n  where member ?who club\n  select ?who\n'), rows: [], used: []};
  assert.equal(renderAnswer(empty), 'No matching answers were established.');
  const uncertain = {...empty, status: 'unknown'};
  assert.match(renderAnswer(uncertain), /I don't know/);
  const unfinished = {...empty, status: 'incomplete', complete: false};
  assert.match(renderAnswer(unfinished), /search stopped/);
  assert.doesNotMatch(renderAnswer(unfinished), /^Yes\.|^No\./);
});

test('complete and open-domain counts have distinct English conclusions', () => {
  const count = ask('@q query\n  mode count\n  where member ?who club\n');
  assert.equal(count.bound, 'at_least');
  assert.match(renderAnswer(count), /^At least 2;.*predicate is not closed/);
  assert.equal(renderAnswer({...count, bound: undefined}), '2.\nSources used: memory (f1) and memory (f2).');
  assert.match(renderAnswer({status: 'incomplete', complete: false, at_least: 1, used: []}), /^At least 1;.*search was not exhaustive/);
  assert.match(renderAnswer({status: 'incomplete', complete: false, bound: 'at_least', used: []}), /^I don't know the number/);
});

test('annotations distinguish used definition and assumption from unused session circuits', () => {
  const packet = {...ask('@q query\n  mode exists\n  where member ana club\n'),
    origins: [{id: 'f1', origin: 'coding_agent', kind: 'definition'}, {id: 'f2', origin: 'coding_agent', kind: 'assumption'}]};
  assert.match(renderAnswer(packet), /Sources used: definition by coding agent \(f1\)/);
  assert.doesNotMatch(renderAnswer(packet), /assumption by coding agent/);
  const conditional = {...packet, used: [{id: 'f1', version: 1}, {id: 'f2', version: 1}]};
  assert.match(renderAnswer(conditional), /definition by coding agent \(f1\) and assumption by coding agent \(f2\)/);
  assert.equal(renderAnswer({status: 'clarify', text: 'Which Ana did you mean?', required: []}), 'Which Ana did you mean?');
});

test('askMemory partial retrieval lists found rows without claiming an exhaustive answer', () => {
  const circuit = '@member predicate\n  args entity entity\n' + Array.from({length: 120}, (_, i) => `@f${i} fact\n  holds member m${i} club\n`).join('');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-wire-'));
  try {
    const repo = new Repository(root, {memory: {engine: 'sqlite'}});
    ingestFacts(repo, 'base', circuit, {knownAt: Date.parse('2024-01-01')});
    const session = repo.session('base', 'alice', 'render');
    const theory = new Theory([{name: 'circuit', text: circuit}]);
    const run = (query, limits) => askMemory({theory, repo, session, query, limits});
    const all = run('@q query\n  where member ?who club\n  select ?who\n');
    assert.equal(all.rows.length, 120);
    assert.match(renderAnswer(all), /^Answers: M0, M1, /);
    assert.match(renderAnswer(all), /and 112 more/);
    const partial = run('@q query\n  where member ?who club\n  select ?who\n', {maxFacts: 25});
    assert.equal(partial.complete, false);
    assert.match(renderAnswer(partial), /more answers may exist/);
    const limitedCount = run('@q query\n  mode count\n  where member ?who club\n', {maxFacts: 25});
    assert.equal(limitedCount.status, 'incomplete');
    assert.match(renderAnswer(limitedCount), /^At least \d+; the exact number cannot be given because the search was not exhaustive\./);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
test('a proof node can provide origin when packet annotations are absent, but cannot override unused evidence', () => {
  const result = {...ask('@q query\n  mode exists\n  where member ana club\n'), used: undefined, rows: [], query: {mode: 'exists'}, proof: {nodes: [
    {id: 'n1', kind: 'definition', origin: 'coding_agent', source: {id: 'f1', version: 1}, premises: []},
    {id: 'n2', kind: 'assumption', origin: 'coding_agent', source: {id: 'f2', version: 1}, premises: []}
  ], roots: ['n1']}};
  const text = renderAnswer(result);
  assert.match(text, /definition by coding agent \(f1\)/);
  assert.doesNotMatch(text, /assumption by coding agent/);
});

