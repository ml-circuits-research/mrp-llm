import test from 'node:test';
import assert from 'node:assert/strict';
import {ask as oracle, NotExpressibleError} from '../../reasoning/strategies/js-reference/index.mjs';
import {datalogSouffle} from '../../reasoning/strategies/datalog-souffle/index.mjs';
import {datalogE10} from '../../reasoning/strategies/datalog-e10/index.mjs';
import {datalogSoplab} from '../../eval/reference-engines/datalog-soplab/index.mjs';

/**
 * Differential test of the three Datalog strategies against the oracle (`js-reference`) on random stratified programs: facts (positive and
 * explicit negative), recursive and non-recursive rules, `not` and `absent` literals, comparisons, arithmetic, aggregates, and the query
 * modes select, exists, count and every. A strategy that declares a circuit not expressible is skipped for it, never weakened; every other
 * answer must agree with the oracle on status, rows, count and bound. The seeds are fixed, so a failure is reproducible.
 */
const souffleOk = (await datalogSouffle.available()).ok;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const CONSTS = ['c0', 'c1', 'c2', 'c3', 'c4'];
const VARS = ['?x', '?y', '?z'];

/** One random program (knowledge text) and a few query circuits. `numeric` adds integers, compute and aggregates. */
function generate(seed, numeric) {
  const r = rng(seed), pick = xs => xs[Math.floor(r() * xs.length)], chance = p => r() < p;
  const base = [{p: 'b0', n: 2}, {p: 'b1', n: 2, closed: true}, {p: 'u0', n: 1}, {p: 'u1', n: 1, closed: true}];
  const derived = [{p: 'd0', n: 2, closed: chance(0.6)}, {p: 'd1', n: 1, closed: chance(0.6)}, {p: 'd2', n: 2, closed: false}];
  const preds = [...base, ...derived];
  const out = [];
  for (const q of preds) out.push(`@${q.p} predicate\n  args ${Array.from({length: q.n}, (_, i) => `${['subject', 'object'][i]}:entity`).join(' ')}${q.closed ? '\n  closed true' : ''}\n`);
  if (numeric) out.push('@amount predicate\n  args subject:entity object:integer\n  closed true\n');
  let id = 0;
  const arg = () => pick(CONSTS);
  const stated = [];
  for (let k = 0; k < 14; k++) {
    const q = pick(base.concat(derived.slice(0, 1)));
    const before = stated.filter(x => x.p === q.p);
    if (chance(0.2) && !q.closed) {
      const args = before.length && chance(0.6) ? pick(before).args : Array.from({length: q.n}, arg); // often the contrary of a stated atom: a conflict
      out.push(`@f${id++} fact\n  holds not ${q.p} ${args.join(' ')}\n`);
    } else { const args = Array.from({length: q.n}, arg); stated.push({p: q.p, args}); out.push(`@f${id++} fact\n  holds ${q.p} ${args.join(' ')}\n`); }
  }
  if (numeric) for (const c of CONSTS.slice(0, 4)) out.push(`@f${id++} fact\n  holds amount ${c} ${Math.floor(r() * 9) + 1}\n`);
  // rules: layer i of the derived predicates may use the base predicates, the lower derived predicates and itself (positive only)
  derived.forEach((d, layer) => {
    const lower = derived.slice(0, layer);
    const usable = [...base, ...lower, d];
    for (let k = 0; k < 2; k++) {
      const body = [], bound = new Set();
      const pos = 1 + Math.floor(r() * 2);
      for (let i = 0; i < pos; i++) { const q = pick(usable); const args = Array.from({length: q.n}, () => pick(VARS)); args.forEach(v => bound.add(v)); body.push({kind: 'pos', q, args}); }
      const vs = [...bound];
      if (chance(0.35)) { const q = pick([...base, ...lower].filter(x => x.closed)); if (q) body.push({kind: 'absent', q, args: Array.from({length: q.n}, () => pick(vs))}); }
      if (chance(0.2)) { const q = pick([...base, ...lower]); body.push({kind: 'not', q, args: Array.from({length: q.n}, () => pick(vs))}); }
      if (chance(0.2) && vs.length > 1) body.push({kind: 'cmp', word: pick(['equal', 'not_equal']), a: vs[0], b: vs[1]});
      const headArgs = Array.from({length: d.n}, () => pick(vs));
      const neg = chance(0.12) ? 'not ' : '';
      const lines = body.map(l => (l.kind === 'cmp' ? `  when compare ${l.a} ${l.word} ${l.b}` : `  when ${l.kind === 'absent' ? 'absent ' : l.kind === 'not' ? 'not ' : ''}${l.q.p} ${l.args.join(' ')}`));
      out.push(`@r${id++} rule\n${lines.join('\n')}\n  then ${neg}${d.p} ${headArgs.join(' ')}\n`);
    }
  });
  if (numeric) {
    out.push('@score predicate\n  args subject:entity object:integer\n@r_score rule\n  when amount ?x ?v\n  when compute ?w ?v times 3\n  when compare ?w above 6\n  then score ?x ?w\n');
    out.push('@total_amount predicate\n  args object:integer\n@agg1 aggregate\n  over amount ?e ?v\n  group none\n  sum ?v as ?t\n  yields total_amount ?t\n'.replace('  group none\n', ''));
    out.push('@bucket predicate\n  args subject:entity object:integer\n@agg2 aggregate\n  over b0 ?x ?y\n  group ?x\n  count ?y as ?n\n  yields bucket ?x ?n\n');
    out.push('@top predicate\n  args subject:entity object:integer\n@agg3 aggregate\n  over amount ?e ?v\n  over b0 ?e ?z\n  group ?z\n  max ?v as ?m\n  yields top ?z ?m\n');
  }
  const queries = [];
  const atomQ = () => { const q = pick(preds); return {q, text: `${q.p} ${Array.from({length: q.n}, () => (chance(0.4) ? pick(CONSTS) : pick(VARS.slice(0, 2)))).join(' ')}`}; };
  const varsOf = text => [...new Set(text.match(/\?[a-z]+/g) ?? [])];
  for (let k = 0; k < 5; k++) {
    const a = atomQ(), vars = varsOf(a.text);
    const mode = pick(['select', 'exists', 'count', 'select']);
    if (mode === 'select' && !vars.length) { queries.push(`@q query\n  mode exists\n  where ${a.text}\n`); continue; }
    queries.push(`@q query\n  mode ${mode}\n  where ${a.text}\n${mode === 'select' ? `  select ${vars.join(' ')}\n` : ''}`);
  }
  // a two-literal query, sometimes with `not`
  { const a = atomQ(), b = atomQ(); const text = `  where ${a.text}\n  where ${chance(0.3) ? 'not ' : ''}${b.text}\n`; const vars = varsOf(a.text);
    if (vars.length && varsOf(b.text).every(v => vars.includes(v))) queries.push(`@q query\n  mode select\n${text}  select ${vars.join(' ')}\n`); }
  { const a = pick(preds.filter(x => x.n === 1 && x.closed)), s = pick(preds.filter(x => x.n === 1)); queries.push(`@q query\n  mode every\n  where ${a.p} ?x\n  scope ${s.p} ?x\n  select ?x\n`); }
  if (numeric) {
    queries.push('@q query\n  mode select\n  where score ?x ?w\n  select ?x ?w\n', '@q query\n  mode select\n  where total_amount ?t\n  select ?t\n', '@q query\n  mode select\n  where bucket ?x ?n\n  select ?x ?n\n', '@q query\n  mode select\n  where top ?z ?m\n  select ?z ?m\n');
  }
  return {knowledge: out.join('\n'), queries};
}

const norm = p => JSON.stringify({status: p.status, complete: p.complete, count: p.count, bound: p.bound, reason: p.reason, rows: (p.rows ?? []).map(x => JSON.stringify(Object.entries(x).sort())).sort()});

function run(fn, knowledge, query, opts = {}) {
  try { return fn({theory: {knowledge}, query}, {}, {conditional: false, ...opts}); } catch (e) { if (e instanceof NotExpressibleError) return {skipped: e.message}; return {error: e}; }
}

const ENGINES = [
  ['datalog-e10', datalogE10, [{}, {pushdown: false}], true],
  ['datalog-soplab', datalogSoplab, [{}], true],
  ['datalog-souffle', datalogSouffle, [{}, {pushdown: false}, {magic: true}], souffleOk]
];

function differential({seeds, numeric, perSeed}) {
  const tally = {checked: 0, skipped: 0, byEngine: {}};
  for (const seed of seeds) {
    const {knowledge, queries} = generate(seed, numeric);
    for (const query of queries.slice(0, perSeed)) {
      let want;
      try { want = oracle({theory: {knowledge}, query}, {}); } catch (e) { continue; } // an invalid random program (unsafe or not stratified) is not a test
      for (const [name, strategy, optionSets, available] of ENGINES) {
        if (!available) continue;
        for (const opts of optionSets) {
          const got = run(strategy.ask, knowledge, query, opts);
          tally.byEngine[name] ??= {checked: 0, skipped: 0};
          if (got.skipped) { tally.skipped++; tally.byEngine[name].skipped++; continue; }
          assert.ok(!got.error, `${name} ${JSON.stringify(opts)} seed ${seed} threw ${got.error?.message}\n${knowledge}\n${query}`);
          tally.checked++; tally.byEngine[name].checked++;
          assert.equal(norm(got), norm(want), `${name} ${JSON.stringify(opts)} disagrees with the oracle (seed ${seed})\n${knowledge}\n${query}\nengine ${norm(got)}\noracle ${norm(want)}`);
        }
      }
    }
  }
  if (process.env.DIFF_VERBOSE) console.log(JSON.stringify(tally));
  return tally;
}

test('the Datalog strategies agree with the oracle on random relational programs', () => {
  const t = differential({seeds: Array.from({length: Number(process.env.DIFF_SEEDS ?? 40)}, (_, i) => 1000 + i), numeric: false, perSeed: 8});
  for (const [name, v] of Object.entries(t.byEngine)) assert.ok(v.checked > 20, `${name} was checked on ${v.checked} answers only`);
});

test('the Datalog strategies agree with the oracle on random programs with arithmetic and aggregates', () => {
  const t = differential({seeds: Array.from({length: Math.ceil(Number(process.env.DIFF_SEEDS ?? 40) / 2)}, (_, i) => 2000 + i), numeric: true, perSeed: 12});
  assert.ok(t.checked > 20);
});
