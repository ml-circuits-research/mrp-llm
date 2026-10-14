/**
 * Provenance: `used`, `proof` and `explain` from the finished relation tables, by backward chaining with SQL point queries.
 *
 * Every stored tuple carries `rk`, the derivation counter at which it first appeared (0 for a stored fact). One derivation of a tuple is
 * a rule instance whose positive premises ALL have a smaller `rk`, so the premise graph is acyclic (a tuple of a cycle cannot justify
 * itself). For a tuple of a relation, each rule with that head is tried with the head arguments bound as named parameters; the first
 * binding found gives the premise tuples, which are proved the same way. The nodes have the shape of the oracle's `support.mjs`
 * (`{neg, p, args, kind, ref, ruleId, premises, binding}`; an `absent` premise is a marker), so `usedOf`-style sets, the proof DAG and the
 * explanation are the same objects the oracle returns:
 *
 *   used   ONE sufficient support set: the leaves of one proof plus the rules, defaults and aggregates applied; `used_incomplete` when the
 *          proof rests on negation as failure (the absence cannot be named as a claim), on a count, an `every` or a closed refutation;
 *   proof  the minimal DAG of section 5.3 (explain mode);
 *   explain {depth, uses} (explain mode).
 *
 * An aggregate tuple has all member rows as premises (one query over the `over` group with the group bound). Proof building is bounded
 * (rows and nodes); beyond the bound the packet says `used_incomplete`, never an invented claim.
 */
import {isVarTerm} from '../js-reference/values.mjs';
import {proofOf, explainOf} from '../js-reference/support.mjs';
import {compileLeaves} from './compile.mjs';
import {tbl, storedTbl, colsOf, width} from './schema.mjs';
import {fromScaled} from '../solver-common/fixed-point.mjs';

const MAX_ROWS = 2000;
const key = (neg, p, args) => `${neg ? 'n' : 'p'}|${p}|${JSON.stringify(args)}`;

class Overflow extends Error {}

export class Prover {
  constructor({session, program, kinds, facts, maxNodes = 20_000, refFor = null}) {
    this.maxNodes = maxNodes;
    this.refFor = refFor;
    this.session = session;
    this.codec = session.codec;
    this.program = program;
    this.ctx = {codec: session.codec, kinds};
    this.facts = facts;
    this.nodes = new Map();
    this.pending = [];
    this.factIndex = null;
    this.stmts = new Map();
    this.byHead = new Map();
    for (const rule of program.rules) {
      const k = `${rule.head.p}/${rule.head.args.length}/${rule.head.neg}`;
      if (!this.byHead.has(k)) this.byHead.set(k, []);
      this.byHead.get(k).push({rule});
    }
    this.aggByHead = new Map();
    for (const agg of program.aggregates) {
      const k = `${agg.yields.p}/${agg.yields.args.length}`;
      if (!this.aggByHead.has(k)) this.aggByHead.set(k, []);
      this.aggByHead.get(k).push(agg);
    }
  }

  index() {
    if (this.factIndex) return this.factIndex;
    this.factIndex = new Map();
    for (const f of this.facts) { const k = key(f.neg, f.p, f.args); if (!this.factIndex.has(k)) this.factIndex.set(k, f); }
    return this.factIndex;
  }

  /** The node of a stored tuple (a shell until `settle` fills its premises). */
  node(neg, p, args, rk = null) {
    const k = key(neg, p, args);
    let n = this.nodes.get(k);
    if (n) return n;
    if (this.nodes.size >= this.maxNodes) throw new Overflow('nodes');
    n = {neg, p, args, kind: null, ref: null, premises: [], rk};
    this.nodes.set(k, n);
    this.pending.push(n);
    return n;
  }

  /** The node of ONE stored fact (start_of and end_of read the validity of a particular fact, not of a tuple). */
  storedFact(index) {
    const k = `fact#${index}`;
    let n = this.nodes.get(k);
    if (n) return n;
    const f = this.facts[index];
    n = {neg: false, p: f.p, args: f.args, kind: 'fact', ref: f.claim, factId: f.id, status: f.status, speaker: f.speaker ?? null, premises: [], rk: 0};
    this.nodes.set(k, n);
    return n;
  }

  settle() {
    while (this.pending.length) this.fill(this.pending.pop());
  }

  rkOf(n) {
    if (n.rk !== null) return n.rk;
    const cols = colsOf(n.args.length);
    const row = this.session.get(`SELECT rk FROM ${tbl(n.p, n.args.length, n.neg)} WHERE ${cols.map((c, i) => `${c} = :a${i}`).join(' AND ')}`, this.params(n.args.length === 0 ? [1] : n.args));
    n.rk = row ? Number(row.rk) : null;
    return n.rk;
  }

  params(values, extra = {}) {
    const out = {...extra};
    values.forEach((v, i) => { out[`a${i}`] = this.codec.bind(v); });
    return out;
  }

  fill(n) {
    const rk = this.rkOf(n);
    const fact = this.index().get(key(n.neg, n.p, n.args));
    if (rk === 0 || (rk === null && fact)) {
      Object.assign(n, {kind: 'fact', ref: fact?.claim ?? this.refFor?.(this.session, n.neg, n.p, n.args) ?? null, factId: fact?.id, status: fact?.status, speaker: fact?.speaker ?? null, premises: []});
      return;
    }
    const arity = n.args.length;
    for (const {rule} of this.byHead.get(`${n.p}/${arity}/${n.neg}`) ?? []) {
      for (let ai = 0; ai < rule.alts.length; ai++) {
        const found = this.derive(rule, ai, n, rk);
        if (found) { Object.assign(n, {kind: 'rule', ref: rule.source, ruleId: rule.id, premises: found.premises, binding: found.binding}); return; }
      }
    }
    if (!n.neg) for (const agg of this.aggByHead.get(`${n.p}/${arity}`) ?? []) {
      const found = this.members(agg, n);
      if (found) { Object.assign(n, {kind: 'aggregate', ref: agg.source, ruleId: agg.id, premises: found.premises, binding: found.binding}); return; }
    }
    n.kind = 'unproved'; // cannot happen on a finished closure; the packet then reports used_incomplete
    n.unproved = true;
  }

  /** Bind head arguments to a tuple; null when a constant or a repeated variable disagrees. */
  unify(args, values) {
    const env = new Map();
    for (let i = 0; i < args.length; i++) {
      const a = args[i], v = values[i];
      if (!isVarTerm(a)) { if (a !== v) return null; } else if (env.has(a.var)) { if (env.get(a.var) !== v) return null; } else env.set(a.var, v);
    }
    return env;
  }

  /** Premise columns of a body: for every positive/not atom and start_of leaf its tuple and rk, for absent leaves its bound arguments. */
  premiseSelect(body, leaves) {
    const cols = [], plan = [];
    leaves.forEach((l, idx) => {
      if (l.kind === 'atom' && l.mode !== 'absent') {
        const alias = body.aliasOf.get(idx), arity = l.args.length;
        const names = colsOf(arity).map((c, i) => `${alias}.${c} AS q${idx}_${i}`);
        cols.push(...names, `${alias}.rk AS q${idx}_rk`);
        plan.push({idx, kind: 'atom', p: l.p, arity, neg: l.mode === 'not'});
      } else if (l.kind === 'timeof') {
        const alias = body.aliasOf.get(idx), arity = l.args.length;
        cols.push(...colsOf(arity).map((c, i) => `${alias}.${c} AS q${idx}_${i}`), `${alias}.fid AS q${idx}_fid`);
        plan.push({idx, kind: 'timeof', p: l.p, arity});
      } else if (l.kind === 'atom') {
        const exprs = l.args.map(a => (isVarTerm(a) ? body.bind.get(a.var).expr : this.codec.lit(a)));
        cols.push(...exprs.map((e, i) => `${e} AS q${idx}_${i}`));
        plan.push({idx, kind: 'absent', p: l.p, arity: l.args.length});
      }
    });
    const vars = [...body.bind.keys()].filter(v => !v.startsWith('?fx')); // ?fx... are the helper variables of the fixed-point rewriting
    cols.push(...vars.map((v, i) => `${body.bind.get(v).expr} AS bv${i}`));
    return {cols, plan, vars};
  }

  premisesOf(row, plan, atoms) {
    const premises = [];
    for (const s of plan) {
      const vals = Array.from({length: s.arity}, (_, i) => this.codec.decode(row[`q${s.idx}_${i}`]));
      if (s.kind === 'absent') premises.push({absent: {p: s.p, args: s.arity === 0 ? [] : vals}});
      else if (s.kind === 'timeof') premises.push(this.storedFact(Number(row[`q${s.idx}_fid`])));
      else premises.push(this.node(s.neg, s.p, s.arity === 0 ? [] : vals, Number(row[`q${s.idx}_rk`])));
    }
    return premises;
  }

  derive(rule, ai, n, rk) {
    const alt = rule.alts[ai];
    const env = this.unify(rule.head.args, n.args);
    if (!env) return null;
    const skey = `${rule.id}/${ai}`;
    let st = this.stmts.get(skey);
    if (!st) {
      const vars = [...new Set(rule.head.args.filter(isVarTerm).map(a => a.var))];
      const initial = new Map(vars.map((v, i) => [v, {expr: `:h${i}`, nat: this.codec.native(`:h${i}`), kind: 'any'}]));
      const body = compileLeaves(alt.leaves, this.ctx, {initial});
      const {cols, plan, vars: bvars} = this.premiseSelect(body, alt.leaves);
      const rkTerms = alt.leaves.flatMap((l, idx) => (l.kind === 'atom' && l.mode !== 'absent' ? [`${body.aliasOf.get(idx)}.rk < :hrk`] : []));
      const sql = `SELECT ${cols.join(', ') || '1 AS one'} ${body.fromSql()} WHERE ${[...body.where, ...rkTerms].join(' AND ') || '1'} LIMIT 1`;
      st = {sql, vars, plan, bvars, usesRk: rkTerms.length > 0};
      this.stmts.set(skey, st);
    }
    const params = st.usesRk ? {hrk: BigInt(rk)} : {};
    st.vars.forEach((v, i) => { params[`h${i}`] = this.codec.bind(env.get(v)); });
    const row = this.session.get(st.sql, params);
    if (!row) return null;
    return {premises: this.premisesOf(row, st.plan), binding: this.bindingOf(row, st.bvars)};
  }

  bindingOf(row, vars) {
    return Object.fromEntries(vars.map((v, i) => [v, this.codec.decode(row[`bv${i}`])]));
  }

  /** An aggregate tuple rests on every member row of its group. */
  members(agg, n) {
    const env = new Map();
    const args = agg.yields.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!isVarTerm(a)) { if (a !== n.args[i]) return null; } else if (a.var !== agg.out) env.set(a.var, n.args[i]);
    }
    const premises = [];
    const initial = new Map([...env].map(([v, val], i) => [v, {expr: `:g${i}`, nat: this.codec.native(`:g${i}`), kind: 'any'}]));
    const params = {};
    [...env.values()].forEach((val, i) => { params[`g${i}`] = this.codec.bind(val); });
    let any = false;
    agg.alts.forEach((alt, ai) => {
      const skey = `agg:${agg.id}/${ai}`;
      let st = this.stmts.get(skey);
      if (!st) {
        const body = compileLeaves(alt.leaves, this.ctx, {initial});
        const {cols, plan} = this.premiseSelect(body, alt.leaves);
        st = {sql: `SELECT ${cols.join(', ') || '1 AS one'} ${body.fromSql()} WHERE ${body.where.join(' AND ') || '1'}`, plan};
        this.stmts.set(skey, st);
      }
      for (const row of this.session.all(st.sql, params)) { any = true; premises.push(...this.premisesOf(row, st.plan)); }
    });
    return any ? {premises: [...new Set(premises.filter(p => p.absent === undefined))], binding: Object.fromEntries([...env])} : null;
  }

  /** One binding of a query alternative for a row of the answer: the premises of the first binding found. */
  rowPremises(qp, row, {nonConflicted = false} = {}) {
    for (let ai = 0; ai < qp.alts.length; ai++) {
      const alt = qp.alts[ai];
      const names = qp.projection.map(v => v);
      const skey = `q:${qp.wireId}/${ai}/${nonConflicted}`;
      let st = this.stmts.get(skey);
      if (!st) {
        const initial = new Map(names.map((v, i) => [v, {expr: `:r${i}`, nat: this.codec.native(`:r${i}`), kind: 'any'}]));
        const body = compileLeaves(alt.leaves, this.ctx, {initial});
        const {cols, plan} = this.premiseSelect(body, alt.leaves);
        st = {sql: `SELECT ${cols.join(', ') || '1 AS one'} ${body.fromSql()} WHERE ${body.where.join(' AND ') || '1'} LIMIT 1`, plan};
        this.stmts.set(skey, st);
      }
      const params = {};
      names.forEach((v, i) => { const x = row[v.replace(/^\?/, '')]; params[`r${i}`] = x === undefined ? null : this.codec.bind(x); });
      const r = this.session.get(st.sql, params);
      if (r) return this.premisesOf(r, st.plan);
    }
    return null;
  }

  /** The opposite evidence that makes a row `both`: for each positive leaf its N tuple, for each `not` leaf its P tuple (when stored). */
  conflictNodes(premises) {
    const out = [];
    for (const p of premises) {
      if (isMarker(p)) continue;
      const opp = this.tupleNode(!p.neg, p.p, p.args);
      if (opp) out.push(opp);
    }
    return out;
  }

  /** Does the stored relation hold this ground tuple? Returns its node. */
  tupleNode(neg, p, args) {
    const cols = colsOf(args.length);
    const row = this.session.get(`SELECT rk FROM ${tbl(p, args.length, neg)} WHERE ${cols.map((c, i) => `${c} = :a${i}`).join(' AND ')}`, this.params(args.length === 0 ? [1] : args));
    return row ? this.node(neg, p, args, Number(row.rk)) : null;
  }
}

const isMarker = p => p && p.absent !== undefined;

/** Leaves of one proof, iteratively (a proof can be thousands of rules deep): the claims applied and whether the proof rests on absence. */
function usedOfIter(roots) {
  const seen = new Set(), claims = new Map();
  let incomplete = false;
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    if (isMarker(n)) { incomplete = true; continue; }
    if (n.unproved) incomplete = true;
    if (n.ref) claims.set(`${n.ref.id}@${n.ref.version}`, {id: n.ref.id, version: n.ref.version});
    for (const p of n.premises ?? []) { if (isMarker(p)) incomplete = true; else stack.push(p); }
  }
  return {used: [...claims.values()], used_incomplete: incomplete};
}

/** Build the support fields of a single-instant answer: used, used_incomplete, and for `explain` the proof and the explanation. */
export function supportOf({session, program, qp, kinds, outcome, facts, maxNodes, refFor, fx = null}) {
  if (!outcome || !['supported', 'refuted', 'both'].includes(outcome.status)) return {fields: {used: []}};
  if (qp.forms && (qp.forms.rank || qp.forms.compares.length || qp.forms.filters.length)) return {fields: {used: [], used_incomplete: true}};
  const prover = new Prover({session, program, kinds, facts, maxNodes, refFor});
  let truncated = false;
  let roots = [];
  try {
    if (outcome.rows?.length && ['select', 'explain'].includes(qp.mode)) {
      const rows = qp.mode === 'select' ? outcome.rows : [outcome.rows.find(r => !r.both) ?? outcome.rows[0]];
      if (rows.length > MAX_ROWS) truncated = true;
      for (const r of rows.slice(0, MAX_ROWS)) {
        const prem = prover.rowPremises(qp, r.row);
        if (prem) roots.push(...prem, ...(r.both ? prover.conflictNodes(prem) : []));
        else truncated = true;
      }
    } else if (qp.mode === 'exists' && outcome.rows?.length) {
      const prem = prover.rowPremises(qp, outcome.rows[0].row);
      if (prem) roots.push(...prem, ...(outcome.rows[0].both ? prover.conflictNodes(prem) : [])); else truncated = true;
    } else if (outcome.refutedByNoRows) {
      for (const alt of qp.alts) for (const l of alt.leaves) {
        if (l.kind !== 'atom' || l.args.some(isVarTerm)) continue;
        const neg = l.mode === 'pos';
        const node = prover.tupleNode(neg, l.p, fx ? l.args.map(a => fromScaled(a, fx.scale)) : l.args);
        if (node) roots.push(node);
      }
      truncated = false;
    }
    prover.settle();
  } catch (e) {
    if (!(e instanceof Overflow)) throw e;
    truncated = true;
  }
  const {used, used_incomplete} = usedOfIter(roots);
  const incomplete = used_incomplete || outcome.supportIncomplete || truncated || (outcome.refutedByNoRows && !roots.length);
  const fields = {used, ...(incomplete ? {used_incomplete: true} : {})};
  if (qp.mode === 'explain' && outcome.rows?.length && !truncated) {
    const first = outcome.rows.find(r => !r.both) ?? outcome.rows[0];
    const firstRoots = prover.rowPremises(qp, first.row)?.filter(p => !isMarker(p)) ?? [];
    prover.settle();
    fields.explain = explainOf(firstRoots);
    fields.proof = proofOf(firstRoots);
  }
  return {fields};
}
