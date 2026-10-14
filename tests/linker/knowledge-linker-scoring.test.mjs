// The scored joint KnowledgeLinker (sop/knowledge-linker.mjs; DS014 "KnowledgeLinker: scoring and ambiguity"): candidates are scored,
// constraints of the memory prune or support them, the decision is made in named stages, and a tie is an explicit ambiguity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Lexicon} from '../../sop/lexicon.mjs';
import {linkRelation, linkQuestion} from '../../sop/linking.mjs';
import {compileDeclarative} from '../../sop/declarative.mjs';
import {chooseEntity, decide, MARGIN, configureLinker} from '../../sop/knowledge-linker.mjs';

const CIRCUIT = `
@person entity
  kind class
  label en "person"
@company entity
  kind class
  label en "company"
@team entity
  kind class
  label en "team"
@ada entity
  kind person
  label en "Ada"
@acme entity
  kind company
  label en "Acme"
@wolves entity
  kind team
  label en "Wolves"
@manages_company predicate
  role subject person
  role object company
@manages_team predicate
  role subject person
  role object team
@lx_mc lexeme
  of manages_company
  language en
  form "run"
  frame subject object
@lx_mt lexeme
  of manages_team
  language en
  form "run"
  frame subject object
@works_at predicate
  role subject person
  role object company
@lx_wa lexeme
  of works_at
  language en
  form "work at"
  frame subject object
@heavy predicate
  role subject person
  role object company
@light predicate
  role subject person
  role object company
@lx_heavy lexeme
  of heavy
  language en
  form "own"
  weight 9
  frame subject object
@lx_light lexeme
  of light
  language en
  form "own"
  weight 4
  frame subject object
`;
const lexicon = () => Lexicon.fromCircuits([{name: 't', text: CIRCUIT}]);
const values = (s, o) => new Map([['subject', s], ['object', o]]);

test('a shared form is decided by the class of the entity the message names, and the alternative is reported', () => {
  const l = lexicon();
  const company = linkRelation('run', ['subject', 'object'], l, {values: values('Ada', 'Acme')});
  assert.equal(company.status, 'bound');
  assert.equal(company.id, 'manages_company');
  assert.equal(company.decided_by, 'constraint');
  assert.deepEqual(company.scored_alternatives.map(a => a.id), ['manages_team']);
  assert.ok(company.scored_alternatives[0].rejected[0].startsWith('type_clash'));
  assert.equal(linkRelation('run', ['subject', 'object'], l, {values: values('Ada', 'Wolves')}).id, 'manages_team');
});

test('two readings the evidence does not separate are an ambiguity with their scores, never a guess', () => {
  const l = lexicon();
  const unknownObject = linkRelation('run', ['subject', 'object'], l, {values: values('Ada', 'Zed')});
  assert.equal(unknownObject.status, 'ambiguous');
  assert.deepEqual(unknownObject.candidates.map(c => c.id), ['manages_company', 'manages_team']);
  assert.equal(unknownObject.scored.length, 2);
  assert.match(linkQuestion([{kind: 'relation', ...unknownObject}]), /manages_company.*manages_team/);
});

test('declared lexeme weights separate readings of one form', () => {
  const r = linkRelation('own', ['subject', 'object'], lexicon(), {values: values('Ada', 'Acme')});
  assert.equal(r.status, 'bound');
  assert.equal(r.id, 'heavy');
  assert.equal(r.decided_by, 'weight');
  assert.equal(r.scored_alternatives[0].id, 'light');
});

test('a constraint never removes the last reading, and one candidate binds as before', () => {
  const only = linkRelation('work at', ['subject', 'object'], lexicon(), {values: values('Ada', 'Wolves')});
  assert.equal(only.status, 'bound');
  assert.equal(only.decided_by, 'only_candidate');
  const all = decide([{id: 'a', tier: 100, weight: null, hard: ['type_clash:object'], soft: 0, score: 100}, {id: 'b', tier: 100, weight: null, hard: ['type_clash:object'], soft: 0, score: 100}]);
  assert.equal(all.chosen, null);
  assert.equal(all.tied.length, 2);
});

test('the head verb tier serves queries only; a statement never binds through it', () => {
  const l = lexicon();
  assert.equal(linkRelation('work for', ['subject', 'object'], l, {exact: true, headVerb: true}).status, 'unknown');
  const query = linkRelation('work for', ['subject', 'object'], l, {exact: false, headVerb: true});
  assert.equal(query.status, 'bound');
  assert.equal(query.id, 'works_at');
  assert.equal(query.via, 'headVerb');
  assert.equal(query.tier, 50);
  assert.equal(linkRelation('work for', ['subject', 'object'], l, {exact: false, headVerb: false}).status, 'unknown');
  assert.equal(linkRelation('run for', ['subject', 'object'], l, {exact: false, headVerb: true}).status, 'ambiguous', 'a head verb shared by two predicates asks');
});

test('namesakes: the class of the role decides, otherwise the notable one only orders the options', () => {
  const l = Lexicon.fromCircuits([{name: 't', text: '@person entity\n  kind class\n  label en "person"\n@place entity\n  kind class\n  label en "place"\n@paris_f entity\n  kind place\n  label en "Paris"\n  notability 90\n@paris_p entity\n  kind person\n  label en "Paris"\n  notability 10\n@paris_t entity\n  kind place\n  alias en "Paris"\n  label en "Paris Texas"\n  notability 20\n'}]);
  const found = l.matching('Paris', {language: 'auto', kind: 'entity'}).found;
  const byClass = chooseEntity(l, found, {type: 'person'});
  assert.equal(byClass.chosen.id, 'paris_p');
  assert.equal(byClass.by, 'class');
  const untyped = chooseEntity(l, found, {type: 'entity'});
  assert.equal(untyped.chosen, null, 'notability alone never decides');
  assert.equal(untyped.scored[0].id, 'paris_f', 'but it orders the options');
  assert.ok(untyped.scored[0].score - untyped.scored[1].score < MARGIN);
});

test('compile: an ambiguous entity string becomes a clarification naming the options, scores are in the report', () => {
  const l = Lexicon.fromCircuits([{name: 't', text: CIRCUIT + '\n@acme2 entity\n  kind company\n  label en "Acme"\n'}]);
  const sop = '@s stated\n  relation "work at"\n  role subject "Ada"\n  role object "Acme"\n  polarity affirmed\n  certainty asserted';
  const plan = compileDeclarative(sop, {inputText: 'Ada works at Acme.', lexicon: l, schema: l.predicates});
  assert.equal(plan.issues[0].kind, 'entity');
  assert.equal(plan.issues[0].status, 'ambiguous');
  assert.match(linkQuestion(plan.issues), /Acme \(company\) or Acme \(company\)/);
  const ok = compileDeclarative(sop, {inputText: 'Ada works at Acme.', lexicon: lexicon(), schema: lexicon().predicates});
  const relation = ok.linking.find(e => e.kind === 'relation');
  assert.equal(relation.symbol, 'works_at');
  assert.equal(relation.score, 110, 'form 100 plus 10 for the person and the company the roles declare');
  assert.equal(relation.decided_by, 'only_candidate');
  assert.equal(ok.linking.find(e => e.kind === 'entity').score, 100);
});

test('the exact linker of M1 stays reproducible for the suite: a tie is an ambiguity', () => {
  try {
    configureLinker({scored: false, headVerb: false});
    assert.equal(linkRelation('run', ['subject', 'object'], lexicon(), {values: values('Ada', 'Acme')}).status, 'ambiguous');
  } finally { configureLinker({scored: true, headVerb: true}); }
  assert.equal(linkRelation('run', ['subject', 'object'], lexicon(), {values: values('Ada', 'Acme')}).status, 'bound');
});
