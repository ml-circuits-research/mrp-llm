import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSOP} from '../../reasoning/strategies/datalog-e10/vendor/parser.mjs';
import {reason} from '../../reasoning/strategies/datalog-e10/vendor/engine.mjs';
import {reference} from '../../reasoning/strategies/datalog-e10/vendor/reference.mjs';

/**
 * The tests of the vendored E10 engine that concern what the strategy uses (sop_reasoner_e10.zip, tests/core.test.mjs: parser, validation, demand
 * variants against the independent reference evaluator, negation, budgets). The proof, session, skill-learning and dreaming tests are not ported:
 * their modules are not vendored.
 */
const run=(s,opts={})=>reason(parseSOP(s),'q',opts);
const basic=`@f facts
FACT edge a b
FACT edge b c
FACT edge c b
@base rule
WHEN edge ?x ?y
THEN path ?x ?y
@rec rule
WHEN path ?x ?y
AND edge ?y ?z
THEN path ?x ?z
@q query
GIVES ?y
MATCH path a ?y`;
const variants=[{demand:false,factor:false,join:'source',indexed:false,mode:'naive'}, {demand:false,factor:false,join:'source'}, {demand:false}, {},{fuse:true}, {demand:true,indexed:false}, {demand:false,mode:'naive'}];
for(const [i,opts]of variants.entries())test(`recursive cycles exact variant ${i}`,()=>{const p=parseSOP(basic);assert.deepEqual(reason(p,'q',opts).rows,reference(p,'q').rows);});
test('all any and explicit NOT',()=>{const s=`@f facts
FACT p a
FACT q b
FACT NOT p c
@a all
GIVES ?x
MATCH p ?x
@b any
GIVES ?x
USE $a ?x
MATCH q ?x
@q query
GIVES ?x
USE $b ?x`;assert.deepEqual(run(s).rows,[['a'],['b']]);});
test('OR branches with conjunction',()=>{const s=`@f facts
FACT a 1
FACT b 1
FACT c 2
@r rule
WHEN a ?x
AND b ?x
OR c ?x
THEN good ?x
@q query
MATCH good ?x`;assert.deepEqual(run(s).rows,[[1],[2]]);});
test('negation waits for recursive stratum',()=>{const s=basic.replace('@q query','@n rule\nWHEN edge ?x ?y\nNONE path ?y ?x\nTHEN one_way ?x ?y\n@q query').replace('MATCH path a ?y','MATCH one_way a ?y');assert.deepEqual(run(s).rows,[['b']]);assert.equal(run(s).plan.demandApplied,false);});
test('negation cycle rejected',()=>assert.throws(()=>run(`@f facts
FACT d a
@a rule
WHEN d ?x
NONE b ?x
THEN a ?x
@b rule
WHEN d ?x
NONE a ?x
THEN b ?x
@q query
MATCH a ?x`),/negation/));
test('unsafe head rejected',()=>assert.throws(()=>parseSOP('@r rule\nWHEN a ?x\nTHEN b ?z'),/Unsafe/));
test('unsafe negation rejected',()=>assert.throws(()=>parseSOP('@q query\nMATCH a ?x\nNONE b ?y'),/Unsafe/));
test('arity mismatch rejected',()=>assert.throws(()=>parseSOP('@f facts\nFACT a 1\nFACT a 1 2'),/Arity/));
test('wire duplicate rejected',()=>assert.throws(()=>parseSOP('@f facts\nFACT a 1\n@f facts\nFACT a 2'),/Duplicate/));
test('quoted strings preserve hash and spaces',()=>assert.deepEqual(run('@f facts\nFACT p "a # b"\n@q query\nMATCH p ?x').rows,[['a # b']]));
test('typed constants do not alias',()=>assert.deepEqual(run('@f facts\nFACT p 1\nFACT p "1"\nFACT p true\n@q query\nMATCH p ?x').rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),[['1'],[1],[true]].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))));
test('unsafe numeric magnitude rejected',()=>assert.throws(()=>parseSOP('@f facts\nFACT p 9007199254740993'),/safe range/));
test('comparison types checked',()=>assert.throws(()=>run('@f facts\nFACT p abc\n@q query\nMATCH p ?x\nTEST ?x < 4'),/integer/));
test('ground boolean query has zero columns',()=>assert.deepEqual(run('@f facts\nFACT p a\n@q query\nMATCH p a').rows,[[]]));
test('empty answers are complete',()=>{const r=run('@f facts\nFACT p a\n@q query\nMATCH p b');assert.equal(r.status,'COMPLETE');assert.deepEqual(r.rows,[]);});
test('repeated variables unified',()=>assert.deepEqual(run('@f facts\nFACT p a b\nFACT p a a\n@q query\nMATCH p ?x ?x').rows,[['a']]));
test('duplicate facts and derivations use set semantics',()=>assert.deepEqual(run('@f facts\nFACT p a\nFACT p a\n@r rule\nWHEN p ?x\nTHEN p ?x\n@q query\nMATCH p ?x').rows,[['a']]));
test('EDB and IDB relation coexist with demand',()=>{const p=parseSOP(basic.replace('FACT edge a b','FACT path a d\nFACT edge a b'));assert.deepEqual(reason(p,'q').rows,reference(p,'q').rows);});
test('constant head demand transformation',()=>{const s='@f facts\nFACT p b\n@r rule\nWHEN p ?y\nTHEN edge a ?y\n@q query\nMATCH edge a ?x';assert.deepEqual(run(s).rows,[['b']]);});
test('repeated head variables demand transformation',()=>assert.deepEqual(run('@f facts\nFACT p a\n@r rule\nWHEN p ?x\nTHEN eq ?x ?x\n@q query\nMATCH eq a ?y').rows,[['a']]));
test('existential decomposition prevents irrelevant product',()=>{const facts=Array.from({length:50},(_,i)=>`FACT a ${i}\nFACT b ${i}`).join('\n');const p=parseSOP(`@f facts\n${facts}\n@q query\nGIVES ?x\nMATCH a ?x\nMATCH b ?y`);const a=reason(p,'q',{demand:false,factor:false}),b=reason(p,'q',{demand:false});assert.deepEqual(a.rows,b.rows);assert.ok(a.stats.candidateVisits>b.stats.candidateVisits*20);});
test('empty existential component kills all rows',()=>assert.deepEqual(run('@f facts\nFACT a 1\n@q query\nGIVES ?x\nMATCH a ?x\nMATCH empty ?y').rows,[]));
test('ground test-only rule prohibited without domain binding',()=>assert.throws(()=>parseSOP('@q query\nGIVES ?x\nTEST ?x > 0'),/Unsafe/));
test('work budget returns INCOMPLETE, never complete false',()=>{const r=run(basic,{maxWork:1});assert.equal(r.status,'INCOMPLETE');assert.equal(r.complete,false);});
test('fusion avoids variable capture and checks EDB guard',()=>{const s=`@f facts
FACT a p q
FACT b q r
FACT c r s
@inner rule
WHEN a ?x ?internal
AND b ?internal ?y
THEN ab ?x ?y
@outer rule
WHEN ab ?internal ?y
AND c ?y ?z
THEN abc ?internal ?z
@q query
MATCH abc ?x ?z`;const p=parseSOP(s);assert.deepEqual(reason(p,'q',{fuse:true}).rows,reference(p,'q').rows);const p2=parseSOP(s.replace('FACT a p q','FACT ab z r\nFACT a p q'));assert.deepEqual(reason(p2,'q',{fuse:true}).rows,reference(p2,'q').rows);});

// ---- the strategy on top of the vendored engine

import {ask as oracle} from '../../reasoning/strategies/js-reference/index.mjs';
import {datalogE10, capabilities, makeEngine, NotExpressibleError} from '../../reasoning/strategies/datalog-e10/index.mjs';
import {askWith} from '../../reasoning/strategies/datalog-common/front.mjs';
import {lowerProgram} from '../../reasoning/strategies/datalog-e10/lower.mjs';
import * as scale from '../../eval/smoke-reasoning/bench/datalog-scale.mjs';
import {parse} from '../../sop/knowledge/index.mjs';

const askE = (knowledge, query, budget = {}, options = {}) => datalogE10.ask({theory: {knowledge}, query}, budget, {conditional: false, ...options});
const rowsOf = r => r.rows.map(x => JSON.stringify(x)).sort();
const sel = (where, select) => `@q query\n  where ${where}\n  select ${select}\n`;

test('capabilities: what E10 provides and what is not expressible', () => {
  assert.equal(capabilities.id, 'datalog-e10');
  assert.deepEqual(capabilities.provides, []);
  for (const f of ['aggregate', 'compute_in_rules', 'temporal', 'plan', 'abduce', 'explain']) assert.ok(capabilities.notExpressible.includes(f), f);
  assert.ok(capabilities.features.includes('budget_probes'));
});

test('lowering: facts, explicit negation as a separate relation, NONE for absent, TEST for compare, bare and quoted symbols', () => {
  const wires = parse('@c predicate\n  args subject:entity\n  closed true\n@f1 fact\n  holds p a\n@f2 fact\n  holds not p b\n@f3 fact\n  holds label n1 "two words"\n@f4 fact\n  holds label n2 true\n@r rule\n  when p ?x\n  when absent c ?x\n  when compare ?x not_equal b\n  then q ?x\n').wires;
  const facts = wires.filter(w => w.type === 'fact').map(w => {
    const toks = w.fields[0].value.split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const neg = toks[0] === 'not';
    const t = neg ? toks.slice(1) : toks;
    return {neg, p: t[0], args: t.slice(1).map(x => (x.startsWith('"') ? JSON.parse(x) : x))};
  });
  const program = {aggregates: [], rules: [{head: {neg: false, p: 'q', args: [{var: '?x'}]}, alts: [{leaves: [{kind: 'atom', mode: 'pos', p: 'p', args: [{var: '?x'}]}, {kind: 'atom', mode: 'absent', p: 'c', args: [{var: '?x'}]}, {kind: 'compare', word: 'not_equal', left: {var: '?x'}, right: 'b'}]}]}]};
  const text = lowerProgram(program, facts);
  assert.match(text, /FACT p a/);
  assert.match(text, /FACT NOT p b/);
  assert.match(text, /FACT label n1 "two words"/);
  assert.match(text, /FACT label n2 "true"/, 'the text true is quoted: E10 would read a bare true as a boolean');
  assert.match(text, /NONE c \?x/);
  assert.match(text, /TEST \?x != b/);
});

test('both polarities coexist: evidence is independent, a conflict is a status, not an explosion', () => {
  const k = '@f1 fact\n  holds p a\n@f2 fact\n  holds not p a\n@f3 fact\n  holds p b\n';
  assert.equal(askE(k, '@q query\n  mode exists\n  where p a\n').status, 'both');
  assert.equal(askE(k, '@q query\n  mode exists\n  where p b\n').status, 'supported');
  assert.deepEqual(rowsOf(askE(k, sel('p ?x', '?x'))), ['{"x":"a"}', '{"x":"b"}']);
});

test('E10 INCOMPLETE is budget_exhausted with a named reason, never unknown or refuted; a monotone select reports its partial rows', () => {
  const chain = Array.from({length: 40}, (_, i) => `@e${i} fact\n  holds edge n${i} n${i + 1}\n`).join('') + '@r1 rule\n  when edge ?a ?b\n  then reach ?a ?b\n@r2 rule\n  when reach ?a ?b\n  when edge ?b ?c\n  then reach ?a ?c\n';
  const full = askE(chain, sel('reach n0 ?y', '?y'));
  assert.equal(full.rows.length, 40);
  const cut = askE(chain, sel('reach n0 ?y', '?y'), {maxJoins: 30});
  assert.equal(cut.complete, false);
  assert.equal(cut.reason, 'probes');
  assert.ok(['budget_exhausted', 'supported'].includes(cut.status));
  if (cut.rows) assert.ok(cut.rows.every(r => full.rows.some(f => f.y === r.y)), 'partial rows are a subset of the true rows');
  const nothing = askE(chain, '@q query\n  mode exists\n  where reach n0 n40\n', {maxJoins: 3});
  assert.equal(nothing.status, 'budget_exhausted');
  assert.equal(nothing.complete, false);
});

test('compute and aggregate are not expressible in E10; ordering over text is refused', () => {
  assert.throws(() => askE('@f1 fact\n  holds n 2\n@r rule\n  when n ?x\n  when compute ?y ?x times 2\n  then d ?y\n', sel('d ?y', '?y')), NotExpressibleError);
  assert.throws(() => askE('@f1 fact\n  holds amount a 3\n@agg aggregate\n  over amount ?e ?v\n  group ?e\n  sum ?v as ?t\n  yields total ?e ?t\n', sel('total ?e ?t', '?e ?t')), NotExpressibleError);
  assert.throws(() => askE('@f1 fact\n  holds p abc\n@r rule\n  when p ?x\n  when compare ?x above 3\n  then q ?x\n', sel('q ?x', '?x')), NotExpressibleError);
});

test('demand rewriting (magic sets): a bound query touches the chain only; with no bound argument it only adds work (the regression of case 69)', () => {
  const sel68 = scale.selectiveChain({components: 60, size: 30});
  const run = (inst, options) => {
    const engine = makeEngine(options);
    const out = askWith(engine, {theory: {knowledge: inst.knowledge}, query: inst.query}, {}, {conditional: false});
    return {out, stats: out.timings.e10.stats};
  };
  const demand = run(sel68, {}), plain = run(sel68, {demand: false});
  assert.deepEqual(rowsOf(demand.out), rowsOf(plain.out));
  assert.equal(demand.stats.demandApplied, true);
  assert.ok(demand.stats.candidateVisits * 100 < plain.stats.candidateVisits, `demand ${demand.stats.candidateVisits} against ${plain.stats.candidateVisits} candidate visits`);
  const dense = scale.denseNonlinear({nodes: 40, density: 3});
  const d1 = run(dense, {}), d2 = run(dense, {demand: false});
  assert.equal(d1.out.count, dense.answer.count);
  assert.equal(d2.out.count, dense.answer.count);
  assert.ok(d1.stats.candidateVisits >= d2.stats.candidateVisits, 'with no bound argument the demand relations are extra work, never a saving');
});

test('10^5 facts: reachability over many ring components is answered exactly (smoke case 65 at scale)', { timeout: 120000 }, () => {
  const big = scale.ringComponents({components: 10000, size: 10});
  const blocks = big.knowledge.split(/\n(?=@)/), wires = [];
  for (let i = 0; i < blocks.length; i += 400) wires.push(...parse(blocks.slice(i, i + 400).join('\n') + '\n').wires);
  const out = datalogE10.ask({theory: {wires}, query: big.query}, {}, {conditional: false});
  assert.equal(out.complete, true);
  assert.deepEqual(rowsOf(out), rowsOf({rows: big.answer.rows}));
  const small = scale.ringComponents({components: 20, size: 10});
  assert.deepEqual(rowsOf(askE(small.knowledge, small.query)), rowsOf(oracle({theory: {knowledge: small.knowledge}, query: small.query})));
});

test('closure path (every, pushdown off) agrees with the pushed-down query', () => {
  const inst = scale.negationChain({nodes: 30});
  const a = askE(inst.knowledge, inst.query), b = askE(inst.knowledge, inst.query, {}, {pushdown: false});
  assert.deepEqual(rowsOf(a), rowsOf(b));
  assert.deepEqual(rowsOf(a), rowsOf({rows: inst.answer.rows}));
  const every = '@q query\n  mode every\n  where s1 ?x\n  scope node ?x\n  select ?x\n';
  assert.equal(askE(inst.knowledge, every).status, oracle({theory: {knowledge: inst.knowledge}, query: every}).status);
});
