import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatData} from '../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../lib/chat-data/memories.mjs';
import {Sessions} from '../../lib/chat-data/sessions.mjs';
import {SessionRuntimes} from '../../server/session-runtime.mjs';
import {Theory, askMemory} from '../../reasoning/slice/index.mjs';
import {validateQuery} from '../../lib/query-author/index.mjs';
import {admitCircuits} from '../../lib/query-author/session.mjs';
import {AuthorRuntime} from '../../lib/query-author/runtime.mjs';
import {tempDir} from '../helpers.mjs';

const KNOWLEDGE = `@employee predicate
  args subject:entity
  closed true
@eligible predicate
  args subject:entity
@away predicate
  args subject:entity
@ada entity
  kind entity
  label en "Ada"
@bea entity
  kind entity
  label en "Bea"
@e1 fact
  holds employee ada
@e2 fact
  holds employee bea
@a1 fact
  holds away bea
@not_eligible fact
  holds not eligible bea
@typically_eligible default
  when employee ?x
  then eligible ?x
  except away ?x
@workforce predicate
  args subject:integer
@headcount aggregate
  over employee ?person
  count ?person as ?n
  yields workforce ?n
`;
const match = (p, who = '?person') => `  where match\n    relation "${p}"\n    role subject ${who}\n    polarity affirmed\n  end\n`;
const QUERY = `@q query\n  select ?person\n${match('eligible')}`;
function fixture(t) {
  const data = ChatData.open({chatData: {root: tempDir(t, 'author-session-')}}, {}, process.cwd());
  const memories = new BaseMemories({chatData: data, memory: {engine: 'sqlite'}});
  memories.create({id: 'work', name: 'Work', strategy: 'sqlite'});
  memories.addKnowledge('work', {circuits: [{name: 'people', text: KNOWLEDGE}], approvedBy: 'test'});
  const sessions = new Sessions({chatData: data, memories, memory: {engine: 'sqlite'}});
  sessions.create({base: 'work', user: 'test', id: 'turn'});
  const runtime = new SessionRuntimes({sessions, memories, config: {policy: {reinforce: false}}});
  const opened = runtime.open('turn', {user: 'test'});
  return {sessions, memories, opened, agent: opened.entry('test').agent};
}
const turn = (agent, sop, message = 'Who is eligible?') => agent.turn(message, {formalizer: {id: 'test-author', formalize: async () => sop}});

test('chat and askMemory use identical defaults and exceptions from the accepted theory', async t => {
  const f = fixture(t);
  const r = await turn(f.agent, QUERY);
  const direct = askMemory({theory: new Theory([...f.sessions.baseCircuits('turn'), ...f.sessions.circuits('turn')]), repo: f.opened.repo, session: f.agent.session, query: '@q query\n  select ?person\n  where eligible ?person\n', reasoning: 'auto'});
  assert.equal(r.packet.status, direct.status);
  assert.deepEqual(r.packet.answers.map(x => x.binding['?person']), direct.rows.map(x => x.person));
  assert.deepEqual(r.packet.answers.map(x => x.binding['?person']), ['ada']);
  assert.ok(r.packet.used.some(x => x.id === 'typically_eligible'));
});

test('chat reads accepted aggregates and complete counts through the shared theory', async t => {
  const f = fixture(t);
  const aggregate = await turn(f.agent, `@q query\n  select ?n\n${match('workforce', '?n')}`, 'What is the workforce count?');
  assert.deepEqual(aggregate.packet.answers.map(x => x.binding['?n']), [2]);
  assert.ok(aggregate.packet.used.some(x => x.id === 'headcount'));
  const count = await turn(f.agent, `@q query\n  mode count\n${match('employee')}`, 'How many employees are there?');
  assert.equal(count.packet.count, 2);
});

test('a closed predicate defined by the coding agent answers negation and stays in its own session', async t => {
  const f = fixture(t);
  const query = '@q query\n' + match('listed', '"Ada"').replace('affirmed', 'negated');
  const closed = await turn(f.agent, '@listed predicate\n  args subject:entity\n  closed true\n' + query, 'Is Ada not listed?');
  assert.equal(closed.packet.status, 'supported');
  assert.ok(closed.packet.origins.some(x => x.id === 'listed' && x.kind === 'definition'));
  assert.match(closed.text, /definition by coding agent/);
  assert.equal(f.sessions.circuits('turn').length, 1, 'the definition joins the session layer');
  const fresh = fixture(t);
  const open = await turn(fresh.agent, '@listed predicate\n  args subject:entity\n' + query, 'Is Ada not listed?');
  assert.equal(open.packet.status, 'unknown', 'another session does not see it: an open predicate does not answer negation');
});

test('coding-agent definitions join the session layer once they validate (no manual acceptance)', async t => {
  const f = fixture(t);
  const definitions = '@available predicate\n  args subject:entity\n@availability rule\n  when eligible ?x\n  then available ?x\n';
  const r = await turn(f.agent, definitions + QUERY.replace('eligible', 'available'), 'Who is available?');
  assert.deepEqual(r.packet.answers.map(x => x.binding['?person']), ['ada']);
  assert.ok(r.packet.origins.some(x => x.id === 'availability' && x.origin === 'coding_agent' && x.kind === 'definition'));
  assert.match(r.text, /definition by coding agent/);
  assert.equal(r.packet.session_circuits.status, 'added');
  assert.equal(f.sessions.circuits('turn').length, 1, 'the definition is in the session layer');
  assert.equal(f.memories.circuits('work').length, 1, 'the base memory did not change');
  f.agent.lexicon = f.sessions.lexicon('turn');
  const after = await turn(f.agent, QUERY.replace('eligible', 'available'));
  assert.deepEqual(after.packet.answers.map(x => x.binding['?person']), ['ada']);
});

test('undeclared body predicates and memory declaration replacements are rejected', t => {
  const f = fixture(t);
  const circuits = f.sessions.baseCircuits('turn');
  const validate = sop => validateQuery({sop, message: 'Who is eligible?', lexicon: f.agent.lexicon, circuits});
  assert.ok(validate('@unknown rule\n  when fictional ?x\n  then eligible ?x\n' + QUERY).problems.some(x => x.code === 'unknown_predicate'));
  assert.ok(validate('@employee predicate\n  args subject:entity\n  closed false\n' + QUERY).problems.some(x => x.code === 'duplicate_id'));
});

test('turn-local positional atoms cannot evade declared arity checks inside groups or rule heads', t => {
  const f = fixture(t);
  const circuits = f.sessions.baseCircuits('turn');
  const definition = '@department_pay predicate\n  args subject:entity object:entity topic:integer\n@mistaken rule\n  when all\n    department_pay department_vlad_dev_285 firm_vlad_dev_285\n  end\n  then eligible department_vlad_dev_285\n';
  const text = definition + QUERY;
  const result = validateQuery({sop: text, message: 'Who is eligible?', lexicon: f.agent.lexicon, circuits});
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].code, 'arity_mismatch');
  assert.throws(() => admitCircuits(text, 'Who is eligible?', f.agent.lexicon, {circuits}), /arity_mismatch: department_pay is declared with arity 3 but used with 2/);
  const badHead = '@department_pay predicate\n  args subject:entity object:entity topic:integer\n@mistaken rule\n  when employee ?x\n  then department_pay ?x ada\n' + QUERY;
  assert.equal(validateQuery({sop: badHead, message: 'Who is eligible?', lexicon: f.agent.lexicon, circuits}).problems[0].code, 'arity_mismatch');
});

test('a coding-agent default keeps its exception and origin', async t => {
  const f = fixture(t);
  const definitions = '@admitted predicate\n  args subject:entity\n@normally_admitted default\n  when employee ?x\n  then admitted ?x\n  except away ?x\n';
  const r = await turn(f.agent, definitions + QUERY.replace('eligible', 'admitted'), 'Who is admitted?');
  assert.deepEqual(r.packet.answers.map(x => x.binding['?person']), ['ada']);
  assert.ok(r.packet.origins.some(x => x.id === 'normally_admitted' && x.origin === 'coding_agent'));
  assert.equal(f.sessions.circuits('turn').length, 1);
});

test('a contrary coding-agent assumption is defeated by memory in its branch', async t => {
  const f = fixture(t);
  f.agent.config.policy.modelAssumptions = 'branch';
  const sop = '@guess assumed\n  relation "eligible"\n  role subject "Bea"\n  polarity affirmed\n  basis world\n@q query\n' + match('eligible', '"Bea"');
  const r = await turn(f.agent, sop, 'Is Bea eligible?');
  assert.equal(r.packet.status, 'refuted');
  assert.equal(r.packet.assumption_branch[0].status, 'refuted');
  assert.ok(r.packet.session_conflicts.some(x => x.reason === 'memory_wins'));
  assert.equal(f.sessions.circuits('turn').length, 0);
});

test('the shared runtime keeps the unconsumed-assumption guard', async t => {
  const f = fixture(t);
  const runtime = new AuthorRuntime({circuits: f.sessions.baseCircuits('turn'), repo: f.opened.repo, session: f.agent.session, lexicon: f.agent.lexicon});
  await assert.rejects(runtime.run('@orphan fact\n  holds eligible bea\n  valid timeless\n  source assumption\n'), /assumption_fact_unconsumed/);
  await assert.rejects(runtime.run('@a fact\n  holds eligible bea\n  valid timeless\n  source assumption\n@q query\n  where eligible bea\n@s solve\n  query $q\n  assume $a\n  data $a\n'), /assumption_fact_not_evidence/);
  assert.equal(f.sessions.circuits('turn').length, 0);
});
