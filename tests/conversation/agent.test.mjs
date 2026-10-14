import test from 'node:test';
import assert from 'node:assert/strict';
import {Agent} from '../../server/agent.mjs';
import {context, lex, assertReply} from '../helpers.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';

/** A scripted formalizer (the injection point of Agent.turn): answers the replies in order and records every message it receives. */
function mock(t, responses) {
  let i = 0;
  const requests = [];
  return {formalizer: {id: 'scripted', formalize: async text => { requests.push(text); return responses[i++].trim(); }}, requests};
}

/** The Agent with the scripted formalizer injected into every turn. */
class ScriptedAgent extends Agent {
  constructor(options, m) { super(options); this.m = m; }
  turn(text, options = {}) { return super.turn(text, {formalizer: this.m.formalizer, ...options}); }
}

/** An agent over a fresh repository context that is disposed after the test. */
async function agentWith(t, replies, options = {}, config = {}, lexicon = lex) {
  const c = context(options);
  t.after(c.dispose);
  const m = mock(t, replies);
  const agent = new ScriptedAgent({repo: c.repo, session: c.session, lexicon, config}, m);
  return {c, m, agent};
}
const turn = {language: 'en', rewrite: false};
/** A context-free model-language proposition: quoted relation phrase and role values as written. */
const prop = (id, type, relation, roles, extra = type === 'stated' ? ['certainty asserted'] : [], polarity = 'affirmed') =>
  [`@${id} ${type}`, `  relation ${JSON.stringify(relation)}`, ...Object.entries(roles).map(([name, value]) => `  role ${name} ${/^\?/.test(value) ? value : JSON.stringify(value)}`), `  polarity ${polarity}`, ...extra.map(line => '  ' + line)].join('\n');
/** A model-language query with one match block. */
const ask = (relation, roles, tail = '') => `@q query\n  where match\n    relation ${JSON.stringify(relation)}\n` + Object.entries(roles).map(([name, value]) => `    role ${name} ${/^\?/.test(value) ? value : JSON.stringify(value)}\n`).join('') + `    polarity affirmed\n  end\n` + tail;
const works = (subject, extra) => prop('s', 'stated', 'works at', {subject, object: 'Alpha Lab'}, extra);
const worksAsk = subject => ask('work at', {subject, object: 'Alpha Lab'});

test('the model sees only the message; the host exposes a separate execution circuit', async t => {
  const answer = ask('grandmother', {subject: 'Ana', object: 'Carina'});
  const {m, agent} = await agentWith(t, [answer, answer]);
  const first = await agent.turn('Is Ana the grandmother of Carina?', turn);
  assert.equal(first.packet.status, 'supported');
  assert.equal(first.sop, answer.trim());
  assert.match(first.executionSop, /@\w+ solve/);
  assert.doesNotMatch(first.sop, /\b(?:solve|remember|cnl)\b/);
  assert.equal((await agent.turn('Why?', turn)).packet.status, 'supported', 'the mock repeats the question; no context was sent');
  assert.equal(m.requests[0], 'Is Ana the grandmother of Carina?', 'the formalizer receives the message and nothing else');
  assert.equal(m.requests[1], 'Why?', 'no context is sent');
});

test('model-authored operations and documentary provenance never run', async t => {
  const declarativeOnly = /Model output must be declarative: stated, assumed, unclear, query, constraint, unparsed, pragmatic or instruction/;
  const forbidden = [
    ['@p fact\n  holds works_at maria lab_alpha\n  valid timeless', declarativeOnly],
    [worksAsk('Maria') + '@s remember\n  input $q', declarativeOnly],
    ['@x jsEval\n  expr 1 + 2', declarativeOnly],
    ['@q query\n  where works_at maria lab_alpha', /query_needs_match/],
    [works('Maria', ['certainty asserted', 'quote "Maria works at Alpha Lab"']), /Unsupported field quote on stated/],
  ];
  const {c, agent} = await agentWith(t, forbidden.map(([reply]) => reply));
  for (const [reply, message] of forbidden) {
    await assert.rejects(() => agent.turn('Maria works at Alpha Lab.', turn), message, reply);
  }
  assert.equal(Object.keys(c.session.live.claims).length, 0);
});

test('a stated value must be mentioned in this message, with typo and inflection tolerance; an assumption need not be', async t => {
  const {agent} = await agentWith(t, []);
  assert.throws(() => agent.validateVocabulary(works('Carina'), 'Maria works at Alpha Lab.'), /stated_value_not_in_message: "Carina"/);
  assert.doesNotThrow(() => agent.validateVocabulary(works('Maria'), 'Maria works at Alpha Lab.'));
  assert.doesNotThrow(() => agent.validateVocabulary(works('Maria'), 'Mraia works at Alpah Lab.'), 'small typos are tolerated');
  assert.doesNotThrow(() => agent.validateVocabulary(prop('s', 'stated', 'lucrează la', {subject: 'Maria', object: 'Alpha Lab'}), 'Mariei i se spune că lucrează la Alpha Lab.'), 'inflections are tolerated');
  assert.doesNotThrow(() => agent.validateVocabulary(prop('a', 'assumed', 'works at', {subject: 'Carina', object: 'Alpha Lab'}), 'Maria works at Alpha Lab.'));
  assert.throws(() => agent.validateVocabulary(works('Maria', ['certainty asserted', 'speaker "Carina"']), 'Maria works at Alpha Lab.'), /speaker "Carina"/);
  assert.doesNotThrow(() => agent.validateVocabulary(works('Maria', ['certainty asserted', 'speaker "Carina"']), 'Carina says that Maria works at Alpha Lab.'));
});

test('a stated user assertion is evidence for the turn, carried in the conversation and never stored', async t => {
  const {c, m, agent} = await agentWith(t, [works('Carina') + '\n' + worksAsk('Carina'), worksAsk('Carina')], {bootstrap: false});
  const first = await agent.turn('Carina works at Alpha Lab. Does Carina work at Alpha Lab?', turn);
  assert.equal(first.packet.status, 'supported');
  assert.equal(first.packet.hypothetical, false);
  assert.deepEqual(first.userStatements.map(s => [s.atom, s.predicate, s.certainty, s.treatment]), [['works_at carina lab_alpha', 'works_at', 'asserted', 'evidence']]);
  const second = await agent.turn('Does Carina still work at Alpha Lab?', turn);
  assert.equal(second.packet.status, 'supported', 'the earlier statement is re-supplied by the host');
  assert.deepEqual(second.carriedStatements.map(s => s.atom), ['works_at carina lab_alpha']);
  assert.ok(!m.requests[1].includes('works_at'), 'carried statements stay with the host, not in the prompt');
  assert.equal(Object.keys(c.session.live.claims).length, 0);
});

test('entity strings are linked by the host with type checks; an ill-typed or unknown value is asked about', async t => {
  const {c, agent} = await agentWith(t, [prop('s', 'stated', 'works at', {subject: 'Alpha Lab', object: 'Maria'}), worksAsk('Mystery')]);
  const typed = await agent.turn('Alpha Lab works at Maria.', turn);
  assert.equal(typed.packet.status, 'clarify');
  assert.match(typed.cnl, /Which entity do you mean by "Alpha Lab"/);
  const unknown = await agent.turn('Does Mystery work at Alpha Lab?', turn);
  assert.equal(unknown.packet.status, 'clarify');
  assert.equal(Object.keys(c.session.live.claims).length, 0);
});

test('English entity strings resolve through reviewed labels with one model call per turn', async t => {
  const {m, agent} = await agentWith(t, [ask('work at', {subject: 'Maria', object: 'Alpha Lab'}), ask('work at', {subject: 'Maria', object: 'Alpha Lab'})]);
  const first = await agent.turn('Does Maria work at Alpha Lab?', turn);
  const second = await agent.turn('Maria works at Alpha Lab?', turn);
  assert.equal(first.packet.status, 'supported');
  assert.equal(second.packet.status, 'supported');
  assert.match(first.executionSop, /@\w+ resolve/);
  assert.equal(m.requests.length, 2);
});

test('ambiguous and unknown entity strings request clarification before downstream querying', async t => {
  const bank = new Lexicon('@has predicate\n  args person\n  label en "has"\n@person1 entity\n  kind person\n  label en "bank"\n@person2 entity\n  kind person\n  label en "bank"');
  const {c, m, agent} = await agentWith(t, [ask('has', {subject: 'bank'}), ask('has', {subject: 'mystery'})], {bootstrap: false}, {}, bank);
  const ambiguous = await agent.turn('Does bank have it?', turn);
  assert.equal(ambiguous.packet.status, 'clarify');
  assert.equal(ambiguous.packet.reason, 'unresolved_link');
  assert.deepEqual(ambiguous.packet.required[0].candidates.map(x => x.id), ['person1', 'person2']);
  assert.match(ambiguous.answer ?? ambiguous.text ?? JSON.stringify(ambiguous.packet), /bank/);
  assert.match(ambiguous.packet.pendingSop, /@q query/);
  const unknown = await agent.turn('Does mystery have it?', turn);
  assert.equal(unknown.packet.status, 'clarify');
  assert.equal(m.requests.length, 2);
  assert.equal(Object.keys(c.session.live.claims).length, 0);
});

test('an unknown relation phrase is asked about, not guessed', async t => {
  const {agent} = await agentWith(t, [ask('fly to', {subject: 'Maria', object: 'Alpha Lab'})]);
  const answer = await agent.turn('Does Maria fly to Alpha Lab?', turn);
  assert.equal(answer.packet.status, 'clarify');
  assert.equal(answer.packet.reason, 'unresolved_link');
  assert.match(answer.cnl, /I do not know the relation "fly to"/);
});

test('reported speech stays attributed and conditional', async t => {
  const {agent} = await agentWith(t, [works('Maria', ['certainty asserted', 'speaker "Carina"']) + '\n' + worksAsk('Maria')], {bootstrap: false});
  const answer = await agent.turn('Carina says that Maria works at Alpha Lab. Does Maria work at Alpha Lab?', turn);
  assert.equal(answer.packet.status, 'supported');
  assert.equal(answer.packet.hypothetical, true);
  assert.match(answer.userStatements[0].statement, /^According to Carina: /);
  assert.match(answer.cnl, /Condition: According to Carina/);
});

test('model assumptions are reported, never used by the primary answer; an ambiguous one is asked about only when branched', async t => {
  const assumed = prop('a', 'assumed', 'works at', {subject: 'Maria', object: 'Alpha Lab'}, ['basis default']);
  const {agent} = await agentWith(t, [assumed + '\n' + worksAsk('Maria')], {bootstrap: false});
  const answer = await agent.turn('Does Maria work at Alpha Lab?', turn);
  assert.equal(answer.packet.status, 'unknown');
  assert.equal(answer.assumptionPolicy, 'report');
  assert.deepEqual(answer.modelAssumptions.map(a => [a.predicate, a.basis, a.treatment]), [['works_at', 'default', 'reported']]);
  const bank = new Lexicon('@has predicate\n  args person\n  label en "has"\n@person1 entity\n  kind person\n  label en "bank"\n@person2 entity\n  kind person\n  label en "bank"\n@ana entity\n  kind person\n  label en "Ana"');
  const reply = prop('a', 'assumed', 'has', {subject: 'bank'}, ['basis disambiguation']) + '\n' + ask('has', {subject: 'Ana'});
  const reported = await agentWith(t, [reply], {bootstrap: false}, {}, bank);
  assert.equal((await reported.agent.turn('Does Ana have it?', turn)).packet.status, 'unknown');
  const branched = await agentWith(t, [reply], {bootstrap: false}, {policy: {modelAssumptions: 'branch'}}, bank);
  const asked = await branched.agent.turn('Does Ana have it?', turn);
  assert.equal(asked.packet.status, 'clarify', 'the host never lets an assumption choose an ambiguous identity');
});

test('unclear is the only wire; the reply is English', async t => {
  const {agent, m} = await agentWith(t, ['@u unclear\n  kind gibberish', '@u unclear\n  kind no_request', '@u unclear\n  kind gibberish\n' + worksAsk('Maria')]);
  const english = await agent.turn('asdf qwer zxcv', turn);
  assert.equal(english.packet.status, 'unclear');
  assert.equal(english.unclear, 'gibberish');
  await assertReply(english.cnl, 'gibberish');
  assert.equal(english.executionSop, '');
  const none = await agent.turn('ok then', turn);
  assert.match(none.packet.reply.body.situation, /^no_request/);
  await assertReply(none.englishText, none.packet.reply.body.situation);
  assert.equal(none.answerLanguage, 'en');
  await assert.rejects(() => agent.turn('asdf', turn), /unclear_not_alone/);
  assert.equal(m.requests.length, 3);
});

test('an understood question without an engine is answered as not computable, not refused', async t => {
  const {agent} = await agentWith(t, ['@c constraint\n  var ?x int\n  require ?x at_least 3\n  claim ?x at_least 1\n  task prove']);
  const answer = await agent.turn('Is every number at least three also at least one?', turn);
  assert.equal(answer.packet.status, 'not_computable');
  assert.match(answer.cnl, /I understood the question as: .*I cannot compute this kind of answer yet/);
});

// AGENTS rule 7 and DS006: a proof-use promotion is a write, so the packet the
// Agent returns must declare it, and a read-only host policy must prevent it.
test('proof-use reinforcement is reported in the agent packet and suppressed by a read-only policy', async t => {
  const memory = {power: 16, arity: 3, retention: {reinforceOnUse: true, writeStrength: 1, useStrength: 2}};
  const c = context({bootstrap: false, memory});
  t.after(c.dispose);
  await c.run('@f fact\n  holds likes ana lab_alpha\n  valid timeless\n  source user\n@s remember\n  input $f');
  const question = ask('likes', {subject: 'Ana', object: 'Alpha Lab'});
  const m = mock(t, [question, question]);
  const reading = policy => new ScriptedAgent({repo: c.repo, session: c.session, lexicon: lex, config: {policy}}, m);
  const promoted = await reading({}).turn('Ana likes Alpha Lab?', turn);
  assert.equal(promoted.packet.status, 'supported');
  assert.deepEqual(promoted.packet.reinforcement, {facts: 1, strength: 2});
  const readOnly = await reading({reinforce: false}).turn('Ana likes Alpha Lab?', turn);
  assert.equal(readOnly.packet.status, 'supported');
  assert.equal(readOnly.packet.reinforcement, undefined);
});
