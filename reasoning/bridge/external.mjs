/**
 * The explicit external backends of the (former `advanced` route, removed), run through the strategies that supersede the retired SWI
 * and Z3 adapters: `backend prolog` is the `prolog-tabling` strategy and `backend z3` is `z3-smt-bounded` (its typed-constraint
 * module `ast.mjs`). A requested backend is never substituted (AGENTS.md rule 8): a missing binary is `unsupported` naming it with
 * `fallback: null`.
 *
 * Horn by Prolog. The answer, its proof and every query form come from the oracle (the packet of the runtime); the explicit
 * backend then solves the relational core of the same question, `where` over every variable with the forms removed, in SWI-Prolog
 * tabling and the two results must agree on the status and on the rows (the closure-agreement check of the retired adapter;
 * `backendAgreement` is reported, a disagreement on complete answers is an error).
 */
import {spawnSync} from 'node:child_process';
import {conditionAtoms} from '../../lib/conditions.mjs';
import {variable} from '../../lib/types.mjs';
import {contains} from '../../lib/time.mjs';
import {stable, assert} from '../../lib/util.mjs';
import {wireText} from '../../sop/knowledge/desugar.mjs';
import {prologTabling} from '../strategies/prolog-tabling/index.mjs';
import {NotExpressibleError} from '../strategies/js-reference/values.mjs';
import {swiplCommand} from '../strategies/prolog-tabling/swipl.mjs';
import {z3Command} from '../strategies/z3-smt-bounded/z3.mjs';
import {z3Decide, z3Optimize} from '../strategies/z3-smt-bounded/ast.mjs';
import {Program, reason, admissibleAssumptions} from './reason.mjs';
import {queryWire} from './lower.mjs';

const WHOLE = {from: -Infinity, until: Infinity};
const ready = command => { const r = spawnSync(command, ['--version'], {encoding: 'utf8', timeout: 5000}); return !r.error && r.status === 0 ? null : (r.error?.message ?? r.stderr ?? 'not runnable'); };

const unavailable = (backend, detail) => ({kind: 'reasoning', status: 'unsupported', backend, code: 'backend_unavailable', detail, complete: false, epistemic: 'undecided', proof: []});

/** The relational core of a query: the same `where`, every variable selected, the host forms removed. */
function plainQuery(q) {
  const vars = [...new Set(conditionAtoms(q.where).flatMap(a => a.a.filter(variable)))];
  return {...q, mode: 'select', select: vars, scope: undefined, compares: [], filters: [], rank: undefined, quantifier: undefined, order: undefined, span: undefined, measure: undefined, limit: 10000};
}

const rowsOf = answers => [...new Set(answers.map(a => stable(Object.fromEntries(Object.entries(a.binding).map(([k, v]) => [k.replace(/^\?/, ''), v])))))].sort();

export function hornProlog(q, memory, {assumptions = [], ...limits} = {}) {
  assert(q.at !== undefined, 'The Prolog adapter implements point-in-time queries; use JS for interval answers');
  const missing = ready(swiplCommand());
  if (missing) return unavailable('prolog', `swipl not available: ${missing}`);
  const scoped = memory.facts.filter(f => contains(f.valid, q.at)), timed = assumptions.filter(f => contains(f.valid, q.at));
  const {kept} = admissibleAssumptions(scoped, timed);
  const rules = memory.rules.filter(r => contains(r.valid ?? WHOLE, q.at));
  const answer = reason(q, {...memory, facts: scoped, rules}, {assumptions: kept, ...limits});
  // the closure-agreement check: the plain relational core in SWI-Prolog tabling and in the oracle
  const plain = plainQuery(q);
  const prog = new Program([...scoped, ...kept.map(a => ({...a, kind: 'observed'}))], rules);
  const qw = queryWire(prog.lowering, {where: plain.where, select: plain.select, at: q.at, mode: plain.select.length ? 'select' : 'exists'});
  let packet;
  try {
    packet = prologTabling.ask({handle: {kind: 'prolog-tabling-handle', knowledge: '', wires: [...prog.factWires, ...prog.ruleWires]}, query: wireText(qw) + '\n'}, {maxJoins: limits.maxJoins, maxRounds: limits.maxRounds});
  } catch (e) {
    if (e instanceof NotExpressibleError) return {kind: 'reasoning', status: 'unsupported', backend: 'prolog', code: 'explicit_backend_not_available_for_query', detail: e.message, complete: false, epistemic: 'undecided', proof: []};
    throw e;
  }
  const js = reason(plain, {...memory, facts: scoped, rules}, {assumptions: kept, ...limits});
  const decided = packet.status !== 'budget_exhausted' && js.complete !== false;
  const sameStatus = plain.select.length ? true : packet.status === js.status;
  const sameRows = plain.select.length ? stable(rowsOf((packet.rows ?? []).map(row => ({binding: row})))) === stable(rowsOf(js.answers)) : true;
  const agree = sameStatus && sameRows;
  assert(agree || !decided, 'Backend divergence on the portable Horn profile');
  return {...answer, backend: 'prolog', proofBackend: 'js-reference-derivation-checked-against-prolog-tabling', backendAgreement: agree, backendStrategy: 'prolog-tabling'};
}

export function constraintZ3(problem, options = {}) {
  const missing = ready(z3Command());
  if (missing) return unavailable('z3', `z3 not available: ${missing}`);
  return z3Decide(problem, options);
}

export function optimizeZ3(problem, options = {}) {
  const missing = ready(z3Command());
  if (missing) return unavailable('z3', `z3 not available: ${missing}`);
  return z3Optimize(problem, options);
}
