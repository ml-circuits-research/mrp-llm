/**
 * Certified state compression (VRC, `vendor/vrc`): find an encoding E, reduced laws G and a decoded observable D with
 * E(T(x)) = G(E(x)) for every action (and guards and the observation factoring through E), checked EXACTLY on rational polynomial
 * identities by the vendored certifier. The artifact is bound to a contract hash of the laws, guards and observable; initial
 * facts and the goal threshold are not in the contract, so one artifact serves a whole family of tasks (VRC: "reuse of one law").
 * An imported artifact is always re-certified; a stored `verified` flag is never evidence.
 */
import {performance} from 'node:perf_hooks';
import {Poly} from './vendor/vrc/poly.mjs';
import {discover} from './vendor/vrc/learner.mjs';
import {RuleOracle} from './vendor/vrc/oracle.mjs';
import {certify, modelJSON, modelFromJSON} from './vendor/vrc/certificate.mjs';
import {contract, hash, PROFILE} from './vendor/vrc/sop.mjs';

export const LEARNER_VERSION = 'vrc-search/0.3.0';
const GOAL = 'goal';

/** The minimal program object the vendored contract and certifier read (instead of VRC's own text format). */
export function programOf(model) {
  const transitions = new Map(model.actions.map(a => [a.id, {id: a.id, variables: model.variables, T: a.T, guards: a.guards, source: a.id, line: 0}]));
  const goals = new Map([[GOAL, {id: GOAL, actions: model.actions.map(a => a.id), H: [model.goal.H], observation: ['observe'], horizon: 1, entity: model.goal.entity, encoding: null}]]);
  return {profile: PROFILE, transitions, goals, encoders: new Map(), facts: [], factIndex: new Map()};
}

export const contractHashOf = model => hash(contract(programOf(model), GOAL));

/** Search an encoding within a budget; returns {status: 'VERIFIED', artifact, ms} or {status: 'NO_MODEL', reason, ms}. */
export function learn(model, {maxLatent = 8, maxMilliseconds = 15000, maxStates = 512} = {}) {
  const t = performance.now();
  const program = programOf(model);
  const found = discover(new RuleOracle(model.actions.map(a => ({id: a.id, T: a.T, guards: a.guards}))), [model.goal.H], {maxLatent, maxMilliseconds, maxStates});
  const ms = performance.now() - t;
  if (!found.success) return {status: 'NO_MODEL', reason: found.reason, ms};
  const certificate = certify(program, GOAL, found);
  if (!certificate.verified) throw new Error('internal error: an exact-rule candidate failed certification');
  return {status: 'VERIFIED', ms, artifact: {format: 'vrc-model/1', model: modelJSON(found), certificate, contract: contract(program, GOAL)}};
}

/** Import an artifact for this model: contract hash must match and the identities are recomputed. Throws on stale or invalid. */
export function importArtifact(artifact, model) {
  if (artifact?.format !== 'vrc-model/1') throw new TypeError('unsupported artifact format');
  const program = programOf(model);
  if (hash(contract(program, GOAL)) !== artifact.certificate.contractHash) throw new Error('stale artifact: laws, guards or the observable differ');
  const m = modelFromJSON(artifact.model);
  const certificate = certify(program, GOAL, m);
  if (!certificate.verified) throw new Error('artifact verification failed');
  return {model: m, certificate};
}

export {Poly};
