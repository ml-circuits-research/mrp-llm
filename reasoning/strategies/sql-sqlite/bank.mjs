/**
 * Bank mode: run the rules where the data lives. `askBank` opens a SQLite memory bank file of DS018 (`memory/banks/sqlite.mjs`, the
 * table `atoms(id, p, n, neg, v0..v3, ...)` and, in the single-file memory, `claims` and `changes`) READ-ONLY and answers a query over
 * it without copying the facts:
 *
 *   base relations     TEMP views over `atoms` (the connection is opened with readOnly, so the bank file cannot be written; temp objects live
 *                      in the temp database). The columns keep the bank's own encoding (JSON text), so a constant or a join between two
 *                      positions is an equality on `v0..v3` and uses the bank's four composite indexes (p, n, neg, position);
 *   derived relations  TEMP tables written by the closure (rules, aggregates), also in JSON text;
 *   text facts         facts written in the circuit (suppositions, the query's own facts) go into temp tables seeded from the bank rows;
 *   time               with the single-file memory, a tuple is present at `asof` when it has a claim known by then that no retraction known
 *                      by then cancels and, with `at`, whose validity (shortened by `end` events) contains the instant; a plain bank is timeless.
 *
 * It is opt-in (a different entry point, never chosen by the router), exact for the retained records of the bank (DS018: absence is only as
 * good as the retention policy, so a predicate is `closed` only relative to a complete retained view) and limited to what the bank holds:
 * arity 1 to 4, a point in time (no interval), no start_of/end_of. `used` names bank tuples by their `atoms.id`.
 */
import fs from 'node:fs';
import {withConditional} from '../js-reference/conditional.mjs';
import {prepare, assumptionIds} from '../js-reference/index.mjs';
import {ProgramError, NotExpressibleError} from '../js-reference/values.mjs';
import {readWires} from './front.mjs';
import {jsonCodec, sqlString} from './codec.mjs';
import {Session} from './session.mjs';
import {tbl, colsOf, width, relName} from './schema.mjs';
import {solveOnce} from './solve.mjs';

const BANK_MAX_ARITY = 4;
const FAR = '1e18';

/** Column kinds are not known for rows the bank holds: everything goes through `cmp` unless the compiler proves the type itself. */
class OpaqueKinds {
  of() { return 'any'; }
  observe() {}
}

const instantMs = text => (text === 'beginning' ? -1e18 : text === 'open' ? 1e18 : Date.parse(text));

/** SQL condition on `a` (an atoms row): a claim known by `asof` and not retracted, valid at `at` (ends shortened by `end` events). */
function temporalCondition({asof, instant}) {
  const known = asof === null || asof === undefined ? FAR : String(instantMs(asof));
  const ended = `COALESCE((SELECT MIN(json_extract(e.body, '$.effective')) FROM changes AS e WHERE e.target = c.id AND e.known_at <= ${known} AND json_extract(e.body, '$.action') = 'end'), ${FAR})`;
  const validity = instant === null || instant === undefined ? `tms(json_extract(c.body, '$.valid.from')) < MIN(tms(json_extract(c.body, '$.valid.until')), ${ended})`
    : `tms(json_extract(c.body, '$.valid.from')) <= ${instant} AND ${instant} < MIN(tms(json_extract(c.body, '$.valid.until')), ${ended})`;
  return `EXISTS (SELECT 1 FROM claims AS c WHERE c.tuple_hash = a.id AND c.known_at <= ${known} ` +
    `AND NOT EXISTS (SELECT 1 FROM changes AS r WHERE r.target = c.id AND r.known_at <= ${known} AND json_extract(r.body, '$.action') = 'retract') AND ${validity})`;
}

export function bankBackend(file) {
  return {
    id: 'bank',
    codec: jsonCodec,
    temp: true,
    kinds: () => new OpaqueKinds(),
    open: budget => {
      if (!fs.existsSync(file)) throw new ProgramError('no_bank', `the bank file ${file} does not exist`);
      const session = new Session({budget, codec: jsonCodec, path: file, readOnly: true});
      session.db.function('tms', {deterministic: true}, text => instantMs(text));
      const have = new Set(session.all(`SELECT name FROM sqlite_master WHERE type = 'table'`).map(r => r.name));
      if (!have.has('atoms')) { session.close(); throw new ProgramError('not_a_bank', `${file} has no atoms table (a DS018 SQLite memory bank is expected)`); }
      session.bank = {claims: have.has('claims') && have.has('changes')};
      return session;
    },
    setup(session, {rels, program, view, instant, asof}) {
      const timed = session.bank.claims;
      const cond = timed ? ' AND ' + temporalCondition({asof, instant}) : '';
      const derived = (p, arity, neg) => program.rules.some(r => r.head.p === p && r.head.args.length === arity && r.head.neg === neg) || (!neg && program.aggregates.some(a => a.yields.p === p && a.yields.args.length === arity));
      const withText = (p, arity, neg) => view.some(f => f.p === p && f.args.length === arity && f.neg === neg);
      const inserts = new Map();
      for (const {p, arity} of rels.values()) {
        const cols = colsOf(arity);
        for (const neg of [false, true]) {
          const inBank = arity >= 1 && arity <= BANK_MAX_ARITY;
          const select = inBank
            ? `SELECT ${cols.map((c, i) => `a.v${i} AS ${c}`).join(', ')}, 0 AS rk FROM atoms AS a WHERE a.p = ${sqlString(p)} AND a.n = ${arity} AND a.neg = ${neg ? 1 : 0}${cond}`
            : `SELECT ${cols.map(c => `NULL AS ${c}`).join(', ')}, 0 AS rk WHERE 0`;
          if (derived(p, arity, neg) || withText(p, arity, neg) || !inBank) {
            session.exec(`CREATE TEMP TABLE ${tbl(p, arity, neg)} (${cols.join(', ')}, rk INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (${cols.join(', ')})) WITHOUT ROWID`);
            if (inBank) session.exec(`INSERT OR IGNORE INTO ${tbl(p, arity, neg)} (${cols.join(', ')}, rk) ${select}`);
            inserts.set(relName(p, arity, neg), session.prepare(`INSERT OR IGNORE INTO ${tbl(p, arity, neg)} (${cols.join(', ')}, rk) VALUES (${Array(width(arity)).fill('?').join(', ')}, 0)`));
          } else session.exec(`CREATE TEMP VIEW ${tbl(p, arity, neg)} AS ${select}`);
        }
      }
      for (const f of view) inserts.get(relName(f.p, f.args.length, f.neg)).run(...(f.args.length === 0 ? [1] : f.args).map(jsonCodec.bind));
    },
    /** The claim a bank tuple stands for is its `atoms.id`. */
    refFor(session, neg, p, args) {
      if (args.length < 1 || args.length > BANK_MAX_ARITY) return null;
      const conds = args.map((_, i) => `v${i} = :v${i}`).join(' AND ');
      const params = Object.fromEntries(args.map((v, i) => [`v${i}`, jsonCodec.bind(v)]));
      const row = session.get(`SELECT id FROM atoms WHERE p = :p AND n = :n AND neg = :neg AND ${conds}`, {...params, p, n: BigInt(args.length), neg: BigInt(neg ? 1 : 0)});
      return row ? {id: row.id, version: 1} : null;
    }
  };
}

/**
 * Answer `query` over the bank file `bank` with the rules, predicates and aggregates of `theory`. The same packet as `ask`
 * (`sql.backend: 'bank'`). Opt-in and read-only: the file is opened with readOnly and nothing is written to it.
 */
export function askBank({bank, theory = '', query, requested = null}, budgetArg = {}, options = {}) {
  const t0 = performance.now();
  const handle = prepare(theory);
  const qWires = readWires(query, 'query');
  const backend = bankBackend(bank);
  const solve = excluded => solveOnce(backend, handle, qWires, excluded, budgetArg, options);
  const packet = options.conditional ? withConditional(assumptionIds(handle, query), solve) : solve(new Set());
  return {
    ...packet,
    route: {requested, chosen: 'sql-sqlite', reason: 'explicit request (bank mode)', fallback: null, delivery: 'bank'},
    timings: {...(packet.timings ?? {}), total: Math.round(performance.now() - t0)}
  };
}

export {NotExpressibleError};
