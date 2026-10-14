// Problem mode (DS014 "Problems that state their own data", DS004 "Exact arithmetic"): a message that gives its own data is
// modelled with session predicates, stated data and session rules; the engines compute with exact decimal arithmetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Agent} from '../../server/agent.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {numberMentioned} from '../../lib/query-author/admit.mjs';
import {validateQuery} from '../../lib/query-author/validate.mjs';
import {compute} from '../../reasoning/strategies/js-reference/values.mjs';
import {lowerLeaf} from '../../reasoning/strategies/asp-clingo/lower.mjs';
import {NotExpressibleError} from '../../reasoning/strategies/js-reference/index.mjs';
import {readValues, readFormulas, arithmeticCircuit} from '../../lib/query-author/step-by-step/problem.mjs';
import {context} from '../helpers.mjs';

const lexicon = new Lexicon(`@works_at predicate
  args subject:entity object:entity
  label en "works at"
@cost predicate
  args subject:entity object:integer
  label en "costs"
`);

async function turn(t, message, sop) {
  const c = context({bootstrap: false});
  t.after(c.dispose);
  const agent = new Agent({repo: c.repo, session: c.session, lexicon, config: {}});
  return agent.turn(message, {language: 'en', formalizer: {formalize: async () => sop}});
}

const stated = (id, relation, roles, polarity = 'affirmed') => `@${id} stated\n  certainty asserted\n  relation "${relation}"\n${roles.map(([n, v]) => `  role ${n} ${typeof v === 'number' ? v : JSON.stringify(v)}`).join('\n')}\n  polarity ${polarity}\n`;

test('exact arithmetic: divided_by is exact, decimals are numbers, rounding words round to a multiple, power takes an integer exponent', () => {
  assert.equal(compute('divided_by', 7, 2), 3.5);
  assert.equal(compute('whole_divided_by', -7, 2), -3);
  assert.equal(compute('modulo', 100, 7), 2);
  assert.equal(compute('plus', 0.1, 0.2), 0.3);
  assert.equal(compute('rounded_to', 293.3333333, 0.01), 293.33);
  assert.equal(compute('rounded_up_to', 50.5 / 28, 1), 2);
  assert.equal(compute('rounded_down_to', 7.9, 1), 7);
  assert.equal(compute('power', 1.05, 2), 1.1025);
  assert.equal(compute('power', 2, 0.5), undefined);
  assert.equal(compute('divided_by', 1, 0), undefined);
  assert.throws(() => lowerLeaf({kind: 'compute', word: 'divided_by', out: '?q', left: 7, right: 2}), NotExpressibleError, 'an integer engine declines exact division');
});

test('numeric anchoring: a stated number is mentioned with separators, as a decimal or as a number word; a number the message does not write is not', () => {
  assert.ok(numberMentioned(4000, 'borrows 4,000 for'));
  assert.ok(numberMentioned(1.84, 'plus 1.84 per unit'));
  assert.ok(numberMentioned(3, 'three apples'));
  assert.ok(!numberMentioned(5, 'the 15 cats'));
});

test('a problem: stated data over its own vocabulary, a rule with decimal arithmetic, the names of the same turn in the question and the rule', async t => {
  const sop = `@unit_price predicate\n  args subject:entity object:value\n@quantity predicate\n  args subject:entity object:value\n@total_price predicate\n  args subject:entity object:value\n`
    + stated('s1', 'unit_price', [['subject', 'Pens'], ['object', 1.5]]) + stated('s2', 'quantity', [['subject', 'Pens'], ['object', 12]])
    + `@total_rule rule\n  when unit_price "Pens" ?p\n  when quantity ?item ?n\n  when compute ?t ?p times ?n\n  then total_price "Pens" ?t\n`
    + `@q query\n  select ?t\n  where match\n    relation "total_price"\n    role subject "Pens"\n    role object ?t\n    polarity affirmed\n  end\n`;
  const r = await turn(t, 'Pens cost 1.5 each. What do 12 pens cost?', sop);
  assert.equal(r.packet.status, 'supported', r.text);
  assert.deepEqual(r.packet.answers.map(a => a.binding['?t']), [18]);
  assert.equal(r.packet.session_circuits?.reason, 'problem_vocabulary', 'a problem\'s own vocabulary stays turn-scoped');
});

test('a problem\'s lowercase things are conversation entities, and a check rule pair answers no rather than unknown', async t => {
  const sop = `@price_of predicate\n  args subject:entity object:value\n@card_minimum predicate\n  args object:value\n@card_accepted predicate\n  args subject:entity\n`
    + stated('s1', 'price_of', [['subject', 'water'], ['object', 3]]) + stated('s2', 'card_minimum', [['object', 20]])
    + `@yes rule\n  when price_of ?i ?p\n  when card_minimum ?m\n  when compare ?p at_least ?m\n  then card_accepted ?i\n`
    + `@no rule\n  when price_of ?i ?p\n  when card_minimum ?m\n  when compare ?p below ?m\n  then not card_accepted ?i\n`
    + `@q query\n  where match\n    relation "card_accepted"\n    role subject "water"\n    polarity affirmed\n  end\n`;
  const r = await turn(t, 'Water costs 3. Cards are refused under 20. Is a card accepted for one water?', sop);
  assert.equal(r.packet.status, 'refuted', r.text);
});

test('a chain with arithmetic: the critical path is a recursive sum and a max aggregate', async t => {
  const tasks = [['A', 16], ['B', 15], ['C', 8], ['D', 10]], deps = [['B', 'A'], ['C', 'A'], ['D', 'B'], ['D', 'C']];
  let k = 0;
  const sop = `@duration_of predicate\n  args subject:entity object:value\n@runs_after predicate\n  args subject:entity object:entity\n@path_finish predicate\n  args subject:entity object:value\n@earliest_finish predicate\n  args subject:entity object:value\n`
    + tasks.map(([n, d]) => stated(`s${++k}`, 'duration_of', [['subject', n], ['object', d]])).join('') + deps.map(([a, b]) => stated(`s${++k}`, 'runs_after', [['subject', a], ['object', b]])).join('')
    + `@start rule\n  when duration_of ?t ?d\n  then path_finish ?t ?d\n@chain rule\n  when runs_after ?t ?p\n  when path_finish ?p ?fp\n  when duration_of ?t ?d\n  when compute ?f ?fp plus ?d\n  then path_finish ?t ?f\n`
    + `@finish aggregate\n  over path_finish ?t ?f\n  group ?t\n  max ?f as ?m\n  yields earliest_finish ?t ?m\n`
    + `@q query\n  select ?m\n  where match\n    relation "earliest_finish"\n    role subject "D"\n    role object ?m\n    polarity affirmed\n  end\n`;
  const r = await turn(t, 'Tasks: A 16, B 15, C 8, D 10. B and C after A; D after B and C. When does D finish at the earliest?', sop);
  // Over the chat memory the answer is supported; the test repository's retrieval guard (R-P2) keeps a recursive aggregate incomplete.
  assert.ok(['supported', 'incomplete'].includes(r.packet.status), r.text);
  assert.deepEqual(r.packet.answers.map(a => a.binding['?m']), [41]);
});

test('two puzzles of one problem select the same variable name independently; an infeasible one is reported, not asked about', async t => {
  const sop = '@c1 constraint\n  var ?n int 13 100\n  require 220 plus 50 times ?n at_most 1000\n  objective 8 times ?n\n  direction max\n  task optimize\n  select ?n\n'
    + '@c2 constraint\n  var ?n int 13 100\n  require 380 plus 50 times ?n at_most 1000\n  objective 8 times ?n plus 120\n  direction max\n  task optimize\n  select ?n\n';
  const r = await turn(t, 'Budget 1000, fixed 220, each unit 50 and 8 points, at least 13 units; an add-on costs 160 and adds 120 points.', sop);
  assert.match(r.text, /Answer: n = 15\./);
  assert.match(r.text, /inconsistent/);
  assert.notEqual(r.packet.status, 'clarify');
});

test('a problem output is validated without the memory-name check, and an identical statement twice is a validator problem', () => {
  const lex = new Lexicon('@works_at predicate\n  args subject:entity object:entity\n');
  const base = '@fee predicate\n  args object:value\n' + stated('s1', 'fee', [['object', 4]]) + '@q query\n  select ?x\n  where match\n    relation "fee"\n    role object ?x\n    polarity affirmed\n  end\n';
  const ok = validateQuery({sop: base, message: 'In Maple Ward the fee is 4. What is the fee?', lexicon: lex, mentions: [{surface: 'Maple Ward', strong: true, candidates: []}]});
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  const twice = validateQuery({sop: base.replace('@q query', stated('s2', 'fee', [['object', 4]]).trimEnd() + '\n@q query'), message: 'the fee is 4', lexicon: lex});
  assert.equal(twice.problems[0]?.code, 'stated_duplicate');
});

test('step-by-step problem lines: numbers the message writes, formulas with functions and checks, a percentage stated as written', () => {
  const values = readValues('loan = 4000\nrate = 0.11\nmonths = 8\ninvented = 77', 'Kara borrows 4,000 for 8 months at 11%.');
  assert.deepEqual(values, [{name: 'loan', value: 4000}, {name: 'rate', value: 11, percent: true}, {name: 'months', value: 8}]);
  const formulas = readFormulas('interest = round(loan * rate * months / 12, 0.01)\naffordable = interest <= 300', values.map(v => v.name));
  assert.deepEqual(formulas.map(f => f.name), ['interest', 'affordable']);
  assert.equal(formulas[1].check.conditions[0].word, 'at_most');
  const sop = arithmeticCircuit({values, formulas, lexicon: {predicates: {}}});
  assert.match(sop, /relation "rate_percent"\n {2}role object 11/);
  assert.match(sop, /when compute \?f \?p divided_by 100\n {2}then rate \?f/);
  assert.match(sop, /then not affordable 1/);
});

test('a problem\'s statements expire with its turn: the next turn of the same conversation does not meet its turn-scoped vocabulary', async t => {
  const c = context({bootstrap: false});
  t.after(c.dispose);
  const agent = new Agent({repo: c.repo, session: c.session, lexicon, config: {}});
  const problem = `@distance_km predicate\n  args object:value\n@double_km predicate\n  args object:value\n` + stated('s1', 'distance_km', [['object', 12]])
    + `@r rule\n  when distance_km ?d\n  when compute ?t ?d times 2\n  then double_km ?t\n@q query\n  select ?x\n  where match\n    relation "double_km"\n    role object ?x\n    polarity affirmed\n  end\n`;
  const first = await agent.turn('A trip is 12 km. How far there and back?', {language: 'en', formalizer: {formalize: async () => problem}});
  assert.deepEqual(first.packet.answers.map(a => a.binding['?x']), [24]);
  assert.ok(!agent.context.statements.some(s => s.atom?.p === 'distance_km'), 'no problem statement is carried on');
  const plain = `@q query\n  select ?x\n  where match\n    relation "works_at"\n    role subject ?x\n    role object "acme"\n    polarity affirmed\n  end\n`;
  const second = await agent.turn('Who works at Acme?', {language: 'en', formalizer: {formalize: async () => plain}});
  assert.ok(second.packet, 'the next turn runs');
});
