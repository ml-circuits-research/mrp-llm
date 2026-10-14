import test from 'node:test';
import assert from 'node:assert/strict';
import {Lexicon} from '../../sop/lexicon.mjs';
import {fuzzyEntities, linkFuzzy, nearMiss, nameSpans, editDistance, nameKey} from '../../lib/near-miss.mjs';

// A tiny memory of its own: the near-miss module reads only the memory's data (labels, aliases, facts), never a word list.
const CIRCUITS = [{name: 'near-miss-fixture', text: `
@person entity
  kind class
  label en "person"

@city entity
  kind class
  label en "city"

@is_a predicate
  args subject:entity object:entity
  reading describe
  describe_rank 1

@born_in predicate
  args subject:entity object:entity
  role subject person
  role object city
  label en "born in"

@lx_born_in lexeme
  of born_in
  language en
  pos verb
  form "born in"
  form "tell"
  frame subject object

@teaches predicate
  args subject:entity object:entity
  role subject person
  role object person

@malaga entity
  kind city
  label en "Málaga"
  notability 50

@athens entity
  kind city
  label en "Athens"
  notability 90

@socrates entity
  kind person
  label en "Socrates"
  notability 80

@socrates_scholasticus entity
  kind person
  label en "Socrates of Constantinople"
  notability 10

@plato entity
  kind person
  label en "Plato"
  notability 70

@platon_jones entity
  kind person
  label en "Platon Jones"
  notability 5

@pablo_picasso entity
  kind person
  label en "Pablo Picasso"
  notability 60

@f1 fact
  holds born_in socrates athens

@f2 fact
  holds teaches socrates plato

@f3 fact
  holds is_a socrates person

@f4 fact
  holds born_in pablo_picasso malaga
`}];
const lexicon = Lexicon.fromCircuits(CIRCUITS, {provenance: 'test:near-miss'});
const ids = list => list.map(c => c.id);

test('the name key folds accents, case, punctuation and doubled letters', () => {
  assert.equal(nameKey('Málaga'), 'malaga');
  assert.equal(nameKey('  Pablo-PICASSO '), 'pablo picaso');
  assert.equal(editDistance([...'socrate'], [...'socrates'], 2), 1);
  assert.equal(editDistance([...'paltp'], [...'plato'], 2), 2, 'a transposition plus a substitution');
  assert.equal(editDistance([...'abcdef'], [...'uvwxyz'], 2), Infinity, 'beyond the budget');
});

test('accent folding: "Malaga" finds Málaga, folded, at distance 0', () => {
  const [first] = fuzzyEntities('Malaga', lexicon);
  assert.equal(first.id, 'malaga');
  assert.equal(first.distance, 0);
  assert.equal(first.matched, 'folded');
  assert.equal(fuzzyEntities('Málaga', lexicon)[0].matched, 'exact');
});

test('a one-edit typo finds the entity', () => {
  const [first] = fuzzyEntities('Athnes', lexicon);
  assert.equal(first.id, 'athens');
  assert.equal(first.distance, 1, 'a transposition is one edit');
  assert.equal(fuzzyEntities('Picaso', lexicon)[0].id, 'pablo_picasso', 'a doubled letter written once matches a word of a multi-word label');
});

test('"Socrate" finds Socrates by its full label first, then by a word of a multi-word label', () => {
  const list = fuzzyEntities('Socrate', lexicon, {max: 5});
  assert.deepEqual(ids(list).slice(0, 2), ['socrates', 'socrates_scholasticus']);
  assert.equal(list[0].token, false);
  assert.equal(list[1].token, true);
  assert.equal(list[1].word, 'Socrates');
});

test('a far string has no candidate; a short one needs an exact folded match', () => {
  assert.deepEqual(fuzzyEntities('Qwxyzt', lexicon), []);
  assert.deepEqual(fuzzyEntities('Ath', lexicon), [], 'below four letters no edit is allowed');
  assert.equal(fuzzyEntities('Plat', lexicon)[0].id, 'plato', 'four letters allow one edit');
});

test('ordering: distance, then full label before a word of one, then notability', () => {
  const list = fuzzyEntities('Platon', lexicon, {max: 5});
  // "Platon" is a word of "Platon Jones" (distance 0) and one edit from "Plato" (distance 1).
  assert.deepEqual(ids(list), ['platon_jones', 'plato']);
  const tie = fuzzyEntities('Socrates', lexicon, {max: 5});
  assert.deepEqual(ids(tie), ['socrates', 'socrates_scholasticus']);
});

test('linkFuzzy binds a unique best candidate and reports a tie as ambiguous', () => {
  assert.equal(linkFuzzy('Socrate', lexicon).status, 'bound');
  assert.equal(linkFuzzy('Socrate', lexicon).id, 'socrates');
  assert.equal(linkFuzzy('Qwxyzt', lexicon).status, 'unknown');
  const twins = Lexicon.fromCircuits([{name: 't', text: '@ion1 entity\n  kind person\n  label en "Ionel"\n\n@ion2 entity\n  kind person\n  label en "Ionela"\n'}]);
  assert.equal(linkFuzzy('Ionell', twins).status, 'ambiguous');
});

test('name spans of a message come from the memory: a relation word is not fuzzily a name, casing must agree', () => {
  const spans = nameSpans('Who is Socrate?', lexicon);
  assert.deepEqual(spans.map(s => s.surface), ['Socrate']);
  assert.deepEqual(nameSpans('Tell me about Malaga', lexicon).map(s => s.surface), ['Malaga']);
});

test('nearMiss lists the candidates with their description and the relations around them', () => {
  const result = nearMiss({text: 'Who is Socrate?', lexicon, circuits: CIRCUITS});
  assert.deepEqual(result.mentions.map(m => m.surface), ['Socrate']);
  const socrates = result.candidates.find(c => c.id === 'socrates');
  assert.ok(socrates);
  assert.deepEqual(socrates.relations.map(r => [r.predicate, r.facts, r.roles]).sort(), [['born_in', 1, ['subject']], ['is_a', 1, ['subject']], ['teaches', 1, ['subject']]]);
  assert.equal(socrates.relations.find(r => r.predicate === 'born_in').label, 'born in');
  assert.deepEqual(socrates.describe, [{predicate: 'is_a', examples: [['socrates', 'person']]}]);
  const given = nearMiss({mentions: ['Athnes'], lexicon, circuits: CIRCUITS});
  assert.equal(given.candidates[0].id, 'athens');
  assert.deepEqual(given.candidates[0].relations.map(r => [r.predicate, r.roles]), [['born_in', ['object']]]);
  assert.deepEqual(nearMiss({text: 'Qwxyzt?', lexicon, circuits: CIRCUITS}), {candidates: [], mentions: []});
});
