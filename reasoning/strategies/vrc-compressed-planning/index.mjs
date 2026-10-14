/**
 * vrc-compressed-planning: exact-rational numeric planning with certified state compression (VRC, `vrc03r.zip`, sop-vrc-reasoner
 * 0.3.0; the kernel is vendored unmodified under `vendor/`). The circuits are the numeric `action` of extension E2
 * (`sop/knowledge/numeric-action.mjs`): relational flags plus `next` and `guard` over exact rationals, and a plan query with
 * `observe` and `horizon`.
 *
 *   ask({theory | handle, query}, budget, options)   plan query; statuses plan_found | no_plan | budget_exhausted | unknown
 *   prepare(theory, {learning: 'off' | 'on-demand' | 'reuse', artifact?, query?})   parse once; with `on-demand` search a certified
 *                                            encoding (may take seconds; reported in timings.prepare) and keep it in the handle
 *   options.shadow: also run the uncompressed search and compare; a disagreement REVOKES the artifact (acceptance rule, 5.6)
 *
 * Honest limits (the proposal's weak column): existential unit-cost reachability only; at most 32 state coordinates; a bound of
 * the engine (horizon, node ceiling, rational size, wall clock) is `budget_exhausted` with a reason, never `no_plan`; a plan is
 * replayed in the ORIGINAL laws before it is returned. On a world without symmetry the encoding is the identity and the search
 * costs the same as the uncompressed one (VRC's guard-rich control: 111 states against 111, a loss once learning is counted).
 */
import {performance} from 'node:perf_hooks';
import {readProgram, buildModel} from './model.mjs';
import {learn, importArtifact, contractHashOf} from './compress.mjs';
import {makeRuntime, search, replay, MAX_HORIZON} from './search.mjs';
import {ProgramError, NotExpressibleError} from '../js-reference/values.mjs';

export {ProgramError, NotExpressibleError};

export const capabilities = {
  id: 'vrc-compressed-planning',
  features: ['plan', 'facts', 'zero_arity', 'budget', 'used', 'numeric_action', 'versions'],
  delivery: 'slice',
  limits: {max_wires: Infinity, max_arity: 6, max_state_coordinates: 32, integer_range: null, arithmetic: 'exact-rational'},
  guarantee: 'exact',
  provides: ['used', 'plan'],
  budgetKeys: ['maxNodes', 'maxDepth', 'timeoutMs'],
  determinism: 'deterministic',
  isolation: false
};

export async function available() { return {ok: true, origin: 'vendored vrc03r kernel'}; }

const REASON = {wall: 'wall', nodes: 'nodes', numeric_range: 'numeric_range', horizon: 'horizon'};

/** Parse once. `learning`: off (full search only), on-demand (learn and certify an encoding), reuse (import `artifact` only). */
export function prepare(theory, {learning = 'off', artifact = null, learn: learnOptions = {}, query = null} = {}) {
  const t0 = performance.now();
  const knowledge = typeof theory === 'string' ? theory : theory?.knowledge ?? '';
  const wires = theory?.wires ?? readProgram(knowledge, 'knowledge');
  const handle = {kind: 'vrc-handle', knowledge, wires, artifact: null, certificate: null, contractHash: null, cacheStatus: 'DISABLED', timings: {}, notes: []};
  if (query !== null && learning !== 'off') attachArtifact(handle, readProgram(query, 'query'), learning, artifact, learnOptions);
  handle.timings.prepare = Math.round(performance.now() - t0);
  return handle;
}

function attachArtifact(handle, queryWires, learning, artifact, learnOptions) {
  const model = buildModel(handle.wires, queryWires);
  handle.contractHash = contractHashOf(model);
  try {
    if (artifact) {
      const imported = importArtifact(artifact, model);
      Object.assign(handle, {artifact: imported.model, certificate: imported.certificate, cacheStatus: 'HIT', artifactJSON: artifact});
    } else if (learning === 'on-demand') {
      const r = learn(model, learnOptions);
      handle.timings.learn = Math.round(r.ms);
      if (r.status === 'VERIFIED') {
        const imported = importArtifact(r.artifact, model);
        Object.assign(handle, {artifact: imported.model, certificate: imported.certificate, cacheStatus: 'LEARNED', artifactJSON: r.artifact});
      } else { handle.cacheStatus = 'NO_MODEL_WITHIN_BUDGET'; handle.notes.push('no_model:' + r.reason); }
    }
  } catch (e) { handle.cacheStatus = 'REJECTED'; handle.notes.push('artifact_rejected:' + e.message); }
}

/** The `used` list: the actions of the plan (each at version 1) plus the facts that gave the initial state. */
const usedOf = (model, path) => [...new Set(path)].map(id => ({id, version: 1})).concat(model.evidence.map(id => ({id, version: 1})));

function packet(extra) {
  return {strategy: 'vrc-compressed-planning', guarantee: 'exact', ...extra};
}

export function ask(problem, budgetArg = {}, options = {}) {
  const t0 = performance.now();
  const handle = problem.handle ?? prepare(problem.theory ?? '');
  const queryWires = readProgram(problem.query, 'query');
  const model = buildModel(handle.wires, queryWires);
  const requested = problem.requested ?? null;
  const route = {requested, chosen: 'vrc-compressed-planning', reason: requested ? 'explicit request' : 'direct call', fallback: null};
  if (model.missing.length) {
    return packet({status: 'unknown', complete: true, reason: 'missing_state', missing: model.missing.map(v => `state ${model.goal.entity} ${v}`), used: [], route, budget: {}, notes: [], timings: {total: Math.round(performance.now() - t0)}});
  }
  if (!handle.artifact && options.learning && options.learning !== 'off') attachArtifact(handle, queryWires, options.learning, options.artifact ?? null, options.learn ?? {});
  else if (handle.artifact && handle.contractHash !== contractHashOf(model)) { handle.artifact = null; handle.cacheStatus = 'STALE'; handle.notes.push('stale: laws changed since the artifact was certified'); }

  const maxDepth = Math.min(model.horizon ?? budgetArg.maxDepth ?? model.policy.maxDepth ?? 20, MAX_HORIZON);
  const limits = {maxDepth, maxNodes: Math.min(budgetArg.maxNodes ?? model.policy.maxNodes ?? 2_000_000, 10_000_000), maxMilliseconds: budgetArg.timeoutMs ?? model.policy.timeoutMs ?? 30000};
  const full = () => search(model, makeRuntime(model), limits);
  const compressed = handle.artifact ? () => search(model, makeRuntime(model, handle.artifact), limits) : null;
  const backend = compressed ? 'vrc' : 'full';
  const result = (compressed ?? full)();
  const timings = {search: +result.ms.toFixed(3), ...handle.timings};
  const notes = [...handle.notes];

  let shadow = null;
  if (options.shadow && compressed) {
    const ref = full();
    shadow = {status: ref.status, depth: ref.depth, unique: ref.unique, ms: Math.round(ref.ms)};
    const agree = ref.status === result.status && ref.depth === result.depth;
    if (!agree && ref.status !== 'BUDGET') {
      handle.artifact = null; handle.cacheStatus = 'REVOKED'; handle.revoked = 'shadow disagreement';
      return packet({status: 'budget_exhausted', complete: false, reason: 'shadow_disagreement', used: [], shadow, route, budget: {}, notes: [...notes, 'artifact_revoked'], timings});
    }
  }

  const stats = {backend, cacheStatus: handle.cacheStatus, dimension: result.dimension, fullDimension: model.variables.length, unique: result.unique, expanded: result.expanded, generated: result.generated, merged: result.merged, contractHash: handle.contractHash};
  const budget = {limit: limits, used: {nodes: result.unique, ms: Math.round(result.ms)}, exhausted: result.status === 'BUDGET', reason: result.reason ?? null, partial: false};
  const common = {route, budget, stats, shadow, notes, ignored: [], retrieval: {complete: true, truncated: false, keyed: false, steps: 0, wires: handle.wires.length, probes: 0}};
  const total = () => ({...timings, total: Math.round(performance.now() - t0)});

  if (result.status === 'FOUND') {
    const witness = replay(model, result.path);
    if (!witness.verified) {
      handle.artifact = null; handle.cacheStatus = 'REVOKED'; handle.revoked = 'replay failure';
      return packet({status: 'budget_exhausted', complete: false, reason: 'replay_failure', used: [], ...common, timings: total()});
    }
    return packet({status: 'plan_found', complete: true, plan: {steps: result.path.length, cost: result.path.length, names: result.path}, witness: {verified: true, value: witness.value}, used: usedOf(model, result.path), ...common, timings: total()});
  }
  if (result.status === 'NOT_FOUND') return packet({status: 'no_plan', complete: true, used: [], ...common, timings: total()});
  return packet({status: 'budget_exhausted', complete: false, reason: REASON[result.reason] ?? result.reason, used: [], ...common, timings: total()});
}

export const vrcCompressedPlanning = {...capabilities, capabilities, available, prepare, ask};
export default vrcCompressedPlanning;
