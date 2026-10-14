import test from 'node:test';
import assert from 'node:assert/strict';
import {score, equivalent, failureLayer} from '../../tools/eval/symbolic-vs-llm/score.mjs';
import {paired, stopDecision, summarize, report} from '../../tools/eval/symbolic-vs-llm/report.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stageRows, evidenceFor, alignProjection, runArm, armParserSettings} from '../../tools/eval/symbolic-vs-llm/run.mjs';
import {createWorld, execute, goldSlice, oracleOverSlice, linkCircuit, withDefinitions} from '../../tools/eval/symbolic-vs-llm/world.mjs';

const knowledge = '@member predicate\n  args subject:entity object:entity\n  closed true\n\n@alice entity\n  label en "Alice"\n\n@club entity\n  label en "Club"\n\n@f fact\n  holds member alice club\n';

test('benchmark scoring preserves conflict, unknown gold and complete lower bounds', () => {
  assert.equal(score({status: 'both'}, {status: 'supported'}).outcome, 'wrong');
  assert.equal(score({status: 'unknown'}, {status: 'unknown'}).outcome, 'correct');
  assert.equal(score({status: 'supported', count: 4}, {status: 'budget_exhausted', complete: false, count: 3}).outcome, 'unknown');
  assert.equal(score({status: 'supported', count: 4}, {status: 'supported', count: 4, complete: false}).outcome, 'unknown');
  assert.equal(score({status: 'supported', count: 4, bound: 'at_least'}, {status: 'supported', count: 4}).outcome, 'wrong');
  assert.equal(score({status: 'supported', rows: [{a: 'alice', b: 'club'}]}, {status: 'supported', rows: [{a: 'club', b: 'alice'}]}).outcome, 'wrong');
});

test('alpha-renamed single-column circuit answers are not false wrong answers', () => {
  const answer = alignProjection({status: 'supported', rows: [{who: 'alice'}]}, '@q query\n  select ?who\n', '@q query\n  select ?person\n');
  assert.equal(score({status: 'supported', rows: [{person: 'alice'}]}, answer).outcome, 'correct');
});

test('staged samples are nested, deterministic and keep depth strata visible', () => {
  const rows = Array.from({length: 600}, (_, i) => ({id: String(i), facts: 1000 * (1 + i % 3), depth: 1 + i % 10}));
  const hundred = stageRows(rows, 100), three = stageRows(rows, 300), full = stageRows(rows, 600);
  assert.deepEqual(three.slice(0, 100), hundred);
  assert.deepEqual(full.slice(0, 300), three);
  assert.deepEqual(stageRows([...rows].reverse(), 100), hundred);
  assert.equal(new Set(hundred.map(r => r.depth)).size, 10);
});

test('paired stopping excludes capped evidence and drops an arm only after first100', () => {
  const rows = Array.from({length: 100}, (_, i) => [
    {id: String(i), arm: 'A', outcome: 'wrong', evidence_does_not_fit: false},
    {id: String(i), arm: 'B', outcome: 'correct', evidence_does_not_fit: false}
  ]).flat();
  assert.equal(paired(rows).lo, 1);
  assert.equal(stopDecision(rows, 100).reason, 'decisive');
  assert.equal(paired(rows.map(r => ({...r, evidence_does_not_fit: true}))), null);
  const broken = rows.map(r => ({...r, outcome: r.arm === 'B' && +r.id < 21 ? 'invalid' : r.outcome, broken_model_output: r.arm === 'B' && +r.id < 21}));
  assert.deepEqual(stopDecision(broken, 100).dropped_arms, ['B']);
  assert.equal(stopDecision(broken.slice(0, 40), 20).stop, false);
});

test('first-100 broken-arm check counts empty and unparsable model output, not validator or engine failures', () => {
  const rows = Array.from({length: 100}, (_, i) => ({id: String(i), arm: 'B',
    outcome: i < 50 ? 'failed' : 'invalid', packet: {status: 'error', reason: 'engine_failure'},
    author: {status: 'invalid', parsed: true, validation: {problems: [{code: 'quantifier_not_used'}]}}}));
  assert.equal(stopDecision(rows, 100).reason, null);
  const boundary = rows.map((r, i) => ({...r, broken_model_output: i < 20}));
  assert.equal(stopDecision(boundary, 100).reason, null);
  const broken = boundary.map((r, i) => i === 20 ? {...r, broken_model_output: true, parse_ok: false} : r);
  assert.deepEqual(stopDecision(broken, 100).dropped_arms, ['B']);
  assert.deepEqual(stopDecision(broken, 100).broken_counts.B, {empty_or_unparsable: 21, denominator: 100});
  assert.equal(stopDecision([...rows.slice(0, 100), {id: '100', arm: 'B', response_empty: true}], 100).reason, null);
  assert.equal(stopDecision(rows.map((r, i) => i < 21 ? {...r, author: {status: 'invalid', parsed: false, validation: {problems: [{code: 'invalid_wire'}]}}} : r), 100).reason, 'broken');
});

test('direct answers attribute reasoning, parser and transport errors without blaming an engine', () => {
  const expected = {status: 'supported'};
  const wrong = {status: 'refuted'};
  assert.equal(score(expected, wrong).outcome, 'wrong');
  assert.equal(failureLayer({arm: 'A', outcome: 'wrong', packet: wrong, rendered: JSON.stringify(wrong)}), 'reasoning');
  const malformed = {status: 'error', reason: 'malformed_output'};
  assert.equal(score(expected, malformed).outcome, 'failed');
  assert.equal(failureLayer({arm: 'A', outcome: 'failed', packet: malformed, parseOk: false}), 'rendering');
  assert.equal(failureLayer({arm: 'A', outcome: 'failed', error: 'completion timed out'}), 'transport');
  assert.equal(failureLayer({arm: 'B', outcome: 'wrong', author: {status: 'validated'}, packet: wrong}), 'engine');
});

test('an unsafe authored projection is not an engine failure', () => {
  const world = createWorld(knowledge);
  try {
    const sop = '@q query\n  mode count\n  select ?person\n  where match\n    relation "member"\n    role subject "Alice"\n    role object "Club"\n    polarity affirmed\n  end\n';
    let error = null;
    try {
      const linked = linkCircuit(sop, 'Count memberships of Alice at Club.', world.lexicon);
      execute(world, linked.query);
    }
    catch (failure) { error = failure.message; }
    assert.equal(failureLayer({arm: 'C', outcome: 'failed', author: {status: 'validated'}, error, packet: null}), 'authoring');
  } finally { world.dispose(); }
});

test('paired comparisons match within families, and proof and cost rates keep their denominators', () => {
  const rows = [
    {family: 'F1', id: 'shared', arm: 'A', outcome: 'wrong', cost_usd: 0, verified: false},
    {family: 'F1', id: 'shared', arm: 'B', outcome: 'correct', verified: true, proof_available: true, cost_usd: 0.03},
    {family: 'F2', id: 'shared', arm: 'A', outcome: 'correct', cost_usd: 0, verified: false},
    {family: 'F2', id: 'shared', arm: 'B', outcome: 'failed', verified: false, proof_available: true, cost_usd: 0.01}
  ];
  assert.equal(paired(rows).n, 2);
  assert.equal(paired(rows).mean, 0);
  const b = summarize(rows.filter(r => r.arm === 'B'));
  assert.deepEqual([b.proof_validity.numerator, b.proof_validity.denominator], [1, 2]);
  assert.deepEqual([b.verified_correct.numerator, b.verified_correct.denominator], [1, 2]);
  assert.equal(b.cost_per_100, 2);
  assert.match(report(rows, {pilot: true}).markdown, /\| Cost USD \/ 100 \|/);
  assert.match(report(rows, {pilot: true}).markdown, /\| Verified correct \/ n \|/);
  assert.match(report(rows, {pilot: true}).markdown, /\| F1\/B\/fits \|[^\n]*\| 3\.0000 \|/);
});

test('real compiler, SQLite slice and oracle preserve exact gold evidence membership', () => {
  const world = createWorld(knowledge);
  try {
    const query = '@q query\n  where member ?person club\n  select ?person\n';
    const gold = execute(world, query), slice = goldSlice(world, query, gold);
    assert.deepEqual(gold.rows, [{person: 'alice'}]);
    assert.equal(slice.facts.length, 1);
    assert.equal(equivalent(gold, oracleOverSlice(slice, query)), true);
    const linked = linkCircuit('@q query\n  where match\n    relation "member"\n    role subject ?person\n    role object "Club"\n    polarity affirmed\n  end\n  select ?person\n', 'Who is a member of Club?', world.lexicon);
    assert.ok(linked.query);
    assert.deepEqual(execute(world, linked.query).rows, [{person: 'alice'}]);
    assert.throws(() => goldSlice(world, query, {...gold, retrieval: {...gold.retrieval, facts: 2}}), /membership differs/);
  } finally { world.dispose(); }
});

test('capped English evidence explicitly removes complete-list declarations', () => {
  const world = createWorld(knowledge);
  try {
    const query = '@q query\n  where member ?person club\n  select ?person\n';
    const gold = execute(world, query), slice = goldSlice(world, query, gold);
    const capped = evidenceFor(slice, 'Which members belong to Club?', {maxChars: 1000, sampleFacts: 0});
    assert.equal(capped.evidence_does_not_fit, false);
    const many = {...slice, facts: Array.from({length: 200}, (_, i) => ({...slice.facts[0], id: 'extra' + i}))};
    const partial = evidenceFor(many, 'Which members belong to Club?', {maxChars: 1000, sampleFacts: 0});
    assert.equal(partial.evidence_does_not_fit, true);
    assert.match(partial.source, /partial keyed sample/);
    assert.doesNotMatch(partial.source, /The list of member is complete/);
  } finally { world.dispose(); }
});

test('first failing layer and dangerous-error denominators remain separate', () => {
  assert.equal(failureLayer({outcome: 'wrong', author: {status: 'validated'}, oracleEquivalent: false, packet: {status: 'supported'}}), 'authoring');
  assert.equal(failureLayer({outcome: 'invalid', author: {status: 'invalid', validation: {problems: [{code: 'entity_id_not_listed'}]}}}), 'linking');
  const cell = summarize([
    {outcome: 'wrong', gold_answerable: true, packet: {status: 'supported'}},
    {outcome: 'unknown', gold_answerable: true, packet: {status: 'unknown'}},
    {outcome: 'correct', gold_answerable: false, packet: {status: 'unknown'}},
    {outcome: 'unknown', gold_answerable: false, packet: {status: 'clarify'}}
  ]);
  assert.equal(cell.wrong_among_answered.denominator, 1);
  assert.equal(cell.unknown_rate.numerator, 1);
  assert.equal(cell.unknown_rate.denominator, 2);
});

test('turn-local suppositions answer conditionally without altering an empty base', () => {
  const world = createWorld(knowledge.slice(0, knowledge.indexOf('@f fact')));
  try {
    const sop = '@s stated\n  relation "member"\n  role subject "Alice"\n  role object "Club"\n  polarity affirmed\n  certainty supposed\n\n@q query\n  where match\n    relation "member"\n    role subject "Alice"\n    role object "Club"\n    polarity affirmed\n  end\n  if $s\n';
    const linked = linkCircuit(sop, 'Suppose Alice is a member of Club. Is Alice a member?', world.lexicon);
    const packet = execute(withDefinitions(world, null, linked.context), linked.query);
    assert.equal(packet.status, 'supported');
    assert.deepEqual(packet.conditional, ['s']);
    assert.equal(execute(world, linked.query).status, 'refuted');
  } finally { world.dispose(); }
});

test('gold evidence preserves all/any joins rather than dropping Boolean groups', () => {
  const world = createWorld(knowledge + '\n@other entity\n  label en "Other"\n\n@bob entity\n  label en "Bob"\n\n@g fact\n  holds member alice other\n\n@h fact\n  holds member bob club\n');
  try {
    for (const op of ['all', 'any']) {
      const query = `@q query\n  where ${op}\n    member ?person club\n    member ?person other\n  end\n  select ?person\n`;
      const gold = execute(world, query), slice = goldSlice(world, query, gold);
      const expected = op === 'all' ? [{person: 'alice'}] : [{person: 'alice'}, {person: 'bob'}];
      assert.deepEqual(gold.rows, expected);
      assert.deepEqual(oracleOverSlice(slice, query).rows, expected);
    }
  } finally { world.dispose(); }
});

test('H3 retains symbolic B/C pairs when only English evidence exceeds its cap', () => {
  const records = [
    {id: 'dense', family: 'f1', arm: 'B', outcome: 'correct', evidence_does_not_fit: true},
    {id: 'dense', family: 'f1', arm: 'C', outcome: 'wrong', evidence_does_not_fit: true}
  ];
  const comparisons = report(records).summary.comparisons.f1;
  assert.equal(comparisons.fits, null);
  assert.equal(comparisons.B_minus_C.n, 1);
  assert.equal(comparisons.B_minus_C.mean, 1);
});

/** One arm of the harness on a tiny world: the gold, its slice and English evidence prepared as main() does. */
async function armOnWorld(arm, settings, {question = 'Who is a member of Club?', query = '@q query\n  where member ?person club\n  select ?person\n'} = {}) {
  const world = createWorld(knowledge), folder = fs.mkdtempSync(path.join(os.tmpdir(), 'symbolic-arm-test-'));
  try {
    const gold = execute(world, query), slice = goldSlice(world, query, gold);
    const row = {id: 'r1', family: 'f1', facts: 1, depth: 1, split: 'dev', question, expected: {status: 'supported', rows: [{person: 'alice'}]}};
    return await runArm({row, arm, world, gold, slice, evidence: evidenceFor(slice, question), knowledge, query, settings, folder});
  } finally { world.dispose(); fs.rmSync(folder, {recursive: true, force: true}); }
}
const memberCircuit = '@q query\n  where match\n    relation "member"\n    role subject ?who\n    role object "Club"\n    polarity affirmed\n  end\n  select ?who\n';

test('arm C answers through the chat turn (ChatSOPAdapter, mode stepwise) and is scored on the chat packet', async () => {
  const record = await armOnWorld('C', {wallMs: 60000, maxTokens: 4096, replayCircuit: memberCircuit});
  assert.equal(record.packet.adapter.object, 'chatsop.answer');
  assert.equal(record.packet.adapter.mode, 'stepwise');
  assert.equal(record.packet.adapter.circuits[0].sop, memberCircuit);
  assert.match(record.rendered, /Alice/);
  // The alpha-renamed projection (?who) is scored by the gold query's column names.
  assert.deepEqual(record.packet.rows, [{person: 'alice'}]);
  assert.equal(record.outcome, 'correct');
  assert.equal(record.model, 'reviewed-circuit');
  assert.equal(record.author.status, 'validated');
  assert.equal(record.author.parsed, true);
  assert.equal(record.verified, true);
  assert.equal(record.oracle_equivalent, true);
  assert.equal(record.offline_verification.outcome, 'agreed');
  assert.equal(record.failure_layer, null);
  assert.equal(record.tokens_out, null);
  assert.deepEqual(JSON.parse(JSON.stringify(record)).packet.rows, record.packet.rows);
});

test('arm C: an invalid reviewed circuit is refused by the validator inside the chat turn, never executed', async () => {
  const record = await armOnWorld('C', {wallMs: 60000, replayCircuit: memberCircuit.replace('"member"', '"owns"').replace('select ?who', 'select ?nobody')});
  assert.equal(record.outcome, 'invalid');
  assert.equal(record.author.status, 'invalid');
  assert.ok(record.author.problems.length > 0);
  assert.equal(record.packet, null);
  assert.equal(record.verified, false);
});

test('arm B-stepbystep: the request parser of the chat gets the arm settings and its parse record fills the author record', async () => {
  const seen = [];
  const localFactory = (name, local, options) => {
    seen.push({name, local, options});
    return {name, tag: 'stub', availability: async () => ({available: true, models: [local.tier], skipped: []}),
      async run({message, repo, session}) {
        assert.equal(message, 'Who is a member of Club?');
        assert.ok(repo && session, 'the strategy reads the chat session');
        return {ok: true, status: 'validated', sop: memberCircuit, model: local.tier, usage: {cost_usd: 0},
          steps: [{name: 'relation', answer: '1', tier: local.tier, ok: true, ms: 3}, {name: 'roles', answer: '2', tier: local.tier, ok: true, ms: 4}]};
      }};
  };
  const settings = {wallMs: 60000, maxTokens: 4096, localTier: 'micro', localFactory};
  const record = await armOnWorld('B-stepbystep', settings);
  assert.deepEqual(seen.map(s => [s.name, s.local.tier, s.local.method, s.local.reasoningControl, s.local.tags.purpose, s.options.timeoutMs]),
    [['LocalLLMStepByStep', 'micro', 'A', 'plan', 'job:symbolic-vs-llm', 60000]]);
  assert.equal(armParserSettings('C', {}).local.tier, 'small');
  assert.equal(armParserSettings('C', {}).local.method, 'B');
  assert.equal(armParserSettings('C', {}).cacheEntries, 0);
  assert.equal(record.packet.adapter.mode, 'stepwise');
  assert.equal(record.packet.parse.strategy, 'LocalLLMStepByStep');
  assert.equal(record.outcome, 'correct');
  assert.equal(record.model, 'tier:micro');
  assert.equal(record.author.steps.length, 2);
  assert.equal(record.author.method, 'A');
  assert.ok(Number.isFinite(record.latency.parse_ms) && Number.isFinite(record.latency.turn_ms));
  assert.equal(record.verified, true);
});
