// Linking R2 (eval-linking-v2; DS014 "KnowledgeLinker: scoring and ambiguity"): single-oblique role relabeling, the frame tier before the
// dictionary tiers, a leading article that is not part of an entity name, and the circuit rules of the memory in the chat turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Lexicon} from '../../sop/lexicon.mjs';
import {compileDeclarative} from '../../sop/declarative.mjs';
import {Frames} from '../../sop/frames.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {linkQuestion} from '../../sop/linking.mjs';
import {Theory} from '../../reasoning/slice/wire.mjs';
import {loadSplit} from '../../tools/eval/linking/split.mjs';

const split = loadSplit();

const CIRCUIT = `
@person entity
  kind class
  label en "person"
@place entity
  kind class
  label en "place"
@ada entity
  kind person
  label en "Ada"
@uk entity
  kind place
  label en "United Kingdom"
@died_in predicate
  role subject person
  role location place
@lx_died_in lexeme
  of died_in
  language en
  form "die at"
  frame subject location
@death_year predicate
  role subject person
  role time value
@lx_death_year lexeme
  of death_year
  language en
  form "die"
  frame subject time
@works_at predicate
  role subject person
  role object place
@lx_works_at lexeme
  of works_at
  language en
  form "work at"
  frame subject object
@r1 rule
  when works_at ?a ?b
  then died_in ?a ?b
`;
const lexicon = Lexicon.fromCircuits([{name: 'c', text: CIRCUIT}]);
const NOW = Date.parse('2026-09-26T12:00:00Z');
const compile = (relation, roles, options = {}) => compileDeclarative(`@q query\n  select ?x\n  where match\n    relation ${JSON.stringify(relation)}\n${roles.map(r => '    role ' + r).join('\n')}\n    polarity affirmed\n  end\n`,
  {lexicon, schema: lexicon.predicates, now: NOW, dictionary: null, ...options});

test('a query role the predicate does not declare is relabeled when exactly one declared role is free, and the report says so', () => {
  const died = compile('die at', ['subject ?x', 'object "United Kingdom"']);
  assert.deepEqual(died.issues ?? [], []);
  const entry = died.linking.find(e => e.kind === 'relation');
  assert.equal(entry.symbol, 'died_in');
  assert.deepEqual(entry.relabeled, {from: 'object', to: 'location'});
  const year = compile('die', ['object ?x', 'subject "Ada"']);
  assert.equal(year.linking.find(e => e.kind === 'relation').symbol, 'death_year');
  assert.deepEqual(year.linking.find(e => e.kind === 'relation').relabeled, {from: 'object', to: 'time'});
});

test('the subject is never relabeled and two unknown roles are a role mismatch', () => {
  const clash = compile('die at', ['subject ?x', 'object "Ada"', 'instrument "a knife"']);
  assert.equal(clash.issues[0].status, 'role_mismatch');
  const noSubject = compile('die at', ['object ?x', 'topic "Ada"']);
  assert.equal(noSubject.issues[0].status, 'role_mismatch');
});

test('a leading article is not part of an entity name when the memory carries none', () => {
  const entity = compile('work at', ['subject "Ada"', 'object "the United Kingdom"']).linking.find(e => e.kind === 'entity' && e.symbol === 'uk');
  assert.ok(entity, 'the United Kingdom links to the label United Kingdom');
  assert.equal(lexicon.resolve('the United Kingdom', {language: 'en', kind: 'entity'}).id, 'uk');
});

test('frame tier: a reviewed frame links an unknown phrase before the dictionary tiers, and strict links never use it', () => {
  const frames = new Frames([{id: 'x:work_at', relation: 'work at', roles: ['subject', 'object'], surfaces: ['be employed at'], source: 'world'}], {dictionary: null});
  const program = ['subject "Ada"', 'object "United Kingdom"'];
  const loose = compile('be employed at', program, {dictionary: undefined, frames});
  assert.deepEqual(loose.issues ?? [], []);
  assert.equal(loose.linking.find(e => e.kind === 'relation').via, 'frame');
  assert.equal(loose.translations.find(t => t.source === 'frame').to, 'work at');
  const strict = compile('be employed at', program, {dictionary: null, frames});
  assert.equal(strict.issues[0].status, 'unknown');
});

test('the circuit rules of the memory reach the chat turn as typed rules', () => {
  const theory = new Theory([{name: 'c', text: CIRCUIT}]);
  const rules = theory.chatRules();
  assert.deepEqual(rules.map(r => r.id), ['r1']);
  assert.deepEqual(rules[0].then, {p: 'died_in', a: ['?a', '?b'], neg: false});
  assert.equal(rules[0].kind, 'rule');
  // The Runtime of a chat turn adds them to the rules of the approved library.
  assert.deepEqual(new Runtime({lexicon, schema: lexicon.predicates, circuitRules: () => rules}).rules({asof: Infinity}).map(r => r.id), ['r1']);
});

test('linking-v1 parts 2 and 3 have a fixed dev/test split with both halves for every form that has two rows', () => {
  assert.ok(split.test > 0 && split.dev > 0);
  assert.equal(split.dev + split.test, 502);
});

test('a name in a role the predicate types as an integer is a precise clarification, not a failure', () => {
  const circuit = CIRCUIT + '@salary predicate\n  role subject person\n  role object integer\n@lx_salary lexeme\n  of salary\n  language en\n  form "earn"\n  frame subject object\n';
  const lex = Lexicon.fromCircuits([{name: 'c', text: circuit}]);
  const plan = compileDeclarative('@q query\n  select ?x\n  where match\n    relation "earn"\n    role subject ?x\n    role object "the Nobel Prize in Physics"\n    polarity affirmed\n  end\n', {lexicon: lex, schema: lex.predicates, now: NOW, dictionary: null});
  assert.equal(plan.issues[0].status, 'type_mismatch');
  assert.equal(plan.issues[0].role, 'object');
});

test('a converse lexeme swaps the clause roles and the report says so', () => {
  const circuit = CIRCUIT + '@person_name predicate\n  role subject person\n  role object place\n@lx_pn lexeme\n  of person_name\n  language en\n  form "name of"\n  frame object subject\n';
  const lex = Lexicon.fromCircuits([{name: 'c', text: circuit}]);
  const plan = compileDeclarative('@q query\n  select ?x\n  where match\n    relation "name of"\n    role subject ?x\n    role object "Ada"\n    polarity affirmed\n  end\n', {lexicon: lex, schema: lex.predicates, now: NOW, dictionary: null});
  const entry = plan.linking.find(e => e.kind === 'relation');
  assert.equal(entry.symbol, 'person_name');
  assert.equal(entry.converse, true);
  assert.deepEqual(plan.issues ?? [], []);
  assert.match(plan.executionSop ?? '', /where person_name \$host0 \?x/);
});

test('an entity clarification names each namesake with the memory description', () => {
  const circuit = CIRCUIT + '@description predicate\n  args subject:entity object:text\n@paris_a entity\n  kind place\n  label en "Paris"\n@paris_b entity\n  kind place\n  label en "Paris"\n'
    + '@d1 fact\n  holds description paris_a "capital and largest city of France"\n@d2 fact\n  holds description paris_b "city in Texas"\n';
  const lex = Lexicon.fromCircuits([{name: 'c', text: circuit}]);
  assert.equal(lex.entities.paris_a.description, 'capital and largest city of France');
  const plan = compile('work at', ['subject "Ada"', 'object "Paris"'], {lexicon: lex, schema: lex.predicates});
  const issue = plan.issues.find(i => i.kind === 'entity');
  assert.equal(issue.status, 'ambiguous');
  assert.deepEqual(issue.candidates.map(c => c.description).sort(), ['capital and largest city of France', 'city in Texas']);
  assert.match(linkQuestion([issue]), /Paris \(capital and largest city of France\) or Paris \(city in Texas\)|Paris \(city in Texas\) or Paris \(capital and largest city of France\)/);
});

test('a relation that continues into its object string is shifted across the boundary when the memory declares the longer form', () => {
  const circuit = CIRCUIT + '@head_of_state_of predicate\n  role subject person\n  role object place\n@lx_hs lexeme\n  of head_of_state_of\n  language en\n  form "be the head of state of"\n  frame subject object\n'
    + '@head_of predicate\n  role subject person\n  role object place\n@lx_h lexeme\n  of head_of\n  language en\n  form "be the head of"\n  frame subject object\n'
    + '@france entity\n  kind place\n  label en "France"\n';
  const lex = Lexicon.fromCircuits([{name: 'c', text: circuit}]);
  const plan = compile('be the head of', ['subject ?x', 'object "state of France"'], {lexicon: lex, schema: lex.predicates});
  const entry = plan.linking.find(e => e.kind === 'relation');
  assert.equal(entry.symbol, 'head_of_state_of');
  assert.deepEqual(entry.boundary, {from: 'be the head of', to: 'be the head of state of'});
  // A whole object string that names an entity is never split.
  const whole = compile('be the head of', ['subject ?x', 'object "France"'], {lexicon: lex, schema: lex.predicates});
  assert.equal(whole.linking.find(e => e.kind === 'relation').symbol, 'head_of');
});
