// KnowledgeLinker, the copula and the relation lexicon (DS014 "KnowledgeLinker: the copula and the relation lexicon").
// SymbolicLM writes "be" for "Who is Ana?", "Ana is a doctor.", "Paris is the capital of France."; the linker reads it with
// the readings (`reading NAME` on predicate wires) the base memory declares and never names a predicate itself. The hand-made
// knowledge base below declares them; the same sentences against a memory without the declarations get a precise question.
// End to end: SymbolicLM-shaped programs through the Runtime and the js-reference oracle (js-oracle) on that knowledge base.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Lexicon} from '../../sop/lexicon.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {publishKnowledge} from '../../sop/ingest.mjs';
import {validateProgram} from '../../sop/knowledge/index.mjs';
import {copulaForm, nounPhrase, declaredPredicates} from '../../sop/copula-linker.mjs';
import {RelationLexicon, defaultRelationLexicon} from '../../sop/relation-lexicon.mjs';
import {linkRelation, linkQuestion} from '../../sop/linking.mjs';
import {context} from '../helpers.mjs';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const predicate = (id, roles, ...extra) => `@${id} predicate\n${roles.map(r => '  role ' + r).join('\n')}\n${extra.map(e => '  ' + e + '\n').join('')}`;
const entity = (id, label, ...more) => `@${id} entity\n  label en ${JSON.stringify(label)}\n${more.map(m => '  ' + m + '\n').join('')}`;
const VOCABULARY = [
  predicate('instance_of', ['subject entity', 'object entity'], 'reading class', 'reading describe', 'describe_rank 1'),
  predicate('occupation', ['subject entity', 'object entity'], 'reading occupation', 'reading describe', 'describe_rank 2'),
  predicate('has_property', ['subject entity', 'object value'], 'reading attribute'),
  predicate('same_as', ['subject entity', 'object entity'], 'reading identity'),
  predicate('located_in', ['subject entity', 'location entity'], 'reading location'),
  predicate('capital_of', ['subject entity', 'object entity'], 'alias en "capital of"', 'alias ro "capitala"'),
  predicate('tall', ['subject entity']),
  predicate('works_at', ['subject entity', 'object entity'], 'alias en "works at"'),
];
const ENTITIES = [['ana', 'Ana'], ['bogdan', 'Bogdan'], ['paris', 'Paris'], ['lyon', 'Lyon'], ['france', 'France'], ['doctor', 'doctor'], ['painter', 'painter'], ['human', 'human'], ['city', 'city'], ['twain', 'Mark Twain'], ['clemens', 'Samuel Clemens'], ['acme', 'Acme']]
  .map(([id, label]) => entity(id, label));
const LEXICON = new Lexicon([...VOCABULARY, ...ENTITIES].join('\n'));
const fact = (n, atom) => `@f${n} fact\n  holds ${atom}\n  valid timeless\n  source demo\n`;
const FACTS = ['instance_of ana human', 'occupation ana doctor', 'has_property ana "happy"', 'tall bogdan', 'same_as twain clemens', 'same_as clemens twain',
  'capital_of paris france', 'located_in paris france', 'located_in lyon france', 'instance_of paris city'].map((atom, i) => fact(i, atom)).join('');

const match = (relation, roles, polarity = 'affirmed') => `    relation ${JSON.stringify(relation)}\n${roles.map(([n, v]) => `    role ${n} ${v.startsWith('?') ? v : JSON.stringify(v)}\n`).join('')}    polarity ${polarity}\n`;
/** A SymbolicLM-shaped question: one query over one match block. */
const question = (relation, roles, {select = null, mode = null} = {}) => `@q query\n${mode ? `  mode ${mode}\n` : ''}${select ? `  select ${select}\n` : ''}  where match\n${match(relation, roles)}  end\n`;
const statement = (relation, roles, polarity = 'affirmed') => `@s1 stated\n${match(relation, roles, polarity).replace(/^ {4}/gm, '  ')}  certainty asserted\n`;

async function withKnowledge(body, lexicon = LEXICON, facts = FACTS) {
  const c = context({bootstrap: false});
  try {
    publishKnowledge(c.repo, 'base', facts, {schema: lexicon.predicates, reviewed: true, knownAt: Date.parse('2024-01-01')});
    const run = (source, options = {}) => new Runtime({repo: c.repo, session: c.repo.session('base', 'alice', 's' + Math.random().toString(36).slice(2)), lexicon, schema: lexicon.predicates, now: NOW}).run(source, {origin: 'model', ...options});
    await body(run);
  } finally { c.dispose(); }
}
const rows = r => (r.result.packet.answers ?? []).flatMap(a => Object.values(a.binding)).sort();
const status = r => r.result.packet.status;
const reading = r => r.result.packet.copula_readings?.[0];

test('copulaForm and nounPhrase: be, be a, be in; articles are language data', () => {
  assert.deepEqual(copulaForm('be'), {form: 'bare', article: 'none'});
  assert.deepEqual(copulaForm('be a'), {form: 'bare', article: 'indefinite'});
  assert.deepEqual(copulaForm('Be An'), {form: 'bare', article: 'indefinite'});
  assert.equal(copulaForm('be located in').form, 'locative');
  assert.equal(copulaForm('be in').form, 'locative');
  assert.deepEqual(copulaForm('fi'), {form: 'bare', article: 'none'});
  assert.equal(copulaForm('fi un').article, 'indefinite');
  for (const other of ['be the capital of', 'be sick', 'be born in', 'work at']) assert.equal(copulaForm(other), null, other);
  assert.deepEqual(nounPhrase('a doctor'), {article: 'indefinite', noun: 'doctor', key: 'doctor', proper: false});
  assert.equal(nounPhrase('un medic').article, 'indefinite');
  assert.equal(nounPhrase('the doctor').article, 'definite');
  assert.equal(nounPhrase('Samuel Clemens').proper, true);
  assert.equal(nounPhrase('doctor', defaultRelationLexicon(), 'indefinite').article, 'indefinite');
});

test('predicate wires declare readings: validated by the lexicon and by the knowledge grammar', () => {
  assert.deepEqual(declaredPredicates(LEXICON, 'describe').map(p => p.id), ['instance_of', 'occupation']);
  assert.deepEqual(declaredPredicates(LEXICON, 'location').map(p => p.id), ['located_in']);
  const codes = text => validateProgram([{name: 'k', text, role: 'knowledge'}]).problems.map(p => p.code);
  assert.ok(codes(predicate('p', ['subject entity', 'object entity'], 'reading wizard')).includes('bad_enum'));
  assert.ok(codes(predicate('p', ['subject entity', 'object entity'], 'reading class', 'reading class')).includes('repeated_reading'));
  assert.ok(codes(predicate('p', ['subject entity', 'object entity'], 'describe_rank 2')).includes('describe_rank_needs_describe'));
  assert.ok(codes(predicate('p', ['object entity', 'subject entity'], 'reading class')).includes('reading_roles_mismatch'));
  const ok = validateProgram([{name: 'k', text: '@p predicate\n  args subject:entity object:entity\n  reading class\n  reading describe\n  describe_rank 2\n', role: 'knowledge'}]);
  assert.equal(ok.ok, true);
  const bad = validateProgram([{name: 'k', text: '@p predicate\n  args subject:entity object:entity\n  reading wizard\n', role: 'knowledge'}]);
  assert.ok(bad.problems.some(p => p.code === 'bad_enum'));
});

test('"Who is Ana?" describes: the facts of the describing predicates, in declared rank order', async () => withKnowledge(async run => {
  const r = await run(question('be', [['subject', 'Ana'], ['object', '?x']], {select: '?x'}));
  assert.equal(status(r), 'supported');
  assert.deepEqual(rows(r), ['doctor', 'human']);
  assert.deepEqual([reading(r).kind, reading(r).alternatives], ['describe', ['instance_of', 'occupation']]);
}));

test('"What is Paris?" describes too, and an entity without facts is not supported', async () => withKnowledge(async run => {
  assert.deepEqual(rows(await run(question('be', [['subject', 'Paris'], ['object', '?x']], {select: '?x'}))), ['city']);
  assert.equal(status(await run(question('be', [['subject', 'Lyon'], ['object', '?x']], {select: '?x'}))), 'unknown');
}));

test('"Ana is a doctor." is the occupation reading; "Paris is a city." the class reading (stated, exact)', async () => withKnowledge(async run => {
  const doctor = await run(statement('be', [['subject', 'Ana'], ['object', 'a doctor']]));
  const s = doctor.result.packet.user_statements[0];
  assert.equal(s.predicate, 'occupation');
  assert.equal(s.atom, 'occupation ana doctor');
  assert.equal(reading(doctor).kind, 'occupation');
  const city = await run(statement('be', [['subject', 'Paris'], ['object', 'a city']]));
  assert.equal(city.result.packet.user_statements[0].predicate, 'instance_of');
}));

test('the relation phrase "be a" (SymbolicLM v2.7) reads like "be" with an indefinite object', async () => withKnowledge(async run => {
  const r = await run(statement('be a', [['subject', 'Ana'], ['object', 'doctor']]));
  assert.equal(r.result.packet.user_statements[0].atom, 'occupation ana doctor');
  assert.equal(status(await run(question('be a', [['subject', 'Ana'], ['object', 'doctor']]))), 'supported');
}));

test('a negated copula is a negated atom of the same reading', async () => withKnowledge(async run => {
  const r = await run(statement('be', [['subject', 'Ana'], ['object', 'a painter']], 'negated'));
  assert.equal(r.result.packet.user_statements[0].atom, 'not occupation ana painter');
}));

test('"Is Ana a doctor?": both readings are tried against the knowledge (an any group); "Is Ana a painter?" is not supported', async () => withKnowledge(async run => {
  const yes = await run(question('be', [['subject', 'Ana'], ['object', 'a doctor']]));
  assert.equal(status(yes), 'supported');
  assert.deepEqual(reading(yes).order, ['occupation', 'class']);
  assert.equal(status(await run(question('be', [['subject', 'Ana'], ['object', 'a painter']]))), 'unknown');
  assert.equal(status(await run(question('be', [['subject', 'Ana'], ['object', 'a human']]))), 'supported'); // the class reading of the same group
}));

test('"Who is a doctor?" reads the class noun with the variable as the subject', async () => withKnowledge(async run => {
  assert.deepEqual(rows(await run(question('be', [['subject', '?x'], ['object', 'a doctor']], {select: '?x'}))), ['ana']);
}));

test('"Is Ana happy?" is an attribute; "Is Bogdan tall?" uses the predicate named after the adjective', async () => withKnowledge(async run => {
  const happy = await run(question('be', [['subject', 'Ana'], ['object', 'happy']]));
  assert.equal(status(happy), 'supported');
  assert.equal(reading(happy).kind, 'attribute');
  const tall = await run(question('be', [['subject', 'Bogdan'], ['object', 'tall']]));
  assert.equal(status(tall), 'supported');
  assert.equal(reading(tall).tried[0].reading, 'named');
  assert.equal(status(await run(question('be', [['subject', 'Ana'], ['object', 'tall']]))), 'unknown');
}));

test('a proper name as object is identity: "Is Mark Twain Samuel Clemens?"', async () => withKnowledge(async run => {
  const r = await run(question('be', [['subject', 'Mark Twain'], ['object', 'Samuel Clemens']]));
  assert.equal(status(r), 'supported');
  assert.equal(reading(r).kind, 'identity');
}));

test('"be the R of": a named relation links by the declared alias, before any copula reading', async () => withKnowledge(async run => {
  assert.deepEqual(rows(await run(question('be the capital of', [['subject', '?x'], ['object', 'France']], {select: '?x'}))), ['paris']);
  assert.deepEqual(rows(await run(question('be the capital of', [['subject', 'Paris'], ['object', '?x']], {select: '?x'}))), ['france']);
  const said = await run(statement('be the capital of', [['subject', 'Lyon'], ['object', 'France']]));
  assert.equal(said.result.packet.user_statements[0].predicate, 'capital_of');
  assert.equal(said.result.packet.copula_readings.length, 0);
}));

test('"be in" / "be located in" / "Where is Paris?": the location reading, with the object role renamed', async () => withKnowledge(async run => {
  assert.equal(status(await run(question('be in', [['subject', 'Paris'], ['location', 'France']]))), 'supported');
  assert.equal(status(await run(question('be in', [['subject', 'Paris'], ['object', 'France']]))), 'supported');
  assert.deepEqual(rows(await run(question('be located in', [['subject', 'Paris'], ['location', '?place']], {select: '?place'}))), ['france']);
  assert.deepEqual(rows(await run(question('be in', [['subject', '?c'], ['location', 'France']], {select: '?c'}))), ['lyon', 'paris']);
  assert.equal(status(await run(question('be in', [['subject', 'Lyon'], ['location', 'Paris']]))), 'unknown');
  // SymbolicLM writes "Where is Paris?" as the bare copula with a location role.
  const where = await run(question('be', [['subject', 'Paris'], ['location', '?place']], {select: '?place'}));
  assert.deepEqual(rows(where), ['france']);
  assert.equal(where.result.packet.linking.find(e => e.kind === 'relation').symbol, 'located_in');
  assert.equal(status(await run(question('be', [['subject', 'Paris'], ['location', 'France']]))), 'supported');
}));

test('Romanian copula forms: "Cine este Ana?" and "Ana este un medic"', async () => withKnowledge(async run => {
  const who = await run(question('fi', [['subject', 'Ana'], ['object', '?x']], {select: '?x'}));
  assert.deepEqual(rows(who), ['doctor', 'human']);
  const said = await run(statement('fi', [['subject', 'Ana'], ['object', 'un doctor']]));
  assert.equal(said.result.packet.user_statements[0].predicate, 'occupation');
}));

test('a memory with no declared readings gets a precise question, never "unknown relation be"', async () => {
  const bare = new Lexicon([predicate('works_at', ['subject entity', 'object entity']), entity('ana', 'Ana'), entity('acme', 'Acme'), entity('doctor', 'doctor')].join('\n'));
  await withKnowledge(async run => {
    const who = await run(question('be', [['subject', 'Ana'], ['object', '?x']], {select: '?x'}));
    assert.equal(status(who), 'clarify');
    assert.match(who.result.text, /Do you mean what "Ana" does, or who "Ana" is related to\?/);
    assert.doesNotMatch(who.result.text, /I do not know the relation/);
    const said = await run(statement('be', [['subject', 'Ana'], ['object', 'a doctor']]));
    assert.match(said.result.text, /declares no meaning for "be" between "Ana" and "a doctor"/);
    assert.equal(said.result.packet.required[0].status, 'copula_unclear');
    const where = await run(question('be in', [['subject', 'Ana'], ['location', '?p']], {select: '?p'}));
    assert.match(where.result.text, /declares no relation for where "Ana" is/);
  }, bare, fact(0, 'works_at ana acme'));
});

test('the question is rendered in English; another language is the translation at the output edge', async () => {
  const bare = new Lexicon(predicate('works_at', ['subject entity', 'object entity']));
  const issue = {kind: 'relation', status: 'copula_unclear', text: 'be', question: 'EN', candidates: []};
  assert.equal(linkQuestion([issue]), 'EN');
  assert.equal(linkRelation('be', ['subject', 'object'], bare).status, 'unknown');
});

test('a definite or unknown noun phrase asks which reading is meant, listing only the declared readings', async () => withKnowledge(async run => {
  const r = await run(statement('be', [['subject', 'Ana'], ['object', 'the doctor']]));
  assert.equal(status(r), 'clarify');
  assert.match(r.result.text, /Do you mean: "Ana" is a kind of "the doctor" or "Ana" works as "the doctor" or "Ana" has the property "the doctor" or "Ana" is the same as "the doctor"\?/);
}));

test('several predicates declaring one reading: a statement asks, a question tries them all', async () => {
  const twin = new Lexicon([...VOCABULARY, predicate('kind_of', ['subject entity', 'object entity'], 'reading class'), ...ENTITIES].join('\n'));
  await withKnowledge(async run => {
    const said = await run(statement('be', [['subject', 'Paris'], ['object', 'a city']]));
    assert.equal(status(said), 'clarify');
    assert.deepEqual(said.result.packet.required[0].candidates.map(c => c.id), ['instance_of', 'kind_of']);
    assert.equal(status(await run(question('be', [['subject', 'Paris'], ['object', 'a city']]))), 'supported');
  }, twin);
});

test('an unknown noun or name is an entity question, not a relation question', async () => withKnowledge(async run => {
  const r = await run(statement('be', [['subject', 'Ana'], ['object', 'a flibber']]));
  assert.equal(status(r), 'clarify');
  assert.match(r.result.text, /Which entity do you mean by "flibber"\?/);
  const who = await run(question('be', [['subject', 'Zorba'], ['object', '?x']], {select: '?x'}));
  assert.match(who.result.text, /Which entity do you mean by "Zorba"\?/);
}));

test('the relation lexicon maps reviewed phrases to predicates a memory declares; entries for undeclared predicates are inert', () => {
  const relations = new RelationLexicon({version: 1, relations: [{relation: 'work for', lang: 'en', predicate: 'works_at'}, {relation: 'lucra la', lang: 'ro', predicate: 'works_at'}, {relation: 'be the cousin of', lang: 'en', predicate: 'cousin_of'}]});
  assert.equal(linkRelation('work for', ['subject', 'object'], LEXICON, {relations}).id, 'works_at');
  assert.equal(linkRelation('lucra la', ['subject', 'object'], LEXICON, {relations}).id, 'works_at');
  assert.equal(linkRelation('be the cousin of', ['subject', 'object'], LEXICON, {relations}).status, 'unknown');
  assert.equal(linkRelation('work for', ['subject', 'object'], LEXICON, {relations: defaultRelationLexicon()}).status, 'unknown');
  assert.throws(() => new RelationLexicon({version: 1, relations: [{relation: 'x', predicate: 'y'}]}), /needs relation, lang and predicate/);
  const merged = defaultRelationLexicon().extend(relations);
  assert.ok(merged.occupations.has('doctor') && merged.relations.length === 3);
});

test('the shipped relation lexicon names no predicate of any memory', () => {
  assert.deepEqual(defaultRelationLexicon().relations, []);
});
