/** Content-word overlap of the sealed tests with train/dev (DSx008 "Content-word overlap"): signatures, duplicates, form coverage. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {overlapOf} from '../../tools/datasets/audit/content-word-overlap.mjs';
import {signatureOf, lightWords, analysisWords, coverage, skeleton} from '../../tools/datasets/three-datasets/forms.mjs';

const tok = (id, form, lemma, upos, head, deprel) => [id, form, lemma, upos, head, deprel];
const sentence = (text, tokens) => ({text, start: 0, end: text.length, tokens});
// "Does Ana lease the vineyard?" and "Does Ion rent the warehouse?" have the same form and different content words.
const lease = [tok(1, 'Does', 'do', 'AUX', 3, 'aux'), tok(2, 'Ana', 'Ana', 'PROPN', 3, 'nsubj'), tok(3, 'lease', 'lease', 'VERB', 0, 'root'), tok(4, 'the', 'the', 'DET', 5, 'det'), tok(5, 'vineyard', 'vineyard', 'NOUN', 3, 'obj'), tok(6, '?', '?', 'PUNCT', 3, 'punct')];
const rent = [tok(1, 'Does', 'do', 'AUX', 3, 'aux'), tok(2, 'Ion', 'Ion', 'PROPN', 3, 'nsubj'), tok(3, 'rent', 'rent', 'VERB', 0, 'root'), tok(4, 'the', 'the', 'DET', 5, 'det'), tok(5, 'warehouse', 'warehouse', 'NOUN', 3, 'obj'), tok(6, '?', '?', 'PUNCT', 3, 'punct')];
const statement = [tok(1, 'Ana', 'Ana', 'PROPN', 2, 'nsubj'), tok(2, 'sleeps', 'sleep', 'VERB', 0, 'root'), tok(3, '.', '.', 'PUNCT', 2, 'punct')];
const row = (id, text, tokens, extra = {}) => ({id, message: text, dataset: 'symbolic_english', analysis: {sentences: [sentence(text, tokens)]}, ...extra});

test('content words are the lemmas of names, nouns and verbs; light words drop stop words', () => {
  assert.deepEqual(analysisWords({sentences: [sentence('x', lease)]}), ['ana', 'lease', 'vineyard']);
  assert.deepEqual(lightWords('Cine lucrează la Tisa Textile și are peste 65 de ani?'), ['ani', 'lucreaza', 'peste', 'textile', 'tisa']);
  assert.equal(coverage(['a', 'b'], ['a', 'b', 'c']), 1);
  assert.equal(coverage(['a', 'b'], ['a']), 0.5);
  assert.match(skeleton(lease), /yes-no question \| root VERB \| nsubj obj \| single clause/);
});

test('same form and different content words is not a duplicate; identical words and form, or the same text, fail closed', () => {
  const train = [row('t1', 'Does Ana lease the vineyard?', lease)];
  const different = overlapOf([row('x1', 'Does Ion rent the warehouse?', rent)], train);
  assert.equal(different.lexical_duplicates.count, 0);
  assert.equal(different.forms.test_rows_sharing_a_form, 1, 'the form is shared');
  assert.equal(different.content_words.identical_same_form, 0);
  // Same names, noun and verb in the same form (only a number or a filler word differs): a lexical duplicate.
  const numbers = overlapOf([row('x2', 'Does Ana lease the vineyard now?', lease)], train);
  assert.equal(numbers.lexical_duplicates.count, 1);
  const same = overlapOf([row('x3', 'does ana LEASE the vineyard', lease)], train);
  assert.equal(same.exact_duplicates.same_dataset, 1, 'normalized text duplicate');
});

test('test forms with no train counterpart are listed as information', () => {
  const report = overlapOf([row('x1', 'Ion sleeps.', statement.map(t => (t[1] === 'Ana' ? tok(1, 'Ion', 'Ion', 'PROPN', 2, 'nsubj') : t)))], [row('t1', 'Does Ana lease the vineyard?', lease)]);
  assert.equal(report.forms.test_forms_without_pool_counterpart, 1);
  assert.equal(report.forms.uncovered[0].rows, 1);
  assert.equal(report.shares.forms_covered_pct, 0);
  assert.equal(report.lexical_duplicates.count, 0);
});

test('rows without an analysis (bad_english) use the target, else the message, and language kind plus family as the form', () => {
  const a = signatureOf({dataset: 'bad_english', language_kind: 'ro', source: {family: 'join'}, message: 'Cine lucreaza la Tisa Textile?', target: 'Who works at Tisa Textile?'});
  assert.equal(a.source, 'target');
  assert.equal(a.form, 'ro|join');
  assert.deepEqual(a.words, ['textile', 'tisa', 'works']);
});
