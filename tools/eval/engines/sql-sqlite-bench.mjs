#!/usr/bin/env node
/**
 * Speed of `sql-sqlite` against `js-oracle` (js-reference) and `datalog-e10` on the SAME circuits.
 *
 *   node tools/eval/engines/sql-sqlite-bench.mjs [--family bulk_join,aggregate] [--scale 1] [--reps 3] [--json]
 *
 * Families (generated, with a procedural expected answer): bulk three-way join, selective join, aggregate over a large group, closed-world
 * policy (absent), unary linear recursion on a chain, bound transitive closure on a chain (what magic sets are built for), all-pairs closure
 * on a dense graph, nonlinear recursion, mutual recursion, triangles. Each strategy answers a prepared handle (the wire text is parsed once,
 * outside the timer, for everyone) under its own default budgets; a strategy that stops on a ceiling reports `budget_exhausted` and its time
 * is the time to the stop. Rows or counts must agree wherever two strategies finish; a disagreement is printed and fails the run.
 * The wall time is the median of `--reps` interleaved runs (cold process caches are not reset between them). Observations go to
 * eval/reports/current/sql-sqlite/bench.json; they are measurements of this machine, never a claim about another one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ask as oracleAsk, prepare as oraclePrepare} from '../../../reasoning/strategies/js-reference/index.mjs';
import {ask as sqlAsk} from '../../../reasoning/strategies/sql-sqlite/index.mjs';
import {datalogE10} from '../../../reasoning/strategies/datalog-e10/index.mjs';
import {parse} from '../../../sop/knowledge/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const scale = Number(opt('--scale', 1)), reps = Number(opt('--reps', 3));
const only = opt('--family', null)?.split(',');

const fact = (i, t) => `@f${i} fact\n  holds ${t}\n`;
const pred = (n, a, closed = true) => `@${n} predicate\n  args ${a}\n${closed ? '  closed true\n' : ''}`;
// the fact lines are kept aside and built as structured wires: the text parser of the grammar is quadratic in the number of wires, so a
// 10^5-fact circuit as text would measure the parser, not the strategies (proposal 11.3: a slice is a structured object, not text)
let currentFacts = [];
const facts = list => { currentFacts = list; return ''; };
export const factLines = () => currentFacts;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export const FAMILIES = {
  bulk_join(n) {
    const C = Math.max(10, Math.floor(n / 20)), R = 12;
    const f = [];
    for (let o = 0; o < n; o++) f.push(`orders o${o} c${(o * 7 + 3) % C}`);
    for (let c = 0; c < C; c++) f.push(`lives c${c} g${c % R}`);
    for (let r = 0; r < R; r++) f.push(`zone_of g${r} z${r % 4}`);
    let count = 0;
    for (let o = 0; o < n; o++) if ((((o * 7 + 3) % C) % R) % 4 === 3) count++;
    return {knowledge: [pred('orders', 'subject:entity object:entity'), pred('lives', 'subject:entity object:entity'), pred('zone_of', 'subject:entity object:entity'), pred('order_zone', 'subject:entity object:entity'), facts(f),
      '@r rule\n  when orders ?o ?c\n  when lives ?c ?g\n  when zone_of ?g ?z\n  then order_zone ?o ?z\n'].join('\n'), query: '@q query\n  mode count\n  where order_zone ?o z3\n  select ?o\n', expect: {count}};
  },
  selective_join(n) {
    const g = 17, chosen = n - 1;
    const f = [];
    for (let i = 0; i < n; i++) { f.push(`r i${i} k${i % g}`); f.push(`s k${i % g} i${i}`); }
    f.push(`chosen i${chosen}`);
    const rows = [];
    for (let i = 0; i < n; i++) if (i % g === chosen % g) rows.push(i);
    return {knowledge: [pred('r', 'subject:entity object:entity'), pred('s', 'subject:entity object:entity'), pred('chosen', 'subject:entity'), facts(f)].join('\n'),
      query: '@q query\n  where r ?x ?y\n  where s ?y ?z\n  where chosen ?z\n  select ?x\n', expect: {rows: rows.length}};
  },
  aggregate(n) {
    const D = 8, dept = i => (i < n * 0.6 ? 0 : 1 + ((i - Math.floor(n * 0.6)) % (D - 1)));
    const f = [];
    const sums = Array(D).fill(0);
    for (let i = 0; i < n; i++) { const pay = 30000 + ((i * 37) % 5000) * 3 + dept(i) * 1000; f.push(`salary p${i} d${dept(i)} ${pay}`); sums[dept(i)] += pay; }
    return {knowledge: [pred('salary', 'subject:entity topic:entity object:integer'), pred('dept_payroll', 'subject:entity object:integer', false), facts(f),
      '@payroll aggregate\n  over salary ?p ?d ?s\n  group ?d\n  sum ?s as ?t\n  yields dept_payroll ?d ?t\n'].join('\n'), query: '@q query\n  where dept_payroll ?d ?t\n  select ?d ?t\n', expect: {rows: D}};
  },
  policy(n) {
    const f = [];
    let denied = 0;
    for (let u = 0; u < n; u++) f.push(`member u${u} r${u % 16}`);
    for (let r = 0; r < 16; r++) for (let s = 0; s < 4; s++) f.push(`grant r${r} s${s}`);
    for (let u = 0; u < n; u += 7) { f.push(`denied u${u} s0`); denied++; }
    return {knowledge: [pred('member', 'subject:entity object:entity'), pred('grant', 'subject:entity object:entity'), pred('denied', 'subject:entity object:entity'), pred('can', 'subject:entity object:entity'), facts(f),
      '@r rule\n  when member ?u ?r\n  when grant ?r ?s\n  when absent denied ?u ?s\n  then can ?u ?s\n'].join('\n'), query: '@q query\n  mode count\n  where can ?u ?s\n  select ?u ?s\n', expect: {count: n * 4 - denied}};
  },
  chain_unary(n) {
    const f = ['start n0'];
    for (let i = 0; i < n; i++) f.push(`edge n${i} n${i + 1}`);
    return {knowledge: [pred('edge', 'source:entity destination:entity'), pred('start', 'subject:entity'), pred('visited', 'subject:entity'), facts(f),
      '@r1 rule\n  when start ?x\n  then visited ?x\n', '@r2 rule\n  when visited ?x\n  when edge ?x ?y\n  then visited ?y\n'].join('\n'), query: '@q query\n  where visited ?t\n  select ?t\n', expect: {rows: n + 1}};
  },
  chain_bound_closure(n) {
    const f = [];
    for (let i = 0; i < n; i++) f.push(`edge n${i} n${i + 1}`);
    return {knowledge: [pred('edge', 'source:entity destination:entity'), pred('path', 'source:entity destination:entity'), facts(f),
      '@r1 rule\n  when edge ?x ?y\n  then path ?x ?y\n', '@r2 rule\n  when path ?x ?y\n  when edge ?y ?z\n  then path ?x ?z\n'].join('\n'), query: '@q query\n  where path n0 ?t\n  select ?t\n', expect: {rows: n}};
  },
  dense_closure(n) {
    const R = rng(7), edges = new Set();
    for (let i = 0; i < n; i++) { edges.add(`${i},${(i + 1) % n}`); for (let j = 0; j < n; j++) if (i !== j && R() < 0.12) edges.add(`${i},${j}`); }
    const f = [...edges].map(e => { const [a, b] = e.split(','); return `edge n${a} n${b}`; });
    return {knowledge: [pred('edge', 'source:entity destination:entity'), pred('path', 'source:entity destination:entity'), facts(f),
      '@r1 rule\n  when edge ?x ?y\n  then path ?x ?y\n', '@r2 rule\n  when path ?x ?y\n  when edge ?y ?z\n  then path ?x ?z\n'].join('\n'), query: '@q query\n  mode count\n  where path ?x ?y\n  select ?x ?y\n', expect: {count: n * n}};
  },
  nonlinear(n) {
    const f = [];
    for (let i = 0; i < n; i++) f.push(`edge n${i} n${i + 1}`);
    return {knowledge: [pred('edge', 'source:entity destination:entity'), pred('path', 'source:entity destination:entity'), facts(f),
      '@r1 rule\n  when edge ?x ?y\n  then path ?x ?y\n', '@r2 rule\n  when path ?x ?y\n  when path ?y ?z\n  then path ?x ?z\n'].join('\n'), query: '@q query\n  mode count\n  where path ?x ?y\n  select ?x ?y\n', expect: {count: (n * (n + 1)) / 2}};
  },
  mutual(n) {
    const f = ['seed n0'];
    for (let i = 0; i < n - 1; i++) f.push(`edge n${i} n${i + 1}`);
    return {knowledge: [pred('edge', 'source:entity destination:entity'), pred('seed', 'subject:entity'), pred('p', 'subject:entity'), pred('q', 'subject:entity'), facts(f),
      '@r1 rule\n  when seed ?x\n  then p ?x\n', '@r2 rule\n  when p ?x\n  then q ?x\n', '@r3 rule\n  when q ?x\n  when edge ?x ?y\n  then p ?y\n'].join('\n'), query: '@q query\n  where p ?x\n  select ?x\n', expect: {rows: n}};
  },
  triangles(n) {
    const R = rng(11), edges = new Set();
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && R() < 0.18) edges.add(`${i},${j}`);
    const f = [...edges].map(e => { const [a, b] = e.split(','); return `edge n${a} n${b}`; });
    let count = 0;
    for (const e of edges) { const [x, y] = e.split(',').map(Number); for (let z = 0; z < n; z++) if (edges.has(`${y},${z}`) && edges.has(`${z},${x}`)) count++; }
    return {knowledge: [pred('edge', 'source:entity destination:entity'), facts(f)].join('\n'), query: '@q query\n  mode count\n  where edge ?x ?y\n  where edge ?y ?z\n  where edge ?z ?x\n  select ?x ?y ?z\n', expect: {count}};
  }
};

const SIZES = {bulk_join: [3000, 30000, 300000], selective_join: [3000, 30000], aggregate: [4000, 40000, 400000], policy: [1600, 16000, 160000], chain_unary: [100, 1000, 10000], chain_bound_closure: [100, 1000],
  dense_closure: [32, 80], nonlinear: [30, 120], mutual: [240, 2400], triangles: [40, 90]};

// one wall-clock cap for everybody, so that no strategy can run for minutes on a size that is out of its reach; every other budget is the strategy's default
const WALL = {timeoutMs: 20000};
const strategies = {
  'js-oracle': (handle, query) => oracleAsk({handle, query}, WALL),
  'datalog-e10': (handle, query) => datalogE10.ask({handle, query}, WALL, {conditional: false}),
  'sql-sqlite': (handle, query) => sqlAsk({handle, query}, WALL, {conditional: false, provenance: false}),
  'sql-sqlite+used': (handle, query) => sqlAsk({handle, query}, WALL, {conditional: false})
};
const answerOf = r => (r.status === 'budget_exhausted' || r.complete === false ? 'budget:' + r.reason : r.count !== undefined ? `count ${r.count}` : r.rows ? `${r.rows.length} rows` : r.status);

function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

function main() {
  const out = {machine: {cpu: os.cpus()[0]?.model, cores: os.cpus().length, node: process.version, platform: process.platform}, scale, reps, results: []};
  let bad = 0, skipOracleFamily = null;
  for (const [family, sizes] of Object.entries(SIZES)) {
    if (only && !only.includes(family)) continue;
    for (const base of sizes) {
      const n = Math.max(4, Math.round(base * scale));
      const inst = FAMILIES[family](n);
      const t0 = performance.now();
      const factWires = currentFacts.map((t, i) => ({id: `f${i + 1}`, type: 'fact', line: 0, fields: [{key: 'holds', value: t, line: 0, block: []}]}));
      const handle = oraclePrepare({wires: [...parse(inst.knowledge).wires, ...factWires]});
      const parseMs = Math.round(performance.now() - t0);
      const row = {family, n, facts: factWires.length, parseMs, times: {}, answers: {}};
      const samples = Object.fromEntries(Object.keys(strategies).map(k => [k, []]));
      for (let rep = 0; rep < reps; rep++) {
        for (const [name, run] of Object.entries(strategies)) {
          // the oracle is naive: skip it once it exhausted its budget at a smaller size of this family (its time would be the ceiling, not a result)
          if (name === 'js-oracle' && (row.skipOracle || skipOracleFamily === family)) continue;
          const t = performance.now();
          let r;
          try { r = run(handle, inst.query); } catch (e) { r = {status: 'error', message: e.message}; }
          samples[name].push(performance.now() - t);
          row.answers[name] = r.status === 'error' ? 'error: ' + r.message.slice(0, 60) : answerOf(r);
          row.correct = row.correct ?? {};
          const want = inst.expect;
          const ok = r.status === 'budget_exhausted' || r.status === 'error' || r.complete === false ? null : (want.count !== undefined ? r.count === want.count : want.rows !== undefined ? r.rows?.length === want.rows : true);
          row.correct[name] = ok;
          if (ok === false) { bad++; console.log(`WRONG ${family} n=${n} ${name}: ${answerOf(r)}, expected ${JSON.stringify(want)}`); }
          if (name === 'js-oracle' && (r.status === 'budget_exhausted' || r.complete === false)) row.skipOracle = true;
        }
      }
      for (const k of Object.keys(strategies)) row.times[k] = samples[k].length ? Math.round(median(samples[k]) * 10) / 10 : null;
      if (row.times['js-oracle'] > 3000) skipOracleFamily = family; // a naive evaluator past 3 s is out of reach: do not time its next size
      delete row.skipOracle;
      out.results.push(row);
      const cell = k => (row.times[k] === null ? '-' : `${row.times[k]}ms ${row.answers[k] && /budget|error/.test(row.answers[k]) ? '(' + row.answers[k] + ')' : ''}`.trim());
      console.log(`${family.padEnd(20)} n=${String(n).padEnd(7)} facts=${String(row.facts).padEnd(7)} oracle ${cell('js-oracle').padEnd(28)} e10 ${cell('datalog-e10').padEnd(28)} sql ${cell('sql-sqlite').padEnd(10)} sql+used ${cell('sql-sqlite+used')}`);
    }
  }
  if (args.includes('--json') || !only) {
    const dir = path.join(repo, 'eval/reports/current/sql-sqlite');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'bench.json'), JSON.stringify(out, null, 1) + '\n');
  }
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
