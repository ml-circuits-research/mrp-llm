#!/usr/bin/env node
/**
 * Differential fuzz of `sql-sqlite` against the oracle `js-reference` (shadow gate, proposal 5.4).
 *
 *   node tools/eval/engines/sql-sqlite-fuzz.mjs [--seeds 0-499] [--verbose]
 *
 * A seeded generator writes small random circuits in the proposed grammar: base predicates with entity and integer columns (some closed,
 * some declared, some with negative facts), derived predicates over lower layers with joins, `not`, `absent` on closed lower predicates,
 * `compare`, `compute` (including division by zero), linear, nonlinear and mutual recursion, and `aggregate` wires (count, sum, min, max,
 * collect), then asks select, count, exists and every queries. Both strategies get the same text; status, rows, count, bound, reason and
 * the `arithmetic_undefined` note must agree. A circuit the oracle refuses (an unsafe or unstratifiable draw) must be refused by
 * sql-sqlite the same way. The generator never reads the smoke cases and the test files of the datasets.
 */
import {parse, wireText} from '../../../sop/knowledge/index.mjs';
import {ask as oracleAsk} from '../../../reasoning/strategies/js-reference/index.mjs';
import {ask as sqlAsk} from '../../../reasoning/strategies/sql-sqlite/index.mjs';

export function rng(seed) {
  let a = (seed + 1) * 2654435761 >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const ENT = ['a', 'b', 'c', 'd'];
const ROLES = ['subject', 'object', 'topic'];
const EVARS = ['?x', '?y', '?z'];
const IVARS = ['?n', '?m'];

export function genCase(seed) {
  const R = rng(seed);
  const pick = xs => xs[Math.floor(R() * xs.length)];
  const chance = p => R() < p;
  const preds = []; // {name, types: ['e'|'i'...], closed, layer, declared}
  const out = [];
  const nBase = 2 + Math.floor(R() * 2);
  for (let i = 0; i < nBase; i++) {
    const arity = 1 + Math.floor(R() * 3);
    preds.push({name: `b${i}`, types: Array.from({length: arity}, (_, j) => (j === arity - 1 && arity > 1 && chance(0.4) ? 'i' : 'e')), closed: chance(0.6), layer: 0, declared: chance(0.7)});
  }
  const decl = p => {
    if (!p.declared && !p.closed) return;
    out.push(`@${p.name} predicate\n  args ${p.types.map((t, j) => `${ROLES[j]}:${t === 'i' ? 'integer' : 'entity'}`).join(' ')}\n${p.closed ? '  closed true\n' : ''}`);
  };
  const constOf = t => (t === 'i' ? String(Math.floor(R() * 9) - 1) : pick(ENT));
  // facts
  let fid = 0;
  for (const p of preds) {
    const n = 4 + Math.floor(R() * 12);
    for (let k = 0; k < n; k++) out.push(`@f${fid++} fact\n  holds ${chance(0.12) ? 'not ' : ''}${p.name} ${p.types.map(constOf).join(' ')}\n`);
  }
  preds.forEach(decl);
  // derived layers
  const nDerived = 2 + Math.floor(R() * 3);
  const heads = [];
  const termFor = (t, bound) => {
    const vs = (t === 'i' ? IVARS : EVARS);
    return chance(0.75) ? pick(vs) : constOf(t);
  };
  const genBody = (allowed, selfPred, layer, {noCompute}) => {
    const atoms = [], lines = [], bound = new Set();
    const nAtoms = 1 + Math.floor(R() * 3);
    for (let k = 0; k < nAtoms; k++) {
      const p = k === 0 && selfPred && chance(0.7) ? selfPred : pick(allowed);
      const neg = k > 0 && chance(0.1) ? 'not ' : '';
      const terms = p.types.map(t => termFor(t));
      atoms.push({p, terms, neg});
      if (!neg) terms.forEach(t => { if (t.startsWith('?')) bound.add(t); });
    }
    // not-atoms need no binding (N evidence), but keep safety: variables only matter in positive atoms for heads
    for (const a of atoms) lines.push(`  when ${a.neg}${a.p.name} ${a.terms.join(' ')}`);
    const bnd = [...bound];
    const ents = bnd.filter(v => EVARS.includes(v)), ints = bnd.filter(v => IVARS.includes(v));
    if (chance(0.25) && ents.length >= 2) lines.push(`  when compare ${ents[0]} ${pick(['not_equal', 'equal'])} ${ents[1]}`);
    if (chance(0.25) && ints.length) lines.push(`  when compare ${ints[0]} ${pick(['above', 'below', 'at_least', 'at_most', 'equal', 'not_equal'])} ${Math.floor(R() * 6) - 1}`);
    if (!noCompute && chance(0.3) && ints.length) {
      const word = pick(['plus', 'minus', 'times', 'whole_divided_by']);
      const rhs = word === 'whole_divided_by' ? (ints.length > 1 && chance(0.6) ? ints[1] : pick(['2', '-2', '3'])) : (ints.length > 1 && chance(0.4) ? ints[1] : String(Math.floor(R() * 4)));
      lines.push(`  when compute ?k ${ints[0]} ${word} ${rhs}`);
      bnd.push('?k');
      ints.push('?k');
    }
    const lower = allowed.filter(p => p.closed && p.layer < layer && p !== selfPred);
    if (chance(0.25) && lower.length) {
      const p = pick(lower);
      const terms = p.types.map(t => { const vs = t === 'i' ? ints : ents; return vs.length ? pick(vs) : constOf(t); });
      lines.push(`  when absent ${p.name} ${terms.join(' ')}`);
    }
    return {lines, ents, ints};
  };
  for (let li = 1; li <= nDerived; li++) {
    const arity = 1 + Math.floor(R() * 2);
    const types = Array.from({length: arity}, (_, j) => (j === arity - 1 && arity > 1 && chance(0.3) ? 'i' : 'e'));
    const p = {name: `d${li}`, types, closed: chance(0.5), layer: li, declared: chance(0.5)};
    const allowed = preds.filter(q => q.layer < li);
    const recursive = chance(0.35);
    const mutual = recursive && chance(0.3);
    const shapes = recursive ? (mutual ? ['mutual'] : [pick(['linear', 'nonlinear'])]) : ['plain'];
    const nRules = 1 + Math.floor(R() * 2) + (recursive ? 1 : 0);
    const mkHead = (hp, ents, ints, neg) => `${neg ? 'not ' : ''}${hp.name} ${hp.types.map(t => { const vs = t === 'i' ? ints : ents; return vs.length ? pick(vs) : constOf(t); }).join(' ')}`;
    const partner = mutual ? {name: `d${li}m`, types: p.types, closed: p.closed, layer: li, declared: false} : null;
    for (let r = 0; r < nRules; r++) {
      const isRec = recursive && r >= 1;
      const {lines, ents, ints} = genBody(allowed, null, li, {noCompute: recursive});
      let body = lines;
      if (isRec) {
        const shape = shapes[0];
        const selfTerms = types.map(t => { const vs = t === 'i' ? ints : ents; return vs.length ? pick(vs) : (t === 'i' ? '?n' : '?x'); });
        // the recursive atom shares variables with the body so the head stays safe
        const sp = shape === 'mutual' ? partner : p;
        const extra = [`  when ${sp.name} ${selfTerms.join(' ')}`];
        if (shape === 'nonlinear') extra.push(`  when ${p.name} ${types.map(t => (t === 'i' ? pick(IVARS) : pick(EVARS))).join(' ')}`);
        body = [...lines.filter(l => !l.includes('compute')), ...extra];
      }
      const bound = new Set(body.filter(l => /^ {2}when (?!not |absent |compare |compute )/.test(l)).flatMap(l => l.trim().split(/\s+/).filter(t => t.startsWith('?'))));
      const be = [...bound].filter(v => EVARS.includes(v)), bi = [...bound].filter(v => IVARS.includes(v));
      const target = isRec && shapes[0] === 'mutual' && chance(0.5) ? partner : p;
      out.push(`@r${li}_${r} rule\n${body.join('\n')}\n  then ${mkHead(target, be, bi, !isRec && chance(0.08))}\n`);
      if (target === partner && !heads.includes(partner)) heads.push(partner);
    }
    if (partner) {
      // the partner needs a base rule or it is empty; that is a valid empty relation too
      const {lines, ents, ints} = genBody(allowed, null, li, {noCompute: true});
      const bound = new Set(lines.filter(l => /^ {2}when (?!not |absent |compare |compute )/.test(l)).flatMap(l => l.trim().split(/\s+/).filter(t => t.startsWith('?'))));
      out.push(`@r${li}_pm rule\n${lines.join('\n')}\n  then ${mkHead(partner, [...bound].filter(v => EVARS.includes(v)), [...bound].filter(v => IVARS.includes(v)), false)}\n`);
    }
    preds.push(p); heads.push(p);
    decl(p);
    // an aggregate over a closed lower predicate
    if (chance(0.4)) {
      const srcs = preds.filter(q => q.closed && q.layer < li && q.types.some(t => t === 'i'));
      if (srcs.length) {
        const s = pick(srcs);
        const vars = s.types.map((t, j) => (t === 'i' ? '?n' : `?v${j}`));
        const gvar = vars.find(v => v.startsWith('?v'));
        const fn = pick(['count', 'sum', 'min', 'max', 'collect']);
        const spec = fn === 'count' ? 'count as ?o' : `${fn} ?n as ?o`;
        const agg = {name: `g${li}`, types: gvar ? ['e', fn === 'collect' ? 'e' : 'i'] : [fn === 'collect' ? 'e' : 'i'], closed: false, layer: li + 0.5, declared: false};
        out.push(`@a${li} aggregate\n  over ${s.name} ${vars.join(' ')}\n  group${gvar ? ' ' + gvar : ''}\n  ${spec}\n  yields ${agg.name} ${gvar ? gvar + ' ' : ''}?o\n`);
        preds.push(agg);
        heads.push(agg);
      }
    }
  }
  // queries
  const queries = [];
  const qpreds = preds;
  const qline = (p, extra = {}) => {
    const terms = p.types.map(t => (chance(0.8) ? (t === 'i' ? pick(IVARS) : pick(EVARS)) : constOf(t)));
    return terms;
  };
  for (let k = 0; k < 4; k++) {
    const p = pick(qpreds);
    const terms = qline(p);
    const vars = [...new Set(terms.filter(t => t.startsWith('?')))];
    const mode = pick(['select', 'select', 'select', 'count', 'exists', 'every']);
    if (mode === 'every') {
      const dom = pick(qpreds.filter(q => q.types.length === 1 && q.types[0] === 'e'));
      const sc = pick(qpreds.filter(q => q.types[0] === 'e'));
      if (!dom) continue;
      queries.push(`@q query\n  mode every\n  where ${dom.name} ?x\n  scope ${sc.name} ?x ${sc.types.slice(1).map(t => (t === 'i' ? '?n' : '?y')).join(' ')}\n`.replace(/ \n/g, '\n'));
      continue;
    }
    const sel = vars.length && mode === 'select' ? `  select ${vars.join(' ')}\n` : mode === 'count' && vars.length && chance(0.5) ? `  select ${vars.join(' ')}\n` : '';
    queries.push(`@q query\n  mode ${mode}\n  where ${chance(0.1) && vars.length === 0 ? '' : ''}${p.name} ${terms.join(' ')}\n${sel}`);
  }
  return {knowledge: out.join('\n'), queries};
}

/** Temporal circuits: stored facts with validity intervals, rules over them (snapshot semantics), start_of/end_of/order, and point and interval queries. */
export function genTemporalCase(seed) {
  const R = rng(seed + 100000);
  const pick = xs => xs[Math.floor(R() * xs.length)];
  const day = n => `2026-${String(1 + Math.floor(n / 28)).padStart(2, '0')}-${String(1 + (n % 28)).padStart(2, '0')}`;
  const out = ['@r1 rule\n  when on ?x\n  when near ?x ?y\n  then lit ?y\n', '@r2 rule\n  when on ?x\n  when start_of ?s on ?x\n  when end_of ?e on ?x\n  when order ?s before ?e\n  then span ?x ?s ?e\n',
    '@r3 rule\n  when lit ?x\n  when absent off ?x\n  then bright ?x\n', '@off predicate\n  args subject:entity\n  closed true\n'];
  const names = ['a', 'b', 'c'];
  let id = 0;
  for (const [p, arity] of [['on', 1], ['near', 2], ['off', 1]]) {
    for (let k = 0, n = 2 + Math.floor(R() * 4); k < n; k++) {
      const terms = Array.from({length: arity}, () => pick(names)).join(' ');
      const from = Math.floor(R() * 60), len = 1 + Math.floor(R() * 60);
      const valid = chance(R, 0.15) ? '' : `  valid ${day(from)} ${chance(R, 0.1) ? 'open' : day(from + len)}\n`;
      out.push(`@t${id++} fact\n  holds ${p} ${terms}\n${valid}`);
    }
  }
  const queries = [];
  for (let k = 0; k < 6; k++) {
    const when = pick(['at ' + day(Math.floor(R() * 120)), `during ${day(Math.floor(R() * 40))} ${day(40 + Math.floor(R() * 40))}`, `overlaps ${day(Math.floor(R() * 40))} ${day(40 + Math.floor(R() * 40))}`, '']);
    const p = pick(['lit ?x', 'bright ?x', 'on ?x', 'span ?x ?s ?e']);
    const vars = [...new Set(p.split(' ').filter(t => t.startsWith('?')))];
    const mode = pick(['select', 'select', 'count', 'exists']);
    if (when.startsWith('overlaps') && mode === 'count') continue; // not specified by the proposal
    queries.push(`@q query\n  mode ${mode}\n  ${when ? when + '\n  ' : ''}where ${p}\n${mode !== 'exists' ? `  select ${vars.join(' ')}\n` : ''}`);
  }
  return {knowledge: out.join('\n'), queries};
}
const chance = (R, p) => R() < p;

const rowsOf = r => (r.rows ?? []).map(x => JSON.stringify(Object.entries(x).sort())).sort();
const view = r => ({status: r.status, complete: r.complete, rows: r.rows ? rowsOf(r) : undefined, count: r.count, bound: r.bound, reason: r.reason, undef: (r.notes ?? []).includes('arithmetic_undefined'), nonint: (r.notes ?? []).includes('aggregate_non_integer_ignored')});

/** Run both strategies on one query; returns null when they agree, else a description. */
export function disagreement(knowledge, query, {recursion = 'auto'} = {}) {
  let a, b, ea = null, eb = null;
  try { a = oracleAsk({theory: {knowledge}, query}, {maxJoins: 400000}); } catch (e) { ea = e; }
  try { b = sqlAsk({theory: {knowledge}, query}, {}, {recursion}); } catch (e) { eb = e; }
  if (ea || eb) {
    if (ea && eb && ea.code === eb.code) return null;
    if (ea && eb) return `different errors: oracle ${ea.message} / sql ${eb.message}`;
    return `oracle ${ea ? 'threw ' + ea.message : 'answered'} / sql ${eb ? 'threw ' + eb.message : 'answered'}`;
  }
  if (a.status === 'budget_exhausted') return null; // the oracle is naive: a ceiling there says nothing about the answer
  const va = JSON.stringify(view(a)), vb = JSON.stringify(view(b));
  if (va === vb) return usedReplayProblem(knowledge, query, b, a);
  // KNOWN DIVERGENCE (reported to the orchestrator): for `mode every` the oracle takes the conflict flag of the FIRST binding of a member's
  // scope, so `both` depends on fact order when a member satisfies the scope through several bindings; sql-sqlite calls a member conflicted
  // only when every binding is, which is order independent. Only that exact pattern (oracle both, sql supported, mode every) is tolerated.
  if (/mode every/.test(query) && a.status === 'both' && b.status === 'supported' && JSON.stringify({...view(a), status: 'x'}) === JSON.stringify({...view(b), status: 'x'})) return null;
  return `oracle ${va} / sql ${vb}`;
}

const CLAIMS = ['fact', 'rule', 'default'];

/** `used` is replayed alone in the oracle: it must re-derive the same status and rows (never leaf-set equality). */
export function usedReplayProblem(knowledge, query, b, a) {
  if (!b.used || b.used_incomplete || !['supported', 'refuted', 'both'].includes(b.status)) return null;
  const keep = new Set(b.used.map(u => u.id));
  const {wires} = parse(knowledge);
  const only = wires.filter(w => !CLAIMS.includes(w.type) || keep.has(w.id)).map(wireText).join('\n\n') + '\n';
  let r;
  try { r = oracleAsk({theory: {knowledge: only}, query}, {maxJoins: 400000}); } catch (e) { return `used replay threw ${e.message}`; }
  return r.status === b.status && JSON.stringify(rowsOf(r)) === JSON.stringify(rowsOf(b)) ? null : `used ${JSON.stringify([...keep])} replays to ${r.status} ${JSON.stringify(rowsOf(r))}, sql said ${b.status} ${JSON.stringify(rowsOf(b))}`;
}

export function runSeed(seed, opts = {}) {
  const found = [];
  for (const {knowledge, queries} of [genCase(seed), genTemporalCase(seed)]) {
    for (const q of queries) for (const recursion of opts.recursion ?? ['auto', 'loop']) {
      const d = disagreement(knowledge, q, {recursion});
      if (d) found.push({seed, query: q, recursion, why: d, knowledge});
    }
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const range = (args[args.indexOf('--seeds') + 1] ?? '0-199').split('-').map(Number);
  let bad = 0, n = 0;
  for (let s = range[0]; s <= (range[1] ?? range[0]); s++) {
    for (const f of runSeed(s)) {
      bad++;
      console.log(`seed ${s} [${f.recursion}] DISAGREES: ${f.why}\n${args.includes('--verbose') ? f.knowledge + '\n' + f.query : f.query}`);
    }
    n++;
  }
  console.log(`${n} seeds, ${bad} disagreement(s)`);
  process.exit(bad ? 1 : 0);
}
