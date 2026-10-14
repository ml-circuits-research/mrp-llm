// Words-only model constructs (DS014 "Words, not operators", owner decisions Q-LANG-1 to Q-LANG-7): parsing and
// admission, host lowering and the reasoner's semantics for compare, except, rank, quantifier, order, fragment,
// "the user", advice and word arithmetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parse} from '../../sop/parser.mjs';
import {checkModelProgram, completeFragment} from '../../sop/declarative.mjs';
import {wordsToExpression} from '../../sop/conditions.mjs';
import {quantifiedStatus, numericValue} from '../../reasoning/bridge/index.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {Repository} from '../../memory/repository.mjs';
import {publishKnowledge} from '../../sop/ingest.mjs';

const ONTOLOGY = `@costs predicate
  role subject asset
  role object integer
  label en "cost"

@aged predicate
  role subject person
  role object integer
  label en "be aged"

@works_at predicate
  role subject person
  role object organization
  label en "work at"

@certified predicate
  role subject person
  label en "be certified"

@left_for predicate
  role subject person
  role destination city
  label en "leave for"

@born predicate
  role subject person
  label en "be born"

@dacia entity
  kind asset
  label en "the red Dacia"

@van entity
  kind asset
  label en "the van"

@ana entity
  kind person
  label en "Ana"

@ion entity
  kind person
  label en "Ion"

@maria entity
  kind person
  label en "Maria"

@acme entity
  kind organization
  label en "Acme"

@berlin entity
  kind city
  label en "Berlin"
`;
const FACTS = [['costs dacia 4000'], ['costs van 9000'], ['aged ana 84'], ['aged ion 40'], ['works_at ana acme'], ['works_at ion acme'], ['works_at maria acme'],
  ['certified ana'], ['certified ion'], ['not certified maria'], ['left_for ion berlin', '2019-03-01 2019-03-02'], ['born maria', '2021-05-01 open']]
  .map(([holds, valid = 'timeless'], i) => `@f${i} fact\n  holds ${holds}\n  valid ${valid}\n  source world`).join('\n\n');

async function run(sop, {context = {statements: []}} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'words-'));
  try {
    const lexicon = new Lexicon(ONTOLOGY);
    const repo = new Repository(dir, {memory: {engine: 'scan'}});
    publishKnowledge(repo, 'world', FACTS, {schema: lexicon.predicates, reviewed: true, knownAt: Date.parse('2023-06-01')});
    const runtime = new Runtime({repo, session: repo.session('world', 't', 'evaluation'), lexicon, schema: lexicon.predicates, now: Date.parse('2026-09-28T12:00:00Z'), policy: {}});
    return await runtime.run(sop, {origin: 'model', language: 'en', context});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
const packet = r => r.result.packet;
const answers = r => (packet(r).answers ?? []).map(a => Object.values(a.binding)[0]).sort();
const match = (relation, roles, polarity = 'affirmed', indent = '    ') => [`${indent}match`, `${indent}  relation ${JSON.stringify(relation)}`, ...Object.entries(roles).map(([k, v]) => `${indent}  role ${k} ${v.startsWith('?') ? v : JSON.stringify(v)}`), `${indent}  polarity ${polarity}`, `${indent}end`].join('\n');
const query = (lines, where) => `@q query\n${lines.map(l => '  ' + l).join('\n')}${lines.length ? '\n' : ''}  where ${where.trimStart()}\n`;

test('words become the host operators; model admission rejects operator symbols', () => {
  assert.equal(wordsToExpression('3 times ?q plus ?r equal 6 minus 1'), '3 * ?q + ?r == 6 - 1');
  assert.throws(() => wordsToExpression('?x above ?y below 3'), /exactly one comparator/);
  assert.throws(() => checkModelProgram(parse(query(['select ?x', 'filter ?x != "Ana"'], match('work at', {subject: '?x', object: 'Acme'})))), /operator_not_words: @q filter/);
  assert.throws(() => checkModelProgram(parse('@c constraint\n  var ?x int 0 9\n  claim ?x >= 3\n  task possible')), /operator_not_words: @c writes an operator symbol/);
  assert.doesNotThrow(() => checkModelProgram(parse('@c constraint\n  var ?x int 0 9\n  claim ?x at_least 3\n  task possible')));
  assert.throws(() => parse(query(['quantifier most'], match('work at', {subject: '?x', object: 'Acme'}))), /quantifier_needs_every/);
  assert.throws(() => parse(query(['compare ?x bigger 3'], match('work at', {subject: '?x', object: 'Acme'}))), /compare_form/);
});

test('compare, grouped compare, except and rank', async () => {
  const aged = match('be aged', {subject: '?x', object: '?age'});
  assert.deepEqual(answers(await run(query(['select ?x', 'compare ?age above 80'], aged))), ['ana']);
  const yesNo = await run(query(['compare ?p above 5000'], match('cost', {subject: 'the red Dacia', object: '?p'})));
  assert.equal(packet(yesNo).status, 'refuted', 'known values that all fail the comparison answer no');
  const works = match('work at', {subject: '?x', object: 'Acme'});
  assert.deepEqual(answers(await run(query(['select ?x', 'except ?x "Ana"'], works))), ['ion', 'maria']);
  assert.deepEqual(answers(await run(`@q query\n  select ?x\n  compare any\n    ?x equal "Ana"\n    ?x equal "Maria"\n  end\n  where ${works.trimStart()}\n`)), ['ana', 'maria']);
  assert.deepEqual(answers(await run(query(['select ?x', 'rank lowest ?p'], match('cost', {subject: '?x', object: '?p'})))), ['dacia']);
  assert.equal(numericValue('2380 lei'), 2380);
  assert.equal(numericValue('the Dacia'), null);
});

test('quantifiers over the known members', async () => {
  const q = word => `@q query\n  mode every\n  quantifier ${word}\n  where ${match('work at', {subject: '?m', object: 'Acme'}).trimStart()}\n  scope ${match('be certified', {subject: '?m'}).trimStart()}\n`;
  assert.equal(packet(await run(q('most'))).status, 'supported');
  assert.equal(packet(await run(q('not_all'))).status, 'supported');
  assert.equal(packet(await run(q('none'))).status, 'refuted');
  assert.equal(packet(await run(q('at_least 3'))).status, 'refuted');
  const members = statuses => statuses.map(status => ({status}));
  assert.equal(quantifiedStatus({word: 'half'}, members(['supported', 'refuted'])), 'supported');
  assert.equal(quantifiedStatus({word: 'most'}, members(['supported', 'unknown', 'unknown'])), 'unknown');
  assert.equal(quantifiedStatus({word: 'at_least', count: 2}, members(['supported', 'supported', 'unknown'])), 'supported');
});

test('order compares the validity intervals of two matches', async () => {
  const where = `all\n${match('leave for', {subject: 'Ion', destination: 'Berlin', time: '?t1'})}\n${match('be born', {subject: 'Maria', time: '?t2'})}\n  end`;
  assert.equal(packet(await run(query(['order ?t1 before ?t2'], where))).status, 'supported');
  assert.equal(packet(await run(query(['order ?t1 after ?t2'], where))).status, 'refuted');
  assert.throws(() => checkModelProgram(parse(query(['select ?t1'], where))), /time_variable_multiple/);
});

test('a follow-up fragment is completed from the conversation, or clarified', async () => {
  const fragment = query(['fragment follow_up'], 'match\n    role subject "Maria"\n  end');
  const alone = await run(fragment);
  assert.equal(packet(alone).reason, 'fragment_without_context');
  assert.match(alone.result.text, /What would you like to know about Maria\?/);
  const context = {statements: []};
  await run(query(['select ?c'], match('work at', {subject: 'Ion', object: '?c'})), {context});
  assert.match(context.lastQuery, /relation "work at"/);
  const completed = await run(fragment, {context});
  assert.deepEqual(answers(completed), ['acme']);
  const previous = query(['select ?c'], match('work at', {subject: 'Ion', object: '?c'}));
  const fragmentWire = parse('@q query\n  fragment follow_up\n  where match\n    role time "last year"\n  end').wires[0];
  assert.deepEqual(completeFragment(fragmentWire, previous).fields.during, ['"last year"']);
});

test('the user, advice questions and word arithmetic', async () => {
  const user = await run(query([], match('work at', {subject: 'the user', object: 'Acme'})), {context: {statements: [], user: 'ana'}});
  assert.equal(packet(user).status, 'supported');
  const advice = await run(query([], match('should negotiate', {subject: 'the user'})));
  assert.equal(packet(advice).status, 'not_computable');
  const vat = await run('@c constraint\n  var ?vat int\n  require ?vat equal 2380 times 19\n  select ?vat\n  task possible');
  assert.match(vat.result.text, /45220/);
  const division = await run('@c constraint\n  var ?each int\n  require ?each equal 900 divided_by 4\n  select ?each\n  task possible');
  assert.equal(packet(division).status, 'not_computable');
});
