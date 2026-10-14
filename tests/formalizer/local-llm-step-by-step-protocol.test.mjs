import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorld} from '../../tools/eval/symbolic-vs-llm/world.mjs';
import {createOracle} from '../../lib/query-author/step-by-step/index.mjs';
import {protocolQuery, METHODS, MAX_QUESTIONS, PROTOCOL_PREFIX, actQuestions} from '../../lib/query-author/step-by-step/protocol.mjs';
import * as questions from '../../lib/query-author/step-by-step/questions.mjs';
import {messageActs} from '../../sop/message-acts.mjs';
import {setReplyLayer, shippedCircuits} from '../../sop/replies.mjs';
import {seedCircuits} from '../../lib/knowledge-seeds.mjs';
import {parse as parseModel} from '../../sop/parser.mjs';
import {STEP_BY_STEP_METHODS, stepPrefix} from '../../lib/formalize/strategies.mjs';
import {FIRST_TURN_PREFIX} from '../../lib/query-author/step-by-step/prompts.mjs';
import {pairedBootstrap, decide} from '../../tools/eval/formalization/stepbystep-protocol/summarize.mjs';

const {KINDS} = questions;
const kind = name => String(KINDS.findIndex(f => f[0] === name) + 1);
const entity = (id, label = id.replaceAll('_', ' ')) => `@${id} entity\n  kind entity\n  label en "${label}"\n  alias en "${id}"\n`;
const pred = (id, args, label, description, closed = false) => `@${id} predicate\n  args ${args}\n  label en "${label}"\n  description "${description}"\n${closed ? '  closed true\n' : ''}`;
let n = 0;
const fact = atom => `@f${++n} fact\n  holds ${atom}\n`;

/** A scripted oracle: each rule answers the first matching question; unmatched questions get "0"; every question is recorded. */
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
const lineOf = (question, words) => question.split('\n').find(l => /^\d+\./.test(l) && l.includes(words))?.match(/^(\d+)\./)?.[1];

/** The lettered yes/no lines of the coarse acts question (one per group of the reply memory, then the request line), `yes` for the named groups. */
const acts = (...names) => [...actQuestions().groups.map(g => g.id), 'request'].map((g, i) => `${actQuestions().letters[i]}: ${names.includes(g) ? 'yes' : 'no'}`).join('\n');
/** The fine question's line number of the act with this description fragment. */
const act = words => q => lineOf(q, words);
/** The configured reply memory (conversation-v1 and the small-talk collections) for one test. */
const withCollections = async fn => {
  const ids = JSON.parse((await import('node:fs')).readFileSync(new URL('../../config/runtime.json', import.meta.url), 'utf8')).conversation.layers;
  setReplyLayer(ids.flatMap(id => seedCircuits(id).map(c => ({name: `${id}:${c.file}`, text: c.text}))), 'test collections');
  try { return await fn(); } finally { setReplyLayer(shippedCircuits(), 'shipped'); }
};

test('no hardcoded understanding: no cue table, no act list in code; the acts and their groups are reply-memory data', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../../lib/query-author/step-by-step/', import.meta.url);
  assert.ok(!fs.existsSync(new URL('cues.mjs', dir)) && !fs.existsSync(new URL('clauses.mjs', dir)), 'the regex cue table and the connective splitter are gone');
  for (const name of ['MESSAGE_ACTS', 'EMOTIONS', 'PRAGMATIC_DESCRIPTIONS']) assert.equal(questions[name], undefined, `${name} is data now`);
  const {groups, acts: declared} = messageActs();
  assert.ok(groups.length >= 5 && declared.has('greeting') && declared.has('sadness'));
  for (const a of declared.values()) assert.ok(a.description && a.group, a.kind);
  const coarse = actQuestions().coarse('Hello!');
  for (const g of groups) assert.ok(coarse.includes(g.line), g.id);
  assert.throws(() => parseModel('@p1 pragmatic\n  kind no_such_act\n  basis llm\n'), /pragmatic_kind_unknown/);
  await withCollections(async () => {
    assert.ok(messageActs().acts.has('how_are_you') && messageActs().acts.has('ask_joke') && messageActs().acts.has('crisis'));
    assert.ok(messageActs().groups.every(g => g.acts.length <= 12), 'no fine menu is longer than 12 lines');
    parseModel('@p1 pragmatic\n  kind how_are_you\n  basis llm\n');
  });
  assert.throws(() => parseModel('@p1 pragmatic\n  kind how_are_you\n  basis llm\n'), /pragmatic_kind_unknown/, 'conversation-v1 alone does not declare the collections\' acts');
});

test('a greeting alone is three short questions (kind, coarse acts, fine acts) and a pragmatic wire, with no query', async () => {
  const world = teamWorld();
  try {
    const {chat, asked} = scripted([{when: /Which kind of answer/, say: kind('none')}, {when: /do the words of this message contain it/, say: acts('courtesy')},
      {when: /Which of these exactly/, say: act('a greeting')}]);
    const r = await protocolQuery({message: 'Hello!', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'B'});
    assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
    assert.equal(asked.length, 3, 'the kind, the coarse acts question and the courtesy group');
    assert.equal(r.sop, '@p1 pragmatic\n  kind greeting\n  source local_llm_step_by_step\n  basis llm\n');
  } finally { world.dispose(); }
});

test('courtesy and an emotion next to a question become pragmatic wires next to the query', async () => {
  const world = teamWorld();
  try {
    const {chat} = scripted([
      {when: /Which kind of answer/, say: kind('count')},
      {when: /do the words of this message contain it/, say: acts('courtesy', 'upset', 'request')},
      {when: /Which of these exactly/, say: q => lineOf(q, 'thanks') ?? lineOf(q, 'frustration')},
      {when: /Besides/, say: '1'},
      {when: /Which statements does/, say: q => lineOf(q, 'member of the team')},
      {when: /Which of these says what the request asks/, say: '3'},
    ]);
    const r = await protocolQuery({message: 'Again: how many people are members of the Falcon team? Thanks.', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'B'});
    assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
    assert.match(r.sop, /mode count/);
    assert.match(r.sop, /@p1 pragmatic\n  kind thanks\n/);
    assert.match(r.sop, /@p2 pragmatic\n  kind frustration\n/);
  } finally { world.dispose(); }
});

test('acts of the reply memory: how are you, a joke request and the user\'s name reach their pragmatic wires (coarse, then fine)', async () => {
  const world = teamWorld();
  try {
    await withCollections(async () => {
      // "Hello, how are you?": nothing to look up and a question, but an act that is the whole request: no second kind question.
      let {chat, asked} = scripted([{when: /Which kind of answer/, say: kind('none')}, {when: /do the words of this message contain it/, say: acts('courtesy', 'request')},
        {when: /Which of these exactly/, say: q => [lineOf(q, 'a greeting'), lineOf(q, 'asks how the assistant is')].join(', ')}]);
      let r = await protocolQuery({message: 'Hello, how are you?', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'B'});
      assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
      assert.equal(r.sop, '@p1 pragmatic\n  kind greeting\n  source local_llm_step_by_step\n  basis llm\n@p2 pragmatic\n  kind how_are_you\n  source local_llm_step_by_step\n  basis llm\n');
      assert.ok(!asked.some(x => /seems to ask for something/.test(x)), 'no kind_again');
      // "Tell me a joke" read as a lookup kind: the act can be the whole request, the besides question says no.
      ({chat, asked} = scripted([{when: /Which kind of answer/, say: kind('list')}, {when: /do the words of this message contain it/, say: acts('play', 'request')},
        {when: /Which of these exactly/, say: act('a request for a joke')}, {when: /Besides/, say: '2'}]));
      r = await protocolQuery({message: 'Tell me a joke', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'B'});
      assert.equal(r.sop, '@p1 pragmatic\n  kind ask_joke\n  source local_llm_step_by_step\n  basis llm\n');
      // A question about the assistant the self layer does not answer: even after a "yes" to the besides question, 0 in the self
      // question leaves it to the act's reply.
      ({chat, asked} = scripted([{when: /Which kind of answer/, say: kind('self')}, {when: /do the words of this message contain it/, say: acts('about_assistant', 'request')},
        {when: /Which of these exactly/, say: act('has feelings')}, {when: /Besides/, say: '1'}, {when: /What does it want\?/, say: '0'}]));
      r = await protocolQuery({message: 'Do you ever feel anything?', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'B'});
      assert.equal(r.sop, '@p1 pragmatic\n  kind ask_feelings\n  source local_llm_step_by_step\n  basis llm\n');
      assert.ok(asked.some(x => /\n0\. none of these: something else about the assistant/.test(x)));
      // The user's name: the act copies it verbatim as the wire's span.
      ({chat} = scripted([{when: /Which kind of answer/, say: kind('statement')}, {when: /do the words of this message contain it/, say: acts('courtesy')},
        {when: /Which of these exactly/, say: q => [lineOf(q, 'a greeting'), lineOf(q, 'tells their own name')].join(',')}, {when: /Besides/, say: '2'}, {when: /^Copy the name/, say: 'Ioana'}]));
      r = await protocolQuery({message: 'Hi, I am Ioana.', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'B'});
      assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
      assert.match(r.sop, /kind introduction\n  span "Ioana"\n/);
    });
  } finally { world.dispose(); }
});

test('the methods have byte-identical cached prefixes and the strategy registry lists them', () => {
  assert.deepEqual(STEP_BY_STEP_METHODS, ['A', ...Object.keys(METHODS)]);
  assert.equal(stepPrefix('A'), FIRST_TURN_PREFIX);
  for (const m of Object.keys(METHODS)) assert.equal(stepPrefix(m), PROTOCOL_PREFIX);
  assert.ok(PROTOCOL_PREFIX.startsWith('Kinds of answer') && PROTOCOL_PREFIX.includes('Parts a request can have') && PROTOCOL_PREFIX.endsWith('<<<\n'));
  assert.doesNotMatch(PROTOCOL_PREFIX, /\d{4}-\d{2}-\d{2}T/, 'no clock or request data in the prefix');
});

function teamWorld() {
  n = 0;
  return createWorld([entity('falcon', 'Falcon'), entity('orbit', 'Orbit'), entity('ana_pop', 'Ana Pop'), entity('ion_rus', 'Ion Rus'), entity('eva_lup', 'Eva Lup'),
    pred('member_of', 'subject:entity object:entity', 'member of the team', 'A person (subject) is a member of the team (object, a team).', true),
    pred('joined_year', 'subject:entity object:integer', 'joined in year', 'A person (subject) joined in the year (object).', true),
    fact('member_of ana_pop falcon'), fact('member_of ion_rus falcon'), fact('member_of eva_lup orbit'),
    fact('joined_year ana_pop 2004'), fact('joined_year ion_rus 2009'), fact('joined_year eva_lup 2001')].join(''));
}

test('a name recorded in one place of a statement and the asked unknown are placed without a question (observed role fit)', async () => {
  const world = teamWorld();
  try {
    const {chat, asked} = scripted([
      {when: /Which kind of answer/, say: kind('count')},
      {when: /Which parts from the list/, say: '0'},
      {when: /Which statements does/, say: q => lineOf(q, 'member of the team')},
      {when: /Which of these says what the request asks/, say: '3'},
    ]);
    const r = await protocolQuery({message: 'How many people are members of the Falcon team?', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'D'});
    assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
    assert.match(r.sop, /mode count/);
    assert.match(r.sop, /relation "member_of"\n\s+role subject \?x\n\s+role object "falcon"/);
    assert.ok(!asked.some(q => /what are A and B/.test(q)), 'no places question');
    assert.ok(r.steps.length <= MAX_QUESTIONS);
  } finally { world.dispose(); }
});

test('a two-sided comparison uses the statement once per name and compares the two values', async () => {
  const world = teamWorld();
  try {
    const {chat} = scripted([
      {when: /Which kind of answer/, say: kind('yesno')},
      {when: /Which parts from the list/, say: '6'},
      {when: /How are they compared/, say: q => lineOf(q, 'smaller, earlier')},
      {when: /Which statements does/, say: q => lineOf(q, 'joined in year')},
      {when: /Which of these says what the request asks/, say: q => q.includes('neither') ? '3' : '1'},
    ]);
    const r = await protocolQuery({message: 'Did Ana Pop join earlier than Ion Rus?', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'D'});
    assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
    assert.match(r.sop, /role subject "ana_pop"\n\s+role object \?a\n/);
    assert.match(r.sop, /role subject "ion_rus"\n\s+role object \?b\n/);
    assert.match(r.sop, /compare \?a below \?b/);
  } finally { world.dispose(); }
});

test('a limit on a count per group becomes an aggregate session definition and a comparison', async () => {
  const world = teamWorld();
  try {
    const {chat} = scripted([
      {when: /Which kind of answer/, say: kind('list')},
      {when: /Which parts from the list/, say: '1'},
      {when: /Which limit does the request set with the number 1/, say: q => lineOf(q, 'more than 1')},
      {when: /Which statements does/, say: q => lineOf(q, 'member of the team')},
      {when: /what are A and B|which is [AB] in the request/, say: q => /what are A and B/.test(q) ? `A: ${lineOf(q, 'anything')}\nB: ${lineOf(q, 'asks for')}` : lineOf(q, 'asks for')},
      {when: /What does it limit/, say: q => lineOf(q, '(a count)')},
      {when: /Which of these says what the request asks/, say: q => q.includes('Which X are there such that') ? lineOf(q, 'Which X are there such that') : '3'},
    ]);
    const r = await protocolQuery({message: 'List the teams that have more than 1 member.', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'D'});
    assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
    assert.match(r.sop, / aggregate\n\s+over member_of \?m \?g\n\s+group \?g\n\s+count \?m as \?n/);
    assert.match(r.sop, /compare \?n1 above 1/);
  } finally { world.dispose(); }
});

test('the old yes/no confirmation is kept as the B-yesno ablation and the budget bounds every dialog', async () => {
  const world = teamWorld();
  try {
    const {chat, asked} = scripted([
      {when: /Which kind of answer/, say: kind('count')},
      {when: /Which statements does/, say: q => lineOf(q, 'member of the team')},
      {when: /Is this what the request asks/, say: 'yes'},
    ]);
    const r = await protocolQuery({message: 'How many people are members of the Falcon team?', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'B-yesno'});
    assert.equal(r.status, 'validated');
    assert.equal(r.confirmed, true);
    assert.ok(asked.some(q => /Is this what the request asks/.test(q)));
    await assert.rejects(protocolQuery({message: 'x', lexicon: world.lexicon, oracle: createOracle({chat}), method: 'Z'}), /unknown step-by-step method/);
  } finally { world.dispose(); }
});

test('the paired bootstrap and the preregistered stop rules', () => {
  const b = pairedBootstrap([1, 1, 1, 0, 1, 0, 1, 1, 1, 1]);
  assert.equal(b.point, 0.8);
  assert.ok(b.low > 0 && b.high <= 1);
  assert.equal(decide({point: 0.3, low: 0.1, high: 0.5}, 2, 2), 'decisive');
  assert.equal(decide({point: 0.3, low: 0.1, high: 0.5}, 5, 2), 'undecided', 'more wrong answers block a decisive stop');
  assert.equal(decide({point: 0, low: -0.1, high: 0.04}, 0, 0), 'futility');
  assert.equal(decide({point: 0.3, low: 0.1, high: 0.5}, 0, 0, {failedShare: 0.3}), 'broken');
});

test('problem mode: the values, the formulas and the options of a problem become session predicates, stated data, rules and queries', async () => {
  const world = teamWorld();
  try {
    const message = 'Plan A costs 400 CU fixed plus 8 CU per unit; Plan B costs 150 CU fixed plus 20 CU per unit. For 30 units, which plan is cheaper?';
    const {chat, asked} = scripted([
      {when: /Which kind of answer/, say: kind('problem')},
      {when: /What does it ask for\?/, say: '2'},
      {when: /List every number the problem gives/, say: 'fixed_a = 400\nunit_a = 8\nfixed_b = 150\nunit_b = 20\nunits = 30\ninvented = 999'},
      {when: /Write how each value the question asks for is computed/, say: 'total_a = fixed_a + unit_a * units\ntotal_b = fixed_b + unit_b * units'},
      {when: /Which computed value belongs to which option/, say: 'Plan A = total_a\nPlan B = total_b'},
      {when: /lowest or the highest/, say: '1'},
    ]);
    const r = await protocolQuery({message, lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'B'});
    assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
    assert.match(r.sop, /@fixed_a predicate\n {2}args object:value/);
    assert.match(r.sop, /relation "unit_b"\n {2}role object 20/);
    assert.doesNotMatch(r.sop, /999/, 'a number the message does not write is never stated');
    assert.match(r.sop, /when compute \?t1 \?v_unit_a times \?v_units/);
    assert.match(r.sop, /rank lowest \?v/);
    assert.ok(asked.length <= MAX_QUESTIONS);
    assert.equal(JSON.parse(r.report).problem.kind, 'choose');
  } finally { world.dispose(); }
});

test('problem mode: a deduction from stated facts and rules is a yes/no query over session properties', async () => {
  const world = teamWorld();
  try {
    const {chat} = scripted([
      {when: /Which kind of answer/, say: kind('problem')},
      {when: /What does it ask for\?/, say: '3'},
      {when: /List the facts the problem states/, say: 'Zed | is_glorp\nMoon | not is_blue'},
      {when: /List the general rules/, say: 'if is_glorp then is_blue'},
      {when: /Write what the question asks/, say: 'Zed | is_blue'},
    ]);
    const r = await protocolQuery({message: 'Every glorp is blue. Zed is a glorp. The Moon is not blue. Is Zed blue?', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'B'});
    assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
    assert.match(r.sop, /@r1 rule\n {2}when is_glorp \?x\n {2}then is_blue \?x/);
    assert.match(r.sop, /relation "is_blue"\n {2}role subject "Moon"\n {2}polarity negated/);
    // A problem is its own closed world: the answer predicate follows from the presence or the absence of is_blue Zed.
    assert.match(r.sop, /@rq rule\n {2}when is_blue "Zed"\n {2}then is_blue_follows "Zed"/);
    assert.match(r.sop, /@rqn rule\n {2}when absent is_blue "Zed"\n {2}then not is_blue_follows "Zed"/);
    assert.match(r.sop, /@q query\n {2}where match\n {4}relation "is_blue_follows"\n {4}role subject "Zed"/);
  } finally { world.dispose(); }
});

test('problem mode with the expression path: a numeric problem is one program over v1..vn, lowered and validated; no problem questions', async () => {
  const world = createWorld('@unit_cost predicate\n  args subject:entity object:integer\n  label en "costs"\n');
  try {
    const asked = [];
    const chat = async messages => {
      const q = messages.at(-1).content;
      asked.push(q);
      const say = /Which kind of answer/.test(q) ? kind('problem') : /For each line, do the words/.test(q) ? 'A: no\nB: no\nC: no\nD: no\nE: no\nF: no\nG: yes'
        : /Write the computation of what the question asks/.test(q) ? 'answer = v1 * v2\nunused: ' : '0';
      return {ok: true, text: say, ms: 1, usage: {input_tokens: 1, output_tokens: 1}};
    };
    const r = await protocolQuery({message: 'Pens cost 1.5 each. Mara buys 12 pens. What does she pay?', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'B', expression: {chat}});
    assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
    assert.match(r.sop, /compute \?t\d+ \?\w+ times \?\w+/);
    assert.equal(JSON.parse(r.report).problem.kind, 'expression');
    assert.ok(!asked.some(q => /List every number the problem gives/.test(q)), 'no value question');
  } finally { world.dispose(); }
});
