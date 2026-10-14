// The deterministic half of the PSM/LFM architecture (experiments/proposal/structure-and-formalizer-models.md): the FOL reader,
// FOL → SOP-IR clausification with its rejections, SOP-IR → SOP Lang circuits executed on the product's engines (perturbation through
// the registry included), the PSM extraction → inventory converter, and the client of the two JSON tiers (a fake Ploinky transport). The
// prompted roles behind those tiers are Ploinky's (Ploinky/lib/prompted.mjs, tested with Ploinky).
// No model is called: FOL strings and PSM extractions here are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFol, showFol, tokenize} from '../../lib/formalize/fol/parse.mjs';
import {folToIr} from '../../lib/formalize/fol/to-ir.mjs';
import {compileIr} from '../../lib/formalize/fol/to-sop.mjs';
import {sentencesOf} from '../../lib/formalize/fol/input.mjs';
import {structureToIr, linkConstants, questionRanges} from '../../lib/formalize/structure/to-ir.mjs';
import {loadSchema, schemaRequest, sketchSentences} from '../../lib/formalize/structure/schema.mjs';
import {registryOf} from '../../lib/formalize/expression-program.mjs';
import {perturbations, perturbCircuit} from '../../lib/formalize/dual-check.mjs';
import {engines} from '../../tools/eval/routed/structure/engines.mjs';
import {askedVerdict} from '../../tools/eval/routed/structure/asked.mjs';
import {goldOf} from '../../tools/eval/routed/structure/gold.mjs';
import {extractStructure, formalizeFol} from '../../lib/formalize/small-models.mjs';

const unit = (text, question = false) => { const p = parseFol(text); assert.ok(p.ok, `${text}: ${p.why}`); return {ast: p.ast, question, source: text}; };
const ir = (...specs) => folToIr(specs.map(s => (Array.isArray(s) ? unit(...s) : unit(s))));

test('FOL reader: glued keywords, precedence, free variables, one structural repair, refusals', () => {
  assert.deepEqual(tokenize('NOTPenguin(x)').map(t => t.t), ['op', 'name', 'lp', 'name', 'rp']);
  assert.equal(showFol(parseFol('FORALLxFORALLy (A(x) AND B(y) IMPLIES C(x, y))').ast), 'FORALLx (FORALLy (((A(x) AND B(y)) IMPLIES C(x, y))))');
  assert.equal(showFol(parseFol('∀x (Bird(x) ∧ ¬Penguin(x) → Flies(x))').ast), 'FORALLx (((Bird(x) AND NOT Penguin(x)) IMPLIES Flies(x)))');
  assert.equal(showFol(parseFol('A(ann) OR B(ann) AND C(ann)').ast), '(A(ann) OR (B(ann) AND C(ann)))');
  assert.equal(showFol(parseFol('A(ann) IMPLIES B(ann) IMPLIES C(ann)').ast), '(A(ann) IMPLIES (B(ann) IMPLIES C(ann)))');
  const free = parseFol('PostOffice(x, east100) IMPLIES From(x, post)');
  assert.deepEqual(free.free, ['x']);
  assert.equal(free.ast.type, 'forall');
  assert.equal(parseFol('In(cedar, northland))').repaired, true);
  assert.equal(parseFol('In(cedar, northland').ok, true);
  assert.equal(parseFol('(ManyY, x)').ok, false);
  assert.equal(parseFol('').ok, false);
  const t = parseFol('Value(total, add(price, 3))').ast;
  assert.deepEqual(t.args[1], {fn: 'add', args: [{const: 'price'}, {num: 3}]});
  // Several variables per quantifier, spaced keywords, prefix connectives, infix comparisons and arithmetic, quoted text.
  const show = x => showFol(parseFol(x).ast);
  assert.equal(show('FORALLx,y (In(x,y) IMPLIES Near(x,y))'), show('FORALLx FORALLy (In(x, y) IMPLIES Near(x, y))'));
  assert.equal(show('FORALLx, FORALLy (In(x,y) IMPLIES Near(x,y))'), show('FORALLx FORALLy (In(x, y) IMPLIES Near(x, y))'));
  assert.equal(show('Exists k (Eq(n, mul(k, 5)))'), 'FORALLn (EXISTSk (Eq(n, mul(k, 5))))');
  assert.equal(show('AND(Eq(a_x, b_x), OR(P(ann), Q(ann), R(ann)))'), '(Eq(a_x, b_x) AND ((P(ann) OR Q(ann)) OR R(ann)))');
  // A quantifier followed by parentheses scopes over them only: (∀z (A → B)) → C.
  assert.equal(show('FORALLy (FORALLz (A(y, z) IMPLIES B(z)) IMPLIES C(y))'), 'FORALLy ((FORALLz ((A(y, z) IMPLIES B(z))) IMPLIES C(y)))');
  assert.equal(show('x <= 88'), 'FORALLx (Le(x, 88))');
  assert.equal(show('City(cc) AND cc != dd'), '(City(cc) AND NOT Eq(cc, dd))');
  assert.equal(show('Value(hours, 1/60)'), 'Value(hours, div(1, 60))');
  assert.equal(show('(a + b) * 2 >= c - -3'), 'FORALLa (FORALLb (FORALLc (Ge(mul(add(a, b), 2), sub(c, -3)))))');
  assert.equal(show(`Says(eli, 'It rained.')`), 'Says(eli, It rained.)');
  assert.equal(parseFol('NOTPenguin(x)').ast.implicit, true);
});

test('FOL → SOP-IR: Horn clausification, Skolem constants, constraints, and named rejections', () => {
  let r = ir('Cat(tom) AND NOTDog(tom)', 'FORALLx (Cat(x) IMPLIES (Mammal(x) AND Animal(x)))');
  assert.equal(r.facts.length, 2); assert.equal(r.facts[1].negated, true);
  assert.equal(r.rules.length, 2);
  r = ir('FORALLx (Bird(x) OR Bat(x) IMPLIES Flies(x))', 'FORALLx (A(x) IMPLIES (B(x) IMPLIES C(x)))', 'FORALLx (P(x) IFF Q(x))');
  assert.equal(r.rules.length, 5);
  assert.equal(r.rules[2].when.length, 2);
  r = ir('EXISTSx (Box(x) AND Red(x))');
  assert.deepEqual(r.facts.map(f => f.args[0].const), ['sk1', 'sk1']);
  r = ir('NOTEXISTSx (Bird(x) AND Penguin(x) AND Flies(x))');
  assert.equal(r.rules[0].then.negated, true); assert.equal(r.rules[0].when.length, 2);
  r = ir('FORALLx EXISTSy Parent(y, x)', 'FORALLx Mortal(x)', 'FORALLx (Cat(x) IMPLIES Likes(x, y))', 'Ge(x, y) OR Big(a)');
  assert.deepEqual(r.rejected.map(x => x.why.split(' ').slice(0, 3).join(' ')), ['a conclusion with', 'a statement about', 'unsafe rule: variable', 'a conclusion with']);
  assert.deepEqual(r.rejected[2].preds, ['Cat', 'Likes']);
  // Non-Horn conclusions: a disjunction is one rule per disjunct over the others' explicit negations (and open predicates); XOR adds
  // the two exclusions; an existential keeps its part without the new thing.
  r = ir('FORALLx (Bird(x) IMPLIES (Flies(x) OR Swims(x)))', 'A(ann) XOR B(ann)', 'FORALLx (Tooth(x) IMPLIES EXISTSy (Hard(x) AND Shape(x, y)))');
  assert.equal(r.rules.length, 2 + 4 + 1);
  assert.deepEqual(r.rules[0].when.map(c => [c.pred, Boolean(c.strong)]), [['Bird', false], ['Swims', true]]);
  assert.deepEqual(r.open, ['Flies', 'Swims', 'A', 'B', 'Shape']);
  // Numeric statements: comparisons are conditions, a free letter is a quantity, Integer and objectives are kept.
  r = ir('Integer(n)', 'Ge(n, 3)', 'x <= 88', 'Eq(mod(n, 4), 1)', 'Maximize(n)');
  assert.deepEqual([r.integer, r.constraints.map(c => c.cmp), r.objectives.map(o => o.direction)], [['n'], ['Ge', 'Le', 'Eq'], ['max']]);
  r = ir(['Mammal(tom)', true], ['EXISTSx Mammal(x)', true], ['Ask(earn)', true], ['Gt(earn, 50)', true], ['FORALLx (A(x) IMPLIES B(x))', true], ['NOTEXISTSx Mammal(x)', true], ['FORALLx (Eq(mul(x, 2), 12) IMPLIES Ask(x))', true]);
  assert.deepEqual(r.queries.map(q => q.kind), ['yesno', 'which', 'value', 'compare', 'every', 'none', 'value']);
});

test('SOP-IR → SOP Lang executes on the engines: yes/no, which, closed world, constraints, time order', async () => {
  const w = await engines();
  const runAll = async (r, names = new Map()) => { const {circuits, rejected} = compileIr(r, {names}); assert.deepEqual(rejected, []); const out = []; for (const c of circuits) out.push(c.decode(await w.run(c.sop, c.literals))); return out; };
  // A closed-world "no" needs the predicate defined by the problem; one only the question names is no answer.
  assert.deepEqual(await runAll(ir('Cat(tom)', 'Dog(rex)', 'Likes(tom, rex)', 'Likes(rex, ann)', 'FORALLx (Cat(x) IMPLIES Mammal(x))', ['Mammal(tom)', true], ['EXISTSx Mammal(x)', true],
    ['Likes(tom, ann)', true], ['EXISTSx (Dog(x) AND Cat(x))', true], ['Bird(tom)', true], ['EXISTSx Bird(x)', true]), new Map([['tom', 'Tom']])),
    [true, ['Tom'], false, [], null, null]);
  assert.deepEqual(await runAll(ir('NOTEXISTSx (Bird(x) AND Penguin(x) AND Flies(x))', 'Bird(pingu)', 'Penguin(pingu)', ['Flies(pingu)', true])), [false]);
  assert.deepEqual(await runAll(ir('Before(breakfast, lunch)', 'After(dinner, lunch)', ['Before(breakfast, dinner)', true], ['Before(dinner, breakfast)', true])), [true, false]);
  assert.deepEqual(await runAll(ir('Bird(tweety)', 'Bird(pingu)', 'Penguin(pingu)', 'FORALLx (Bird(x) AND NOTPenguin(x) IMPLIES Flies(x))', ['Flies(tweety)', true], ['Flies(pingu)', true], ['EXISTSx (Bird(x) AND NOTFlies(x))', true]), new Map([['pingu', 'Pingu']])), [true, false, ['Pingu']]);
  assert.deepEqual(await runAll(ir('In(cedar, northland)', 'In(northland, republic_d)', 'FORALLx FORALLy FORALLz (In(x, y) AND In(y, z) IMPLIES In(x, z))', ['In(cedar, republic_d)', true])), [true]);
});

test('values: numbers map to the registry, so the same circuit follows perturbed numbers; compare queries', async () => {
  const w = await engines();
  const message = 'A bakery bakes 24 muffins and sells them at 3 dollars each. 5 are left unsold. How much does it earn?';
  const registry = registryOf(message);
  const r = ir('Value(muffins, 24)', 'Value(price, 3)', 'Value(unsold, 5)', 'Value(earn, mul(sub(muffins, unsold), price))', ['Ask(earn)', true], ['Gt(earn, 50)', true]);
  const {circuits} = compileIr(r, {registry});
  assert.deepEqual(circuits[0].program.map(l => `${l.name} = ${l.text}`), ['q_muffins = v1', 'q_unsold = v3', 'q_price = v2', 'q_earn = ((q_muffins - q_unsold) * q_price)', 'answer1 = q_earn']);
  assert.equal(circuits[0].decode(await w.run(circuits[0].sop, circuits[0].literals)), 57);
  assert.equal(circuits[1].decode(await w.run(circuits[1].sop, circuits[1].literals)), true);
  const [map] = perturbations(registry, {k: 1, seed: 'test'});
  const moved = perturbCircuit(circuits[0].sop, map);
  const [m, p, u] = [24, 3, 5].map(x => map.get(x));
  assert.equal(circuits[0].decode(await w.run(moved, [...map.values()].map(String))), (m - u) * p);
  const written = compileIr(ir('Value(earn, 57)', ['Ask(earn)', true]), {registry});
  assert.match(written.rejected[0].why, /computes nothing from the problem's numbers/);
  const bad = compileIr(ir('Value(earn, mul(muffins, 2))', ['Ask(earn)', true]), {registry});
  assert.match(bad.rejected[0].why, /muffins is used but never given a Value/);
});

test('non-Horn logic on the engines: disjunctions, IFF conclusions, universal and negated conditions, universal questions, trust', async () => {
  const w = await engines();
  const answers = async (units, {names = new Map(), registry = []} = {}) => {
    const {circuits, rejected} = compileIr(folToIr(units.map(u => (typeof u === 'string' ? unit(u) : u.unparsed ? u : unit(...u)))), {names, registry});
    assert.deepEqual(rejected, []);
    const out = [];
    for (const c of circuits) out.push(c.decode(await w.run(c.sop, c.literals)));
    return out;
  };
  // A disjunction concludes a disjunct only when the others are explicitly false; an undecided disjunct is not refuted.
  assert.deepEqual(await answers(['FORALLx (Seed(x) IMPLIES (Wind(x) OR Water(x)))', 'Seed(s1)', 'NOT Water(s1)', 'Seed(s2)', ['Wind(s1)', true], ['Wind(s2)', true]]), [true, null]);
  assert.deepEqual(await answers(['FORALLx (Person(x) IMPLIES (Adult(x) IFF Votes(x)))', 'Person(ann)', 'Adult(ann)', 'Person(bo)', ['Votes(ann)', true], ['Votes(bo)', true]]), [true, false]);
  // "every required attribute": a universal inside a condition, over the things the problem names.
  const cells = ['Has(a1, forest)', 'Has(a1, road)', 'Has(b2, road)', 'Required(task, forest)', 'Required(task, road)'];
  assert.deepEqual(await answers([...cells, 'FORALLx FORALLy (FORALLz (Required(y, z) IMPLIES Has(x, z)) IMPLIES Satisfies(x, y))', ['EXISTSx Satisfies(x, task)', true]]), [['a1']]);
  assert.deepEqual(await answers([...cells, 'FORALLx FORALLy ((Cell(x) AND FORALLz (Required(y, z) IMPLIES Has(x, z))) IMPLIES Satisfies(x, y))', 'Cell(b2)', ['EXISTSx Satisfies(x, task)', true]]), [[]]);
  assert.deepEqual(await answers(['Clue(c1)', 'Clue(c2)', 'Eliminates(c1, n2)', ['EXISTSx (Clue(x) AND NOT EXISTSy Eliminates(x, y))', true]]), [['c2']]);
  // A universal question covers the known members; no member at all is no answer.
  assert.deepEqual(await answers(['City(a1)', 'City(b1)', 'Big(a1)', 'Town(t1)', ['FORALLx (City(x) IMPLIES Big(x))', true], ['FORALLx (Town(x) IMPLIES Town(x))', true], ['FORALLx (Village(x) IMPLIES Big(x))', true]]), [false, true, null]);
  // A closed-world "no" is withheld when a statement about the predicate was not understood.
  const likes = ['Likes(tom, rex)', 'Likes(rex, ann)'];
  assert.deepEqual(await answers([...likes, ['Likes(tom, ann)', true]]), [false]);
  assert.deepEqual(await answers([...likes, {unparsed: 'Likes(tom, ann) %% maybe', source: 'x'}, ['Likes(tom, ann)', true]]), [null]);
  // The contrapositive of a comparison conclusion is an explicit negation, sound without the closed world.
  const message = 'Option A scores at least 49 and option B at most 52. A ranking is robust only if min A is above max B. Is it robust?';
  assert.deepEqual(await answers(['Value(low_a, 49)', 'Value(high_b, 52)', 'Robust(opt_a, opt_b) IMPLIES Gt(low_a, high_b)', {unparsed: 'Robust(opt_a, opt_b) IFF %%', source: 'y'}, ['Robust(opt_a, opt_b)', true]], {registry: registryOf(message)}), [false]);
});

test('numbers on the engines: unknowns as a constraint search, objectives, value rules, pow, asked unknowns in a rule', async () => {
  const w = await engines();
  const answers = async (message, lines) => {
    const {circuits, rejected} = compileIr(folToIr(lines.map(l => unit(l.replace(/^\?\s*/, ''), l.startsWith('?')))), {registry: registryOf(message)});
    const out = [];
    for (const c of circuits) out.push(c.decode(await w.run(c.sop, c.literals)));
    return {out, rejected: rejected.map(r => r.why)};
  };
  const search = 'A count n is at least 70 and at most 77, a multiple of 4, and n plus 3 must stay within 77. What is n?';
  assert.deepEqual((await answers(search, ['Integer(n)', 'Ge(n, 70)', 'Le(n, 77)', 'Eq(mod(n, 4), 0)', 'Value(limit, 77)', 'Le(add(n, 3), limit)', '? Ask(n)'])).out, [72]);
  assert.deepEqual((await answers(search, ['Integer(n)', 'Ge(n, 70)', 'Le(n, 77)', 'Le(add(n, 3), 77)', '? Ask(n)'])).out, [null]);
  assert.match((await answers(search, ['Ge(n, 70)', 'Le(n, 77)', '? Ask(n)'])).rejected[0], /not declared a whole number/);
  assert.deepEqual((await answers(search, ['Integer(n)', 'Ge(n, 70)', 'Le(n, 77)', 'Eq(mod(n, 4), 0)', '? Ge(n, 70)', '? Ge(n, 74)'])).out, [true, null]);
  const plan = 'Budget 1400, fixed cost 260, each unit costs 50 and gives 8 points; an add-on costs 210 and gives 100 points; at least 12 units, at most 1 add-on. Best plan?';
  assert.deepEqual((await answers(plan, ['Integer(units)', 'Integer(addon)', 'Ge(units, 12)', 'Ge(addon, 0)', 'Le(addon, 1)', 'Le(add(260, mul(units, 50), mul(addon, 210)), 1400)',
    'Value(points, add(mul(units, 8), mul(addon, 100)))', 'Maximize(points)', '? Ask(units)', '? Ask(points)'])).out, [[18, 244]]);
  const fees = 'Two children, long hours: 1050; short hours: 700. Families in River get 50 off. Hugo lives in River and wants long hours. How much?';
  assert.deepEqual((await answers(fees, ['Value(children, 2)', 'Value(hours, long_hours)', 'LivesIn(hugo, river)',
    '(Value(hours, long_hours) AND Value(children, 2)) IMPLIES Value(base_fee, 1050)', '(Value(hours, short_hours) AND Value(children, 2)) IMPLIES Value(base_fee, 700)',
    'LivesIn(hugo, river) IMPLIES Value(discount, 50)', 'FORALLx (Value(base_fee, x) IMPLIES Value(owed, sub(x, discount)))', '? Ask(owed)'])).out, [1000]);
  assert.deepEqual((await answers('A code has 3 binary positions. How many messages?', ['Value(positions, 3)', 'Value(messages, pow(2, positions))', '? Ask(messages)'])).out, [8]);
  assert.deepEqual((await answers('Each unit breaks 2 pieces. How many units for 12 pieces?', ['Value(rate, 2)', '? FORALLx (Eq(mul(x, rate), 12) IMPLIES Ask(x))'])).out, [6]);
  assert.match((await answers('A price is 5.', ['Value(p, 5)', 'Value(p, 6)', '? Ask(p)'])).rejected[0], /two different values/);
});

test('the asked-parts scorer: inputs and check values leave the gold list, clock pairs join, partial and wrong answers are told apart', () => {
  const item = (question, answer, values) => ({id: 'test:1', question, answer, answer_kind: 'list', answer_value: values});
  const v = (it, ...values) => askedVerdict(it, goldOf(it), values.map(value => ({kind: Array.isArray(value) ? 'which' : 'value', value}))).verdict;
  const fees = item('Base 1050 for 2 children, lunch 205 each, 50 off. How much?', '1050 + 2×205 − 50 = 1410.', [1050, 2, 205, 50, 1410]);
  assert.equal(v(fees, 1410), 'correct');
  const tanks = item('A tank holds 24 units: 7, 4 and 13. Move 4, then 2. Final state, and check the total?', 'Final: 3, 6, 15; the total is 24.', [3, 6, 15, 24]);
  assert.deepEqual([v(tanks, 3, 6, 15, true), v(tanks, 3, 15), v(tanks, 3, 2, 15), v(tanks, 99)], ['correct', 'partial', 'wrong', 'wrong']);
  const trip = item('Leave at 9:00, drive 168 km at 60 km/h. How long, and when do you arrive?', '2.80 h ≈ 2 h 48 min. Arrival 11:48.', [2.8, 2, 48, 11, 48]);
  assert.equal(v(trip, 2.8, 11.8), 'correct');
  const reasons = item('A card needs 7 points; Ana has 5. Is the refusal forced?', 'The refusal is forced by the definition (5 < 7).', [5, 7]);
  assert.equal(v(reasons, true), 'gold_defect');
  assert.equal(v(item('Draw 8 times; 2 of 8 balls are red. Chance per draw?', 'P=2/8=1/4. Expected reds in 8 draws: 2.', [0.25, 8, 2]), 0.25), 'correct');
  assert.equal(v({id: 'test:2', question: 'Is it raining?', answer: 'No.', answer_kind: 'yes_no', answer_value: false}, 10, false), 'correct');
});

test('PSM extraction → inventory: registry coverage, goals in the question, names, relation de-duplication, sketch', () => {
  const text = 'Ana has 12 apples and gives 5 to Ben. How many apples does Ana have left?';
  const ext = {entities: {quantity: [{text: '12 apples', start: 8, end: 17}, {text: 'some', start: 0, end: 0}], entity: [{text: 'Ana', start: 0, end: 3}, {text: 'Ben', start: 33, end: 36}], goal: [{text: 'How many apples', start: 38, end: 53}], condition: [{text: 'gives 5 to Ben', start: 22, end: 36}]},
    relations: [{type: 'has_quantity', head: {text: 'Ana'}, tail: {text: '12 apples'}}, {type: 'has_quantity', head: {text: 'Ana'}, tail: {text: '12 apples'}}]};
  const s = structureToIr(ext, text);
  assert.deepEqual(s.numbers.map(n => [n.value, Boolean(n.quantity)]), [[12, true], [5, false]]);
  assert.deepEqual(s.wordQuantities, ['some']);
  assert.equal(s.goals[0].inQuestion, true);
  assert.deepEqual([...s.names.values()], ['Ana', 'Ben']);
  assert.equal(s.relations.length, 1);
  assert.deepEqual(questionRanges('A. B?'), [[3, 5]]);
  const link = linkConstants(ir('Has(ana, apples)'), s.names);
  assert.deepEqual(link, {linked: ['ana'], unlinked: ['apples']});
  const sketch = sketchSentences(ext, text, {relations: {has_quantity: {render: '{head} has {tail}.'}}});
  assert.deepEqual(sketch.map(u => u.text), ['Ana has 12 apples and gives 5 to Ben.', 'How many apples does Ana have left?', 'Ana has 12 apples.']);
  assert.deepEqual(sentencesOf('One. Two? 3 more.').map(u => u.question), [false, true, false]);
  const req = schemaRequest(loadSchema(), text);
  assert.ok(req.entities.goal && req.relations.has_quantity.head.includes('entity'));
});

test('the client of the structure and formalizer tiers tags its calls and reports failures', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({url, headers: init.headers, body: JSON.parse(init.body)}); return new Response(JSON.stringify({object: 'fol', results: []}), {status: 200, headers: {'content-type': 'application/json'}}); };
  const r = await formalizeFol({inputs: ['x']}, {purpose: 'test:fol', run: 'r1', fetchImpl});
  assert.equal(r.ok, true);
  assert.equal(seen[0].body.model, 'formalizer'); assert.match(seen[0].url, /\/v1\/fol$/);
  assert.equal(seen[0].headers['x-pworker-purpose'], 'test:fol'); assert.equal(seen[0].headers['x-pworker-run'], 'r1');
  const e = await extractStructure({text: 'x', entities: ['quantity']}, {fetchImpl: async () => new Response('{"error":{"message":"down"}}', {status: 503})});
  assert.equal(e.ok, false); assert.match(e.reason, /503 down/);
});

test.after(async () => { (await engines()).dispose(); });
