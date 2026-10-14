/**
 * The closure of a program over loaded facts, stratum by stratum (the strata of the oracle's `compileProgram`, lower strata final before
 * a higher one reads them, so `absent` and aggregates read finished relations).
 *
 *   non-recursive   one `INSERT OR IGNORE ... SELECT` per rule alternative (a "view" materialised once, because every consumer
 *                   needs it more than once);
 *   aggregate       `GROUP BY` over the DISTINCT bindings of all variables of `over` (set semantics, as the proposal says);
 *   recursive CTE   one statement for a single relation whose rule alternatives have at most one recursive atom (linear recursion):
 *                   `WITH RECURSIVE c AS (seed UNION bases UNION steps)`; SQLite runs it breadth first, so the order of the produced rows
 *                   is a valid derivation order and is stored as the tuple's `rk`. A tightened `maxRounds` cannot be counted inside a
 *                   CTE, so a stratum then runs as a loop;
 *   semi-naive loop everything else: nonlinear recursion (two recursive atoms), mutual recursion (several relations) and the
 *                   round-counted case. Each round runs, per alternative and per recursive atom, one statement with that atom reading the
 *                   delta of the previous round, writes only tuples not yet stored into a `next` table, then commits the whole round
 *                   (so the rounds are exactly the oracle's rounds). Statements are prepared once and reused.
 * Nonlinear and mutual recursion are therefore EXPRESSIBLE here (through the loop in JS over SQL statements), not declared out.
 */
import {isVarTerm, ProgramError} from '../js-reference/values.mjs';
import {BudgetStop} from '../js-reference/budget.mjs';
import {compileLeaves, termExpr} from './compile.mjs';
import {tbl, tblWith, quoteId, colsOf, width, relKey, indexTable} from './schema.mjs';
import {preservedPositions} from './demand.mjs';

const SAFE = '9007199254740991';

const headCols = arity => colsOf(arity).join(', ');
const headRow = (head, body, codec) => (head.args.length === 0 ? [codec.lit(1)] : head.args.map(a => termExpr(a, body.bind, codec)));
const eqRow = (alias, exprs) => exprs.map((e, i) => `${alias}.c${i} = ${e}`).join(' AND ');

export class Closure {
  constructor({session, program, rels, kinds, budget, notes, temp = false}) {
    Object.assign(this, {session, program, rels, kinds, budget, notes, temp});
    this.codec = session.codec;
    this.ctx = {codec: session.codec, kinds};
    this.counter = 0;      // the derivation counter stored as rk
    this.stats = {plain: 0, cte: 0, loop: 0, aggregate: 0, rounds: 0, statements: 0};
    this.strategyOf = [];  // per stratum: how it was run, for the packet notes and the tests
    this.options = {recursion: 'auto'};
    this.demand = new Map(); // 'p/arity' -> [{i, value}] (demand.mjs)
    this.demanded = [];
  }

  /** Run every stratum. Returns null when complete, else {reason, key, stratum}. */
  run({recursion = 'auto', demand = null} = {}) {
    this.options.recursion = recursion;
    this.demand = demand ?? new Map();
    let at = 0;
    try {
      for (; at < this.program.strata.length; at++) this.stratum(this.program.strata[at]);
      return null;
    } catch (e) {
      if (!(e instanceof BudgetStop)) throw e;
      return {reason: e.reason, key: e.key, stratum: at};
    }
  }

  exec(sql, ...params) {
    this.stats.statements++;
    return this.session.run(sql, ...params);
  }

  // -------------------------------------------------------------------------------------------------- strata

  stratum(st) {
    for (const agg of st.aggregates) this.aggregate(agg);
    if (!st.rules.length) return;
    const rels = new Map();
    for (const r of st.rules) rels.set(relKey(r.head.p, r.head.args.length, r.head.neg), {p: r.head.p, arity: r.head.args.length, neg: r.head.neg});
    const occ = rule => rule.alts.map(alt => alt.leaves.map((l, i) => (l.kind === 'atom' && l.mode !== 'absent' && rels.has(relKey(l.p, l.args.length, l.mode === 'not')) ? i : -1)).filter(i => i >= 0));
    const occs = st.rules.map(occ);
    const recursive = occs.some(o => o.some(x => x.length));
    if (!recursive) { this.plain(st.rules, rels); return; }
    const linear = rels.size === 1 && occs.every(o => o.every(x => x.length <= 1));
    const mayCte = this.options.recursion === 'cte' || (this.options.recursion === 'auto' && this.budget.limits.maxRounds >= this.budgetCeilingRounds());
    if (linear && mayCte && this.options.recursion !== 'loop') this.cte(st.rules, occs, [...rels.values()][0]);
    else this.loop(st.rules, occs, rels);
    this.noteArithmetic(st.rules);
  }

  budgetCeilingRounds() { return 100_000; }

  // -------------------------------------------------------------------------------------------- non-recursive

  insertSql(rule, alt, {into, tableFor = null, first = null, dedupe = null}) {
    const body = compileLeaves(alt.leaves, this.ctx, {tableFor});
    const exprs = headRow(rule.head, body, this.codec);
    const where = [...body.where];
    if (dedupe) where.push(`NOT EXISTS (SELECT 1 FROM ${dedupe} AS dd WHERE ${eqRow('dd', exprs)})`);
    const terms = [body.tickSql(), ...where];
    return `INSERT OR IGNORE INTO ${into} (${headCols(rule.head.args.length)}, rk) SELECT ${exprs.join(', ')}, ? ${body.fromSql({first})} WHERE ${terms.join(' AND ')}`;
  }

  plain(rules, rels) {
    this.stats.plain++;
    this.strategyOf.push('plain');
    const rk = BigInt(++this.counter);
    let added = 0;
    for (const rule of rules) {
      for (const alt of rule.alts) {
        const sql = this.insertSql(rule, alt, {into: tbl(rule.head.p, rule.head.args.length, rule.head.neg)});
        const n = this.exec(sql, rk).changes;
        added += n;
        this.budget.facts(n);
      }
    }
    if (added) this.budget.round(1);
    this.noteArithmetic(rules);
    for (const {p, arity, neg} of rels.values()) indexTable(this.session, p, arity, neg);
  }

  // ---------------------------------------------------------------------------------------- recursive CTE

  cte(rules, occs, rel) {
    this.stats.cte++;
    this.strategyOf.push('cte');
    const {p, arity, neg} = rel;
    const R = tbl(p, arity, neg), cols = colsOf(arity), name = quoteId('cte');
    // demand: the constants of the query that every step keeps (demand.mjs) restrict the seed and the base alternatives
    const asked = neg ? null : this.demand.get(`${p}/${arity}`);
    const kept = asked ? preservedPositions(rules, occs, arity) : new Set();
    const restrict = (asked ?? []).filter(d => kept.has(d.i));
    if (restrict.length) this.demanded.push(`${p}/${arity}: ${restrict.map(d => `c${d.i} = ${JSON.stringify(d.value)}`).join(', ')}`);
    const seedWhere = restrict.length ? ` WHERE ${restrict.map(d => `${cols[d.i]} = ${this.codec.lit(d.value)}`).join(' AND ')}` : '';
    const parts = [`SELECT ${cols.join(', ')} FROM ${R}${seedWhere}`];
    const steps = [];
    rules.forEach((rule, ri) => rule.alts.forEach((alt, ai) => {
      const j = occs[ri][ai][0];
      const body = compileLeaves(alt.leaves, this.ctx, {tableFor: j === undefined ? null : (i => (i === j ? name : null))});
      const exprs = headRow(rule.head, body, this.codec);
      // the recursive table is the outer loop (CROSS JOIN keeps the order): the planner knows nothing about the size of the CTE queue
      const demandTerms = j === undefined ? restrict.map(d => `${exprs[d.i]} = ${this.codec.lit(d.value)}`) : [];
      const sel = `SELECT ${exprs.join(', ')} ${body.fromSql({first: j === undefined ? null : body.aliasOf.get(j)})} WHERE ${[body.tickSql(), ...body.where, ...demandTerms].join(' AND ')}`;
      (j === undefined ? parts : steps).push(sel);
    }));
    const room = this.budget.factRoom();
    const sql = `INSERT OR IGNORE INTO ${R} (${cols.join(', ')}, rk) WITH RECURSIVE ${name}(${cols.join(', ')}) AS (${[...parts, ...steps].join(' UNION ')}) ` +
      `SELECT ${cols.map(c => `x.${c}`).join(', ')}, ? + ROW_NUMBER() OVER () FROM ${name} AS x WHERE NOT EXISTS (SELECT 1 FROM ${R} AS dd WHERE ${cols.map(c => `dd.${c} = x.${c}`).join(' AND ')}) LIMIT ${room + 1}`;
    indexTable(this.session, p, arity, neg);
    const base = this.counter;
    const n = this.exec(sql, BigInt(base)).changes;
    this.counter = base + n + 1;
    this.budget.facts(n);
    this.budget.round(1);
  }

  // --------------------------------------------------------------------------------------- semi-naive loop

  loop(rules, occs, rels) {
    this.stats.loop++;
    this.strategyOf.push('loop');
    const list = [...rels.values()];
    const R = r => tbl(r.p, r.arity, r.neg), D = r => tblWith('d', r.p, r.arity, r.neg), X = r => tblWith('x', r.p, r.arity, r.neg);
    for (const r of list) {
      const cols = colsOf(r.arity);
      indexTable(this.session, r.p, r.arity, r.neg);
      for (const t of [D(r), X(r)]) this.session.exec(`CREATE ${this.temp ? 'TEMP ' : ''}TABLE ${t} (${cols.join(', ')}, rk INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (${cols.join(', ')})) WITHOUT ROWID`);
    }
    const first = [], later = [];
    rules.forEach((rule, ri) => rule.alts.forEach((alt, ai) => {
      const into = X({p: rule.head.p, arity: rule.head.args.length, neg: rule.head.neg});
      const dedupe = R({p: rule.head.p, arity: rule.head.args.length, neg: rule.head.neg});
      first.push(this.insertSql(rule, alt, {into, dedupe}));
      for (const j of occs[ri][ai]) {
        const l = alt.leaves[j];
        const delta = D({p: l.p, arity: l.args.length, neg: l.mode === 'not'});
        const probe = compileLeaves(alt.leaves, this.ctx, {tableFor: i => (i === j ? delta : null)});
        later.push(this.insertSql(rule, alt, {into, dedupe, tableFor: i => (i === j ? delta : null), first: probe.aliasOf.get(j)}));
      }
    }));
    try {
      for (let pass = 1; ; pass++) {
        const rk = BigInt(++this.counter);
        let added = 0;
        for (const sql of pass === 1 ? first : later) added += this.exec(sql, rk).changes;
        if (!added) break;
        this.stats.rounds++;
        this.budget.round(pass);
        this.budget.facts(added);
        for (const r of list) {
          this.session.exec(`INSERT INTO ${R(r)} SELECT * FROM ${X(r)}; DELETE FROM ${D(r)}; INSERT INTO ${D(r)} SELECT * FROM ${X(r)}; DELETE FROM ${X(r)};`);
        }
      }
    } finally {
      for (const r of list) for (const t of [D(r), X(r)]) { try { this.session.exec(`DROP TABLE ${t}`); } catch { /* the connection may be mid-statement after a stop */ } }
    }
  }

  // --------------------------------------------------------------------------------------------- aggregates

  aggregate(agg) {
    this.stats.aggregate++;
    const {codec} = this;
    const rv = agg.rowVars;
    const bodies = agg.alts.map(a => compileLeaves(a.leaves, this.ctx));
    const inner = bodies.map(b => `SELECT 1 AS vz${rv.map((v, i) => `, ${b.bind.has(v) ? b.bind.get(v).expr : 'NULL'} AS v${i}`).join('')} ${b.fromSql()} WHERE ${[b.tickSql(), ...b.where].join(' AND ')}`).join(' UNION ');
    const g = agg.group.map(v => `v${rv.indexOf(v)}`);
    const arity = agg.yields.args.length;
    const out = arity === 0 ? null : agg.yields.args;
    const argExpr = t => {
      if (!isVarTerm(t)) return codec.lit(t);
      const gi = agg.group.indexOf(t.var);
      if (gi >= 0) return `a.g${gi}`;
      if (t.var === agg.out) return 'a.o';
      throw new ProgramError('unsafe_head', `the yields of ${agg.id} uses a variable that is neither grouped nor the output`, agg.id);
    };
    const exprs = arity === 0 ? [codec.lit(1)] : out.map(argExpr);
    const target = tbl(agg.yields.p, arity, false);
    const rk = BigInt(++this.counter);
    if (agg.fn === 'collect') { this.collect(agg, inner, g, rv, argExpr, target, rk, arity); return; }
    const fi = agg.field ? rv.indexOf(agg.field) : -1;
    const nat = fi >= 0 ? codec.native(`r.v${fi}`) : null;
    const isInt = nat ? `typeof(${nat}) = 'integer' AND abs(${nat}) <= ${SAFE}` : null;
    const fnExpr = agg.fn === 'count' ? (agg.scaleCount ? `(COUNT(*) * ${agg.scaleCount})` : 'COUNT(*)') : `${agg.fn.toUpperCase()}(${nat})`;
    const filter = agg.fn === 'count' ? '' : `WHERE ${isInt}`;
    const groupBy = g.length ? `GROUP BY ${g.map(c => `r.${c}`).join(', ')}` : '';
    const outer = `SELECT ${g.map((c, i) => `r.${c} AS g${i}`).join(', ')}${g.length ? ', ' : ''}${codec.store(fnExpr)} AS o FROM (${inner}) AS r ${filter} ${groupBy} HAVING COUNT(*) > 0`;
    const n = this.exec(`INSERT OR IGNORE INTO ${target} (${headCols(arity)}, rk) SELECT ${exprs.join(', ')}, ? FROM (${outer}) AS a`, rk).changes;
    this.budget.facts(n);
    if (agg.fn !== 'count' && this.session.get(`SELECT 1 AS x FROM (${inner}) AS r WHERE NOT (${isInt}) LIMIT 1`)) this.notes.add('aggregate_non_integer_ignored');
    indexTable(this.session, agg.yields.p, arity, false);
  }

  /** `collect` builds a sorted JSON array of the distinct values; the order rule is the oracle's, so it is done here. */
  collect(agg, inner, g, rv, argExpr, target, rk, arity) {
    const {codec} = this;
    const fi = rv.indexOf(agg.field);
    const rows = this.session.all(`SELECT ${g.map((c, i) => `r.${c} AS g${i}`).join(', ')}${g.length ? ', ' : ''}r.v${fi} AS f FROM (${inner}) AS r`);
    const groups = new Map();
    for (const row of rows) {
      const key = JSON.stringify(g.map((_, i) => row[`g${i}`]));
      if (!groups.has(key)) groups.set(key, {gv: g.map((_, i) => row[`g${i}`]), vals: new Set()});
      groups.get(key).vals.add(codec.decode(row.f));
    }
    const order = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
    const exprsOf = (gv, outValue) => agg.yields.args.map(t => {
      if (!isVarTerm(t)) return codec.bind(t);
      const gi = agg.group.indexOf(t.var);
      return gi >= 0 ? gv[gi] : codec.bind(outValue);
    });
    const ins = this.session.prepare(`INSERT OR IGNORE INTO ${target} (${headCols(arity)}, rk) VALUES (${Array(width(arity)).fill('?').join(', ')}, ?)`);
    for (const {gv, vals} of groups.values()) {
      const text = JSON.stringify([...vals].sort(order));
      const row = arity === 0 ? [codec.bind(1)] : exprsOf(gv, text);
      this.budget.facts(Number(ins.run(...row, rk).changes));
    }
    indexTable(this.session, agg.yields.p, arity, false);
  }

  // ------------------------------------------------------------------------------------------------ notes

  /** `arithmetic_undefined`: some binding reached a compute leaf whose operands or result are undefined (zero divisor, overflow). */
  noteArithmetic(rules) {
    if (this.notes.has('arithmetic_undefined')) return;
    for (const rule of rules) for (const alt of rule.alts) {
      if (!alt.leaves.some(l => l.kind === 'compute')) continue;
      const body = compileLeaves(alt.leaves, this.ctx);
      for (const step of body.computeSteps) {
        const from = step.from.length ? 'FROM ' + step.from.map(f => `${f.table} AS ${f.alias}`).join(', ') : '';
        if (this.session.get(`SELECT 1 AS x ${from} WHERE ${[...step.where, step.undef].join(' AND ')} LIMIT 1`)) { this.notes.add('arithmetic_undefined'); return; }
      }
    }
  }
}
