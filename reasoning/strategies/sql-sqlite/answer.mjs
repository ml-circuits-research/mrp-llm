/**
 * Query modes over the finished relations: select, exists, count, explain, every. The statuses follow the four-valued evidence of the
 * oracle (query.mjs): supported (P only), refuted (N only), both, unknown. A query that finds no row is `refuted` only when evidence
 * or a CLOSED predicate says no instance can exist; otherwise it is `unknown` (open world). A count over a predicate that is not
 * closed is a lower bound; an `every` over an open domain without counterexample is `unknown` (`open_domain`), a counterexample still
 * refutes. All of it runs as SQL over the relation tables; only rows that the packet returns are read into JS.
 *
 * A row is `both` when every binding that produces it also has the opposite evidence for some positive or `not` leaf (the oracle's
 * `conflicted`), computed as an EXISTS over the opposite relation inside the same SELECT.
 */
import {isVarTerm} from '../js-reference/values.mjs';
import {compileLeaves} from './compile.mjs';
import {tbl} from './schema.mjs';
import {evaluateCandidates} from '../js-reference/query.mjs';
import {hasRowForms} from '../js-reference/forms.mjs';

const stripVar = v => v.replace(/^\?/, '');

/** `EXISTS` over a relation for an argument list whose entries are SQL expressions (or `{wild}`), with wildcards equal when repeated. */
function existsOver(p, arity, neg, args) {
  const conds = [];
  const first = new Map();
  args.forEach((a, i) => {
    if (a.expr !== undefined) conds.push(`z.c${i} = ${a.expr}`);
    else if (first.has(a.wild)) conds.push(`z.c${i} = z.c${first.get(a.wild)}`);
    else first.set(a.wild, i);
  });
  return `EXISTS (SELECT 1 FROM ${tbl(p, arity, neg)} AS z${conds.length ? ' WHERE ' + conds.join(' AND ') : ''})`;
}

/** SQL boolean: no possible instance of the leaf exists, by evidence or closure (the oracle's `leafRefuted`). `known`: ?var -> stored SQL expression. */
export function leafRefutedSql(l, known, closed, codec) {
  if (l.kind !== 'atom') return '0';
  const args = l.args.map(a => (!isVarTerm(a) ? {expr: codec.lit(a)} : known.has(a.var) ? {expr: known.get(a.var)} : {wild: a.var}));
  const ground = args.every(a => a.expr !== undefined);
  const arity = l.args.length;
  if (l.mode === 'pos') {
    const byEvidence = ground ? existsOver(l.p, arity, true, args) : '0';
    const byClosure = closed.has(l.p) ? `NOT ${existsOver(l.p, arity, false, args)}` : '0';
    return `(${byEvidence} OR ${byClosure})`;
  }
  return ground ? existsOver(l.p, arity, false, args) : '0'; // `not` needs N but has P; `absent` needs no P but has P
}

/** SQL boolean: the binding has the opposite evidence for some positive or `not` leaf (the oracle's `conflicted`). */
function conflictedSql(alt, body, codec) {
  const parts = [];
  alt.leaves.forEach(l => {
    if (l.kind !== 'atom' || l.mode === 'absent') return;
    const args = l.args.map(a => ({expr: isVarTerm(a) ? body.bind.get(a.var).expr : codec.lit(a)}));
    parts.push(existsOver(l.p, l.args.length, l.mode === 'pos', args));
  });
  return parts.length ? `(${parts.join(' OR ')})` : '0';
}

export class Answerer {
  constructor({session, qp, program, kinds, notes}) {
    Object.assign(this, {session, qp, program, kinds, notes});
    this.codec = session.codec;
    this.ctx = {codec: session.codec, kinds};
  }

  /** Evaluate one view. `needRows` forces rows in every mode (an interval query combines parts by rows). Returns the oracle's outcome shape. */
  evaluate({needRows = false} = {}) {
    const {qp} = this;
    if (qp.mode === 'every') return this.every();
    if (hasRowForms(qp.forms)) return this.forms();
    if (qp.mode === 'count' && !needRows) return this.count();
    if (qp.mode === 'exists' && !needRows) return this.exists();
    return this.select();
  }

  /** One SELECT per alternative: the projection (stored form) and, optionally, the conflict flag. */
  altSelects({conflict}) {
    const {qp, codec} = this;
    return qp.alts.map(alt => {
      const body = compileLeaves(alt.leaves, this.ctx);
      const proj = qp.projection.map(v => body.bind.get(v)?.expr ?? 'NULL'); // an alternative may not bind every variable of the union
      const flag = conflict ? `, CASE WHEN ${conflictedSql(alt, body, codec)} THEN 1 ELSE 0 END AS conflict` : '';
      return `SELECT 0 AS z${proj.map((e, i) => `, ${e} AS p${i}`).join('')}${flag} ${body.fromSql()} WHERE ${[body.tickSql(), ...body.where].join(' AND ')}`;
    });
  }

  select() {
    const {qp, codec} = this;
    const cols = qp.projection.map((_, i) => `p${i}`);
    const sql = `SELECT z${cols.map(c => `, ${c}`).join('')}, MIN(conflict) AS conflict FROM (${this.altSelects({conflict: true}).join(' UNION ALL ')}) GROUP BY z${cols.map(c => `, ${c}`).join('')}`;
    const rows = this.session.all(sql).map(r => ({
      row: Object.fromEntries(qp.projection.map((v, i) => [stripVar(v), r[`p${i}`] === null ? undefined : codec.decode(r[`p${i}`])])),
      both: r.conflict === 1 || r.conflict === 1n, prem: []
    })).sort((a, b) => (JSON.stringify(Object.entries(a.row).sort()) < JSON.stringify(Object.entries(b.row).sort()) ? -1 : 1));
    return this.finish(rows);
  }
  /** SQL computes closure and joins; the oracle decides value forms before projection, preserving hidden ranking variables and ties. */
  forms() {
    const {qp, codec} = this;
    const candidates = [];
    for (const alt of qp.alts) {
      const body = compileLeaves(alt.leaves, this.ctx);
      const vars = [...alt.bound].sort();
      const bindings = vars.map((v, i) => `${body.bind.get(v).expr} AS b${i}`);
      const sql = `SELECT ${[...bindings, `${conflictedSql(alt, body, codec)} AS conflict`].join(', ')} ${body.fromSql()} ${body.whereSql()}`;
      for (const r of this.session.iterate(sql)) {
        candidates.push({
          env: Object.fromEntries(vars.map((v, i) => [v, codec.decode(r[`b${i}`])])),
          both: Boolean(r.conflict), prem: []
        });
      }
      this.session.budget.checkTime();
    }
    const outcome = evaluateCandidates(qp, candidates, {refuted: () => this.refutedNoRows(), refutationRoots: () => []});
    this.session.budget.checkTime();
    // A positive row alone cannot prove a ranking or a comparison-driven refutation; never advertise unverified support.
    outcome.supportIncomplete = true;
    return outcome;
  }

  /** The outcome of the oracle's `evaluatePart` for a list of rows. */
  finish(list) {
    const {qp} = this;
    if (qp.mode === 'count') {
      const exact = qp.domainClosed;
      return {status: list.length || exact ? 'supported' : 'unknown', rows: list, count: list.length, ...(exact ? {} : {bound: 'at_least'}), roots: [], supportIncomplete: true};
    }
    if (list.length) return {status: list.some(r => !r.both) ? 'supported' : 'both', rows: list, roots: [], supportIncomplete: false};
    const refuted = this.refutedNoRows();
    return {status: refuted ? 'refuted' : 'unknown', rows: [], roots: [], supportIncomplete: false, refutedByNoRows: refuted};
  }

  /** No row: refuted iff every alternative has a leaf with no possible instance (evidence or closed predicate). */
  refutedNoRows() {
    const {qp, codec} = this;
    const known = new Map();
    const alts = qp.alts.map(alt => alt.leaves.map(l => leafRefutedSql(l, known, qp.closed, codec)).join(' OR ') || '0');
    return Boolean(this.session.get(`SELECT (${alts.map(a => `(${a})`).join(' AND ')}) AS r`).r);
  }

  count() {
    const {qp} = this;
    const inner = this.altSelects({conflict: false}).join(' UNION ');
    const n = Number(this.session.get(`SELECT COUNT(*) AS n FROM (${inner})`).n);
    const exact = qp.domainClosed;
    return {status: n || exact ? 'supported' : 'unknown', rows: [], count: n, ...(exact ? {} : {bound: 'at_least'}), roots: [], supportIncomplete: true};
  }

  exists() {
    const {qp, codec} = this;
    const sel = this.altSelects({conflict: true}).join(' UNION ALL ');
    const one = r => ({row: Object.fromEntries(qp.projection.map((v, i) => [stripVar(v), r[`p${i}`] === null ? undefined : codec.decode(r[`p${i}`])])), both: r.conflict === 1, prem: []});
    const nonConflicted = this.session.get(`SELECT * FROM (${sel}) WHERE conflict = 0 LIMIT 1`);
    if (nonConflicted) return {status: 'supported', rows: [one(nonConflicted)], roots: [], supportIncomplete: false};
    const any = this.session.get(`SELECT * FROM (${sel}) LIMIT 1`);
    if (any) return {status: 'both', rows: [one(any)], roots: [], supportIncomplete: false};
    const refuted = this.refutedNoRows();
    return {status: refuted ? 'refuted' : 'unknown', rows: [], roots: [], supportIncomplete: false, refutedByNoRows: refuted};
  }

  /** `every`: the domain is the `where` part, the scope must hold for each member. Counterexample refutes, an open domain gives unknown. */
  every() {
    const {qp, codec} = this;
    let counter = false, failing = 0, conflicts = 0;
    for (const alt of qp.alts) {
      const dom = compileLeaves(alt.leaves, this.ctx);
      const vars = [...alt.bound].sort();
      const domSql = `SELECT DISTINCT ${vars.length ? vars.map((v, i) => `${dom.bind.get(v).expr} AS d${i}`).join(', ') : '1 AS dz'} ${dom.fromSql()} WHERE ${[dom.tickSql(), ...dom.where].join(' AND ')}`;
      const known = new Map(vars.map((v, i) => [v, `m.d${i}`]));
      const holdsOf = [], conflictFree = [], refutedOf = [];
      for (const sc of qp.scopeAlts) {
        const body = compileLeaves(sc.leaves, this.ctx, {initial: new Map(vars.map((v, i) => [v, {expr: `m.d${i}`, nat: codec.native(`m.d${i}`), kind: 'any'}]))});
        const sub = `SELECT 1 ${body.fromSql()}${body.where.length ? ' WHERE ' + body.where.join(' AND ') : ''}`;
        holdsOf.push(`EXISTS (${sub})`);
        const confl = conflictedSql(sc, body, codec);
        conflictFree.push(`EXISTS (${sub}${body.where.length ? ' AND ' : ' WHERE '}NOT ${confl})`);
        refutedOf.push(`(${sc.leaves.map(l => leafRefutedSql(l, known, qp.closed, codec)).join(' OR ') || '0'})`);
      }
      const holds = holdsOf.join(' OR ') || '0';
      const sql = `SELECT COALESCE(SUM(CASE WHEN ${holds} THEN 0 ELSE 1 END), 0) AS failing, ` +
        `COALESCE(SUM(CASE WHEN ${holds} THEN 0 WHEN ${refutedOf.join(' AND ') || '0'} THEN 1 ELSE 0 END), 0) AS refuted, ` +
        `COALESCE(SUM(CASE WHEN ${holds} AND NOT (${conflictFree.join(' OR ') || '0'}) THEN 1 ELSE 0 END), 0) AS conflicts FROM (${domSql}) AS m`;
      const r = this.session.get(sql);
      failing += Number(r.failing);
      if (Number(r.refuted) > 0) counter = true;
      conflicts += Number(r.conflicts);
    }
    if (counter) return {status: 'refuted', rows: [], roots: [], supportIncomplete: true, counterexample: true};
    if (!qp.domainClosed) return {status: 'unknown', reason: 'open_domain', rows: [], roots: [], supportIncomplete: true};
    if (failing) return {status: 'unknown', reason: 'scope_unknown', rows: [], roots: [], supportIncomplete: true};
    return {status: conflicts ? 'both' : 'supported', rows: [], roots: [], supportIncomplete: true};
  }
}

