/**
 * The knowledge-wire path from a memory to the oracle (DS004 "Knowledge wires", DS005, DS006 "Completeness under partial retrieval").
 *
 * A base memory keeps its rules, defaults, aggregates, integrity constraints and predicate declarations as circuits and its facts in the
 * repository. `Theory` holds the circuits without their facts, indexed by head predicate. `askMemory` answers one query circuit over a
 * memory: it takes the rules that can reach the query, retrieves the facts those rules and the query can use (`SliceRetrieval`), hands
 * the oracle (`reasoning/strategies/js-reference`) exactly that slice as wires, and lets `judgeWire` decide, from the oracle's own
 * `sensitivity` block, whether the answer may be given over a slice that could not be proven complete (R-P1 to R-P5). The whole theory
 * never goes to the engine.
 *
 * Facts that live in the repository are not read from the circuits. The few fact wires the repository cannot store (an arity outside 1 to
 * 4) stay in the theory and join every slice.
 */
import {parse, tokens, parseCondition, leaves} from '../../sop/knowledge/lexical.mjs';
import {ProgramError} from '../strategies/js-reference/values.mjs';
import {routedAsk} from '../router/index.mjs';
import {Lowering, factWire} from '../bridge/lower.mjs';
import {StrategyRegistry} from '../../memory/strategies.mjs';
import {instant, interval} from '../../lib/time.mjs';
import {digest} from '../../lib/util.mjs';
import {SliceRetrieval} from './retrieval.mjs';
import {RepositorySource} from './source.mjs';
import {alternatives, equalityDomains, bindDomains} from './demand.mjs';
import {readForms} from '../strategies/js-reference/forms.mjs';
import {answerOverSlice} from './answer.mjs';

import {conditionMisuses} from './condition-misuse.mjs';
/** The query modes answered from a slice: the others read the whole memory (or are `incomplete` when it does not fit). */
export const SLICED_MODES = Object.freeze(['select', 'exists', 'count', 'explain', 'every']);

const f1 = (w, key) => w.fields.find(f => f.key === key);
const value = (w, key) => f1(w, key)?.value.trim() ?? null;

/** A term token as a typed value: a ?variable stays, a quoted string is unquoted, an integer is a number, a symbol is its text. */
export function termValue(token) {
  if (token.startsWith('?')) return token;
  if (token.startsWith('"')) return JSON.parse(token);
  return /^-?\d+$/.test(token) ? Number(token) : token;
}

/** The non-atom `when` lines of a rule wire verbatim (`compute`, `compare`), or null when one is a group or another leaf kind the typed planners cannot carry. */
function extraWhen(w) {
  const out = [];
  for (const f of w.fields.filter(x => x.key === 'when')) {
    const tree = parseCondition(f, []);
    const kinds = leaves(tree).map(l => l.kind);
    if (kinds.every(k => k === 'atom')) continue;
    if ((f.block ?? []).length || kinds.length !== 1 || !['compute', 'compare'].includes(kinds[0])) return null;
    out.push(f.value.trim());
  }
  return out;
}

const typedAtom = leaf => ({p: leaf.p, a: leaf.terms.map(termValue), neg: leaf.neg === 'not'});

/** The atom of a `then` / `yields` / `holds` field: `[not] predicate term...`. */
function naturalAtom(text) {
  const t = tokens(text);
  const neg = t[0] === 'not';
  const rest = neg ? t.slice(1) : t;
  return {p: rest[0], a: rest.slice(1).map(termValue), neg};
}

const atomsOf = (w, key) => w.fields.filter(f => f.key === key).flatMap(f => leaves(parseCondition(f, []))).filter(l => l.kind === 'atom').map(typedAtom);

/** A condition field as the typed tree `alternatives` reads (groups of atoms; every other leaf is dropped). */
function conditionTree(node) {
  if (!node) return null;
  if (node.kind === 'all' || node.kind === 'any') {
    const children = node.children.map(conditionTree).filter(Boolean);
    return children.length ? {kind: node.kind, children} : null;
  }
  return node.kind === 'atom' ? typedAtom(node) : null;
}

export class Theory {
  /** @param circuits [{name, text}] in layer order: the circuits of a base memory, then those of a session */
  constructor(circuits) {
    this.recs = [];
    this.byHead = new Map();
    this.byId = new Map();
    this.predicates = new Map();
    this.closed = new Set();
    this.carry = [];
    this.storedFacts = 0;
    this.digest = digest(circuits.map(c => c.name + '\0' + c.text).join('\0'));
    for (const c of circuits) {
      const {wires, errors} = parse(c.text);
      if (errors.length) throw new ProgramError(errors[0].code, `circuit ${c.name}: ${errors[0].message} (line ${errors[0].line})`);
      for (const w of wires) this.add(w);
    }
  }

  add(w) {
    this.byId.set(w.id, w);
    this.revision = (this.revision ?? 0) + 1;
    switch (w.type) {
      case 'fact': {
        const holds = naturalAtom(value(w, 'holds'));
        if (holds.a.length >= 1 && holds.a.length <= 4) this.storedFacts++; else this.carry.push(w);
        return;
      }
      case 'predicate':
        this.predicates.set(w.id, w);
        if (value(w, 'closed') === 'true') this.closed.add(w.id);
        return;
      case 'lexeme': case 'entity': case 'reply': return;
      case 'rule': return this.rec(w, 'rule', naturalAtom(value(w, 'then')), atomsOf(w, 'when'));
      case 'default': return this.rec(w, 'default', naturalAtom(value(w, 'then')), atomsOf(w, 'when'), atomsOf(w, 'except'));
      case 'aggregate': return this.rec(w, 'aggregate', naturalAtom(value(w, 'yields')), atomsOf(w, 'over'));
      case 'integrity': {
        const witness = tokens(value(w, 'witness') ?? '')[0] ?? '?w';
        return this.rec(w, 'integrity', {p: 'violation', a: [w.id, witness], neg: false}, atomsOf(w, 'never'));
      }
      default: this.carry.push(w);
    }
  }

  rec(w, kind, head, body, except = []) {
    const call = kind === 'default' ? [{p: head.p, a: head.a, neg: false}] : [];
    const rec = {id: w.id, kind, wire: w, head, body: [...body, ...except, ...call], overrides: w.fields.filter(f => f.key === 'overrides').map(f => f.value.trim().replace(/^\$/, ''))};
    this.recs.push(rec);
    if (!this.byHead.has(head.p)) this.byHead.set(head.p, []);
    this.byHead.get(head.p).push(rec);
  }

  /** The records that can derive any predicate of `atoms`, to a fixpoint (the rule closure; defaults pull the defaults they override). */
  closure(atoms, {maxRules = 1024} = {}) {
    const chosen = new Map();
    let complete = true;
    const todo = atoms.map(a => a.p);
    const seen = new Set(todo);
    const take = rec => {
      if (chosen.has(rec.id)) return;
      if (chosen.size >= maxRules) { complete = false; return; }
      chosen.set(rec.id, rec);
      for (const a of [...rec.body, rec.head]) if (!seen.has(a.p)) { seen.add(a.p); todo.push(a.p); }
      for (const id of rec.overrides) { const other = this.recs.find(r => r.id === id); if (other) take(other); }
    };
    for (let i = 0; i < todo.length; i++) for (const rec of this.byHead.get(todo[i]) ?? []) take(rec);
    return {recs: [...chosen.values()], predicates: seen, complete};
  }

  /**
   * The `rule` circuits of the memory as the typed rules the chat Runtime plans with (`sop/lower.mjs` lowerRule: {id, if, then, valid,
   * ...}). The chat turn carries these into its slice the way the session query path does (askMemory); defaults, aggregates and
   * integrity constraints stay with the oracle path. Memoized.
   */
  chatRules() {
    // A rule whose `when` lines include a computation or a comparison (`compute ?years ?d minus ?b`, the derived measures of the knowledge)
    // carries those lines verbatim as `extra`; the oracle runs them, the typed planners see only the atoms. A rule with a grouped or
    // otherwise untyped condition is left to the knowledge-wire path (askMemory).
    this.typedRules ??= this.recs.filter(r => r.kind === 'rule' && r.body.every(a => !a.neg) && extraWhen(r.wire) !== null)
      .map(r => ({...this.asRule(r), ...(extraWhen(r.wire).length ? {extra: extraWhen(r.wire)} : {}), kind: 'rule', mode: 'logical', source: 'base-memory', valid: {from: -Infinity, until: Infinity}}));
    return this.typedRules;
  }

  /** As a typed rule, the shape `SliceRetrieval` plans from. */
  asRule(rec) { return {id: rec.id, if: rec.body, then: rec.head}; }
}

/** Memoizes theories by the digest of their circuits. */
export class TheoryCache {
  constructor(limit = 8) { this.limit = limit; this.map = new Map(); }
  get(circuits) {
    const key = digest(circuits.map(c => c.name + '\0' + c.text).join('\0'));
    if (this.map.has(key)) { const hit = this.map.get(key); this.map.delete(key); this.map.set(key, hit); return hit; }
    const theory = new Theory(circuits);
    this.map.set(key, theory);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    return theory;
  }
}

/** The decision for an answer of the oracle over a slice, from the packet's own `sensitivity` (R-P1 to R-P4). */
export function judgeWire({query, output, slice}) {
  const sensitivity = output.sensitivity ?? {monotone: false};
  const mode = query?.mode ?? 'select';
  const settled = slice.settled;
  // an explicitly requested engine that is not installed or cannot express the circuit: reported as it is, never judged as a partial answer (AGENTS.md rule 8)
  if (output.status === 'unsupported') return {accept: true, output, rule: 'unsupported'};
  const evidence = ['supported', 'both', 'refuted'].includes(output.status);
  const partial = {...output, complete: false, reason: 'partial_retrieval', retrieval_reasons: slice.complete ? ['inexact_view'] : slice.reasons};
  const withheld = {...partial, status: 'incomplete', ...(mode === 'count' ? {at_least: output.count ?? 0, bound: 'at_least'} : {}), ...(mode === 'count' ? {count: undefined} : {})};
  if (settled) return {accept: true, output, rule: 'complete_slice'};
  // A closed predicate's negation is asked as `not` or `absent` (lib/query-author/runtime.mjs): `refuted` there is a proof of the atom
  // itself, as monotone as any other evidence (R-P1); only an answer that may rest on the absence is withheld.
  if (!sensitivity.monotone && output.status === 'refuted' && sensitivity.refutation_monotone) return {accept: true, output: slice.complete ? output : {...output, complete: false}, rule: 'R-P1 refutation'};
  if (!sensitivity.monotone) return {accept: false, output: withheld, rule: 'R-P2'};
  if (slice.complete) return {accept: true, output, rule: 'complete_inexact_view'};
  if (evidence && ['exists', 'explain'].includes(mode)) return {accept: true, output: {...output, complete: false}, rule: 'R-P1 monotone'};
  if (output.status === 'unknown' || output.status === 'budget_exhausted') return {accept: false, output: partial, rule: 'R-P2'};
  return {accept: false, output: partial, rule: 'R-P1 subset'};
}

const lowering = Object.assign(new Lowering(), {predicate: p => p});

/** The time window of a query circuit for the memory lookups (the oracle applies the exact semantics itself). */
function timeWindow(w) {
  const out = {asof: Infinity};
  try {
    if (value(w, 'at')) out.at = instant(value(w, 'at'));
    else if (value(w, 'during') || value(w, 'overlaps')) out.during = interval(value(w, 'during') ?? value(w, 'overlaps'));
    if (value(w, 'asof')) out.asof = instant(value(w, 'asof'));
  } catch { /* an unreadable time is the oracle's error to report; retrieval then filters nothing */ }
  return out;
}

/**
 * Answers a query circuit over a memory.
 * @param theory   a `Theory` (the circuits of the memory without their facts)
 * @param repo, session   the repository and the repository session whose visible facts are the memory
 * @param query    the query circuit text (a `query` wire, optional `policy` and supposed `fact` wires)
 * @param seed     the seed of `order random` (DS004 "Sampling"), passed to the StrategyRouter
 * @returns the oracle's packet with `retrieval` (R-P5): slice size, predicates, bounds, whether it is complete and why not
 */
export function askMemory({theory, repo, session, query, lexicon = null, registry = new StrategyRegistry(), strategy = 'hybrid', limits = {}, budget = {}, reasoning = 'auto', verify = 'auto', verifyBudget = {}, seed = Date.now()}) {
  const {wires: qWires, errors} = parse(query);
  if (errors.length) throw new ProgramError(errors[0].code, `query: ${errors[0].message} (line ${errors[0].line})`);
  const qw = qWires.find(w => w.type === 'query');
  const mode = qw ? (value(qw, 'mode') ?? 'select') : 'select';
  const sliced = Boolean(qw) && SLICED_MODES.includes(mode);
  const lim = {maxShards: 256, maxGoals: 256, maxRules: 1024, ...limits};
  const window = timeWindow(qw ?? {fields: []});
  const conditionAtoms = qw ? qw.fields.filter(f => ['where', 'scope'].includes(f.key))
    .flatMap(f => leaves(parseCondition(f, []))).filter(l => l.kind === 'atom').map(l => ({...typedAtom(l), absent: l.neg === 'absent'})) : [];
  const domainSource = new RepositorySource({repo, session, registry, strategy, query: {asof: window.asof}, limits: lim});
  const guard = conditionMisuses({theory, atoms: conditionAtoms, source: domainSource, localWires: qWires, lexicon,
    maxLookups: Math.min(128, lim.maxLookups ?? 128), maxProbes: Math.min(2048, lim.maxProbes ?? 2048)});
  const malformed = guard.problems.find(p => p.reason === 'arity_mismatch');
  if (malformed) throw new ProgramError('arity_mismatch', malformed.condition, qw.id);
  if (guard.problems.length) return {status: 'unknown', complete: !guard.problems.some(p => p.reason === 'domain_check_incomplete'), reason: 'condition_misuse', misuses: guard.problems,
    rows: [], used: [], notes: [], strategy: null, guarantee: 'exact', condition_guard: guard.diagnostics,
    route: {requested: reasoning, chosen: null, reason: 'condition_misuse', fallback: null}};

  let conjunctions, closure;
  if (sliced) {
    const trees = qw.fields.filter(f => f.key === 'where' || f.key === 'scope').map(f => conditionTree(parseCondition(f, []))).filter(Boolean);
    const atoms = trees.flatMap(function flat(t) { return t.children ? t.children.flatMap(flat) : [t]; });
    conjunctions = bindDomains(alternatives(trees) ?? atoms.map(a => [a]), equalityDomains(qw.fields.some(f => f.key === 'compare') ? readForms(qw).compares : []));
    closure = theory.closure(atoms, {maxRules: lim.maxRules});
  } else {
    // modes of work read the whole memory: every declared relation is scanned, and the answer is incomplete when the memory does not fit
    conjunctions = [...theory.predicates.entries()].map(([id, w]) => [{p: id, a: Array.from({length: predicateArity(w)}, (_, i) => '?v' + i), neg: false}]).filter(c => c[0].a.length >= 1 && c[0].a.length <= 4);
    closure = {recs: theory.recs, predicates: new Set(theory.predicates.keys()), complete: true};
  }

  const source = new RepositorySource({repo, session, registry, strategy, query: window, limits: lim});
  const retrieval = new SliceRetrieval({source, conjunctions, rules: closure.recs.map(r => theory.asRule(r)), rulesComplete: closure.complete, limits: lim, strategy});
  retrieval.expand();
  const describe = {query: {mode}, strategy, goals: [], steps: []};
  const widen = () => (retrieval.widen() ? Object.defineProperty(retrieval.result(describe), 'widen', {enumerable: false, value: widen}) : null);
  const first = Object.defineProperty(retrieval.result(describe), 'widen', {enumerable: false, value: widen});

  const declared = new Set([...closure.predicates, ...conjunctions.flat().map(a => a.p)]);
  const base = [
    ...closure.recs.map(r => r.wire),
    ...[...declared].map(p => theory.predicates.get(p)).filter(Boolean),
    ...theory.carry, ...extraWires(theory, closure.recs),
  ];
  const unique = [...new Map(base.map(w => [w.id, w])).values()];
  // The engine is chosen by the StrategyRouter (reasoning/router, DS006 "Routing rules"): `reasoning auto` by the features of the slice, a
  // strategy id exactly that engine (AGENTS.md rule 8). The oracle stays the product route and the verifier.
  const solve = memory => routedAsk({
    handle: {kind: 'js-reference-handle', knowledge: '', wires: [...unique, ...memory.facts.map(f => factWire(lowering, f.id, f, f.kind === 'assumed' ? 'supposed' : 'observed'))]},
    query, queryWires: qWires, requested: reasoning, verify, verifyBudget, budget, seed,
  });

  const answer = answerOverSlice({memory: first, query: {mode}, solve, decide: judgeWire});
  return {...answer, condition_guard: guard.diagnostics};
}

/** The defaults named by `overrides` are in the closure already; nothing else rides along. Kept as a hook for governance wires. */
const extraWires = () => [];

function predicateArity(w) {
  const args = value(w, 'args');
  if (args && args !== 'none') return tokens(args).length;
  return w.fields.filter(f => f.key === 'role').length;
}

