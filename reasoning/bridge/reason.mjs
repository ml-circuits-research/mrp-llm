/**
 * The runtime's Horn question over the oracle. Facts, rules and the lowered `query` of the runtime (lib/types.mjs shapes) are
 * lowered to knowledge wires (lower.mjs), the oracle (reasoning/strategies/js-reference) closes and reads them, and the result is
 * projected back to the runtime's packet: answers with their validity, the proof as typed facts (derived facts carry their rule
 * and premises), `depth`, `explanation`, `conflictedAnswers`, `counterexamples`, the statuses `mixed_temporal` and `not_computable`.
 *
 * Time is the one place where the oracle and the runtime differ in method. The oracle evaluates at an instant (snapshot); the
 * runtime asks over intervals. This module cuts an interval question at every validity boundary of the facts and rules that the
 * question can depend on and asks the oracle once per part (the oracle's own interval mode does the same); a row holds when it
 * holds in some part, its validity is the intersection of the validities of the facts it used, and a claim and its negation are
 * `both` when they hold in the same part and `mixed_temporal` when they hold only in different parts.
 */
import {atomKey, variable} from '../../lib/types.mjs';
import {conditionAtoms} from '../../lib/conditions.mjs';
import {stable, digest} from '../../lib/util.mjs';
import {sampleAnswers} from '../sample.mjs';
import {intersect, contains, formatTime} from '../../lib/time.mjs';
import {ask} from '../strategies/js-reference/index.mjs';
import {quantifiedStatus, numericValue} from '../strategies/js-reference/forms.mjs';
import {evaluateExpression} from '../../sop/expression.mjs';
import {Lowering, factWire, ruleWire, queryWire, conditionField, lowerForms, oppositeConditions} from './lower.mjs';

const WHOLE = {from: -Infinity, until: Infinity};
const MAX_PARTS = 512;
const DAY = 86400000;
const isMarker = n => n.absent !== undefined;

/** The value a time variable takes: the matched interval, or its start, end or length in days (`measure`). */
export function spanValue(valid, q) {
  if (q.measure === 'start') return formatTime(valid.from);
  if (q.measure === 'end') return formatTime(valid.until);
  if (q.measure === 'duration') {
    const until = Math.min(valid.until, q.now ?? Date.now());
    return Number.isFinite(valid.from) && until >= valid.from ? Math.floor((until - valid.from) / DAY) : 'unbounded';
  }
  return formatTime(valid.from) + ' ' + formatTime(valid.until);
}

/** A fact that rests on an unproven supposition is not evidence: its wire is `status supposed`. */
export const isAssumed = f => f.kind === 'assumed';

/** Admitted assumptions: an assumption whose contrary atom is an admitted fact is defeated and never enters the closure. */
export function admissibleAssumptions(facts, assumptions = []) {
  if (!assumptions.length) return {kept: [], defeated: []};
  const admitted = new Set(facts.map(f => atomKey(f.atom)));
  const kept = [], defeated = [];
  for (const assumption of assumptions) {
    const contrary = {...assumption.atom, neg: !assumption.atom.neg};
    (admitted.has(atomKey(contrary)) ? defeated : kept).push(assumption);
  }
  return {kept, defeated};
}

/** The lowered facts and rules, shared by every part of one question. */
export class Program {
  constructor(facts, rules, closed = []) {
    this.lowering = new Lowering();
    this.closedWires = closed.map(({id, args}) => ({id: this.lowering.predicate(id), type: 'predicate', line: 0, fields: [
      {key: 'args', value: args.map((type, i) => `${['subject', 'object', 'topic', 'recipient'][i]}:${type}`).join(' '), line: 0, block: []},
      {key: 'closed', value: 'true', line: 0, block: []}
    ]}));
    this.rules = rules;
    this.ruleById = new Map(rules.map(r => [r.id, r]));
    let prefix = 'zf';
    while (rules.some(r => r.id.startsWith(prefix))) prefix += 'x';
    this.base = new Map();
    this.facts = facts.map((f, i) => (f.id === undefined ? {...f, id: 'local_' + i} : f));
    this.factWires = this.facts.map((f, i) => {
      const id = prefix + i;
      this.base.set(id, f);
      return factWire(this.lowering, id, f, isAssumed(f) ? 'supposed' : 'observed');
    });
    this.ruleWires = rules.map(r => ruleWire(this.lowering, r));
    this.byId = new Map(this.facts.map(f => [f.id, f]));
    this.cache = new WeakMap();
    // the position of a fact in the closure, as a sortable key: stored facts as given, then derived facts by round (derivation depth),
    // rule and premises, which is the order a bottom-up closure appends them
    this.position = new Map(this.facts.map((f, i) => [f.id, [0, i]]));
    this.ruleIndex = new Map(rules.map((r, i) => [r.id, i]));
    this.depth = new Map();
  }

  /** The typed fact of an evidence node: a stored fact as given, a derived fact rebuilt with its rule, premises and validity. */
  fact(node) {
    if (this.cache.has(node)) return this.cache.get(node);
    let f;
    if (node.kind === 'fact') f = this.base.get(node.factId);
    else {
      const prem = node.premises.filter(p => !isMarker(p)).map(p => this.fact(p));
      const rule = this.ruleById.get(node.ruleId);
      const valid = intersect(rule?.valid ?? WHOLE, ...prem.map(x => x.valid)) ?? WHOLE;
      const atom = {p: this.lowering.unpredicate(node.p), a: [...node.args], neg: node.neg};
      const key = stable([atomKey(atom), valid.from === -Infinity ? 'beginning' : valid.from, valid.until === Infinity ? 'open' : valid.until]);
      f = {atom, valid, id: 'd_' + digest(key).slice(0, 32), kind: 'derived', rule: node.ruleId, from: prem.map(x => x.id)};
      this.byId.set(f.id, f);
      if (!this.position.has(f.id)) {
        const depth = 1 + Math.max(0, ...prem.map(x => this.depth.get(x.id) ?? 0));
        this.depth.set(f.id, depth);
        this.position.set(f.id, [1, depth, this.ruleIndex.get(node.ruleId) ?? 0, ...prem.flatMap(x => this.position.get(x.id) ?? [])]);
      }
    }
    this.cache.set(node, f);
    return f;
  }

  evidence(prem) { return prem.filter(p => !isMarker(p)).map(p => this.fact(p)); }

  /** Predicates a question can depend on: the ones it names and, backwards, the bodies of the rules that conclude them. */
  relevant(conditions) {
    const out = new Set(conditionAtoms(conditions).map(a => a.p));
    for (let changed = true; changed;) {
      changed = false;
      for (const r of this.rules) if (out.has(r.then.p)) for (const a of r.if) if (!out.has(a.p)) { out.add(a.p); changed = true; }
    }
    return out;
  }

  /** The instants an interval question is evaluated at: its start and every validity boundary inside it of what it can depend on. */
  instants(span, conditions) {
    const preds = this.relevant(conditions), cuts = new Set();
    const mark = valid => { for (const t of [valid.from, valid.until]) if (Number.isFinite(t) && t > span.from && t < span.until) cuts.add(t); };
    for (const f of this.facts) if (preds.has(f.atom.p) && f.valid) mark(f.valid);
    for (const r of this.rules) if (preds.has(r.then.p) && r.valid) mark(r.valid);
    const list = [span.from, ...[...cuts].sort((a, b) => a - b)];
    return {instants: list.slice(0, MAX_PARTS), truncated: list.length > MAX_PARTS};
  }
}

const limitsOf = limits => Object.fromEntries(['maxRounds', 'maxFacts', 'maxJoins'].filter(k => Number.isSafeInteger(limits?.[k])).map(k => [k, limits[k]]));

/** Ask the oracle one question at one instant. Returns {packet, part} (part: the raw outcome, with `reread`). */
function askAt(prog, t, {where, scope = [], forms, mode = 'select'}, limits) {
  const rulesAt = prog.ruleWires.filter((w, i) => contains(prog.rules[i].valid ?? WHOLE, t));
  const handle = {kind: 'js-reference-handle', knowledge: '', wires: [...prog.closedWires, ...prog.factWires, ...rulesAt]};
  const q = queryWire(prog.lowering, {where, scope, at: t, mode});
  const packet = ask({handle, queryWires: [q], forms, detail: true, conditional: false}, limitsOf(limits));
  return {packet, part: packet.detail?.parts?.[0] ?? null};
}

const newAcc = () => ({exhausted: false, truncated: false, notComputable: false, filtered: 0, compared: false, rounds: 0, derived: 0, filteredEvidence: []});
function noteBudget(acc, packet) {
  // a partial positive answer (`complete: false`) and a bare stop (`budget_exhausted`) both leave the question incomplete
  if (packet.budget?.exhausted || packet.status === 'budget_exhausted') acc.exhausted = true;
  acc.rounds = Math.max(acc.rounds, packet.budget?.used?.maxRounds ?? 0);
  acc.derived = Math.max(acc.derived, packet.budget?.used?.maxFacts ?? 0);
}

/** Join rows of the conditions over every instant: [{binding, valid, evidence, both}] and the opposing rows of a ground claim. */
function collect(prog, q, instants, {where, scope = [], forms, mode = 'select', opposite = false}, limits, acc) {
  const during = q.during ?? WHOLE;
  const rows = [], opposing = [], memberLists = [];
  const seen = new Map(), seenOpp = new Map();
  for (const t of instants) {
    const {packet, part} = askAt(prog, t, {where, scope, forms, mode}, limits);
    noteBudget(acc, packet);
    if (!part) continue;
    const out = part.outcome;
    if (out.state) {
      acc.filtered += out.state.filtered; acc.compared ||= out.state.compared; acc.notComputable ||= out.state.notComputable;
      if (out.state.compared) for (const m of out.state.afterFilters ?? []) acc.filteredEvidence.push(...prog.evidence(m.prem).map(f => f.id));
    }
    if (out.status === 'not_computable') acc.notComputable = true;
    if (out.memberList) memberLists.push(out.memberList);
    const add = (list, target, keys, withBoth) => {
      for (const m of list) {
        const evidence = prog.evidence(m.prem);
        const valid = intersect(during, ...evidence.map(f => f.valid));
        if (!valid) continue;
        const binding = prog.lowering.binding(m.env);
        const key = stable([binding, valid]);
        const row = {binding, valid, evidence: evidence.map(f => f.id), facts: evidence, ...(withBoth ? {both: m.both} : {})};
        // the same answer through a clean derivation and through a contradicted one is reported clean
        if (keys.has(key)) { const at = keys.get(key); if (withBoth && target[at].both && !m.both) target[at] = row; continue; }
        keys.set(key, target.length);
        target.push(row);
      }
    };
    add(out.matches ?? [], rows, seen, true);
    if (opposite) {
      const opp = part.reread(oppositeConditions(where).map(c => conditionField(prog.lowering, 'where', c)), 'select', []);
      add(opp.matches ?? [], opposing, seenOpp, false);
    }
  }
  // rows found part by part come in chronological order; the runtime lists them in the order of the facts they used
  if (instants.length > 1) {
    const at = r => r.evidence.flatMap(id => prog.position.get(id) ?? [Infinity]);
    const cmp = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };
    rows.sort((x, y) => cmp(at(x), at(y)));
    opposing.sort((x, y) => cmp(at(x), at(y)));
  }
  return {rows, opposing, memberLists};
}

const groundConditions = where => conditionAtoms(where).every(a => a.a.every(v => !variable(v)));
const notComputable = (q, reason) => ({status: 'not_computable', kind: q.mode, query: q, conflictedAnswers: [], answers: [], proof: [], depth: 0, complete: true, truncated: false, reason,
  assurance: 'The host understood the question but cannot compute it from the values it has.'});

/** The proof of a set of used evidence ids: each fact once, a fact before the facts it was derived from. */
function traceProof(prog, ids) {
  const used = new Set();
  const trace = id => { if (used.has(id)) return; used.add(id); for (const p of prog.byId.get(id)?.from ?? []) trace(p); };
  ids.forEach(trace);
  return [...used].map(id => prog.byId.get(id)).filter(Boolean);
}

function depthOf(prog, proof) {
  const memo = new Map();
  const walk = id => {
    if (memo.has(id)) return memo.get(id);
    const f = prog.byId.get(id);
    const v = !f || !(f.from ?? []).length ? 0 : 1 + Math.max(...f.from.map(walk));
    memo.set(id, v);
    return v;
  };
  return proof.length ? Math.max(...proof.map(f => walk(f.id))) : 0;
}

/** Temporal ordering (`order ?t1 before ?t2`): each top-level condition is joined on its own, without intersecting validity. */
function evaluateOrder(prog, q, instants, limits, complete, acc) {
  const top = q.where.length === 1 && q.where[0].kind === 'all' ? q.where[0].children : q.where;
  const forms = lowerForms(prog.lowering, {...q, quantifier: null});
  let offset = 0;
  const parts = [];
  for (const condition of top) {
    const count = conditionAtoms([condition]).length;
    const {rows} = collect(prog, {...q, during: WHOLE}, instants, {where: [condition], forms: {...forms, compares: [], filters: [], rank: null}}, limits, acc);
    parts.push({from: offset, to: offset + count, rows});
    offset += count;
  }
  const partOf = leaf => parts.findIndex(part => leaf >= part.from && leaf < part.to);
  const [li, ri] = q.order.leaves.map(partOf);
  if (li < 0 || ri < 0 || li === ri) return notComputable(q, 'order_needs_two_conditions');
  let rows = [{binding: {}, valids: [], evidence: []}];
  for (const part of parts) {
    const next = [];
    for (const row of rows) for (const r of part.rows) {
      if (Object.entries(r.binding).some(([k, v]) => Object.hasOwn(row.binding, k) && row.binding[k] !== v)) continue;
      next.push({binding: {...row.binding, ...r.binding}, valids: [...row.valids, r.valid], evidence: [...row.evidence, ...r.evidence]});
    }
    rows = next;
  }
  const state = {};
  const decided = rows.map(row => {
    const a = row.valids[li], b = row.valids[ri], known = Number.isFinite(a.from) && Number.isFinite(b.from);
    const holds = q.order.relation === 'same_time' ? !!intersect(a, b) : known && (q.order.relation === 'before' ? a.from < b.from : a.from > b.from);
    return {row: {...row, binding: {...row.binding, [q.order.left]: spanValue(a, q), [q.order.right]: spanValue(b, q)}}, holds, known: q.order.relation === 'same_time' || known};
  });
  const kept = applyFiltersAndCompares(decided.filter(d => d.holds).map(d => d.row), q, state);
  const status = kept.length ? 'supported' : decided.length && decided.every(d => d.known) ? 'refuted' : 'unknown';
  const used = (kept.length ? kept : decided.map(d => d.row)).flatMap(row => row.evidence);
  const proof = traceProof(prog, [...new Set(used)]).filter(f => used.includes(f.id));
  const unique = new Map();
  for (const row of kept) { const binding = Object.fromEntries(q.select.map(k => [k, row.binding[k]])); unique.set(stable(binding), {binding, valid: WHOLE}); }
  return {status, kind: q.mode, query: q, conflictedAnswers: [], answers: q.select.length ? [...unique.values()].slice(0, q.limit) : [], count: q.mode === 'count' ? unique.size : undefined, proof, depth: 0, complete: complete && !acc.exhausted, truncated: false,
    assurance: 'Order of the matched validity intervals known to the host.'};
}

/** `filter` expressions and `compare` lines of a query over already joined rows with a combined binding (the order question). */
function applyFiltersAndCompares(rows, q, state) {
  const COMPARE = {above: (a, b) => a > b, below: (a, b) => a < b, at_least: (a, b) => a >= b, at_most: (a, b) => a <= b};
  const test = (node, row) => {
    if (node.kind === 'all') return node.children.every(c => test(c, row));
    if (node.kind === 'any') return node.children.some(c => test(c, row));
    const a = row.binding[node.left], b = variable(node.right) ? row.binding[node.right] : node.right;
    if (node.op === 'equal' || node.op === 'not_equal') { const x = numericValue(a), y = numericValue(b), same = x !== null && y !== null ? x === y : a === b; return node.op === 'equal' ? same : !same; }
    const x = numericValue(a), y = numericValue(b);
    if (x === null || y === null) { state.notComputable = true; return false; }
    return COMPARE[node.op](x, y);
  };
  const filtered = rows.filter(row => (q.filters ?? []).every(ast => evaluateExpression(ast, {variables: row.binding}).value === true));
  return filtered.filter(row => (q.compares ?? []).every(node => test(node, row)));
}

/** A universal question (mode every): the oracle decides each member of the restriction; members of the parts are merged. */
function evaluateEvery(prog, q, instants, limits, complete, acc) {
  const valid = q.during ?? WHOLE;
  const quantifier = q.quantifier ?? {word: 'all'};
  const forms = lowerForms(prog.lowering, q, {quantifier});
  const {memberLists} = collect(prog, q, instants, {where: q.where, scope: q.scope ?? [], forms, mode: 'every'}, limits, acc);
  const rank = {supported: 3, refuted: 2, unknown: 1};
  const merged = new Map();
  for (const list of memberLists) for (const m of list) {
    const binding = prog.lowering.binding(m.env), key = stable(binding), prior = merged.get(key);
    if (!prior || rank[m.status] > rank[prior.status]) merged.set(key, {binding, status: m.status, evidence: prog.evidence(m.prem).map(f => f.id)});
  }
  const members = [...merged.values()];
  const groups = new Map();
  for (const m of members) {
    const key = stable(q.select.map(v => m.binding[v]));
    if (!groups.has(key)) groups.set(key, {binding: Object.fromEntries(q.select.map(v => [v, m.binding[v]])), members: [], evidence: []});
    const g = groups.get(key);
    g.members.push(m);
    g.evidence.push(...m.evidence);
  }
  const all = [...groups.values()].map(g => ({...g, status: quantifiedStatus(quantifier, g.members)}));
  let status, answers = [], evidence = [];
  if (q.select.length) {
    answers = all.filter(g => g.status === 'supported').slice(0, q.limit).map(g => ({binding: g.binding, valid}));
    status = all.filter(g => g.status === 'supported').length ? 'supported' : all.length && all.every(g => g.status === 'refuted') ? 'refuted' : 'unknown';
    evidence = all.filter(g => g.status === status).flatMap(g => g.evidence);
  } else {
    status = all.length ? all[0].status : 'unknown';
    evidence = all.length ? all[0].evidence : [];
  }
  const proof = traceProof(prog, evidence);
  return {status, kind: 'every', query: q, conflictedAnswers: [], answers, members: members.length, counterexamples: members.filter(m => m.status === 'refuted').map(m => m.binding), undecided: members.filter(m => m.status === 'unknown').map(m => m.binding),
    proof, depth: 0, complete: complete && !acc.exhausted && !acc.truncated, truncated: false,
    assurance: 'Universal checked over the members of the restriction known to the host; members it does not know are not covered.'};
}

/**
 * Evaluate one typed query over typed facts and rules (the runtime's deduce, temporal and classify). `facts` may already hold
 * derived facts of an earlier closure (they are read as facts, and their own `from` links stay in the proof).
 */
export function evaluate(q, facts, {rules = [], complete = true, limits = {}} = {}) {
  const prog = facts instanceof Program ? facts : new Program(facts, rules, q.closed);
  const acc = newAcc();
  const span = q.at !== undefined ? null : q.during ?? WHOLE;
  const planned = span ? prog.instants(span, [...q.where, ...(q.scope ?? [])]) : {instants: [q.at], truncated: false};
  acc.truncated = planned.truncated;
  const {instants} = planned;
  if (q.mode === 'every') return evaluateEvery(prog, q, instants, limits, complete, acc);
  if (q.order) return evaluateOrder(prog, q, instants, limits, complete, acc);
  const ground = groundConditions(q.where);
  const forms = lowerForms(prog.lowering, q, {quantifier: null});
  const {rows, opposing} = collect(prog, q, instants, {where: q.where, forms, opposite: ground}, limits, acc);
  complete = complete && !acc.exhausted && !acc.truncated;
  // A time variable (`span`) is bound to the interval of the matched facts, or to its start, end or length.
  if (q.span) for (const row of rows) row.binding = {...row.binding, [q.span]: spanValue(row.valid, q)};
  if (!rows.length && acc.notComputable) return notComputable(q, 'value_not_numeric');
  // A yes/no question whose known values all fail a numeric comparison is answered no ("Is the Dacia over 5000?" with a price of 4000).
  // A query without select is a yes/no question too (as reasoning/bridge/external.mjs lowers it).
  const comparedAway = !rows.length && acc.filtered > 0 && acc.compared && !acc.notComputable && (q.mode === 'exists' || (q.mode === 'select' && !q.select?.length));
  const overlap = rows.some(m => opposing.some(o => intersect(m.valid, o.valid)));
  const status = rows.length ? (opposing.length ? (overlap ? 'both' : 'mixed_temporal') : 'supported') : opposing.length || comparedAway ? 'refuted' : 'unknown';
  const unique = new Map();
  for (const r of rows) {
    const binding = Object.fromEntries(q.select.map(k => [k, r.binding[k]]));
    const key = stable([binding, q.during ? r.valid : null]), conflicted = Boolean(r.both);
    const prior = unique.get(key);
    if (!prior || prior.conflicted && !conflicted) unique.set(key, {binding, valid: r.valid, evidence: r.evidence, conflicted});
  }
  // `order random` (reasoning/sample.mjs): the same answer set in a seeded random order, then the limit.
  const sampled = q.sample ? sampleAnswers([...unique.values()], {limit: q.limit, seed: q.sample.seed}) : null;
  const all = [...unique.values()], truncated = all.length > q.limit;
  const answers = sampled ? sampled.items : all.slice(0, q.limit);
  const ids = answers.flatMap(a => a.evidence);
  if (comparedAway) ids.push(...acc.filteredEvidence, ...opposing.flatMap(r => r.evidence));
  else ids.push(...opposing.flatMap(r => r.evidence));
  const usedFacts = traceProof(prog, ids);
  const depth = depthOf(prog, usedFacts);
  const explanation = q.mode === 'explain' ? {kind: !usedFacts.length ? 'none' : usedFacts.some(f => f.kind === 'derived') ? 'derivation' : 'recorded',
    steps: usedFacts.map(f => ({atom: f.atom, valid: f.valid, ...(f.kind === 'derived' ? {rule: f.rule, from: f.from} : {source: f.source ?? f.kind})}))} : undefined;
  const count = q.mode === 'count' ? new Set(rows.map(r => stable(q.select.length ? Object.fromEntries(q.select.map(k => [k, r.binding[k]])) : r.binding))).size : undefined;
  return {status, kind: q.mode, query: q, conflictedAnswers: answers.filter(r => r.conflicted).map(({conflicted, evidence, ...r}) => r), answers: answers.map(({conflicted, evidence, ...r}) => r),
    ...(explanation ? {explanation} : {}), ...(sampled ? {sample: sampled.sample} : {}), count, proof: usedFacts, depth, complete: complete && !truncated, truncated,
    assurance: 'Derivation from admitted facts; support is not a calibrated probability of truth.', diagnostics: {rounds: acc.rounds, derived: acc.derived}};
}

/** The runtime's deduction: admitted assumptions join the facts; a proof that uses one is `hypothetical`. */
export function reason(q, memory, {assumptions = [], ...limits} = {}) {
  const {kept, defeated} = assumptions.length ? admissibleAssumptions(memory.facts, assumptions) : {kept: [], defeated: []};
  const facts = [...memory.facts, ...kept];
  const out = evaluate(q, facts, {rules: memory.rules, complete: memory.complete !== false, limits});
  const assumeIds = new Set(kept.map(a => a.id));
  const usesAssumption = (out.proof ?? []).some(p => assumeIds.has(p.id));
  const {diagnostics: d = {}, ...rest} = out;
  return {...rest, hypothetical: kept.length > 0 && usesAssumption, defeatedAssumptions: defeated.map(a => a.id),
    diagnostics: {memoryProbes: memory.probes ?? 0, retrieved: memory.facts.length, closureFacts: facts.length + (d.derived ?? 0), rounds: d.rounds ?? 0, assumptionsKept: kept.length}};
}
