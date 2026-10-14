import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generalityCases, HELD_OUT_FORMS, COMPOSITIONS} from '../../tools/datasets/diversity/generality.mjs';
import {heldoutCheck, SIGNATURES} from '../../tools/eval/formalization/generality/heldout-check.mjs';
import {rescore} from '../../tools/eval/formalization/generality/run.mjs';
import {runArm} from '../../tools/eval/symbolic-vs-llm/run.mjs';
import {createWorld, execute} from '../../tools/eval/symbolic-vs-llm/world.mjs';
import {verifyAnswer} from '../../reasoning/strategies/js-reference/index.mjs';
import {compare} from '../../eval/smoke-reasoning/lib/compare.mjs';
import {parse} from '../../sop/knowledge/lexical.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {entityHints} from '../../lib/query-author/retrieval.mjs';
import {kindFromRanges} from '../../tools/world-kb/mapping.mjs';

const rows = generalityCases({per: 2});
const strip = ({requires, ...rest}) => rest;

test('generality generator: 10 held-out forms and 5 compositions, gold by construction agrees with the reference oracle', () => {
  assert.equal(HELD_OUT_FORMS.length, 10);
  assert.equal(COMPOSITIONS.length, 5);
  assert.equal(rows.length, 30);
  for (const row of rows) {
    const got = verifyAnswer({theory: {knowledge: row.knowledge + row.gold_defs}, query: row.query});
    const verdict = compare(strip(row.expected), got);
    // The reference refutes a closed join only per leaf; the product refutes the whole closed join (see run.mjs gold check).
    assert.ok(verdict.ok || (row.expected.status === 'refuted' && got.status === 'unknown'), `${row.id}: ${verdict.why.join('; ')}`);
    assert.ok(!/\bg_/.test(row.knowledge), `${row.id}: gold definitions never enter the memory`);
  }
});

test('held-out check: every level-b phrasing matches its signature and appears in no guide, dev set, example or test', () => {
  for (const row of rows.filter(r => r.level === 'b')) assert.match(row.question, SIGNATURES[row.form], row.id);
  const result = heldoutCheck();
  assert.ok(result.scanned.guide >= 2 && result.scanned.dev >= 3 && result.scanned.test > 10);
  assert.deepEqual(result.hits, []);
});

test('reviewed model-surface circuits of every form run through admission, KnowledgeLinker and the engine (zero-model replay)', async () => {
  for (const row of rows.filter(r => r.form !== 'counterfactual-closure' || r.id.endsWith('-1'))) {
    const world = createWorld(row.knowledge), folder = fs.mkdtempSync(path.join(os.tmpdir(), 'generality-test-'));
    try {
      const gold = verifyAnswer({theory: {knowledge: row.knowledge + row.gold_defs}, query: row.query});
      const settings = {subscriptionModel: 'zai/glm-5.3', wallMs: 60000, maxTokens: 4096, authorBackend: {id: 'replay', kind: 'replay', async generate() { return {ok: true, sop: row.reference, usage: {}, duration_ms: 0}; }}};
      const record = await runArm({row: {...row, family: row.form, expected: strip(row.expected)}, arm: 'C', world, gold, slice: {facts: [], wires: parse(row.knowledge).wires},
        evidence: {source: '', evidence_does_not_fit: false, facts: 0, original_chars: 0}, knowledge: row.knowledge, query: row.query, settings, folder});
      assert.equal(rescore(row, record), 'correct', `${row.id}: ${record.outcome} ${JSON.stringify(record.author?.problems ?? record.reasons)}`);
    } finally { world.dispose(); fs.rmSync(folder, {recursive: true, force: true}); }
  }
});

test('lexicon: an English possessive is not part of a name, tried only after the whole surface matched nothing', () => {
  const lexicon = Lexicon.fromCircuits([{name: 'm.sop', text: '@napoleon entity\n  kind entity\n  label en "Napoleon"\n@james entity\n  kind entity\n  label en "James"\n'}]);
  assert.equal(lexicon.resolve("Napoleon's", {language: 'en', kind: 'entity'}).id, 'napoleon');
  assert.equal(lexicon.resolve('James’s', {language: 'en', kind: 'entity'}).id, 'james');
  assert.equal(lexicon.resolve("Zork's", {language: 'en', kind: 'entity'}).status, 'unknown');
});

test('entity hints: a capitalised sentence-initial word is marked initial (not a strong name by capitalisation)', () => {
  const lexicon = Lexicon.fromCircuits([{name: 'm.sop', text: '@health_care entity\n  kind entity\n  label en "Care"\n@france entity\n  kind entity\n  label en "France"\n'}]);
  const hints = entityHints('Care este capitala lui France?', lexicon);
  assert.equal(hints.find(h => h.surface === 'Care').initial, true);
  assert.equal(hints.find(h => h.surface === 'France').initial, false);
});

test('world-kb: the most frequent property range decides an unselected item class; priority only breaks ties', () => {
  assert.equal(kindFromRanges(new Map([['country', 59], ['place', 38], ['person', 1]])), 'country');
  assert.equal(kindFromRanges(new Map([['country', 2], ['person', 2]])), 'person');
  assert.equal(kindFromRanges(new Map()), undefined);
});

test('a query without select is a yes/no question: known values that all fail its comparison refute it (reference and product)', () => {
  const knowledge = '@joined predicate\n  args subject:entity object:integer\n@f1 fact\n  holds joined ana 2001\n@f2 fact\n  holds joined bob 1999\n';
  const query = '@q query\n  where all\n    joined ana ?x\n    joined bob ?y\n  end\n  compare ?x below ?y\n';
  assert.equal(verifyAnswer({theory: {knowledge}, query}).status, 'refuted');
  const world = createWorld(knowledge);
  try { assert.equal(execute(world, query).status, 'refuted'); } finally { world.dispose(); }
});
