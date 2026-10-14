// The behaviour layer (DS023 "Behaviour layer", experiments/proposal/behaviour-layer.md): the user's standing instructions, drives
// with cooldowns and occasions, and decisions over the time since the last reaction of a kind, all decided by the JS oracle over the
// conversation layer. Code maps the turn to facts and the instructions to SOP data; it never chooses a reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Agent} from '../../server/agent.mjs';
import {SessionStore} from '../../server/session-store.mjs';
import {parse} from '../../sop/parser.mjs';
import {compileDeclarative} from '../../sop/declarative.mjs';
import {admitModel} from '../../lib/query-author/admit.mjs';
import {emptyBehaviour, applyInstructions, overlayOf, timeFacts, personalFacts} from '../../lib/conversation/behaviour.mjs';
import {composeReply, layerInfo} from '../../lib/conversation/index.mjs';
import {createWorld} from '../../tools/eval/symbolic-vs-llm/world.mjs';
import {createOracle} from '../../lib/query-author/step-by-step/index.mjs';
import {protocolQuery} from '../../lib/query-author/step-by-step/protocol.mjs';
import {KINDS, INSTRUCTION_ASPECTS} from '../../lib/query-author/step-by-step/questions.mjs';
import {assertReply, tempDir} from '../helpers.mjs';

const KNOWLEDGE = [
  '@works_at predicate\n  args subject:entity object:entity\n  label en "works at"\n',
  '@located_in predicate\n  args subject:entity location:entity\n  label en "located in"\n',
  '@maria entity\n  label en "Maria"\n', '@acme entity\n  label en "Acme"\n', '@cluj entity\n  label en "Cluj"\n',
  '@f1 fact\n  holds works_at maria acme\n', '@f2 fact\n  holds located_in acme cluj\n',
].join('');
const ASK = '@q query\n  select ?y\n  where match\n    relation "works_at"\n    role subject "Maria"\n    role object ?y\n    polarity affirmed\n  end\n';
const instruction = (action, kind = null, text = null) => `@i instruction\n  do ${action}\n${kind ? `  kind ${kind}\n` : ''}${text ? `  text ${JSON.stringify(text)}\n` : ''}`;
const parts = r => ['prefix', 'opening', 'body', 'aside', 'follow_up', 'closing', 'suffix'].map(p => r.packet.reply[p]?.situation).filter(Boolean);

function chat(t) {
  const world = createWorld(KNOWLEDGE);
  t.after(world.dispose);
  const agent = new Agent({repo: world.repo, session: world.session, lexicon: world.lexicon, config: {}});
  let now = Date.parse('2026-10-02T15:00:00Z');
  const say = async (message, sop, {after = 60_000} = {}) => { now += after; return agent.turn(message, {now, formalizer: {id: 'stub', formalize: async () => sop}}); };
  return {agent, say, world};
}

test('the instruction wire: parse, model compilation and admission (the words must be in the message)', () => {
  assert.throws(() => parse('@i instruction\n  do set\n  text "OK:"\n'), /instruction_kind_required/);
  assert.throws(() => parse('@i instruction\n  do list\n  kind prefix\n'), /instruction_list_form/);
  assert.throws(() => parse('@i instruction\n  do set\n  kind short\n  text "x"\n'), /instruction_text/);
  assert.throws(() => parse('@i instruction\n  do stop\n'), /instruction do must be one of/);
  const plan = compileDeclarative(instruction('set', 'prefix', "I'm here:"), {inputText: 'start with I\'m here:'});
  assert.deepEqual(plan.instructions.map(i => [i.do, i.kind, i.text]), [['set', 'prefix', "I'm here:"]]);
  assert.equal(admitModel(instruction('set', 'prefix', "I'm here:"), 'From now on always start your answers with «I’m here:»').wires.length, 1, 'quotation marks of any style compare equal');
  assert.throws(() => admitModel(instruction('set', 'prefix', 'Hello:'), 'start with OK:'), /instruction_text_not_in_message/);
});

test('an instruction changes every later reply, is listed, and is withdrawn; the reasoner applies it as data', async t => {
  const {say, agent} = chat(t);
  const set = await say("From now on always start your answers with 'I'm here:'", instruction('set', 'prefix', "I'm here:"));
  assert.match(set.text, /^I'm here: /);
  assert.deepEqual(parts(set), ['user_ui1', 'instruction_set']);
  assert.deepEqual(set.packet.behaviour.instructions.map(i => [i.kind, i.text]), [['prefix', "I'm here:"]]);
  const answer = await say('Where does Maria work?', ASK);
  assert.match(answer.text, /^I'm here: /);
  assert.ok(answer.packet.reply.prefix.why.some(l => /cv_ui1_rule/.test(l)), 'the derivation names the user rule');
  const listed = await say('What are my instructions?', instruction('list'));
  assert.equal(listed.packet.reply.body.situation, 'instructions_listed');
  assert.match(listed.text, /start my answers with "I'm here:"/);
  const stop = await say("Stop starting with I'm here", instruction('cancel', 'prefix'));
  assert.equal(stop.packet.reply.body.situation, 'instruction_cancelled');
  assert.doesNotMatch(stop.text, /^I'm here:/);
  const after = await say('Where does Maria work?', ASK);
  assert.doesNotMatch(after.text, /I'm here:/);
  const none = await say('What are my instructions?', instruction('list'));
  assert.equal(none.packet.reply.body.situation, 'instructions_none');
  const missing = await say('Stop that', instruction('cancel', 'suffix'));
  assert.equal(missing.packet.reply.body.situation, 'instruction_missing');
  assert.equal(agent.context.behaviour.history[0].cancelled.turn, 4);
});

test('a style instruction: short answers until detailed is asked; detailed also overrides the short style of urgency', async t => {
  const {say} = chat(t);
  await say('Keep your answers short', instruction('set', 'short'));
  const short = await say('Where does Maria work?', ASK);
  assert.equal(short.packet.reply.style, 'short');
  assert.ok(!short.text.includes('\n'));
  await say('Give detailed answers', instruction('set', 'detailed'));
  const urgent = await say('Where does Maria work? Quick!', ASK + '\n@p pragmatic\n  kind urgency\n  basis llm\n');
  assert.equal(urgent.packet.reply.style, 'detailed', 'detailed is active, short was withdrawn and urgency does not shorten');
  assert.deepEqual(urgent.packet.behaviour.instructions.map(i => i.kind), ['detailed']);
});

test('a drive fires only on its occasion and after its cooldown; frustration triggers the check-back drive', async t => {
  const {say} = chat(t);
  const fired = [];
  for (let i = 1; i <= 7; i++) { const r = await say('Where does Maria work?', ASK); fired.push(r.packet.reply.aside?.situation ?? null); }
  // aside_fact: cooldown 3 turns, counted from the start of the conversation, then from its last use.
  assert.deepEqual(fired, [null, null, 'aside_fact', null, null, 'aside_fact', null]);
  const r = await say('Where does Maria work? I asked this already!', ASK + '\n@p pragmatic\n  kind frustration\n  basis llm\n');
  assert.equal(r.packet.reply.opening.situation, 'open_sorry');
  assert.equal(r.packet.reply.follow_up?.situation, 'check_helped');
  assert.equal(r.packet.reply.aside, null, 'no aside for a frustrated user');
  const third = (await say('Where does Maria work?', ASK)).packet.reply.aside;
  assert.equal(third?.situation, 'aside_fact');
  assert.match(third ? 'ok' : '', /ok/);
});

test('greeting again: the first greeting introduces the assistant, a greeting within the hour is answered as a return', async t => {
  const {say} = chat(t);
  const greet = '@p pragmatic\n  kind greeting\n  basis llm\n';
  const first = await say('hello', greet);
  assert.match(first.packet.reply.body.situation, /^courtesy_greeting/);
  const again = await say('hi', greet, {after: 120_000});
  assert.equal(again.packet.reply.body.situation, 'courtesy_greeting_again');
  await assertReply(again.text, 'courtesy_greeting_again');
  assert.ok(again.packet.reply.body.why.some(l => /cv_seconds_since greeting/.test(l)));
  const later = await say('hello', greet, {after: 2 * 3600_000});
  assert.equal(later.packet.reply.body.situation, 'courtesy_greeting');
});

test('the behaviour of a conversation is saved and restored with it', async t => {
  const dir = tempDir(t, 'behaviour-');
  const world = createWorld(KNOWLEDGE);
  t.after(world.dispose);
  const store = new SessionStore({repo: world.repo, lexicon: world.lexicon, config: {}, root: dir});
  const entry = store.get('ana', 'c1', 'base');
  await entry.agent.turn('start with OK:', {formalizer: {id: 'stub', formalize: async () => instruction('set', 'prefix', 'OK:')}});
  store.save(entry, 'ana', 'c1', 'base');
  const again = new SessionStore({repo: world.repo, lexicon: world.lexicon, config: {}, root: dir}).get('ana', 'c1', 'base');
  assert.deepEqual(again.agent.context.behaviour.instructions.map(i => [i.kind, i.text]), [['prefix', 'OK:']]);
  const r = await again.agent.turn('Where does Maria work?', {formalizer: {id: 'stub', formalize: async () => ASK}});
  assert.match(r.text, /^OK: /);
});

test('the behaviour data: an instruction becomes a reply wire and a rule; time facts count turns and seconds', () => {
  const state = emptyBehaviour();
  const out = applyInstructions(state, [{do: 'set', kind: 'suffix', text: 'Cheers.'}], {turn: 1, at: 0});
  assert.deepEqual(out.facts, ['cv_turn_instruction_set suffix', 'cv_instruction_active suffix']);
  assert.match(overlayOf(state), /@cv_ui1_reply reply\n {2}situation user_ui1\n {2}part suffix\n {2}language en\n {2}text "Cheers."/);
  state.reactions.greeting = {turn: 1, at: 0};
  assert.deepEqual(timeFacts(state, {drives: ['aside_fact']}, {turn: 3, at: 90_000}), ['cv_turn_number 3', 'cv_turns_since greeting 2', 'cv_seconds_since greeting 90', 'cv_turns_since aside_fact 3']);
});

test('step-by-step kind `instruction`: one numbered question, the words copied from the message', async () => {
  const world = createWorld(KNOWLEDGE);
  try {
    const run = async (message, answers) => {
      const chatFn = async messages => {
        const q = messages.at(-1).content;
        const say = /Which kind of answer/.test(q) ? String(KINDS.findIndex(k => k[0] === 'instruction') + 1)
          : /What does it ask\?/.test(q) ? String(INSTRUCTION_ASPECTS.findIndex(a => a[0] === answers.aspect) + 1)
          : /Copy/i.test(q) ? answers.copy ?? '0' : /Which instruction should be stopped/.test(q) ? answers.stop ?? '0' : '0';
        return {ok: true, text: say, ms: 1, usage: {input_tokens: 1, output_tokens: 1}};
      };
      return protocolQuery({message, lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat: chatFn}), method: 'B'});
    };
    const set = await run("From now on start every answer with «I'm here:»", {aspect: 'prefix', copy: "«I'm here:»"});
    assert.equal(set.status, 'validated', JSON.stringify(set.validation?.problems));
    assert.match(set.sop, /@i1 instruction\n {2}do set\n {2}kind prefix\n {2}text "I'm here:"/);
    const stop = await run("Stop starting with I'm here", {aspect: 'cancel', stop: '1'});
    assert.match(stop.sop, /do cancel\n {2}kind prefix/);
    const list = await run('What are my instructions?', {aspect: 'list'});
    assert.match(list.sop, /do list/);
  } finally { world.dispose(); }
});

test('the register is a conversation instruction: formal and playful exclude each other and add no style rule (P-2.2)', async t => {
  const {say, agent} = chat(t);
  const formal = await say('From now on please answer formally', instruction('set', 'formal'));
  assert.equal(formal.packet.reply.body.situation, 'instruction_set');
  assert.deepEqual(agent.context.behaviour.instructions.map(i => i.kind), ['formal']);
  assert.equal(overlayOf(agent.context.behaviour), '', 'the layer derives cv_register from cv_instruction_active; no style rule');
  await say('Be playful from now on', instruction('set', 'playful'));
  assert.deepEqual(agent.context.behaviour.instructions.map(i => i.kind), ['playful'], 'playful withdrew formal');
});

test('the user\'s name and the time of day fill their slots when known; a reply that needs an unknown slot is left out, never a failure (P-2.3)', async t => {
  const {say, agent} = chat(t);
  const intro = await say("Hi, I'm Ioana", '@p1 pragmatic\n  kind greeting\n  basis llm\n@p2 pragmatic\n  kind introduction\n  span "Ioana"\n  basis llm\n');
  assert.equal(intro.packet.reply.body.situation, 'courtesy_introduction_named');
  assert.match(intro.text, /Ioana/);
  assert.equal(agent.context.behaviour.slots.user_name, 'Ioana');
  const later = await say('Hello again', '@p1 pragmatic\n  kind greeting\n  basis llm\n', {after: 2 * 3600_000});
  assert.equal(later.packet.reply.body.situation, 'courtesy_greeting_named');
  assert.match(later.text, /Ioana/);
  // Without a name: the named situation does not apply, and a named variant with a missing slot is not applicable.
  const state = emptyBehaviour();
  const info = layerInfo();
  const morning = personalFacts(state, [], info, {at: new Date(2026, 9, 3, 9, 30).getTime()});
  assert.deepEqual(morning, {facts: ['cv_turn_time_of_day morning'], slots: {time_of_day: 'morning'}});
  assert.deepEqual(personalFacts(state, [], info, {at: new Date(2026, 9, 3, 23, 30).getTime()}).facts, ['cv_turn_time_of_day night']);
  const noName = composeReply({packet: {status: 'courtesy', pragmatic: [{kind: 'introduction', score: 1}]}, seed: 1, facts: ['cv_turn_number 2']});
  assert.equal(noName.reply.body.situation, 'courtesy_introduction', 'the named replies need user_name: left out, the unnamed one is used');
  const forced = composeReply({packet: {status: 'courtesy', pragmatic: [{kind: 'greeting', score: 1}]}, seed: 1, facts: ['cv_turn_user_name', 'cv_turn_number 2']});
  assert.notEqual(forced.reply.body.situation, 'courtesy_greeting_named', 'a fact without its slot never fails the turn');
});
