import test from 'node:test';
import assert from 'node:assert/strict';
import {ask, prepare, update, capabilities, ProgramError, NotExpressibleError} from '../../reasoning/strategies/js-reference/index.mjs';

/** Run a knowledge text and a query text through the oracle. */
const run = (knowledge, query, budget = {}) => ask({theory: {knowledge}, query}, budget);
const status = (knowledge, query) => run(knowledge, query).status;
const rowsOf = r => r.rows.map(x => JSON.stringify(x)).sort();

test('both is a reported status: positive and negative evidence propagate independently', () => {
  const k = `@f1 fact
  holds bird tweety
@f2 fact
  holds not flies tweety
@r1 rule
  when bird ?x
  then flies ?x
@r2 rule
  when flies ?x
  then can_glide ?x
@r3 rule
  when not flies ?x
  then grounded ?x
`;
  assert.equal(status(k, '@q query\n  mode exists\n  where flies tweety\n'), 'both');
  // a body `flies` is satisfied by P although N exists; a body `not flies` by N although P exists; nothing unrelated follows
  assert.equal(status(k, '@q query\n  mode exists\n  where can_glide tweety\n'), 'supported');
  assert.equal(status(k, '@q query\n  mode exists\n  where grounded tweety\n'), 'supported');
  assert.equal(status(k, '@q query\n  mode exists\n  where flies pingu\n'), 'unknown');
});

test('adding a negative fact never retracts a positive answer (R-P1: evidence is monotone)', () => {
  const k = '@f1 fact\n  holds bird tweety\n@r1 rule\n  when bird ?x\n  then flies ?x\n';
  const q = '@q query\n  where flies ?x\n  select ?x\n';
  assert.deepEqual(rowsOf(run(k, q)), ['{"x":"tweety"}']);
  assert.deepEqual(rowsOf(run(k + '@f2 fact\n  holds not flies tweety\n', q)), ['{"x":"tweety"}']);
});

test('negation as failure: absent needs a closed predicate and the program must be stratified', () => {
  const open = '@r rule\n  when node ?x\n  when absent blocked ?x\n  then free ?x\n';
  assert.throws(() => run(open, '@q query\n  where free ?x\n  select ?x\n'), e => e instanceof ProgramError && e.code === 'absent_needs_closed');
  const selfCycle = '@p predicate\n  args subject:entity\n  closed true\n@r rule\n  when q ?x\n  when absent p ?x\n  then p ?x\n';
  assert.throws(() => run(selfCycle, '@q query\n  where p ?x\n  select ?x\n'), e => e.code === 'not_stratifiable');
  const twoCycle = '@a predicate\n  args subject:entity\n  closed true\n@b predicate\n  args subject:entity\n  closed true\n@r1 rule\n  when n ?x\n  when absent b ?x\n  then a ?x\n@r2 rule\n  when a ?x\n  then b ?x\n';
  assert.throws(() => run(twoCycle, '@q query\n  where a ?x\n  select ?x\n'), e => e.code === 'not_stratifiable');
  assert.throws(() => run('@r rule\n  when p ?x\n  then q ?y\n', '@q query\n  where q ?y\n  select ?y\n'), e => e.code === 'unsafe_head');
  assert.throws(() => run('@c predicate\n  args subject:entity\n  closed true\n@r rule\n  when p ?x\n  when absent c ?z\n  then q ?x\n', '@q query\n  where q ?x\n  select ?x\n'), e => e.code === 'unsafe_negation');
});

test('negation as failure over a derived closed predicate reads the completed lower stratum', () => {
  const k = `@reach predicate
  args source:entity destination:entity
  closed true
@e1 fact
  holds edge a b
@e2 fact
  holds edge b a
@n1 fact
  holds node a
@n2 fact
  holds node b
@n3 fact
  holds node c
@r_base rule
  when edge ?x ?y
  then reach ?x ?y
@r_step rule
  when edge ?x ?m
  when reach ?m ?y
  then reach ?x ?y
@r_un rule
  when node ?y
  when absent reach a ?y
  then unreached ?y
`;
  assert.deepEqual(rowsOf(run(k, '@q query\n  where unreached ?y\n  select ?y\n')), ['{"y":"c"}']);
});

test('defaults: exception, strict contrary, priority, and overrides blocks by FIRE', () => {
  const nixon = `@f1 fact
  holds quaker nixon
@f2 fact
  holds republican nixon
`;
  const q = '@q query\n  mode exists\n  where pacifist nixon\n';
  const d = (id, body, head, extra = '') => `@${id} default\n  when ${body} ?x\n  then ${head} ?x\n${extra}`;
  assert.equal(status(nixon + d('dq', 'quaker', 'pacifist') + d('dr', 'republican', 'not pacifist'), q), 'both'); // the Nixon diamond
  assert.equal(status(nixon + d('dq', 'quaker', 'pacifist', '  priority 1\n') + d('dr', 'republican', 'not pacifist', '  priority 2\n'), q), 'refuted');
  const exempt = nixon + '@f3 fact\n  holds exempt nixon\n';
  // the republican default overrides the quaker one but is itself blocked by its exception: it fires nothing, so it blocks nothing
  assert.equal(status(exempt + d('dq', 'quaker', 'pacifist') + d('dr', 'republican', 'not pacifist', '  except exempt ?x\n  overrides $dq\n'), q), 'supported');
  // a strict contrary derived by a rule that does not depend on any default blocks the default: refuted, not both
  const strict = '@f1 fact\n  holds penguin pingu\n@r rule\n  when penguin ?x\n  then not flies ?x\n@f2 fact\n  holds bird pingu\n' + d('bf', 'bird', 'flies');
  assert.equal(status(strict, '@q query\n  mode exists\n  where flies pingu\n'), 'refuted');
});

test('default conclusions are flagged completeness-sensitive on the desugared program', () => {
  const k = '@f1 fact\n  holds bird tweety\n@bf default\n  when bird ?x\n  then flies ?x\n  except penguin ?x\n';
  const r = run(k, '@q query\n  where flies ?x\n  select ?x\n');
  assert.equal(r.sensitivity.monotone, false);
  assert.deepEqual(r.sensitivity.defaults, ['bf']);
  assert.ok(r.sensitivity.over.includes('x_bf_blocked'));
  const plain = run('@f1 fact\n  holds bird tweety\n@r rule\n  when bird ?x\n  then flies ?x\n', '@q query\n  where flies ?x\n  select ?x\n');
  assert.equal(plain.sensitivity.monotone, true);
});

test('counts and every over open predicates: lower bound and open_domain; a counterexample still refutes', () => {
  const open = '@f1 fact\n  holds member ann delta\n@f2 fact\n  holds member bob delta\n@f3 fact\n  holds works ann alpha\n@f4 fact\n  holds works bob alpha\n';
  const closed = '@member predicate\n  args subject:entity object:entity\n  closed true\n' + open;
  const count = '@q query\n  mode count\n  where member ?m delta\n  select ?m\n';
  const every = '@q query\n  mode every\n  where member ?m delta\n  scope works ?m alpha\n';
  assert.deepEqual([run(open, count).count, run(open, count).bound], [2, 'at_least']);
  assert.deepEqual([run(closed, count).count, run(closed, count).bound], [2, undefined]);
  const e = run(open, every);
  assert.deepEqual([e.status, e.reason], ['unknown', 'open_domain']);
  assert.equal(run(closed, every).status, 'supported');
  // a member whose scope atom has P and N evidence makes a closed universal both; without P, the N evidence is a counterexample
  assert.equal(run(closed + '@f5 fact\n  holds not works bob alpha\n', every).status, 'both');
  assert.equal(run(open.replace('holds works bob alpha', 'holds not works bob alpha'), every).status, 'refuted');
  // an empty closed domain is vacuously true, an empty open one is unknown
  assert.equal(run('@member predicate\n  args subject:entity object:entity\n  closed true\n', every).status, 'supported');
});

test('time: at, throughout (during), some instant (overlaps), and derived atoms by endpoint partitioning', () => {
  const k = `@f1 fact
  holds works_at ann alpha
  valid 2020-01-01 2023-01-01
@f2 fact
  holds works_at bob alpha
  valid 2022-01-01 2025-01-01
@r rule
  when works_at ?x ?c
  when works_at ?y ?c
  when compare ?x not_equal ?y
  then colleague ?x ?y
`;
  const at = d => run(k, `@q query\n  mode exists\n  where colleague ann bob\n  at ${d}\n`).status;
  assert.equal(at('2021-12-31'), 'unknown');
  assert.equal(at('2022-01-01'), 'supported'); // start inclusive
  assert.equal(at('2023-01-01'), 'unknown'); // end exclusive: ann's validity ended
  const during = (s, e) => run(k, `@q query\n  mode exists\n  where colleague ann bob\n  during ${s} ${e}\n`).status;
  assert.equal(during('2022-03-01', '2022-09-01'), 'supported');
  assert.equal(during('2021-06-01', '2022-06-01'), 'unknown'); // body does not hold before 2022
  assert.equal(during('2022-06-01', '2023-01-01'), 'supported'); // end exclusive: the last instant is 2022-12-31
  assert.equal(during('2022-06-01', '2023-01-02'), 'unknown');
  const overlaps = run(k, '@q query\n  mode exists\n  where colleague ann bob\n  overlaps 2021-06-01 2022-06-01\n').status;
  assert.equal(overlaps, 'supported');
  assert.equal(run(k, '@q query\n  mode exists\n  where colleague ann bob\n  overlaps 2020-01-01 2022-01-01\n').status, 'unknown');
});

test('time variables: start_of binds the start of a stored validity and order compares', () => {
  const k = `@f1 fact
  holds works_at ann alpha
  valid 2020-01-01 2023-01-01
@f2 fact
  holds works_at ann beta
  valid 2023-01-01 open
@r rule
  when start_of ?t1 works_at ?p alpha
  when start_of ?t2 works_at ?p beta
  when order ?t1 before ?t2
  then moved_on ?p
`;
  assert.deepEqual(rowsOf(run(k, '@q query\n  where moved_on ?p\n  select ?p\n')), ['{"p":"ann"}']);
});

test('abduce returns ALL inclusion-minimal explanations, not only the cheapest', () => {
  const k = `@r1 rule
  when a
  then goal
@r2 rule
  when b
  then c
@r3 rule
  when c
  then goal
@r4 rule
  when d
  then c
@ha hypothesis
  holds a
  cost 1
@hb hypothesis
  holds b
  cost 5
@hd hypothesis
  holds d
  cost 9
@hx hypothesis
  holds unrelated
  cost 1
`;
  const r = run(k, '@q query\n  mode abduce\n  where goal\n');
  assert.equal(r.status, 'hypotheses');
  assert.deepEqual(r.hypotheses.map(h => h.join('+')).sort(), ['a', 'b', 'd']); // b and d cost more than a, both are still minimal
  assert.ok(!r.hypotheses.some(h => h.length > 1)); // no superset such as a+b
  // two hypotheses needed together
  const together = run('@r rule\n  when p\n  when q\n  then goal\n@h1 hypothesis\n  holds p\n@h2 hypothesis\n  holds q\n', '@q query\n  mode abduce\n  where goal\n');
  assert.deepEqual(together.hypotheses, [['p', 'q']]);
  assert.equal(run(k, '@q query\n  mode abduce\n  where nothing_explains_this\n').status, 'unknown');
});

test('budgets: exhaustion is reported with a reason, never read as a negative answer', () => {
  const chain = Array.from({length: 12}, (_, i) => `@e${i} fact\n  holds edge n${i} n${i + 1}\n`).join('') + '@rb rule\n  when edge ?x ?y\n  then reaches ?x ?y\n@rs rule\n  when edge ?x ?m\n  when reaches ?m ?y\n  then reaches ?x ?y\n';
  const policy = limits => `@p policy\n${Object.entries(limits).map(([k, v]) => `  ${k} ${v}`).join('\n')}\n\n`;
  const partial = run(chain, policy({maxRounds: 3}) + '@q query\n  where reaches n0 ?t\n  select ?t\n  policy $p\n');
  assert.equal(partial.status, 'supported');
  assert.equal(partial.complete, false);
  assert.equal(partial.budget.exhausted, true);
  assert.equal(partial.budget.reason, 'rounds');
  assert.ok(partial.rows.length >= 1 && partial.rows.length < 12); // a sound subset of the true rows
  const none = run(chain, policy({maxRounds: 3}) + '@q query\n  mode exists\n  where reaches n0 n12\n  policy $p\n');
  assert.deepEqual([none.status, none.complete, none.reason], ['budget_exhausted', false, 'rounds']);
  const probes = run(chain, policy({maxJoins: 30}) + '@q query\n  mode exists\n  where reaches n0 n12\n  policy $p\n');
  assert.equal(probes.status, 'budget_exhausted');
  assert.equal(probes.reason, 'probes');
  // negation as failure over a cut closure would be unsound: no partial answer at all, and `partial forbid` also withholds rows
  const withNaf = '@c predicate\n  args subject:entity\n  closed true\n' + chain + '@rn rule\n  when edge ?x ?y\n  when absent c ?x\n  then free ?x\n';
  const naf = run(withNaf + '@f fact\n  holds c n5\n', policy({maxRounds: 1}) + '@q query\n  where reaches n0 ?t\n  select ?t\n  policy $p\n');
  assert.equal(naf.status, 'supported'); // its slice has no negation: still a positive partial answer
  const forbid = run(chain, policy({maxRounds: 3}).replace('maxRounds 3', 'maxRounds 3\n  partial forbid') + '@q query\n  where reaches n0 ?t\n  select ?t\n  policy $p\n');
  assert.equal(forbid.status, 'budget_exhausted');
  const negative = run('@c predicate\n  args subject:entity\n  closed true\n' + chain + '@rn rule\n  when reaches n0 ?y\n  when absent c ?y\n  then free ?y\n', policy({maxRounds: 3}) + '@q query\n  where free ?y\n  select ?y\n  policy $p\n');
  assert.deepEqual([negative.status, negative.complete], ['budget_exhausted', false]);
});

test('planning: a horizon cut is budget_exhausted (reason horizon), never no_plan', () => {
  const line = Array.from({length: 6}, (_, i) => `@r${i} fact\n  holds road n${i} n${i + 1}\n`).join('')
    + '@s fact\n  holds at robot n0\n@move action\n  params ?r ?f ?t\n  requires at ?r ?f\n  requires road ?f ?t\n  adds at ?r ?t\n  removes at ?r ?f\n  cost 1\n';
  const goal = '@q query\n  mode plan\n  where at robot n6\n';
  const found = run(line, goal);
  assert.deepEqual([found.status, found.plan.steps, found.plan.cost], ['plan_found', 6, 6]);
  const cut = run(line, '@p policy\n  maxDepth 3\n\n' + goal.replace('where at robot n6', 'where at robot n6\n  policy $p'));
  assert.deepEqual([cut.status, cut.reason, cut.complete], ['budget_exhausted', 'horizon', false]);
  // a goal that cannot be reached in the finite state space is a real no_plan
  assert.equal(run(line, '@q query\n  mode plan\n  where at robot n9\n').status, 'no_plan');
  // polarity-explicit state: `requires not` over an open fluent needs negative evidence
  const open = '@s fact\n  holds at robot a\n@go action\n  params ?r\n  requires not locked ?r\n  requires at ?r a\n  adds done ?r\n  cost 1\n';
  assert.equal(run(open, '@q query\n  mode plan\n  where done robot\n').status, 'no_plan');
  assert.equal(run(open + '@l fact\n  holds not locked robot\n', '@q query\n  mode plan\n  where done robot\n').status, 'plan_found');
  // over a closed fluent, not means absent
  assert.equal(run('@locked predicate\n  args subject:entity\n  closed true\n' + open, '@q query\n  mode plan\n  where done robot\n').status, 'plan_found');
});

test('constraints: enumeration, entailment, optimum, inconsistency, and an unbounded domain is not an answer', () => {
  const c = body => run('', `@c constraint\n${body}`);
  assert.equal(c('  var ?x int 0 20\n  var ?y int 0 20\n  require ?x plus ?y equal 10\n  require ?x minus ?y equal 2\n  claim ?x equal 6\n  task prove\n').status, 'entailed');
  assert.equal(c('  var ?x int 0 5\n  require ?x above 7\n  claim ?x equal 1\n').status, 'inconsistent');
  assert.equal(c('  var ?x int 0 5\n  claim ?x above 3\n  task prove\n').status, 'possible');
  assert.equal(c('  var ?x int 0 5\n  claim ?x above 9\n  task possible\n').status, 'impossible');
  const opt = c('  var ?x int 0 10\n  var ?y int 0 10\n  require ?x plus ?y at_least 5\n  objective 2 times ?x plus ?y\n  direction min\n  task optimize\n');
  assert.deepEqual([opt.status, opt.objective], ['optimal', 5]);
  const unbounded = c('  var ?x int\n  claim ?x above 3\n');
  assert.deepEqual([unbounded.status, unbounded.reason], ['budget_exhausted', 'numeric_range']);
  const cut = run('', '@p policy\n  maxAssignments 10\n\n@c constraint\n  var ?x int 0 1000\n  claim ?x above 500\n');
  assert.deepEqual([cut.status, cut.reason], ['budget_exhausted', 'domain']);
});

test('conditional is per row and VERIFIED; leave-one-out alone would be wrong', () => {
  const k = '@r1 rule\n  when has_c ?x\n  when has_a ?x\n  then ok ?x\n@r2 rule\n  when has_c ?x\n  when has_b ?x\n  then ok ?x\n';
  const sup = id => `@s_${id} fact\n  holds has_${id} z\n  status supposed\n`;
  const q = '@q query\n  where ok ?x\n  select ?x\n  if $s_a\n  if $s_b\n  if $s_c\n';
  const r = run(k, sup('a') + sup('b') + sup('c') + q);
  assert.deepEqual(r.conditional.sort(), ['s_a', 's_b', 's_c']);
  assert.equal(r.conditional_unknown, true);
  assert.deepEqual(r.row_conditional[0].conditional.sort(), ['s_a', 's_b', 's_c']);
  // an exact case: only s1 is needed, and the verification run confirms it
  const exact = run('@f1 fact\n  holds works bob alpha\n', '@s1 fact\n  holds works ann alpha\n  status supposed\n@s2 fact\n  holds works cy beta\n  status supposed\n@q query\n  where works ?x alpha\n  select ?x\n  if $s1\n  if $s2\n');
  assert.deepEqual(exact.conditional, ['s1']);
  assert.equal(exact.conditional_unknown, undefined);
  assert.deepEqual(exact.row_conditional.find(r => r.row.x === 'bob').conditional, []); // bob is unconditional, ann depends on s1
  assert.deepEqual(exact.row_conditional.find(r => r.row.x === 'ann').conditional, ['s1']);
  // a supposition that removes a row under negation as failure is flagged nonmonotone
  const naf = run('@blocked predicate\n  args subject:entity\n  closed true\n@n1 fact\n  holds node a\n@n2 fact\n  holds node b\n@r rule\n  when node ?x\n  when absent blocked ?x\n  then open ?x\n', '@s1 fact\n  holds blocked b\n  status supposed\n@q query\n  where open ?x\n  select ?x\n  if $s1\n');
  assert.equal(naf.nonmonotone, true);
  assert.deepEqual(rowsOf(naf), ['{"x":"a"}']);
});

test('used is ONE sufficient support set; it rests on NAF is flagged used_incomplete', () => {
  const k = '@fa fact\n  holds via_a z\n@fb fact\n  holds via_b z\n@r1 rule\n  when via_a ?x\n  then ok ?x\n@r2 rule\n  when via_b ?x\n  then ok ?x\n';
  const r = run(k, '@q query\n  mode exists\n  where ok z\n');
  const ids = r.used.map(u => u.id).sort();
  assert.ok(JSON.stringify(ids) === JSON.stringify(['fa', 'r1']) || JSON.stringify(ids) === JSON.stringify(['fb', 'r2']), ids.join());
  // replaying the used claims alone re-derives the answer
  const replay = run(k.split('@').filter(w => ids.includes(w.split(' ')[0])).map(w => '@' + w).join(''), '@q query\n  mode exists\n  where ok z\n');
  assert.equal(replay.status, 'supported');
  const naf = run('@b predicate\n  args subject:entity\n  closed true\n@f fact\n  holds n a\n@r rule\n  when n ?x\n  when absent b ?x\n  then free ?x\n', '@q query\n  mode exists\n  where free a\n');
  assert.equal(naf.status, 'supported');
  assert.equal(naf.used_incomplete, true);
});

test('why_not: minimal EDB additions plus the blocking atoms', () => {
  const k = '@f1 fact\n  holds parent ann bob\n@r rule\n  when parent ?x ?y\n  when parent ?y ?z\n  then grandparent ?x ?z\n';
  const r = run(k, '@q query\n  mode why_not\n  where grandparent ann cy\n');
  assert.deepEqual([r.status, r.complete, r.missing], ['unknown', true, [['parent bob cy']]]);
  const held = run(k + '@f2 fact\n  holds parent bob cy\n', '@q query\n  mode why_not\n  where grandparent ann cy\n');
  assert.deepEqual([held.status, held.missing], ['supported', []]);
  // a blocker: an `absent` condition that fails because the atom holds
  const naf = run('@blocked predicate\n  args subject:entity\n  closed true\n@f1 fact\n  holds node a\n@f2 fact\n  holds blocked a\n@r rule\n  when node ?x\n  when absent blocked ?x\n  then free ?x\n', '@q query\n  mode why_not\n  where free a\n');
  assert.equal(naf.status, 'unknown');
  assert.deepEqual(naf.missing, []); // adding facts cannot repair it
  assert.deepEqual(naf.blockers.map(b => [b.atom, b.why]), [['blocked a', 'absent_fails']]);
});

test('aggregates: count, sum, min, max, collect over the distinct bindings of the over group', () => {
  const k = `@s1 fact
  holds salary ann dev 100
@s2 fact
  holds salary bob dev 100
@s3 fact
  holds salary cy ops 80
@a1 aggregate
  over salary ?p ?d ?s
  group ?d
  sum ?s as ?total
  yields payroll ?d ?total
@a2 aggregate
  over salary ?p ?d ?s
  group ?d
  count as ?n
  yields headcount ?d ?n
@a3 aggregate
  over salary ?p ?d ?s
  group ?d
  max ?s as ?m
  yields top ?d ?m
@a4 aggregate
  over salary ?p ?d ?s
  group ?d
  min ?s as ?m
  yields low ?d ?m
@a5 aggregate
  over salary ?p ?d ?s
  group ?d
  collect ?p as ?who
  yields people ?d ?who
`;
  const sel = (p, vars) => rowsOf(run(k, `@q query\n  where ${p} ${vars}\n  select ${vars}\n`));
  assert.deepEqual(sel('payroll', '?d ?t'), ['{"d":"dev","t":200}', '{"d":"ops","t":80}']); // two people with the same salary count twice
  assert.deepEqual(sel('headcount', '?d ?t'), ['{"d":"dev","t":2}', '{"d":"ops","t":1}']);
  assert.deepEqual(sel('top', '?d ?t'), ['{"d":"dev","t":100}', '{"d":"ops","t":80}']);
  assert.deepEqual(sel('low', '?d ?t'), ['{"d":"dev","t":100}', '{"d":"ops","t":80}']);
  assert.deepEqual(sel('people', '?d ?t'), ['{"d":"dev","t":"[\\"ann\\",\\"bob\\"]"}', '{"d":"ops","t":"[\\"cy\\"]"}']);
  assert.throws(() => run('@a aggregate\n  over p ?x\n  group ?x\n  count as ?n\n  yields q ?x ?n\n@r rule\n  when q ?x ?n\n  then p ?x\n', '@q query\n  where q ?x ?n\n  select ?x\n'), e => e.code === 'not_stratifiable');
});

test('compute: whole_divided_by truncates toward zero, a zero divisor makes the body false and is noted', () => {
  const k = '@f1 fact\n  holds amount a 7 2\n@f2 fact\n  holds amount b -7 2\n@f3 fact\n  holds amount c 5 0\n@r rule\n  when amount ?n ?x ?y\n  when compute ?q ?x whole_divided_by ?y\n  then share ?n ?q\n';
  const r = run(k, '@q query\n  where share ?n ?q\n  select ?n ?q\n');
  assert.deepEqual(rowsOf(r), ['{"n":"a","q":3}', '{"n":"b","q":-3}']);
  assert.ok(r.notes.includes('arithmetic_undefined'));
  // Exact arithmetic (DS004): divided_by is exact, decimals are numbers, rounding words round to a multiple.
  const exact = run(k.replace('whole_divided_by', 'divided_by'), '@q query\n  where share ?n ?q\n  select ?n ?q\n');
  assert.deepEqual(rowsOf(exact), ['{"n":"a","q":3.5}', '{"n":"b","q":-3.5}']);
  const money = '@f1 fact\n  holds loan kara 4000\n@f2 fact\n  holds rate kara 0.11\n@r rule\n  when loan ?p ?c\n  when rate ?p ?r\n  when compute ?y ?c times ?r\n  when compute ?z ?y times 8\n  when compute ?m ?z divided_by 12\n  when compute ?i ?m rounded_to 0.01\n  when compute ?b ?m rounded_up_to 100\n  when compute ?w 100 modulo 7\n  when compute ?g 1.05 power 2\n  then interest ?p ?i ?b ?w\n@r2 rule\n  when rate ?p ?r\n  when compute ?g 1.05 power 2\n  when compute ?s 0.1 plus 0.2\n  then growth ?p ?g ?s\n';
  assert.deepEqual(rowsOf(run(money, '@q query\n  where interest ?p ?i ?b ?w\n  select ?i ?b ?w\n')), ['{"i":293.33,"b":300,"w":2}']);
  assert.deepEqual(rowsOf(run(money, '@q query\n  where growth ?p ?g ?s\n  select ?g ?s\n')), ['{"g":1.1025,"s":0.3}']);
  // Arithmetic inside a recursion (DS004): a bounded recursion closes; an unbounded one is stopped by the round budget, never answered wrongly.
  const climb = '@f0 fact\n  holds f 0\n@r rule\n  when f ?x\n  when compute ?z ?x plus 1\n  when compare ?z at_most 5\n  then g ?z\n@r2 rule\n  when g ?x\n  then f ?x\n';
  assert.deepEqual(rowsOf(run(climb, '@q query\n  where g ?x\n  select ?x\n')), [1, 2, 3, 4, 5].map(x => `{"x":${x}}`));
  const unbounded = run(climb.replace('  when compare ?z at_most 5\n', ''), '@q query\n  where g ?x\n  select ?x\n', {maxRounds: 50});
  assert.equal(unbounded.complete, false);
  assert.equal(unbounded.reason, 'rounds', 'the cut is reported; the rows found are sound but the answer is incomplete');
});

test('governance: only approved wires bind; asof reproduces the version in force; a supposed proposed wire is conditional', () => {
  const k = `@f1 fact
  holds income ann 90
@v1 rule
  when income ?p ?i
  when compare ?i above 100
  then taxable ?p
  version 1
  approval superseded
  approved_at 2025-01-01
@v2 rule
  when income ?p ?i
  when compare ?i above 80
  then taxable ?p
  version 2
  supersedes $v1
  approval approved
  approved_at 2026-06-01
@v3 rule
  when income ?p ?i
  when compare ?i above 95
  then luxury ?p
  approval proposed
`;
  assert.equal(status(k, '@q query\n  mode exists\n  where taxable ann\n'), 'supported');
  assert.equal(status(k, '@q query\n  mode exists\n  where taxable ann\n  asof 2026-01-01\n'), 'unknown');
  assert.equal(status(k, '@q query\n  mode exists\n  where luxury ann\n'), 'unknown'); // a proposed wire does not bind
});

test('explain returns the proof DAG and the stored facts it used', () => {
  const k = '@f1 fact\n  holds parent ann bob\n@f2 fact\n  holds parent bob cy\n@f3 fact\n  holds parent cy di\n@r rule\n  when parent ?x ?y\n  when parent ?y ?z\n  then grandparent ?x ?z\n';
  const r = run(k, '@q query\n  mode explain\n  where grandparent ann cy\n');
  assert.equal(r.explain.depth, 1);
  assert.deepEqual(r.explain.uses.sort(), ['parent ann bob', 'parent bob cy']);
  const root = r.proof.nodes.find(n => n.id === r.proof.roots[0]);
  assert.deepEqual([root.atom, root.kind, root.source.id], ['grandparent ann cy', 'rule', 'r']);
  assert.equal(root.premises.length, 2);
  assert.ok(r.proof.nodes.filter(n => n.kind === 'fact').length === 2);
});

test('arity 0 to 6 with named roles, and a seventh term is rejected', () => {
  assert.equal(status('@f fact\n  holds smoke\n@r rule\n  when smoke\n  then alarm\n', '@q query\n  mode exists\n  where alarm\n'), 'supported');
  const six = '@p predicate\n  args subject:entity object:entity location:entity source:entity destination:entity topic:entity\n@f fact\n  holds p a b c d e f\n';
  assert.deepEqual(rowsOf(run(six, '@q query\n  where p ?a b c d e ?f\n  select ?a ?f\n')), ['{"a":"a","f":"f"}']);
  assert.throws(() => run('@f fact\n  holds p a b c d e f g\n', '@q query\n  mode exists\n  where p a b c d e f g\n'));
  assert.throws(() => run('@p predicate\n  args subject:entity\n@f fact\n  holds p a b\n', '@q query\n  mode exists\n  where p a b\n'), e => e.code === 'arity_mismatch');
});

test('strategy interface: capabilities declare modes of work not_expressible, which are never weakened', () => {
  assert.ok(capabilities.features.includes('naf') && capabilities.features.includes('why_not') && capabilities.features.includes('throughout'));
  for (const f of ['method', 'norms_hard', 'procedures', 'amendment', 'check_plan']) assert.ok(capabilities.notExpressible.includes(f) && !capabilities.features.includes(f));
  assert.deepEqual([capabilities.guarantee, capabilities.determinism, capabilities.delivery], ['exact', 'deterministic', 'slice']);
  const k = '@f fact\n  holds at robot a\n@act action\n  params ?r\n  requires at ?r a\n  adds done ?r\n@m method\n  achieves done ?r\n  step ~act ?r\n';
  assert.throws(() => run(k, '@q query\n  mode plan\n  where done robot\n'), e => e instanceof NotExpressibleError && e.features.includes('method'));
  assert.throws(() => run(k, '@q query\n  mode conform\n  where done robot\n'), NotExpressibleError);
  // a method that the query does not use does not change a relational answer: it is outside the dependency slice
  const r = run(k, '@q query\n  mode exists\n  where at robot a\n');
  assert.equal(r.status, 'supported');
});

test('prepare and update: a handle is recomputed, never stale; the packet names strategy and route', () => {
  let h = prepare({knowledge: '@f1 fact\n  holds bird tweety\n@r rule\n  when bird ?x\n  then flies ?x\n'});
  const q = '@q query\n  where flies ?x\n  select ?x\n';
  const r0 = ask({handle: h, query: q, requested: 'js-reference'});
  assert.deepEqual([r0.strategy, r0.route.chosen, r0.route.requested, r0.route.fallback], ['js-reference', 'js-reference', 'js-reference', null]);
  h = update(h, {add: '@f2 fact\n  holds bird pingu\n'});
  assert.deepEqual(rowsOf(ask({handle: h, query: q})), ['{"x":"pingu"}', '{"x":"tweety"}']);
  h = update(h, {remove: ['f1']});
  assert.deepEqual(rowsOf(ask({handle: h, query: q})), ['{"x":"pingu"}']);
});

test('integrity is a violation relation, never a hard assertion', () => {
  const k = `@b1 fact
  holds booked room1 slot9 ann
@b2 fact
  holds booked room1 slot9 bob
@no_double integrity
  never all
    booked ?r ?s ?a
    booked ?r ?s ?b
    compare ?a not_equal ?b
  end
  witness ?r
  message "two bookings"
`;
  assert.deepEqual(rowsOf(run(k, '@q query\n  where violation ?c ?w\n  select ?c ?w\n')), ['{"c":"no_double","w":"room1"}']);
  // the rest of the knowledge stays usable: nothing explodes
  assert.equal(status(k, '@q query\n  mode exists\n  where booked room1 slot9 ann\n'), 'supported');
});

test('every answer packet carries the fields of section 5.3', () => {
  const r = run('@f1 fact\n  holds p a\n', '@q query\n  where p ?x\n  select ?x\n');
  for (const k of ['status', 'complete', 'rows', 'used', 'budget', 'retrieval', 'strategy', 'route', 'timings', 'ignored', 'notes', 'guarantee']) assert.ok(k in r, k);
  assert.deepEqual(Object.keys(r.budget).sort(), ['exhausted', 'limit', 'partial', 'reason', 'used']);
  assert.equal(r.guarantee, 'exact');
});

// ---------------------------------------------------------------------------------------------- order, used and wall clock

test('every: a member is conflicted only when ALL its bindings are, whatever the fact order', () => {
  const head = '@member predicate\n  args subject:entity\n  closed true\n@works predicate\n  args subject:entity object:entity\n  closed true\n@m fact\n  holds member m1\n';
  const clean = '@f1 fact\n  holds works m1 alpha\n', conflicted = '@f2 fact\n  holds works m1 beta\n@f3 fact\n  holds not works m1 beta\n';
  const every = '@q query\n  mode every\n  where member ?m\n  scope works ?m ?org\n';
  // one clean binding and one conflicted binding: the member is clean, in either order
  assert.equal(run(head + clean + conflicted, every).status, 'supported');
  assert.equal(run(head + conflicted + clean, every).status, 'supported');
  // every binding conflicted: the universal is both
  assert.equal(run(head + conflicted, every).status, 'both');
});

test('used names the stored fact whose validity start_of read, not the first fact of the tuple', () => {
  const k = `@t0 fact
  holds on c
  valid 2026-01-01 2026-02-01
@t1 fact
  holds on c
@r rule
  when on ?x
  when start_of ?s on ?x
  then began ?x ?s
`;
  const q = '@q query\n  mode exists\n  where began c beginning\n';
  const r = run(k, q);
  assert.equal(r.status, 'supported');
  assert.ok(r.used.some(u => u.id === 't1'), 'the timeless fact produced ?s = beginning');
  // the support set replays: the claims it names alone give the same answer
  const claims = new Set(r.used.map(u => u.id));
  const replay = k.split(/(?=^@)/m).filter(w => claims.has(/^@(\S+)/.exec(w)[1])).join('');
  assert.equal(status(replay, q), 'supported');
});

test('the wall clock stops a selective join over many facts: budget_exhausted, reason wall', () => {
  const facts = [];
  for (let i = 0; i < 3000; i++) facts.push(`@p${i} fact\n  holds pp n${i}\n@q${i} fact\n  holds qq n${i}\n`);
  const k = facts.join('');
  const query = '@q query\n  mode exists\n  where all\n    pp ?x\n    qq ?y\n    rr ?x ?y\n  end\n';
  const started = performance.now();
  const r = run(k, query, {timeoutMs: 100});
  assert.equal(r.status, 'budget_exhausted');
  assert.equal(r.reason, 'wall');
  assert.equal(r.complete, false);
  assert.ok(performance.now() - started < 20000, 'the stop happens long before the join would finish');
});

// ---------------------------------------------------------------------------------------------- query forms (ported from the retired reference route)

import {numericValue, quantifiedStatus} from '../../reasoning/strategies/js-reference/forms.mjs';

const WORLD = `@a1 fact
  holds costs dacia 4000
@a2 fact
  holds costs golf 9000
@a3 fact
  holds costs fiat "2380 lei"
@a4 fact
  holds works ana acme
@a5 fact
  holds works bob acme
@a6 fact
  holds works dan zeta
@a7 fact
  holds certified ana
@a8 fact
  holds not certified bob
@a9 fact
  holds certified dan
`;

test('forms: a number is a number or a string that starts with one; a quantifier decides from supported, refuted and unknown members', () => {
  assert.equal(numericValue(7), 7);
  assert.equal(numericValue('2380 lei'), 2380);
  assert.equal(numericValue('80'), 80);
  assert.equal(numericValue('lei 80'), null);
  assert.equal(numericValue(Number.NaN), null);
  const m = (s, r, u) => [...Array(s).fill({status: 'supported'}), ...Array(r).fill({status: 'refuted'}), ...Array(u).fill({status: 'unknown'})];
  const q = (word, count) => ({word, ...(count !== undefined ? {count} : {})});
  assert.equal(quantifiedStatus(q('all'), m(2, 0, 0)), 'supported');
  assert.equal(quantifiedStatus(q('all'), m(1, 1, 0)), 'refuted');
  assert.equal(quantifiedStatus(q('all'), m(1, 0, 1)), 'unknown');
  assert.equal(quantifiedStatus(q('none'), m(0, 2, 0)), 'supported');
  assert.equal(quantifiedStatus(q('none'), m(1, 1, 0)), 'refuted');
  assert.equal(quantifiedStatus(q('not_all'), m(1, 1, 0)), 'supported');
  assert.equal(quantifiedStatus(q('not_all'), m(2, 0, 0)), 'refuted');
  assert.equal(quantifiedStatus(q('not_all'), m(1, 0, 1)), 'unknown');
  assert.equal(quantifiedStatus(q('most'), m(3, 1, 0)), 'supported');
  assert.equal(quantifiedStatus(q('most'), m(1, 3, 0)), 'refuted');
  assert.equal(quantifiedStatus(q('most'), m(1, 1, 1)), 'unknown');
  assert.equal(quantifiedStatus(q('half'), m(2, 2, 0)), 'supported');
  assert.equal(quantifiedStatus(q('half'), m(3, 1, 0)), 'refuted');
  assert.equal(quantifiedStatus(q('half'), m(1, 1, 2)), 'unknown');
  assert.equal(quantifiedStatus(q('at_least', 2), m(2, 1, 0)), 'supported');
  assert.equal(quantifiedStatus(q('at_least', 2), m(1, 2, 0)), 'refuted');
  assert.equal(quantifiedStatus(q('at_least', 2), m(1, 1, 1)), 'unknown');
  assert.equal(quantifiedStatus(q('all'), []), 'unknown');
  assert.throws(() => quantifiedStatus(q('some'), m(1, 0, 0)), /bad_quantifier/);
});

test('forms: compare, rank, except, filter and limit act on the join rows', () => {
  const sel = lines => run(WORLD, `@q query\n  where costs ?c ?p\n  select ?c\n${lines}`);
  assert.deepEqual(rowsOf(sel('  compare ?p above 5000\n')), ['{"c":"golf"}']);
  assert.deepEqual(rowsOf(sel('  compare ?p at_most 4000\n')), ['{"c":"dacia"}', '{"c":"fiat"}']);
  assert.deepEqual(rowsOf(sel('  compare ?p equal 2380\n')), ['{"c":"fiat"}']);
  assert.deepEqual(rowsOf(sel('  compare ?p equal "2380 lei"\n')), ['{"c":"fiat"}']);
  assert.deepEqual(rowsOf(sel('  compare ?p above 3000\n  compare ?p below 5000\n')), ['{"c":"dacia"}']);
  assert.deepEqual(rowsOf(sel('  compare any\n    ?p above 8000\n    ?p below 3000\n  end\n')), ['{"c":"fiat"}', '{"c":"golf"}']);
  assert.deepEqual(rowsOf(sel('  rank highest ?p\n')), ['{"c":"golf"}']);
  assert.deepEqual(rowsOf(sel('  rank lowest ?p\n')), ['{"c":"fiat"}']);
  // v2.9: the N-th best distinct value (position) and the N best (top); ties are never split; beyond the values no row
  assert.deepEqual(rowsOf(sel('  rank highest ?p position 2\n')), ['{"c":"dacia"}']);
  assert.deepEqual(rowsOf(sel('  rank lowest ?p position 2\n')), ['{"c":"dacia"}']);
  assert.deepEqual(rowsOf(sel('  rank highest ?p top 2\n')), ['{"c":"dacia"}', '{"c":"golf"}']);
  assert.deepEqual(rowsOf(sel('  rank highest ?p position 4\n')), []);
  assert.throws(() => sel('  rank highest ?p position 0\n'), /bad_rank/);
  assert.deepEqual(rowsOf(sel('  except ?c "dacia"\n')), ['{"c":"fiat"}', '{"c":"golf"}']);
  // a filter is a typed host expression; it compares numbers with numbers (a mixed comparison is an error, as in the host language)
  assert.deepEqual(rowsOf(run('@a fact\n  holds costs dacia 4000\n@b fact\n  holds costs golf 9000\n', '@q query\n  where costs ?c ?p\n  select ?c\n  filter ?p > 5000\n')), ['{"c":"golf"}']);
  const limited = sel('  limit 2\n');
  assert.equal(limited.rows.length, 2);
  assert.equal(limited.truncated, true);
});

test('forms: a yes/no question whose known values all fail the comparison is refuted; a non-number is not_computable', () => {
  const ask1 = lines => status(WORLD, `@q query\n  mode exists\n  where costs dacia ?p\n${lines}`);
  assert.equal(ask1('  compare ?p above 3000\n'), 'supported');
  assert.equal(ask1('  compare ?p above 5000\n'), 'refuted');
  assert.equal(status(WORLD, '@q query\n  mode exists\n  where costs fiat ?p\n  compare ?p above "cheap"\n'), 'not_computable');
  // a ranking over values that are not numbers cannot be computed either
  assert.equal(status('@a fact\n  holds label x "red"\n', '@q query\n  where label ?x ?v\n  select ?x\n  rank highest ?v\n'), 'not_computable');
});

test('forms: a quantified universal ranges over the known members of an open predicate; without a quantifier the strict every stays unknown', () => {
  const every = q => run(WORLD, `@q query\n  mode every\n  where works ?e acme\n  scope certified ?e\n${q}`);
  // the strict every of the proposal: an open domain without a counterexample is unknown; a counterexample still refutes
  const strictZeta = run(WORLD, '@q query\n  mode every\n  where works ?e zeta\n  scope certified ?e\n');
  assert.equal(strictZeta.status, 'unknown');
  assert.equal(strictZeta.reason, 'open_domain');
  assert.equal(every('').status, 'refuted');
  const all = every('  quantifier all\n');
  assert.equal(all.status, 'refuted');
  assert.equal(all.members, 2);
  assert.deepEqual(all.counterexamples, [{'?e': 'bob'}]);
  assert.equal(every('  quantifier not_all\n').status, 'supported');
  assert.equal(every('  quantifier half\n').status, 'supported');
  assert.equal(every('  quantifier most\n').status, 'refuted');
  assert.equal(every('  quantifier at_least 1\n').status, 'supported');
  assert.equal(every('  quantifier none\n').status, 'refuted');
  const grouped = run(WORLD, '@q query\n  mode every\n  where works ?e ?org\n  select ?org\n  scope certified ?e\n  quantifier all\n');
  assert.deepEqual(rowsOf(grouped), ['{"org":"zeta"}']);
  assert.throws(() => run(WORLD, '@q query\n  mode every\n  where works ?e acme\n  scope certified ?e\n  quantifier at_least\n'), e => e.code === 'bad_quantifier');
  assert.throws(() => run(WORLD, '@q query\n  mode every\n  where works ?e acme\n  scope certified ?e\n  quantifier all 3\n'), e => e.code === 'bad_quantifier');
});

test('every with select groups the members: each group is decided on its own, closed and open rules per group', () => {
  const head = '@player predicate\n  args subject:entity object:entity\n  closed true\n@cert predicate\n  args subject:entity\n  closed true\n';
  const teams = head + '@a fact\n  holds player ann rapid\n@b fact\n  holds player bob rapid\n@c fact\n  holds player cy united\n@d fact\n  holds player di united\n@k1 fact\n  holds cert ann\n@k2 fact\n  holds cert bob\n@k3 fact\n  holds cert cy\n';
  const only = '@q query\n  mode every\n  where player ?p ?t\n  select ?t\n  scope cert ?p\n';
  const r = run(teams, only);
  // rapid has only certified players; united has a player (di) without certification: closed predicates make that a counterexample
  assert.equal(r.status, 'supported');
  assert.deepEqual(rowsOf(r), ['{"t":"rapid"}']);
  assert.ok(r.used.length >= 1);
  // every group fails: refuted
  assert.equal(run(teams.replace('@k1 fact\n  holds cert ann\n@k2 fact\n  holds cert bob\n', ''), only).status, 'refuted');
  // a group with an explicit negation of its scope is refuted, the others stay
  const negated = run(head + '@a fact\n  holds player ann rapid\n@c fact\n  holds player cy united\n@k1 fact\n  holds cert ann\n@k2 fact\n  holds not cert cy\n', only);
  assert.equal(negated.status, 'supported');
  assert.deepEqual(rowsOf(negated), ['{"t":"rapid"}']);
  // open predicates: a group without a counterexample is unknown (open_domain), a group with one is refuted
  const open = '@a fact\n  holds player ann rapid\n@b fact\n  holds player cy united\n@k1 fact\n  holds cert ann\n@k2 fact\n  holds not cert cy\n';
  const o = run(open, only);
  assert.equal(o.status, 'unknown');
  assert.equal(o.reason, 'open_domain');
  assert.deepEqual(o.rows ?? [], []);
  // without select the population is one group, as before
  assert.equal(run(teams, '@q query\n  mode every\n  where player ?p ?t\n  scope cert ?p\n').status, 'refuted');
});

test('code and test wires are not_expressible outside the sandbox strategy, never unknown_wire_type', () => {
  const k = '@f1 fact\n  holds bird tweety\n@sum code\n  of "sum_list"\n  language javascript\n  entry "sum"\n  body "function sum(a){return a.length}"\n';
  assert.throws(() => run(k, '@q query\n  mode exists\n  where bird tweety\n'), e => e instanceof NotExpressibleError && e.features.join() === 'code_sandbox');
});
