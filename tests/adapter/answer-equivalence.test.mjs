// Symbolic answer equivalence (lib/formalize/equivalence.mjs): every check of the catalog on invented short answers, the memory's unit
// facts and entities, the reasoner's mutual entailment, and the rule that a false "equivalent" never comes from a guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import {decide, timeOf, numberOf, statementOf} from '../../lib/formalize/equivalence.mjs';
import {seedLexicon} from '../../lib/knowledge-seeds.mjs';

const lexicon = seedLexicon('commonsense-v1');
const v = async (a, b, ctx = {}) => (await decide(a, b, {lexicon, ...ctx})).verdict;

test('structural: yes/no, numbers with stated precision, percent, times, labels', async () => {
  assert.equal(await v(true, 'Yes'), 'equivalent');
  assert.equal(await v('No', 'false'), 'equivalent');
  assert.equal(await v('Yes, 28', 'yes'), 'equivalent');
  assert.equal(await v('Yes, 28', 'yes, 30'), 'different');
  assert.equal(await v('58.89', 58.8888), 'equivalent');
  assert.equal(await v('58.9', 58.8888), 'equivalent');
  assert.equal(await v('59', 58.4), 'different');
  assert.equal(await v('12', '13'), 'different');
  assert.equal(await v('44.1%', '0.441'), 'equivalent');
  assert.equal(await v('44.1%', '0.45'), 'different');
  assert.equal(await v('08:40', '8:40 am'), 'equivalent');
  assert.equal(await v('8:40 pm', '20:40'), 'equivalent');
  assert.equal(await v('08:40', 520), 'equivalent');
  assert.equal(await v('Plan B', 'Plan A'), 'different');
  assert.equal(await v('Plan B', 'B'), 'equivalent');
  assert.equal(await v('window 2', 'window 3'), 'different');
  assert.equal(timeOf('25:10'), null);
  assert.equal(numberOf('1,200 kg').value, 1200);
});

test('units through the memory: 120 minutes = 2 hours, 150 minutes is not 2 hours', async () => {
  assert.equal(await v('120 minutes', '2 hours'), 'equivalent');
  assert.equal(await v('150 minutes', '2 hours'), 'different');
  assert.equal(await v('150 minutes', '2.5 hours'), 'equivalent');
  assert.equal(await v('2 kg', '2 hours'), 'different');
  assert.equal(await v('2.5 hours', 150, {problem: 'The trip takes some minutes.'}), 'equivalent');
});

test('lists: sets unless the order matters', async () => {
  assert.equal(await v('Mara, Ana', 'Ana and Mara'), 'equivalent');
  assert.equal(await v('Tom, Ana, Ben', 'Ben, Ana, Tom', {ordered: true}), 'different');
  assert.equal(await v('Tom, Ana', 'Tom, Ana, Ben'), 'different');
});

test('entailment through the reasoner: B is active against B is not inactive under an exclusivity rule', async () => {
  // An invented reasoner over one rule: inactive excludes active and the reverse (closed world over the stated atoms).
  const rules = [['inactive', 'not active'], ['active', 'not inactive'], ['not inactive', 'active'], ['not active', 'inactive']];
  const entail = async (facts, _rules, atom) => {
    const known = new Set(facts.map(f => f.replace(/ ".*"$/, '')));
    for (let changed = true; changed;) { changed = false; for (const [p, q] of rules) if (known.has(p) && !known.has(q)) { known.add(q); changed = true; } }
    return known.has(atom.replace(/ ".*"$/, ''));
  };
  assert.deepEqual(statementOf('B is not inactive'), {thing: 'b', negated: true, property: 'inactive'});
  assert.equal(await v('B is active', 'B is not inactive', {entail}), 'equivalent');
  assert.equal(await v('B is active', 'B is inactive', {entail}), 'different');
});

test('the tier decides only free text, never numbers or labels; unknown is not equivalent', async () => {
  const tier = async () => true;   // a tier that always says "same" would be a false positive anywhere it is asked
  assert.equal(await v('12', '13', {tier}), 'different');
  assert.equal(await v('Plan A', 'Plan B', {tier}), 'different');
  assert.equal((await decide('the headline', 'the title', {lexicon, tier})).check, 'tier');
  assert.equal(await v('the headline', 'the title'), 'unknown');
});
