// InternalReasoningStepByStep (DS022 "InternalReasoningStepByStep") with a scripted oracle: the planner decides each question, the
// protocol's defaults avoid questions the memory already answers, two-sided comparisons and per-group limits are assembled by the
// shared circuit writer, the greedy ablation formalizes the same circuit, a puzzle needs no statement, a message with nothing to look
// up is a pragmatic wire, an unreadable answer stops honestly, and the trace says why each question was asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld} from '../../tools/eval/symbolic-vs-llm/world.mjs';
import {internalReasoningQuery, createReasoningOracle, internalReasoningPrefix, loadProtocol} from '../../lib/formalize/internal-reasoning/index.mjs';

const protocol = loadProtocol();
const KINDS = protocol.questions.get('ask_kind').choices.map(c => c.value);
const kind = name => String(KINDS.indexOf(name) + 1);
const entity = (id, label = id.replaceAll('_', ' ')) => `@${id} entity\n  kind entity\n  label en "${label}"\n  alias en "${id}"\n`;
const pred = (id, args, label, description, closed = false) => `@${id} predicate\n  args ${args}\n  label en "${label}"\n  description "${description}"\n${closed ? '  closed true\n' : ''}`;
let n = 0;
const fact = atom => `@f${++n} fact\n  holds ${atom}\n`;
const lineOf = (question, words) => question.split('\n').find(l => /^\d+\./.test(l) && l.includes(words))?.match(/^(\d+)\./)?.[1];
const NO_ACTS = {when: /For each line, do the words/, say: 'A: no\nB: no\nC: no\nD: no\nE: no\nF: no\nG: yes'};

function scripted(rules) {
  const asked = [];
  const chat = async messages => {
    const question = messages.at(-1).content;
    asked.push(question);
    const rule = rules.find(r => r.when.test(question));
    return {ok: true, text: rule ? (typeof rule.say === 'function' ? rule.say(question) : rule.say) : '0', ms: 1, usage: {input_tokens: 10, output_tokens: 1}, cached: 8, evaluated: 2};
  };
  return {chat, asked};
}

function teamWorld() {
  n = 0;
  return createWorld([entity('falcon', 'Falcon'), entity('orbit', 'Orbit'), entity('ana_pop', 'Ana Pop'), entity('ion_rus', 'Ion Rus'), entity('eva_lup', 'Eva Lup'),
    pred('member_of', 'subject:entity object:entity', 'member of the team', 'A person (subject) is a member of the team (object, a team).', true),
    pred('joined_year', 'subject:entity object:integer', 'joined in year', 'A person (subject) joined in the year (object).', true),
    fact('member_of ana_pop falcon'), fact('member_of ion_rus falcon'), fact('member_of eva_lup orbit'),
    fact('joined_year ana_pop 2004'), fact('joined_year ion_rus 2009'), fact('joined_year eva_lup 2001')].join(''));
}

const run = (world, message, rules, extra = {}) => {
  const {chat, asked} = scripted(rules);
  return internalReasoningQuery({message, lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createReasoningOracle({chat, protocol}), protocol, ...extra}).then(r => ({r, asked}));
};

test('the stable prefix is rendered from the protocol memory: the kinds and the first aspects, byte-identical for every request', () => {
  const prefix = internalReasoningPrefix(protocol);
  assert.equal(prefix.firstTurn, internalReasoningPrefix(loadProtocol()).firstTurn);
  assert.ok(prefix.firstTurn.startsWith('Kinds of answer a request can want:\n1. ') && prefix.firstTurn.includes('\n\nParts a request can have:\n1. ') && prefix.firstTurn.endsWith("The user's request:\n<<<\n"));
  assert.equal(prefix.firstTurn.split('\n').filter(l => /^\d+\. /.test(l)).length, KINDS.length + 8);
  assert.match(prefix.system, /^You help a symbolic reasoning system/);
  assert.doesNotMatch(prefix.firstTurn, /\d{4}-\d{2}-\d{2}T/, 'no clock or request data in the prefix');
});

test('a count over one statement: the planner asks the kind, the acts, the own-data gate, the aspects and the statements; the memory places the name and the asked unknown', async () => {
  const world = teamWorld();
  try {
    const {r, asked} = await run(world, 'How many people are members of the Falcon team?', [
      {when: /Which kind of answer/, say: kind('count')}, NO_ACTS, {when: /Which parts from the list/, say: '0'},
      {when: /Which statements does/, say: q => lineOf(q, 'member of the team')}, {when: /Which of these says/, say: q => lineOf(q, 'How many different X')}]);
    assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
    assert.match(r.sop, /mode count/);
    assert.match(r.sop, /relation "member_of"\n\s+role subject \?x\n\s+role object "falcon"/);
    assert.ok(!asked.some(q => /what are A and B/.test(q)), 'no places question');
    assert.equal(r.confirmed, true);
    assert.ok(r.defaults.some(d => d.default === 'd_observed_place' && /place i1 object n\d+/.test(d.atom)), JSON.stringify(r.defaults));
    assert.deepEqual(r.trace.filter(e => e.chosen).map(e => e.chosen.split(' ')[0]), ['ask_kind', 'ask_acts', 'ask_own_data', 'ask_aspects', 'ask_statements', 'ask_places', 'assemble', 'ask_contrast']);
    assert.ok(r.trace.every(e => e.control === 'plan'));
    assert.match(r.explanation, /Step 5: ask_statements q \(plan; plan ask_statements q → .*assemble none/);
    assert.match(r.explanation, /needed statements q ← rule need_statements/);
    const report = JSON.parse(r.report);
    assert.equal(report.questions, r.steps.length);
    assert.ok(report.engine_ms_per_decision > 0);
  } finally { world.dispose(); }
});

test('a two-sided comparison is the statement twice, once per name, with the two values compared', async () => {
  const world = teamWorld();
  try {
    const {r} = await run(world, 'Did Ana Pop join earlier than Ion Rus?', [
      {when: /Which kind of answer/, say: kind('yesno')}, NO_ACTS, {when: /Which parts from the list/, say: '6'},
      {when: /How are they compared/, say: q => lineOf(q, 'smaller, earlier')}, {when: /Which statements does/, say: q => lineOf(q, 'joined in year')},
      {when: /Which of these says/, say: q => lineOf(q, 'Is it true that')}]);
    assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
    assert.match(r.sop, /role subject "ana_pop"\n\s+role object \?ca\n/);
    assert.match(r.sop, /role subject "ion_rus"\n\s+role object \?cb\n/);
    assert.match(r.sop, /compare \?ca below \?cb/);
    assert.ok(r.defaults.some(d => d.atom === 'polarity q affirmed'), 'no truth question without a negation');
  } finally { world.dispose(); }
});

test('a limit on a count per group becomes an aggregate session definition and a comparison; the greedy ablation writes the same circuit', async () => {
  const rules = [
    {when: /Which kind of answer/, say: kind('list')}, NO_ACTS, {when: /Which parts from the list/, say: '1'},
    {when: /Which limit does the request set with the number 1/, say: q => lineOf(q, 'more than 1')}, {when: /Which statements does/, say: q => lineOf(q, 'member of the team')},
    {when: /what are A and B/, say: q => `A: ${lineOf(q, 'anything')}\nB: ${lineOf(q, 'asks for')}`}, {when: /What does it limit/, say: q => lineOf(q, '(a count)')},
    {when: /Which of these says/, say: q => lineOf(q, 'Which X are there such that')}];
  const world = teamWorld();
  try {
    const plan = (await run(world, 'List the teams that have more than 1 member.', rules)).r;
    assert.equal(plan.status, 'validated', JSON.stringify(plan.validation?.problems));
    assert.match(plan.sop, / aggregate\n\s+over member_of \?m \?g\n\s+group \?g\n\s+count \?m as \?n/);
    assert.match(plan.sop, /compare \?n1 above 1/);
    const greedy = (await run(world, 'List the teams that have more than 1 member.', rules, {control: 'greedy'})).r;
    assert.equal(greedy.sop, plan.sop);
    assert.ok(greedy.trace.filter(e => e.chosen).every(e => e.control === 'greedy'));
    await assert.rejects(run(world, 'x', rules, {control: 'random'}), /unknown control/);
  } finally { world.dispose(); }
});

test('a numeric puzzle needs no statement; a message with nothing to look up is its pragmatic wires', async () => {
  const world = teamWorld();
  try {
    const puzzle = (await run(world, 'Let x and y be integers from 0 to 5; is there an assignment with x + y = 4?', [
      {when: /Which kind of answer/, say: kind('puzzle')}, NO_ACTS, {when: /List each unknown/, say: 'x: 0 to 5\ny: 0 to 5'},
      {when: /Write each condition/, say: 'x + y = 4'}, {when: /What does the request want/, say: '1'}])).r;
    assert.equal(puzzle.status, 'validated', JSON.stringify(puzzle.validation?.problems));
    assert.match(puzzle.sop, /@q constraint\n\s+var \?x int 0 5\n\s+var \?y int 0 5\n\s+require \?x plus \?y equal 4\n\s+task possible/);
    // The message names a thing of the memory, so the schema neighbourhood offers statements and the kind question is asked.
    const hello = (await run(world, 'Hello Ana Pop, thanks!', [{when: /Which kind of answer/, say: kind('none')}, {when: /For each line, do the words/, say: 'A: yes\nB: yes\nC: no\nD: no\nE: no\nF: no\nG: no'}])).r;
    assert.equal(hello.status, 'validated', JSON.stringify(hello.validation?.problems));
    assert.match(hello.sop, /@p1 pragmatic\n\s+kind greeting/);
    assert.match(hello.sop, /@p2 pragmatic\n\s+kind thanks/);
    assert.equal(hello.steps.length, 2);
  } finally { world.dispose(); }
});

test('an answer that cannot be read twice stops honestly with status failed', async () => {
  const world = teamWorld();
  try {
    const {r} = await run(world, 'How many people are members of the Falcon team?', [{when: /Which kind of answer/, say: 'I think it is a count'}]);
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /kind question could not be read/);
    assert.equal(r.steps.length, 2);
  } finally { world.dispose(); }
});
