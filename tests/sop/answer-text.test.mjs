import test from 'node:test';
import assert from 'node:assert/strict';
import {renderAnswer, renderable} from '../../sop/answer-text.mjs';
import {cnl} from '../../sop/cnl.mjs';

const fact = (id, p, a, source, extra = {}) => ({id, atom: {p, a, neg: false}, kind: 'observed', source, ...extra});
const base = {kind: 'query', query: {kind: 'query', where: [], select: ['?x']}, complete: true, proof: [], answers: []};

test('a wh-question lists the answer values with labels and a short justification, without raw lines', () => {
  const packet = {...base, status: 'supported', answers: [{binding: {'?x': 'paris'}}], proof: [fact('c1', 'capital_of', ['paris', 'france'], 'Wikidata Q142 P36')]};
  const text = renderAnswer(packet);
  assert.match(text, /^Answer: Paris\.$/m);
  assert.match(text, /Paris .*capital.* France \(memory: Wikidata Q142 P36\)/);
  assert.doesNotMatch(text, /ANSWER|EVIDENCE|\?x|c1|supports the claim/);
});

test('classes are not capitalized, implied superclasses are dropped, descriptions are labelled', () => {
  const packet = {...base, status: 'supported', answers: ['person', 'entity', 'mathematician', 'English mathematician (1815-1852)'].map(v => ({binding: {'?x': v}})),
    proof: [fact('c1', 'is_a', ['ada_lovelace', 'person'], 'Wikidata Q7259 P31'), fact('c0', 'is_a', ['person', 'entity'], 'core-en class hierarchy'),
      {id: 'd1', atom: {p: 'is_a', a: ['ada_lovelace', 'entity'], neg: false}, kind: 'derived', rule: 'r_is_a_transitive', from: ['c1', 'c0']},
      fact('c2', 'has_occupation', ['ada_lovelace', 'mathematician'], 'Wikidata Q7259 P106')]};
  const text = renderAnswer(packet);
  assert.match(text, /Answers: person and mathematician\./);
  assert.match(text, /Described as: English mathematician/);
  assert.doesNotMatch(text, /entity\./);
});

test('yes/no answers: Yes with a derived reason and origin labels, No for an explicit negation, I do not know otherwise', () => {
  const yes = renderAnswer({...base, status: 'supported', answers: [{binding: {}}], proof: [
    {id: 'd1', atom: {p: 'located_in', a: ['paris', 'europe'], neg: false}, kind: 'derived', rule: 'r_located_in_transitive', from: ['c1', 'c2']},
    fact('c1', 'located_in', ['paris', 'france'], 'Wikidata Q90 P17'), fact('c2', 'located_in', ['france', 'europe'], 'user')]});
  assert.match(yes, /^Yes\.$/m);
  assert.match(yes, /because .*Paris .*France \(memory: Wikidata Q90 P17\) and France .*Europe \(stated in this conversation\), by the rule "located in transitive"/);
  const no = renderAnswer({...base, status: 'refuted', answers: [{binding: {}}], proof: [{...fact('n1', 'lives_in', ['ana', 'rome'], 'user'), atom: {p: 'lives_in', a: ['ana', 'rome'], neg: true}}]});
  assert.match(no, /^No\.$/m);
  assert.match(no, /Ana does not \w+ in Rome/);
  assert.match(renderAnswer({...base, status: 'unknown', answers: []}), /^The available information does not decide the question, so I don't know\.$/);
});

test('counts say "at least" when the retrieval is incomplete, incomplete lists say so', () => {
  assert.match(renderAnswer({...base, kind: 'count', status: 'incomplete', complete: false, at_least: 50}), /^At least 50;/);
  assert.equal(renderAnswer({...base, kind: 'count', status: 'supported', count: 3}), '3.');
  const text = renderAnswer({...base, status: 'supported', complete: false, answers: [{binding: {'?x': 'ulm'}}], proof: [fact('c1', 'born_in', ['albert_einstein', 'ulm'], 'Wikidata Q937 P19')]});
  assert.match(text, /not exhaustive/);
});

test('cnl uses the natural answer for query results and keeps the generic lines for other packets', () => {
  const packet = {...base, status: 'supported', answers: [{binding: {'?x': 'paris'}}], proof: [fact('c1', 'capital_of', ['paris', 'france'], 'x')]};
  assert.equal(cnl(packet).text, renderAnswer(packet));
  assert.equal(cnl(packet).packet, packet);
  assert.equal(renderable({status: 'plan_found', plan: {}}), false);
  assert.match(cnl({status: 'entailed', kind: 'constraint', complete: true}).text, /holds in every model/);
});

test('cnl renders a universal (mode every) packet with or without the count of known members', () => {
  // The strict universal of the engines reports no member count; the line about it is then left out instead of failing the turn.
  const every = {status: 'refuted', kind: 'every', complete: true, counterexamples: [{'?m': 'b1'}], answers: [], query: {mode: 'every'}};
  assert.match(cnl(every).text, /COUNTEREXAMPLE \?m = "b1"/);
  assert.match(cnl({...every, members: 2}).text, /Known members checked: 2\./);
});
