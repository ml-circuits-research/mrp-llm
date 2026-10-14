import test from 'node:test';
import assert from 'node:assert/strict';
import {ask as aspAsk, available as aspAvailable} from '../../reasoning/strategies/asp-clingo/index.mjs';
import {ask as z3Ask, available as z3Available} from '../../reasoning/strategies/z3-smt-bounded/index.mjs';
import {ask as oracleAsk} from '../../reasoning/strategies/js-reference/index.mjs';

/**
 * Random stratified programs (explicit negation, `absent` over closed derived predicates, `compute`, `compare`, aggregates, and for
 * clingo recursion) run through the oracle and both solver strategies: status, rows and counts must be identical. A fixed seed keeps
 * the run deterministic; the programs are small so that the oracle is the reference on EXACTLY decided answers.
 */
const aspReady = (await aspAvailable()).ok, z3Ready = (await z3Available()).ok;
const opts = {conditional: false, used: false};

function prng(seed) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; };
}

function program(seed, {recursion}) {
  const r = prng(seed), pick = xs => xs[Math.floor(r() * xs.length)], chance = p => r() < p;
  const ents = ['a', 'b', 'c', 'd', 'e'];
  const out = [];
  for (const p of ['b0', 'b1']) out.push(`@${p} predicate\n  args subject:entity object:entity\n  closed true\n`);
  out.push('@b2 predicate\n  args subject:entity object:integer\n  closed true\n');
  let n = 0;
  const fact = (p, a, b) => out.push(`@f${n++} fact\n  holds ${p} ${a} ${b}\n`);
  for (let i = 0; i < 6; i++) fact(pick(['b0', 'b1']), pick(ents), pick(ents));
  for (let i = 0; i < 4; i++) fact('b2', pick(ents), 1 + Math.floor(r() * 9));
  if (chance(0.5)) out.push(`@f${n++} fact\n  holds not b0 ${pick(ents)} ${pick(ents)}\n`);
  const levels = [['b0', 'b1']]; // predicates of arity 2 over entities usable as lower levels
  const derived = [];
  const rules = [];
  const bodyAtom = (preds, x, y) => `  when ${pick(preds)} ${x} ${y}\n`;
  for (let k = 0; k < 4; k++) {
    const name = `d${k}`;
    const lower = [...levels.flat(), ...derived.filter(d => d.arity === 2).map(d => d.name)];
    const lowerClosed = derived.map(d => d.name);
    const variant = pick(['join', 'neg', 'arith', 'explicit', 'agg']);
    const decl = arity => out.push(`@${name} predicate\n  args ${arity === 2 ? 'subject:entity object:entity' : 'subject:entity'}\n  closed true\n`);
    if (variant === 'join') {
      decl(2);
      rules.push(`@r${k} rule\n${bodyAtom(lower, '?x', '?y')}${bodyAtom(lower, '?y', '?z')}  then ${name} ?x ?z\n`);
      derived.push({name, arity: 2});
    } else if (variant === 'neg' && lowerClosed.length) {
      decl(2);
      rules.push(`@r${k} rule\n${bodyAtom(lower, '?x', '?y')}  when absent ${pick(lowerClosed)} ?x ?y\n  then ${name} ?x ?y\n`);
      derived.push({name, arity: 2});
    } else if (variant === 'explicit') {
      decl(1);
      rules.push(`@r${k} rule\n  when not b0 ?x ?y\n  then ${name} ?x\n`);
      derived.push({name, arity: 1});
    } else if (variant === 'arith') {
      out.push(`@${name} predicate\n  args subject:entity object:integer\n  closed true\n`);
      rules.push(`@r${k} rule\n  when b2 ?x ?n\n  when compute ?m ?n ${pick(['times', 'plus', 'minus', 'whole_divided_by'])} ${1 + Math.floor(r() * 4)}\n  when compare ?m ${pick(['above', 'at_least', 'below', 'not_equal'])} ${Math.floor(r() * 8)}\n  then ${name} ?x ?m\n`);
      derived.push({name, arity: 3});
    } else {
      out.push(`@${name} predicate\n  args subject:entity object:integer\n  closed true\n`);
      rules.push(`@a${k} aggregate\n  over ${pick(['b0', 'b1'])} ?x ?y\n  group ?x\n  count ?y as ?c\n  yields ${name} ?x ?c\n`);
      derived.push({name, arity: 3});
    }
  }
  if (recursion) {
    out.push('@reach predicate\n  args subject:entity object:entity\n  closed true\n@cut predicate\n  args subject:entity object:entity\n  closed true\n');
    rules.push('@rr0 rule\n  when b0 ?x ?y\n  then reach ?x ?y\n', '@rr1 rule\n  when b0 ?x ?m\n  when reach ?m ?y\n  then reach ?x ?y\n', `@rr2 rule\n  when b1 ?x ?y\n  when absent reach ?x ?y\n  then cut ?x ?y\n`);
    derived.push({name: 'reach', arity: 2}, {name: 'cut', arity: 2});
  }
  const target = pick(derived);
  const query = target.arity === 1 ? `@q query\n  where ${target.name} ?x\n  select ?x\n` : target.arity === 3 ? `@q query\n  where ${target.name} ?x ?v\n  select ?x ?v\n` : `@q query\n  where ${target.name} ?x ?y\n  select ?x ?y\n`;
  return {knowledge: [...out, ...rules].join('\n'), query: chance(0.3) ? query.replace('@q query\n', '@q query\n  mode count\n') : query};
}

const norm = r => JSON.stringify({status: r.status, rows: (r.rows ?? []).map(x => JSON.stringify(Object.entries(x).sort())).sort(), count: r.count, bound: r.bound});

for (const [name, run, ready, recursion] of [['asp-clingo', aspAsk, aspReady, true], ['z3-smt-bounded', z3Ask, z3Ready, false]]) {
  test(`differential: ${name} equals the oracle on 80 random stratified programs`, {skip: !ready && 'solver not available'}, () => {
    for (let seed = 1; seed <= 80; seed++) {
      const p = program(seed * 7919, {recursion});
      const expected = oracleAsk({theory: {knowledge: p.knowledge}, query: p.query}, {}, {});
      const got = run({theory: {knowledge: p.knowledge}, query: p.query}, {}, opts);
      assert.equal(norm(got), norm(expected), `seed ${seed}\n${p.knowledge}\n${p.query}`);
    }
  });
}
