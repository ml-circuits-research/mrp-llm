/**
 * datalog-e10: the desugared core lowered to the E10 engine (sop_reasoner_e10.zip, sop-verified-reasoner 0.3.0, vendored in `vendor/`).
 * E10 is bottom-up, set-valued, function-free Datalog with stratified negation (`NONE`), explicit negation (a separate relation),
 * SCC scheduling, semi-naive evaluation, greedy join order and magic-set demand rewriting (applied when the cone has no negation).
 *
 *   select, exists, count   pushed into E10 as a query wire (alternatives joined by OR); only the answer rows are read back;
 *                           `both` (clean-derivation) and refutation tests are extra queries, run only when they can matter;
 *   every                   the closure of the query predicates (one E10 query per relation and polarity), read by the oracle's reader;
 *   budget                  `maxJoins` -> E10 `maxWork` (candidate visits), `maxFacts` -> `maxDerived`, `timeoutMs` -> `maxMs`;
 *                           an overrun is INCOMPLETE and the strategy answers `budget_exhausted` (never a negative answer); a select
 *                           that already found rows is reported as a partial positive answer when the program is monotone.
 *
 * Not provided: `used`/`proof`/`explain` (E10's `explain` proof extractor is not wired here; the host computes `used`), compute and
 * aggregates (E10 has no arithmetic or aggregate), time, plan, abduction, why_not, constraints, methods and norms. A circuit that needs
 * one of these is `not_expressible`.
 */
import fs from 'node:fs';
import {askWith, prepare, NotExpressibleError} from '../datalog-common/front.mjs';
import {update as updateHandle} from '../js-reference/index.mjs';
import {isVarTerm} from '../js-reference/values.mjs';
import {parseSOP} from './vendor/parser.mjs';
import {reason} from './vendor/engine.mjs';
import {lowerProgram, queryText} from './lower.mjs';

export {NotExpressibleError};

const FEATURES = ['facts', 'select', 'open_world', 'classical_negation', 'conflict', 'rules', 'recursion', 'conjunction', 'exists', 'every', 'count',
  'whatif', 'epistemic_status', 'naf', 'closed_world', 'closed_derived', 'compare_in_rules', 'default', 'overrides', 'strict_contrary', 'integrity',
  'versions', 'zero_arity', 'budget_probes', 'retrieval'];
const NOT_EXPRESSIBLE = ['compute_in_rules', 'aggregate', 'used', 'explain', 'why_not', 'temporal', 'interval', 'throughout', 'snapshot_derived', 'time_vars', 'plan', 'abduce',
  'constraint', 'optimize', 'budget', 'method', 'htn_choice', 'on_failure', 'norms_hard', 'norms_soft', 'temporal_norms', 'procedures', 'procedure_render', 'amendment',
  'check_plan', 'blocked_info', 'abduce_waive'];

export const capabilities = {
  id: 'datalog-e10',
  features: FEATURES,
  notExpressible: NOT_EXPRESSIBLE,
  delivery: 'slice',
  limits: {max_wires: 5_000_000, max_arity: 6, integer_range: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]},
  guarantee: 'exact',
  provides: [],
  providesNote: 'used: false (the host computes used by deletion and replay), proof: false, explain: false',
  budgetKeys: ['maxJoins', 'maxFacts', 'timeoutMs'],
  determinism: 'deterministic',
  isolation: false
};

const REASONS = {maxWork: 'probes', maxDerived: 'facts', maxMs: 'wall'};
const strip = v => v.replace(/^\?/, '');
const rowKey = row => JSON.stringify(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Can polarity `neg` of predicate p carry evidence at all (a fact or a rule head)? */
const possible = (program, neg, p) => program.facts.some(f => f.p === p && f.neg === neg) || program.rules.some(r => r.head.p === p && r.head.neg === neg);

/** Options of the engine: `demand` (magic sets, default on) and `join` ('greedy' | 'source'). */
export function makeEngine(options = {}) {
  const engine = {
    id: 'datalog-e10',
    ceilings: {
      maxJoins: {max: 2_000_000_000, default: 200_000_000},
      maxFacts: {max: 50_000_000, default: 5_000_000},
      timeoutMs: {max: 120_000, default: 60_000}
    },
    last: null,

    /** Parse the lowered program once; run named queries against it. */
    session(job) {
      const t0 = performance.now();
      const text = lowerProgram(job.program, job.facts);
      let base;
      try { base = parseSOP(text, 'datalog-e10'); } catch (e) { throw translate(e); }
      return {text, base, runs: 0, inconclusive: null, parseMs: Math.round(performance.now() - t0)};
    },

    /** Run one query text against the lowered program. Returns {rows, complete, reason, stats}. */
    runQuery(ctx, job, name, qText) {
      const t0 = performance.now();
      let program;
      try {
        const q = parseSOP(qText, 'datalog-e10-query');
        for (const [rel, n] of q.arities) if (ctx.base.arities.has(rel) && ctx.base.arities.get(rel) !== n) throw new SyntaxError(`Arity mismatch ${rel}`);
        program = {...ctx.base, rules: [...ctx.base.rules, ...q.rules], queries: [...ctx.base.queries, ...q.queries], arities: new Map([...ctx.base.arities, ...q.arities])};
      } catch (e) { throw translate(e); }
      const remaining = Math.max(1, job.budget.limits.timeoutMs - (performance.now() - job.budget.started));
      const settings = {maxWork: job.budget.limits.maxJoins, maxDerived: job.budget.limits.maxFacts, maxMs: remaining, demand: options.demand !== false, join: options.join ?? 'greedy'};
      let r;
      try { r = reason(program, name, settings); } catch (e) { throw translate(e); }
      ctx.runs++;
      ctx.lastStats = {...r.stats, demandApplied: r.plan.demandApplied, demandReason: r.plan.demandReason};
      return {rows: r.rows, complete: r.complete, reason: REASONS[r.stopReason] ?? r.stopReason, ms: Math.round(performance.now() - t0)};
    },

    pushdown(job) {
      const {qp, program} = job;
      if (options.pushdown === false || !['select', 'exists', 'count'].includes(qp.mode)) return null;
      for (const alt of qp.alts) if (qp.projection.some(v => !alt.bound.has(v))) throw new NotExpressibleError(['query_projection'], 'an alternative of the query does not bind every projected variable');
      const ctx = engine.session(job);
      const vars = qp.projection;
      const main = engine.runQuery(ctx, job, 'qrows', queryText('qrows', qp.alts, vars));
      const toRows = (rows, bothFor) => rows.map(arr => ({row: Object.fromEntries(vars.map((v, i) => [strip(v), arr[i]])), both: bothFor ? bothFor(arr) : false, prem: []}));
      let list = toRows(main.rows);
      const timings = {e10: {parse: ctx.parseMs, runs: ctx.runs, stats: ctx.lastStats}};
      if (!main.complete) return {status: list.length ? 'supported' : 'unknown', rows: dedupe(list), roots: [], supportIncomplete: false, exhausted: {reason: main.reason}, timings};
      // conflict: a row is `both` when none of its derivations is clean (no opposite evidence on any literal)
      const opp = alt => alt.leaves.filter(l => l.kind === 'atom' && l.mode !== 'absent' && possible(program, l.mode === 'pos', l.p));
      if (list.length && qp.alts.some(alt => opp(alt).length)) {
        const extra = alt => alt.leaves.filter(l => l.kind === 'atom' && l.mode !== 'absent').map(l => ({kind: 'atom', mode: 'absent', negRel: l.mode === 'pos', p: l.p, args: l.args}));
        const clean = engine.runQuery(ctx, job, 'qclean', queryText('qclean', qp.alts, vars, extra));
        if (!clean.complete) return {status: 'supported', rows: dedupe(list), roots: [], supportIncomplete: false, exhausted: {reason: clean.reason}, timings};
        const cleanSet = new Set(clean.rows.map(r => JSON.stringify(r)));
        list = toRows(main.rows, arr => !cleanSet.has(JSON.stringify(arr)));
      }
      list = dedupe(list);
      timings.e10.runs = ctx.runs;
      if (qp.mode === 'count') {
        const exact = qp.domainClosed;
        return {status: list.length || exact ? 'supported' : 'unknown', rows: list, count: list.length, ...(exact ? {} : {bound: 'at_least'}), roots: [], supportIncomplete: true, timings};
      }
      if (list.length) return {status: list.some(r => !r.both) ? 'supported' : 'both', rows: list, roots: [], supportIncomplete: false, timings};
      const refuted = engine.refuted(ctx, job);
      timings.e10.runs = ctx.runs;
      if (refuted === null) return {status: 'unknown', rows: [], roots: [], supportIncomplete: false, exhausted: {reason: ctx.inconclusive}, timings};
      return {status: refuted ? 'refuted' : 'unknown', rows: [], roots: [], supportIncomplete: refuted, timings};
    },

    /** The oracle's refutation test of a query with no answer: every alternative has a literal that cannot have an instance. */
    refuted(ctx, job) {
      const {qp, program} = job;
      let n = 0;
      const nonempty = (neg, p, args) => {
        const body = `${neg ? 'NOT ' : ''}${p} ${args.map(a => (isVarTerm(a) ? a.var : termOf(a))).join(' ')}`.trim();
        const vars = [...new Set(args.filter(isVarTerm).map(a => a.var))];
        const r = engine.runQuery(ctx, job, `qref${n}`, `@qref${n++} query\nGIVES ${vars.join(' ')}\nMATCH ${body}\n`);
        if (!r.complete) { ctx.inconclusive = r.reason; return null; }
        return r.rows.length > 0;
      };
      for (const alt of qp.alts) {
        let refutedAlt = false;
        for (const l of alt.leaves) {
          if (l.kind !== 'atom') continue;
          const ground = l.args.every(a => !isVarTerm(a));
          let hit;
          if (l.mode === 'pos') {
            hit = ground ? nonempty(true, l.p, l.args) : false;
            if (hit === null) return null;
            if (!hit && qp.closed.has(l.p)) { const any = nonempty(false, l.p, l.args); if (any === null) return null; hit = !any; }
          } else if (ground) { hit = nonempty(false, l.p, l.args); if (hit === null) return null; } else hit = false;
          if (hit) { refutedAlt = true; break; }
        }
        if (!refutedAlt) return false;
      }
      return true;
    },

    closure(job) {
      const ctx = engine.session(job);
      const tables = new Map();
      let exhausted = null;
      const arity = new Map();
      for (const f of job.facts) arity.set(f.p, f.args.length);
      for (const r of job.program.rules) { arity.set(r.head.p, r.head.args.length); for (const alt of r.alts) for (const l of alt.leaves) if (l.kind === 'atom') arity.set(l.p, l.args.length); }
      for (const alt of [...job.qp.alts, ...job.qp.scopeAlts]) for (const l of alt.leaves) if (l.kind === 'atom') arity.set(l.p, l.args.length);
      let k = 0;
      for (const key of job.wanted) {
        const neg = key.startsWith('n|'), p = key.slice(2);
        if (!arity.has(p)) { tables.set(key, []); continue; }
        const vars = Array.from({length: arity.get(p)}, (_, i) => `?c${i}`);
        const name = `qc${k++}`;
        const r = engine.runQuery(ctx, job, name, `@${name} query\nGIVES ${vars.join(' ')}\nMATCH ${neg ? 'NOT ' : ''}${p} ${vars.join(' ')}\n`);
        tables.set(key, r.rows);
        if (!r.complete) exhausted = exhausted ?? {reason: r.reason};
      }
      return {tables, exhausted, state: ctx};
    }
  };
  return engine;
}

const termOf = t => (typeof t === 'number' ? String(t) : /^[A-Za-z_][\w.:/-]*$/.test(t) && t !== 'true' && t !== 'false' ? t : JSON.stringify(t));

function dedupe(list) {
  const seen = new Map();
  for (const r of list) {
    const k = rowKey(r.row), old = seen.get(k);
    if (!old || (old.both && !r.both)) seen.set(k, r);
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
}

function translate(e) {
  const m = String(e.message ?? e);
  if (/Ordered TEST requires integer/.test(m)) return new NotExpressibleError(['compare_on_text'], 'ordering over text is not available in E10 (TEST needs integers)');
  if (/Arity mismatch|Relation arity mismatch/.test(m)) return new NotExpressibleError(['arity_clash'], 'a predicate is used with two arities (E10 fixes the arity of a relation)');
  return e;
}

const defaultEngine = makeEngine();

export const available = async () => (fs.existsSync(new URL('./vendor/engine.mjs', import.meta.url)) ? {ok: true, version: 'sop-verified-reasoner 0.3.0 (vendored)'} : {ok: false, reason: 'vendored E10 engine missing'});

/** Answer a problem {theory | handle, query, requested?} (proposal 5.2, 5.3). `options`: engine options and `conditional: false`. */
export function ask(problem, budget = {}, options = {}) {
  const engine = Object.keys(options).some(k => ['demand', 'join', 'pushdown'].includes(k)) ? makeEngine(options) : defaultEngine;
  return askWith(engine, problem, budget, options);
}

export {prepare};
export const update = updateHandle;

export const datalogE10 = {...capabilities, capabilities, available, prepare, ask, update};
export default datalogE10;
