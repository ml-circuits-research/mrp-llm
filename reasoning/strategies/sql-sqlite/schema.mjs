/**
 * Relations of the sql-sqlite strategy: one table per predicate, arity and polarity, loading of the facts, column kinds.
 *
 *   "+p/2"   positive evidence P of p/2      columns c0, c1, rk     PRIMARY KEY (c0, c1)  WITHOUT ROWID
 *   "-p/2"   negative evidence N (`not p`)   the same; `both` is never stored, it is P and N read together at query time
 *   "s:p/2"  the stored facts of p/2 with their validity text (vf, vt) and their index in the loaded view (fid), only when a rule or query uses
 *            start_of / end_of (each stored fact is a row: two facts of one tuple with different validity are two rows)
 *
 * `rk` is the derivation counter of the tuple: 0 for a stored fact, a larger number for each later derivation, so a derivation whose
 * premises all have a smaller `rk` is acyclic (used by provenance.mjs). A predicate used with two arities is two relations, as in the
 * oracle, where tuples of different length never unify. An atom of arity 0 has the single column c0 = 1.
 *
 * Column kinds let the compiler use plain SQL operators where it can prove them equal to the oracle's rules:
 *   int    always a safe integer (declared `integer` and every loaded fact checks out)
 *   plain  never a date or time text (declared `entity` or `text`, every loaded fact checks out), so `=` is the oracle's equality
 *   any    anything else: comparisons go through the `cmp` function
 */
import {DATE} from '../js-reference/wires.mjs';

export const relName = (p, arity, neg) => `${neg ? '-' : '+'}${p}/${arity}`;
export const quoteId = n => '"' + n.replaceAll('"', '""') + '"';
export const tbl = (p, arity, neg) => quoteId(relName(p, arity, neg));
export const tblWith = (prefix, p, arity, neg) => quoteId(prefix + relName(p, arity, neg));
export const storedTbl = (p, arity) => quoteId(`s:${p}/${arity}`);
export const width = arity => Math.max(1, arity);
export const colsOf = arity => Array.from({length: width(arity)}, (_, i) => `c${i}`);
export const relKey = (p, arity, neg) => relName(p, arity, neg);

/** Every relation the slice and the query mention: Map('p/arity') -> {p, arity, stored, derived: {pos, neg}}. */
export function collectRelations(program, qp = null) {
  const rels = new Map();
  const touch = (p, arity) => {
    const k = `${p}/${arity}`;
    if (!rels.has(k)) rels.set(k, {p, arity, stored: false, derived: {pos: false, neg: false}});
    return rels.get(k);
  };
  const leaf = l => { if (l.kind === 'atom') touch(l.p, l.args.length); else if (l.kind === 'timeof') touch(l.p, l.args.length).stored = true; };
  for (const f of program.facts) touch(f.p, f.args.length);
  for (const r of program.rules) {
    touch(r.head.p, r.head.args.length).derived[r.head.neg ? 'neg' : 'pos'] = true;
    for (const alt of r.alts) alt.leaves.forEach(leaf);
  }
  for (const a of program.aggregates) {
    touch(a.yields.p, a.yields.args.length).derived.pos = true;
    for (const alt of a.alts) alt.leaves.forEach(leaf);
  }
  if (qp) for (const alt of [...qp.alts, ...qp.scopeAlts]) alt.leaves.forEach(leaf);
  return rels;
}

/** Column kinds from the `predicate` declarations, downgraded by the loaded facts (see the header). */
export class Kinds {
  constructor(program) {
    this.program = program;
    this.down = new Set();
  }

  declared(p, arity, i) {
    const args = this.program.predicates.get(p)?.args;
    if (!args || args.length !== arity) return 'any';
    const t = args[i]?.type;
    return t === 'integer' ? 'int' : t === 'entity' || t === 'text' ? 'plain' : 'any';
  }

  /** Check a loaded fact against the declared kinds of its columns. */
  observe(p, arity, args) {
    for (let i = 0; i < args.length; i++) {
      const k = this.declared(p, arity, i);
      if (k === 'any') continue;
      const v = args[i];
      if (k === 'int' ? !Number.isSafeInteger(v) : (typeof v === 'string' && DATE.test(v))) this.down.add(`${p}/${arity}/${i}`);
    }
  }

  of(p, arity, i) { return this.down.has(`${p}/${arity}/${i}`) ? 'any' : this.declared(p, arity, i); }
}

/** Create the tables. `temp` makes them TEMP tables (the bank mode may not write the bank's own file). */
export function createTables(session, rels, {temp = false} = {}) {
  const t = temp ? 'TEMP ' : '';
  for (const {p, arity, stored} of rels.values()) {
    const cols = colsOf(arity);
    for (const neg of [false, true]) {
      session.exec(`CREATE ${t}TABLE ${tbl(p, arity, neg)} (${cols.join(', ')}, rk INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (${cols.join(', ')})) WITHOUT ROWID`);
    }
    if (stored) session.exec(`CREATE ${t}TABLE ${storedTbl(p, arity)} (${cols.join(', ')}, vf, vt, fid)`);
  }
}

/** One secondary index per column after the first (the primary key covers column 0), as the memory bank does. */
export function indexTable(session, p, arity, neg, {temp = false} = {}) {
  const cols = colsOf(arity);
  for (let i = 1; i < cols.length; i++) {
    session.exec(`CREATE INDEX IF NOT EXISTS ${quoteId(`i${i}:${relName(p, arity, neg)}`)} ON ${tbl(p, arity, neg)} (${cols[i]})`);
  }
}

export function indexAll(session, rels, which = () => true) {
  for (const {p, arity} of rels.values()) for (const neg of [false, true]) if (which(p, arity, neg)) indexTable(session, p, arity, neg);
}

/** Load the facts of a view (stored facts, rk 0) and observe their kinds. */
export function loadFacts(session, facts, rels, kinds) {
  const codec = session.codec;
  const inserts = new Map();
  const insertFor = (p, arity, neg) => {
    const k = relName(p, arity, neg);
    if (!inserts.has(k)) {
      const n = width(arity);
      inserts.set(k, session.prepare(`INSERT OR IGNORE INTO ${tbl(p, arity, neg)} (${colsOf(arity).join(', ')}, rk) VALUES (${Array(n).fill('?').join(', ')}, 0)`));
    }
    return inserts.get(k);
  };
  const storedInserts = new Map();
  session.exec('BEGIN');
  try {
    for (const [fi, f] of facts.entries()) {
      const arity = f.args.length;
      const row = (arity === 0 ? [1] : f.args).map(codec.bind);
      kinds.observe(f.p, arity, f.args);
      insertFor(f.p, arity, f.neg).run(...row);
      if (!f.neg && rels.get(`${f.p}/${arity}`)?.stored) {
        const k = `${f.p}/${arity}`;
        if (!storedInserts.has(k)) storedInserts.set(k, session.prepare(`INSERT INTO ${storedTbl(f.p, arity)} (${colsOf(arity).join(', ')}, vf, vt, fid) VALUES (${Array(width(arity) + 3).fill('?').join(', ')})`));
        storedInserts.get(k).run(...row, f.valid?.fromText ?? 'beginning', f.valid?.toText ?? 'open', BigInt(fi));
      }
    }
    session.exec('COMMIT');
  } catch (e) { session.exec('ROLLBACK'); throw e; }
}
