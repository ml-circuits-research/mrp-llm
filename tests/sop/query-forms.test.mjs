// DS014 question forms of the model language: universal questions (mode every with a scope),
// time variables (role time ?t, measure start|end|duration, how many times), where/how roles and
// "why" questions (mode explain). Parser shape, model admission, host lowering and host semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parse} from '../../sop/parser.mjs';
import {compileDeclarative, checkModelProgram} from '../../sop/declarative.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {Repository} from '../../memory/repository.mjs';
import {publishKnowledge} from '../../sop/ingest.mjs';
import {ENUMS, QUERY_MODES, REASONING_QUERY_MODES, TIME_MEASURES} from '../../sop/enums.mjs';
import {UNCLEAR_KINDS} from '../../sop/unclear.mjs';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const ONTOLOGY = `@ana entity
  kind person
  label en "Ana"
@bob entity
  kind person
  label en "Bob"
@dan entity
  kind person
  label en "Dan"
@acme entity
  kind organization
  label en "Acme"
@zeta entity
  kind organization
  label en "Zeta"
@cluj entity
  kind city
  label en "Cluj"
@bike entity
  kind vehicle
  label en "bike"
@works_at predicate
  role subject person
  role object organization
  label en "work at"
@certified predicate
  role subject person
  label en "be certified"
@lives_in predicate
  role subject person
  role location city
  label en "live in"
@visited predicate
  role subject person
  role destination city
  label en "visit"
@commutes_by predicate
  role subject person
  role instrument vehicle
  label en "commute"
@left predicate
  role subject person
  role object organization
  label en "leave"
@moved predicate
  role subject person
  label en "move away"
@meeting_on predicate
  role subject person
  role time value
  label en "meet"
`;
const WORLD = `@f1 fact
  holds works_at ana acme
  valid 2020-03-01 open
  source world
@f2 fact
  holds works_at bob acme
  valid 2019-01-01 open
  source world
@f3 fact
  holds certified ana
  valid timeless
  source world
@f4 fact
  holds not certified bob
  valid timeless
  source world
@f5 fact
  holds visited ana cluj
  valid 2021-05-01 2021-05-02
  source world
@f6 fact
  holds visited ana cluj
  valid 2022-07-01 2022-07-02
  source world
@f7 fact
  holds moved ana
  valid timeless
  source world
@f8 fact
  holds lives_in ana cluj
  valid timeless
  source world
@f9 fact
  holds commutes_by ana bike
  valid timeless
  source world
@f10 fact
  holds works_at dan zeta
  valid 2018-01-01 2021-01-01
  source world
@f11 fact
  holds certified dan
  valid timeless
  source world
@r1 rule
  when moved ?x
  when works_at ?x ?y
  then left ?x ?y
`;
const lexicon = new Lexicon(ONTOLOGY);
function world() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'query-forms-'));
  const repo = new Repository(directory, {memory: {engine: 'scan'}});
  publishKnowledge(repo, 'world', WORLD, {schema: lexicon.predicates, reviewed: true, knownAt: Date.parse('2018-01-01')});
  return {directory, repo, session: repo.session('world', 'reader', 'evaluation')};
}
async function ask(source) {
  const w = world();
  try {
    const runtime = new Runtime({repo: w.repo, session: w.session, lexicon, schema: lexicon.predicates, now: NOW, policy: {allowWrite: false, reinforce: false}});
    const result = await runtime.run(source, {origin: 'model', inputText: 'Ana Bob Dan Acme Zeta Cluj', language: 'en'});
    return result.result.packet ?? result.result;
  } finally { fs.rmSync(w.directory, {recursive: true, force: true}); }
}
const block = (key, relation, roles, polarity = 'affirmed') => [`  ${key} match`, `    relation ${JSON.stringify(relation)}`, ...roles.map(([name, value]) => `    role ${name} ${value}`), `    polarity ${polarity}`, '  end'].join('\n');
const query = (...lines) => ['@q query', ...lines].join('\n') + '\n';
const employees = (org = '"Acme"') => block('where', 'work at', [['subject', '?e'], ['object', org]]);
const certified = (polarity = 'affirmed') => block('scope', 'be certified', [['subject', '?e']], polarity);
const workTime = block('where', 'work at', [['subject', '"Ana"'], ['object', '"Acme"'], ['time', '?t']]);

test('enumerations: query modes and time measures are closed lists', () => {
  assert.deepEqual([...QUERY_MODES], ['select', 'exists', 'count', 'explain', 'every']);
  assert.deepEqual([...TIME_MEASURES], ['start', 'end', 'duration']);
  assert.deepEqual(ENUMS.query.mode, [...QUERY_MODES, ...REASONING_QUERY_MODES]);
  assert.deepEqual(ENUMS.query.measure, [...TIME_MEASURES]);
});

test('universal question: "Is everyone at Acme certified?" is mode every with restriction and scope', async () => {
  const source = query('  mode every', employees(), certified());
  checkModelProgram(parse(source));
  const plan = compileDeclarative(source, {lexicon, schema: lexicon.predicates, now: NOW});
  assert.match(plan.executionSop, /mode every/);
  assert.match(plan.executionSop, /scope certified \?e/);
  const refuted = await ask(source);
  assert.equal(refuted.status, 'refuted');
  assert.deepEqual(refuted.counterexamples, [{'?e': 'bob'}]);
  assert.equal(refuted.members, 2);
  // Zeta's only known employee is certified: supported over the known members.
  const supported = await ask(query('  mode every', block('where', 'work at', [['subject', '?e'], ['object', '"Zeta"']]), certified(), '  during "2019"'));
  assert.equal(supported.status, 'supported');
  // "Is nobody at Acme certified?": the determiner "no" is every with a negated scope.
  const nobody = await ask(query('  mode every', employees(), certified('negated')));
  assert.equal(nobody.status, 'refuted');
  assert.deepEqual(nobody.counterexamples, [{'?e': 'ana'}]);
});

test('universal question with select: "Which companies have only certified employees?"', async () => {
  const packet = await ask(query('  mode every', '  select ?c', block('where', 'work at', [['subject', '?e'], ['object', '?c']]), certified(), '  during "2020"'));
  assert.equal(packet.status, 'supported');
  assert.deepEqual(packet.answers.map(a => a.binding), [{'?c': 'zeta'}]);
});

test('invalid universal forms', () => {
  const rejects = [
    [query('  mode every', employees()), /every_needs_scope/],
    [query(employees(), certified()), /scope_needs_every/],
    [query('  mode exists', employees(), certified()), /scope_needs_every/],
    [query('  mode all', employees(), certified()), /query mode must be one of/],
  ];
  for (const [source, error] of rejects) assert.throws(() => parse(source), error, source);
  // The scope of a model query is a match block, never an atom.
  assert.throws(() => checkModelProgram(parse(query('  mode every', employees(), '  scope certified ?e'))), /query_needs_match/);
});

test('"When did Ana work at Acme?": role time ?t binds the validity interval', async () => {
  const source = query('  select ?t', workTime);
  const plan = compileDeclarative(source, {lexicon, schema: lexicon.predicates, now: NOW});
  assert.match(plan.executionSop, /span \?t/);
  assert.match(plan.executionSop, /where works_at \$\w+ \$\w+/);
  const packet = await ask(source);
  assert.equal(packet.status, 'supported');
  assert.deepEqual(packet.answers.map(a => a.binding['?t']), ['2020-03-01T00:00:00.000Z open']);
});

test('"Since when", "until when" and "how long" measure the time variable', async () => {
  assert.deepEqual((await ask(query('  select ?t', '  measure start', workTime))).answers.map(a => a.binding['?t']), ['2020-03-01T00:00:00.000Z']);
  assert.deepEqual((await ask(query('  select ?t', '  measure end', workTime))).answers.map(a => a.binding['?t']), ['open']);
  const days = (await ask(query('  select ?t', '  measure duration', workTime))).answers[0].binding['?t'];
  assert.equal(days, Math.floor((NOW - Date.parse('2020-03-01')) / 86400000));
  const closed = await ask(query('  select ?t', '  measure duration', block('where', 'work at', [['subject', '"Dan"'], ['object', '"Zeta"'], ['time', '?t']])));
  assert.deepEqual(closed.answers.map(a => a.binding['?t']), [1096]);
});

test('"How many times did Ana visit Cluj?" counts distinct validity intervals', async () => {
  const packet = await ask(query('  mode count', '  select ?t', block('where', 'visit', [['subject', '"Ana"'], ['destination', '"Cluj"'], ['time', '?t']])));
  assert.equal(packet.count, 2);
});

test('"Where does Ana live?" asks for the location role; "How does Ana commute?" for the instrument', async () => {
  const where = await ask(query('  select ?place', block('where', 'live in', [['subject', '"Ana"'], ['location', '?place']])));
  assert.deepEqual(where.answers.map(a => a.binding['?place']), ['cluj']);
  const how = await ask(query('  select ?how', block('where', 'commute', [['subject', '"Ana"'], ['instrument', '?how']])));
  assert.deepEqual(how.answers.map(a => a.binding['?how']), ['bike']);
});

test('"Why did Ana leave Acme?" is mode explain: the answer is the derivation', async () => {
  const packet = await ask(query('  mode explain', block('where', 'leave', [['subject', '"Ana"'], ['object', '"Acme"']])));
  assert.equal(packet.status, 'supported');
  assert.equal(packet.explanation.kind, 'derivation');
  assert.ok(packet.explanation.steps.some(step => step.rule === 'r1'));
  const recorded = await ask(query('  mode explain', block('where', 'live in', [['subject', '"Ana"'], ['location', '"Cluj"']])));
  assert.equal(recorded.explanation.kind, 'recorded');
  const none = await ask(query('  mode explain', block('where', 'leave', [['subject', '"Bob"'], ['object', '"Acme"']])));
  assert.equal(none.status, 'unknown');
  assert.equal(none.explanation.kind, 'none');
});

test('invalid time and explain forms', () => {
  assert.throws(() => parse(query('  measure start', workTime)), /measure_needs_time_variable/);
  assert.throws(() => parse(query('  select ?t', '  measure length', workTime)), /measure must be one of/);
  assert.throws(() => parse(query('  mode explain', '  select ?x', block('where', 'leave', [['subject', '?x'], ['object', '"Acme"']]))), /explain_no_select/);
  assert.throws(() => checkModelProgram(parse(query('  select ?t', '  span ?t', workTime))), /span is host plumbing/);
  assert.throws(() => checkModelProgram(parse(query('  select ?x', '  measure start', block('where', 'work at', [['subject', '?x'], ['object', '"Acme"'], ['time', '?t']])))), /measure_needs_time_variable/);
  const two = query('  select ?t ?u', '  where all', '    match', '      relation "work at"', '      role subject "Ana"', '      role object "Acme"', '      role time ?t', '      polarity affirmed', '    end',
    '    match', '      relation "visit"', '      role subject "Ana"', '      role destination "Cluj"', '      role time ?u', '      polarity affirmed', '    end', '  end');
  assert.throws(() => checkModelProgram(parse(two)), /time_variable_multiple/);
  // A time literal is not a role of these relations: the host asks instead of guessing.
  const literal = compileDeclarative(query(block('where', 'work at', [['subject', '"Ana"'], ['object', '"Acme"'], ['time', '"2021"']])), {lexicon, schema: lexicon.predicates, now: NOW});
  assert.equal(literal.issues[0].status, 'role_mismatch');
});

test('a relation that declares a time role keeps role time as an argument', () => {
  const plan = compileDeclarative(query('  select ?t', block('where', 'meet', [['subject', '"Ana"'], ['time', '?t']])), {lexicon, schema: lexicon.predicates, now: NOW});
  assert.doesNotMatch(plan.executionSop, /span/);
  assert.match(plan.executionSop, /where meeting_on \$\w+ \?t/);
  const measured = compileDeclarative(query('  select ?t', '  measure start', block('where', 'meet', [['subject', '"Ana"'], ['time', '?t']])), {lexicon, schema: lexicon.predicates, now: NOW});
  assert.equal(measured.issues[0].status, 'not_an_interval');
});

test('unclear kind ambiguous: 2 to 4 reading paraphrases rendered as a host clarification', async () => {
  const source = '@u unclear\n  kind ambiguous\n  reading "Ana saw the man who had the telescope"\n  reading "Ana used the telescope to see the man"\n';
  checkModelProgram(parse(source));
  const out = await new Runtime({}).run(source, {origin: 'model', inputText: 'Ana saw the man with the telescope.'});
  assert.equal(out.result.packet.status, 'unclear');
  assert.equal(out.result.packet.unclear_kind, 'ambiguous');
  assert.equal(out.result.packet.next, 'choose_reading');
  assert.deepEqual(out.result.packet.readings, ['Ana saw the man who had the telescope', 'Ana used the telescope to see the man']);
  assert.match(out.result.text, /\n\(1\) Ana saw the man who had the telescope\n\(2\) Ana used the telescope to see the man$/);
  // The core renders English only; another answer language is the translation of this text at the output edge.
  const asked = await new Runtime({}).run('@u unclear\n  kind ambiguous\n  reading "the bench on the street, for sitting"\n  reading "the bank where you keep money"\n', {origin: 'model', language: 'ro', languageSource: 'request'});
  assert.match(asked.result.text, /more than one/);
  const rejects = [
    ['@u unclear\n  kind ambiguous\n', /unclear_readings: .* lists 2 to 4 reading lines/],
    ['@u unclear\n  kind ambiguous\n  reading "only one"\n', /lists 2 to 4 reading lines/],
    ['@u unclear\n  kind ambiguous\n' + ['a', 'b', 'c', 'd', 'e'].map(r => `  reading "${r}"\n`).join(''), /lists 2 to 4 reading lines/],
    ['@u unclear\n  kind ambiguous\n  reading "same"\n  reading "Same"\n', /repeats a reading/],
    ['@u unclear\n  kind ambiguous\n  reading one\n  reading "two"\n', /reading takes one JSON-quoted paraphrase/],
    ['@u unclear\n  kind no_request\n  reading "a"\n  reading "b"\n', /reading lines belong to kind ambiguous/],
    ['@u unclear\n  kind ambiguous\n  reading ""\n  reading "b"\n', /short nonempty paraphrase/],
  ];
  for (const [text, error] of rejects) assert.throws(() => parse(text), error, text);
  // An ambiguous unclear is still the only wire of the output.
  assert.throws(() => checkModelProgram(parse('@u unclear\n  kind ambiguous\n  reading "a"\n  reading "b"\n\n' + query(workTime.replace('role time ?t', 'role time ?t')))), /unclear_not_alone/);
});

test('host time normalizer reads day-month-year phrasings and ranges as written in messages', async () => {
  const {normalizeTime} = await import('../../sop/linking.mjs');
  const day = iso => ({from: Date.parse(iso), until: Date.parse(iso) + 86400000});
  for (const text of ['3 March 2025', 'March 3, 2025', 'the 3rd of March 2025', '3 mar. 2025', '03.03.2025', 'on 3 March 2025']) assert.deepEqual(normalizeTime(text, NOW), day('2025-03-03'), text);
  assert.deepEqual(normalizeTime('2019 – 2021', NOW), {from: Date.parse('2019-01-01'), until: Date.parse('2021-01-01')});
  for (const text of ['31 February 2025', '3 martie 2025', '2021 – 2019', 'sometime in spring']) assert.equal(normalizeTime(text, NOW), null, text);
});

test('quoted to-ranges preserve a shared year and exclusive end, rejecting invalid bounds', async () => {
  const {normalizeTime} = await import('../../sop/linking.mjs');
  for (const [text, from, until] of [
    ['2026-03-01 to 2026-06-01', '2026-03-01', '2026-06-01'],
    ['April 1 to May 1, 2025', '2025-04-01', '2025-05-01'],
    ['1 April to 1 May 2025', '2025-04-01', '2025-05-01'],
    ['Feb 29 to March 1, 2024', '2024-02-29', '2024-03-01'],
    ['from 2026-03-01 to 2026-06-01', '2026-03-01', '2026-06-01'],
  ]) assert.deepEqual(normalizeTime(text, NOW), {from: Date.parse(from), until: Date.parse(until)}, text);
  for (const text of ['May 1 to April 1, 2025', 'April 1 to April 1, 2025', 'February 30 to March 1, 2024'])
    assert.equal(normalizeTime(text, NOW), null, text);
});

test('a quoted except literal is resolved by the host like a role value', () => {
  const source = query('  select ?e', employees(), '  except ?e "Bob"');
  const plan = compileDeclarative(source, {lexicon, schema: lexicon.predicates, now: NOW});
  assert.match(plan.executionSop, /except \?e "bob"/);
  const unknown = compileDeclarative(query('  select ?e', employees(), '  except ?e "Zoltan"'), {lexicon, schema: lexicon.predicates, now: NOW});
  assert.equal(unknown.issues[0].kind, 'entity');
  assert.equal(unknown.issues[0].status, 'unknown');
});
