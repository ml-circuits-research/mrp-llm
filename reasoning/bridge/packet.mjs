/**
 * The one result packet of the reasoning operations (proposal 5.3, DS006 "Result packet"). `abduce`, `diagnose`, `plan`,
 * `simulate` (reasoning/bridge/operations.mjs) and `associate`, `induce`, `analogize` (reasoning/learning.mjs) answer in the
 * packet the oracle (reasoning/strategies/js-reference) returns: `status`, `complete`, `guarantee`, `budget {limit, used, exhausted,
 * reason, partial}`, `used` (one sufficient support set, `{id, version}`), `proof` (the DAG of the oracle, or a DAG built from the
 * typed facts of a relational answer), `notes`, `ignored`, `strategy`, plus the operation's own field named as in the oracle
 * (`hypotheses` and `explanations`, `plan`, `missing`, `tests`) or `candidates`, `patterns`, `mappings` for the case operations.
 * No second format exists: there is no `kind`, `epistemic`, `search` or `assurance` field and no per-operation packet constructor.
 */
import {Budget, BudgetStop} from '../strategies/js-reference/budget.mjs';
import {atomText} from '../strategies/js-reference/values.mjs';

export {Budget, BudgetStop};

/** The ceilings the runtime asks for, unless a policy or the caller tightens them (the oracle's ceilings are the upper bound). */
export const OPERATION_LIMITS = Object.freeze({maxNodes: 5000, maxDepth: 8, maxHypotheses: 64, maxCandidates: 512, maxPlans: 1, maxRounds: 32, maxFacts: 10000, maxJoins: 30000, maxAssignments: 100000, timeoutMs: 3000});

/** The budget of one operation: the caller's limits over the runtime defaults, never above the oracle's ceilings. */
export const operationBudget = (limits = {}) => new Budget({...OPERATION_LIMITS, ...limits});

/** One unit of work against the budget: false once a ceiling is hit (the operation then reports itself incomplete). */
export function step(budget) {
  try { budget.node(); return true; } catch (e) { if (e instanceof BudgetStop) return false; throw e; }
}

/** The text of a typed atom `{p, a, neg}` as the packet writes atoms. */
export const atomOf = atom => atomText(atom.neg === true, atom.p, atom.a);

/** The packet envelope: the native fields every operation carries, then the operation's own fields. */
export function operationPacket(budget, fields = {}) {
  const {status, complete = true, guarantee = 'exact', used = [], ...rest} = fields;
  const exhausted = budget.stop !== null;
  return {status, complete: complete && !exhausted, guarantee: exhausted && guarantee === 'exact' ? 'bounded' : guarantee, budget: budget.snapshot(false), used, notes: [], ignored: [], strategy: 'js-reference', ...rest};
}

/** A budget stop as the packet of the operation that was cut: `budget_exhausted` with the reason, never `unknown`. */
export const stoppedPacket = (budget, stop, fields = {}) => operationPacket(budget, {status: 'budget_exhausted', complete: false, reason: stop.reason, ...fields});

/** `used` of a relational answer: the stored facts and the rules its proof took part in (one sufficient support set). */
export function usedOfTyped(proof = []) {
  const seen = new Map();
  for (const fact of proof) {
    const ref = fact.kind === 'derived' ? fact.rule : fact.id;
    if (ref !== undefined) seen.set(ref, {id: ref, version: 1});
  }
  return [...seen.values()];
}

/** The proof DAG of the oracle (nodes {id, atom, kind, source, premises}, roots) built from the typed proof facts of a relational answer. */
export function proofDagOfTyped(proof = [], answerIds = null) {
  const ids = new Map(proof.map((fact, i) => [fact.id, 'n' + (i + 1)]));
  const nodes = proof.map(fact => ({
    id: ids.get(fact.id), atom: atomOf(fact.atom), kind: fact.kind === 'derived' ? 'rule' : fact.kind === 'assumed' ? 'assumption' : 'fact',
    source: {id: fact.kind === 'derived' ? fact.rule : fact.id, version: 1}, premises: (fact.from ?? []).map(id => ids.get(id)).filter(Boolean)
  }));
  const premises = new Set(nodes.flatMap(n => n.premises));
  const roots = (answerIds ?? proof.filter(fact => !proof.some(other => (other.from ?? []).includes(fact.id))).map(fact => fact.id)).map(id => ids.get(id)).filter(Boolean);
  return {nodes, roots: roots.length ? roots : nodes.filter(n => !premises.has(n.id)).map(n => n.id)};
}
