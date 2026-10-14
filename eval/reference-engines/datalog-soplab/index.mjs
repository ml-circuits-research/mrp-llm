/**
 * datalog-soplab: the desugared core lowered to soplab (soplab-v0.4.0.zip, sop-reasoning-lab 0.4.0, vendored in `vendor/`): a relation-of-bindings
 * engine with naive or delta materialisation, stratified `NONE`, `reduce` aggregates, a uniform-cost transition planner and a cheapest-explanation
 * abduction search.
 *
 *   select, exists, count, every   the closure of the query predicates (soplab saturates the sliced program, delta strategy), read by the oracle's reader;
 *   explain                        the first derivation of the answer in soplab's proof store (depth and stored facts used);
 *   plan                           actions as transitions, the goal as a `goal` wire, `planParsed`: the cheapest plan; positive literals only;
 *                                  a search that ends without a goal is `no_plan` only when soplab exhausted the state space, else `budget_exhausted` (nodes);
 *   abduce                         ALL inclusion-minimal explanations (soplab's native `abduct()` returns only the first cheapest one, the known finding of
 *                                  the smoke case 14a, see abduce.mjs): capabilities say `abduce: all_minimal`, the vendored engine's own is `cheapest_only`;
 *   budget                         `maxRounds` -> materialisation rounds (a cut closure is partial and sound), `maxFacts` -> its fact limit, `maxNodes` -> the planner's
 *                                  expansions; soplab has no clock, so `timeoutMs` is not honoured.
 *
 * Not provided: `used` and `proof` (the host computes `used`), compute and ungrouped aggregates, time, why_not, constraints, methods and norms.
 */
import fs from 'node:fs';
import {askWith, prepare, NotExpressibleError} from '../../../reasoning/strategies/datalog-common/front.mjs';
import {update as updateHandle} from '../../../reasoning/strategies/js-reference/index.mjs';
import {conditionAlts} from '../../../reasoning/strategies/js-reference/program.mjs';
import {evaluatePart, READ_BUDGET} from '../../../reasoning/strategies/js-reference/query.mjs';
import {evidenceFromTables, wantedRelations} from '../../../reasoning/strategies/datalog-common/front.mjs';
import {Reasoner, parseSOP, loadSOP, parseAtom, planParsed} from './vendor/index.mjs';
import {lowerProgram, lowerPlanning} from './lower.mjs';
import {abduceAll} from './abduce.mjs';

export {NotExpressibleError};

const FEATURES = ['facts', 'select', 'open_world', 'classical_negation', 'conflict', 'rules', 'recursion', 'conjunction', 'exists', 'every', 'count', 'explain',
  'aggregate', 'whatif', 'epistemic_status', 'naf', 'closed_world', 'closed_derived', 'compare_in_rules', 'default', 'overrides', 'strict_contrary', 'integrity',
  'versions', 'zero_arity', 'plan', 'abduce', 'budget', 'retrieval'];
const NOT_EXPRESSIBLE = ['compute_in_rules', 'used', 'why_not', 'temporal', 'interval', 'throughout', 'snapshot_derived', 'time_vars', 'constraint', 'optimize', 'budget_probes',
  'method', 'htn_choice', 'on_failure', 'norms_hard', 'norms_soft', 'temporal_norms', 'procedures', 'procedure_render', 'amendment', 'check_plan', 'blocked_info', 'abduce_waive'];

export const capabilities = {
  id: 'datalog-soplab',
  features: FEATURES,
  notExpressible: NOT_EXPRESSIBLE,
  abduce: 'all_minimal',
  nativeAbduce: 'cheapest_only',
  delivery: 'slice',
  limits: {max_wires: 1_000_000, max_arity: 6, integer_range: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]},
  guarantee: 'exact',
  provides: ['explain'],
  providesNote: 'explain: the first derivation in the proof store; used: false (the host computes used by deletion and replay), proof: false',
  budgetKeys: ['maxRounds', 'maxFacts', 'maxNodes'],
  determinism: 'deterministic',
  isolation: false
};

const strip = v => v.replace(/^\?/, '');

const showAtom = a => [a.sign === -1 ? 'not' : null, a.pred, ...a.args].filter(x => x !== null && x !== undefined).join(' ');

/** Lower, parse and load a program into a soplab Reasoner (extra facts are added as assumption-free source claims). */
function load(program, facts, extra = []) {
  const text = lowerProgram(program, facts);
  const parsed = parseSOP(text);
  const reasoner = loadSOP(new Reasoner(), parsed);
  for (const f of extra) reasoner.fact(parseAtom(`${f.neg ? 'NOT ' : ''}${f.p} ${f.args.map(a => (typeof a === 'number' ? a : JSON.stringify(String(a)))).join(' ')}`.trim()), {kind: 'assumption'});
  return {reasoner, text};
}

function saturate(reasoner, budget) {
  try {
    const m = reasoner.saturate({strategy: 'delta', maxRounds: budget.limits.maxRounds, maxFacts: budget.limits.maxFacts});
    return {converged: m.converged !== false, rounds: m.rounds};
  } catch (e) {
    if (/Fact limit exceeded/.test(e.message)) return {converged: false, reason: 'facts'};
    throw e;
  }
}

/** The wanted relations of a closure, from soplab's claim store (sign +1 positive evidence, -1 negative). */
function tablesOf(reasoner, wanted) {
  const tables = new Map([...wanted].map(k => [k, []]));
  for (const rec of reasoner.store.values()) {
    const key = `${rec.atom.sign === -1 ? 'n' : 'p'}|${rec.atom.pred}`;
    if (tables.has(key)) tables.get(key).push(rec.atom.args);
  }
  return tables;
}

/** Depth and stored facts of the first derivation of a ground atom (the oracle's `explain` shape). */
function proofOf(reasoner, atom) {
  const rec = reasoner.store.get(atom);
  const seen = new Set();
  const visit = record => {
    if (!record || seen.has(record.key)) return {depth: 0, uses: []};
    seen.add(record.key);
    const rule = record.proofs.find(p => p.kind === 'rule');
    if (!rule) return {depth: 0, uses: [record.atom]};
    const subs = (rule.premises ?? []).map(k => (typeof k === 'string' ? visit(reasoner.store.claims.get(k)) : {depth: 0, uses: []}));
    return {depth: 1 + Math.max(0, ...subs.map(s => s.depth)), uses: subs.flatMap(s => s.uses)};
  };
  return rec ? visit(rec) : {depth: 0, uses: []};
}

export function makeEngine(options = {}) {
  return {
    id: 'datalog-soplab',
    modes: ['select', 'exists', 'count', 'every', 'explain', 'plan', 'abduce'],
    ceilings: {maxRounds: {max: 100_000, default: 1000}, maxFacts: {max: 5_000_000, default: 1_000_000}, maxNodes: {max: 1_000_000, default: 50_000}},

    closure(job) {
      const t0 = performance.now();
      const {reasoner} = load(job.program, job.facts);
      const s = saturate(reasoner, job.budget);
      return {tables: tablesOf(reasoner, job.wanted), exhausted: s.converged ? null : {reason: s.reason ?? 'rounds'}, state: {reasoner, loadMs: Math.round(performance.now() - t0)}};
    },

    explain({state, qp, outcome}) {
      const leaf = qp.alts[0]?.leaves[0];
      if (qp.alts.length !== 1 || qp.alts[0].leaves.length !== 1 || leaf.kind !== 'atom' || leaf.mode !== 'pos') throw new NotExpressibleError(['explain_shape'], 'explain by soplab needs a single positive atom');
      const row = outcome.rows.find(r => !r.both) ?? outcome.rows[0];
      const sub = t => (typeof t === 'object' && t !== null && 'var' in t ? row.row[strip(t.var)] : t);
      if (leaf.args.some(t => typeof t === 'object' && !(strip(t.var) in row.row))) throw new NotExpressibleError(['explain_shape'], 'explain by soplab needs every variable of the atom in the answer');
      const atom = {kind: 'atom', pred: leaf.p, args: leaf.args.map(sub), sign: 1};
      const d = proofOf(state.reasoner, atom);
      return {depth: d.depth, uses: d.uses.map(showAtom)};
    },

    special({program, q, qp, budget}) {
      if (q.mode === 'plan') {
        const goalAlts = conditionAlts(q.wire.fields.filter(f => f.key === 'where'), q.wire.id);
        const goal = lowerPlanning(program, goalAlts.map(leaves => ({leaves})));
        const text = lowerProgram({...program, aggregates: []}, program.facts) + goal;
        const parsed = parseSOP(text);
        const r = planParsed(parsed, {maxExpansions: Math.min(budget.limits.maxNodes, options.maxExpansions ?? Infinity)});
        if (!r.found) return r.exhausted ? {status: 'no_plan', complete: true} : {status: 'budget_exhausted', complete: false, reason: 'nodes'};
        return {status: 'plan_found', complete: true, plan: {steps: r.path.length, cost: r.cost, names: r.path.map(x => x.transition)}, used: [...new Set(r.path.map(x => x.transition))].map(id => ({id, version: 1}))};
      }
      // abduce
      const wanted = wantedRelations(qp);
      const holdsWith = extra => {
        const {reasoner} = load(program, program.facts, extra);
        const s = saturate(reasoner, budget);
        if (!s.converged) throw Object.assign(new Error('closure cut'), {cut: s});
        const ev = evidenceFromTables(tablesOf(reasoner, wanted));
        const out = evaluatePart(qp, ev, {ev, stored: new Map(), budget: READ_BUDGET, notes: new Set()});
        return out.rows.length > 0 && ['supported', 'both'].includes(out.status);
      };
      try {
        return abduceAll({hypotheses: program.hypotheses, budget, limit: q.limit, holdsWith});
      } catch (e) {
        if (e.cut) return {status: 'budget_exhausted', complete: false, reason: e.cut.reason ?? 'rounds'};
        throw e;
      }
    }
  };
}

const defaultEngine = makeEngine();

export const available = async () => (fs.existsSync(new URL('./vendor/index.mjs', import.meta.url)) ? {ok: true, version: 'sop-reasoning-lab 0.4.0 (vendored)'} : {ok: false, reason: 'vendored soplab engine missing'});

/** Answer a problem {theory | handle, query, requested?} (proposal 5.2, 5.3). `options`: `conditional: false`. */
export function ask(problem, budget = {}, options = {}) {
  return askWith(defaultEngine, problem, budget, options);
}

export {prepare};
export const update = updateHandle;

export const datalogSoplab = {...capabilities, capabilities, available, prepare, ask, update};
export default datalogSoplab;
