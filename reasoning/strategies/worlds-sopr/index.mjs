/**
 * worlds-sopr: sop-r's copy-on-write hypothetical worlds with lazy cone saturation and rule lifting (`sop-r.zip`, sop-r 0.2.0; the
 * engine is vendored unmodified under `vendor/sop-r/`), as a reasoning strategy for MANY WHAT-IF QUERIES OVER A LARGE BASE.
 *
 * What it is: the core circuits are lowered to sop-r text (`lower.mjs`); one engine holds the base and its saturation; a what-if
 * is a world forked from it (cost proportional to the number of relations), the first query after a change saturates only the
 * forward cone of the changed relations, pure additions on monotone paths continue incrementally, and sibling worlds saturate their
 * common parent once. Entry gate (proposal 7): sop-r's 1,200-answer incremental test, ported (`tests/engines/strategy-worlds-sopr.test.mjs`),
 * plus a non-monotone case (an addition that flips a negation-as-failure conclusion).
 *
 * Interface: prepare(theory, {lift}) -> handle; ask({theory | handle, query}) where the FACT wires of the query circuit are the
 * hypothetical additions of the world the query is asked in; fork(handle, delta) -> world, delta = {add, remove, set}; askMany for
 * a batch of sibling worlds in one engine call. A packet reports whether the world continued incrementally (`notes`).
 *
 * Honest limits: closed-world engine (the host reads `refuted` from closed predicates as the oracle does), statements of arity 1 or 2
 * only, no classical negation, time, aggregates, explanations or `used` (the host computes `used` by deletion); deletion and `set` are
 * supported but not incremental (the cone and everything downstream of a retraction is recomputed: 870 ms against 31 ms for an addition
 * at 100,000 entities in the zip's own run); `set` needs a predicate declared with `key`.
 */
import {parse, selectInForce, desugar, tokens, atomFrom} from '../../../sop/knowledge/index.mjs';
import {compileProgram, conditionAlts, orderLeaves} from '../js-reference/program.mjs';
import {planQuery} from '../js-reference/query.mjs';
import {ProgramError, NotExpressibleError, isVarTerm, toTerm} from '../js-reference/values.mjs';
import {Engine} from './vendor/sop-r/engine.mjs';
import {factsText, rulesText, findLines, addLines, triple, tok} from './lower.mjs';

export {ProgramError, NotExpressibleError};

export const capabilities = {
  id: 'worlds-sopr',
  features: ['facts', 'select', 'exists', 'count', 'open_world', 'closed_world', 'closed_derived', 'rules', 'recursion', 'conjunction', 'naf', 'compare_in_rules', 'compute_in_rules', 'whatif', 'versions'],
  delivery: 'slice',
  limits: {max_wires: Infinity, max_arity: 2, integer_range: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]},
  guarantee: 'exact',
  provides: ['fork'],
  budgetKeys: [],
  determinism: 'deterministic',
  isolation: false,
  worlds: {add: 'incremental', remove: 'recomputed', set: 'recomputed, needs predicate key'}
};

export async function available() { return {ok: true, origin: 'vendored sop-r engine'}; }

const f1 = (w, k) => w.fields.find(f => f.key === k);
const decline = (features, message) => { throw new NotExpressibleError(features, `worlds-sopr: ${message}`); };

function readWires(text, what) {
  const {wires, errors} = parse(text ?? '');
  if (errors.length) throw new ProgramError(errors[0].code, `${what}: ${errors[0].message} (line ${errors[0].line})`);
  return wires;
}

// ---------------------------------------------------------------------------------------------------------- handle

/** Parse and lower the knowledge once and build the engine; `lift` rewrites families of same-shape rules (sop-r R01). */
export function prepare(theory, {lift = false} = {}) {
  const t0 = performance.now();
  const knowledge = typeof theory === 'string' ? theory : theory?.knowledge ?? '';
  const wires = theory?.wires ?? readWires(knowledge, 'knowledge');
  const inForce = selectInForce(wires, {asof: null, include: []});
  const {wires: core, origin} = desugar(inForce);
  const program = compileProgram(core, {origin});
  const text = factsText(program.facts) + rulesText(program);
  const engine = new Engine([['kb', text]], {lift});
  if (engine.errors.length) throw new ProgramError('lowering_rejected', `sop-r rejected the lowered circuits: ${engine.errors[0]}`);
  return {kind: 'worlds-sopr-handle', wires, inForce, program, engine, lift, keys: keyedPredicates(wires), timings: {prepare: Math.round(performance.now() - t0)}, worlds: 0};
}

function keyedPredicates(wires) {
  return new Map(wires.filter(w => w.type === 'predicate' && f1(w, 'key')).map(w => [w.id, Number(f1(w, 'key').value)]));
}

/** Compile bare fact wires of the query circuit against the declared predicates. */
function queryFacts(handle, qWires) {
  const facts = qWires.filter(w => w.type === 'fact');
  if (!facts.length) return [];
  const preds = handle.inForce.filter(w => w.type === 'predicate');
  return compileProgram([...preds, ...facts], {}).facts;
}

// ------------------------------------------------------------------------------------------------------ world deltas

const parseAtom = text => {
  const a = atomFrom(typeof text === 'string' ? tokens(text) : text, {allowNeg: false});
  if (a.error) throw new ProgramError('bad_atom', a.error);
  return {neg: false, p: a.p, args: a.terms.map(toTerm)};
};

/** A delta {add: [atom...], remove: [atom...], set: [atom...]} (atoms are texts `p a b` or {p, args}) as `assume` lines. */
function deltaLines(handle, delta) {
  const norm = x => (typeof x === 'string' ? parseAtom(x) : x);
  const lines = [];
  const add = (delta.add ?? []).map(norm), rm = (delta.remove ?? []).map(norm), set = (delta.set ?? []).map(norm);
  lines.push(...addLines(add));
  for (const r of rm) {
    const [s, p, o] = triple(r.p, r.args);
    lines.push(`  remove ${s} ${p} ${o}`);
  }
  for (const x of set) {
    if (!handle.keys.has(x.p) || handle.keys.get(x.p) !== 1) decline(['whatif'], `set on ${x.p} needs the predicate declared with key 1 (the first argument identifies the row)`);
    lines.push(`  set ${triple(x.p, x.args).join(' ')}`);
  }
  return lines;
}

/** A world: the delta chain from the base. Nothing is computed until a query is asked in it. */
export function fork(handle, delta, parent = null) {
  handle.worlds++;
  const chain = [...(parent?.chain ?? []), deltaLines(handle, delta)];
  return {kind: 'worlds-sopr-world', handle, chain, incrementalAdditionsOnly: !(delta.remove?.length || delta.set?.length) && (parent?.incrementalAdditionsOnly ?? true)};
}

function worldText(world, tag = 'w') {
  const out = [];
  world.chain.forEach((lines, i) => out.push(`@${tag}${i} assume`, ...(i ? [`  in $${tag}${i - 1}`] : []), ...lines));
  return {text: out.join('\n') + '\n', leaf: world.chain.length ? `${tag}${world.chain.length - 1}` : null};
}

// ------------------------------------------------------------------------------------------------------------ query

function planOf(handle, qWires) {
  const query = qWires.find(w => w.type === 'query');
  if (!query) decline(['select'], 'no query wire');
  for (const k of ['at', 'during', 'overlaps', 'asof', 'scope', 'limit', 'order', 'rank', 'filter', 'quantifier', 'except', 'measure', 'compare', 'via', 'trace', 'policy']) if (f1(query, k) && !(k === 'policy')) decline(['temporal'], `query field ${k}`);
  if (f1(query, 'candidate')) decline(['candidate'], 'query field candidate: runs with wires not in force elsewhere are the oracle\'s');
  // `if $id` names supposed FACT wires of the query circuit, which are the additions of the world anyway; a governed wire is not lowered
  const factIds = new Set(qWires.filter(w => w.type === 'fact').map(w => w.id));
  for (const f of query.fields.filter(x => x.key === 'if')) if (!factIds.has(f.value.trim().slice(1))) decline(['versions'], `if ${f.value.trim()} names a wire that is not a supposed fact`);
  const mode = f1(query, 'mode')?.value.trim() ?? 'select';
  if (!['select', 'exists', 'count'].includes(mode)) decline([mode === 'every' ? 'every' : mode], `mode ${mode}`);
  const select = (f1(query, 'select')?.value.trim() ?? '').split(/\s+/).filter(Boolean);
  const qp = planQuery(query, handle.program.closed, {mode, select});
  if (qp.alts.length !== 1) decline(['conjunction'], 'a disjunctive (any) query body');
  return {query, mode, qp};
}

/** Text of the probes of one query inside world `leaf`: the find itself and the single-atom refutation checks. */
function probeText(qp, leaf, tag) {
  const alt = qp.alts[0];
  const out = [`@${tag}q find`, ...(leaf ? [`  in $${leaf}`] : []), ...findLines(alt.leaves)];
  if (qp.projection.length) out.push(`  return ${qp.projection.join(' ')}`);
  const checks = [];
  alt.leaves.forEach((l, i) => {
    if (l.kind !== 'atom') return;
    if (l.mode === 'pos' && !qp.closed.has(l.p)) return;
    const args = l.mode === 'absent' ? l.args : l.args.map((a, k) => (isVarTerm(a) ? {var: `?w${k}`} : a));
    const vars = [...new Set(args.filter(isVarTerm).map(a => a.var))];
    out.push(`@${tag}c${i} find`, ...(leaf ? [`  in $${leaf}`] : []), `  match ${triple(l.p, args).join(' ')}`, ...(vars.length ? [`  return ${vars.join(' ')}`] : []));
    checks.push({i, mode: l.mode});
  });
  return {lines: out, checks};
}

const valOf = (eng, id) => eng.dict.val(id);
const rowOf = (eng, r) => Object.fromEntries(Object.entries(r).map(([k, id]) => [k.replace(/^\?/, ''), valOf(eng, id)]));
const rowKey = r => JSON.stringify(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Turn the engine's rows of one probe into the packet (statuses as the oracle: closed predicates, `refuted`, count bounds). */
function packetOf(handle, {mode, qp}, eng, tag, checks) {
  const rows = [...new Map(eng.result(`${tag}q`).rows.map(r => rowOf(eng, r)).map(r => [rowKey(r), r])).values()];
  const exact = qp.domainClosed;
  const base = {strategy: 'worlds-sopr', guarantee: 'exact', complete: true};
  if (mode === 'count') return {...base, status: rows.length || exact ? 'supported' : 'unknown', count: rows.length, ...(exact ? {} : {bound: 'at_least'})};
  if (rows.length) return {...base, status: 'supported', ...(mode === 'select' ? {rows} : {})};
  const refuted = checks.some(c => {
    const found = eng.result(`${tag}c${c.i}`).rows.length > 0;
    return c.mode === 'absent' ? found : !found;
  });
  return {...base, status: refuted ? 'refuted' : 'unknown', ...(mode === 'select' ? {rows: []} : {})};
}

function finish(handle, packet, world, t0, before, after, batch = false) {
  const incremental = after - before;
  return {
    ...packet,
    route: {requested: null, chosen: 'worlds-sopr', reason: world?.chain.length ? 'hypothetical world' : 'base world', fallback: null},
    budget: {limit: {}, used: {ms: Math.round(performance.now() - t0)}, exhausted: false, reason: null, partial: false},
    retrieval: {complete: true, truncated: false, keyed: false, steps: 0, wires: handle.program.facts.length, probes: 0},
    ignored: [], notes: !world?.chain.length ? [] : batch ? [`incremental_continuations_in_batch:${incremental}`] : [incremental > 0 ? 'world_continued_incrementally' : 'world_recomputed_or_unchanged'],
    timings: {ask: Math.round(performance.now() - t0), total: Math.round(performance.now() - t0)}
  };
}

/** Answer a query in the base world, or in `world` when given. The fact wires of the query circuit are extra additions. */
export function ask(problem, budgetArg = {}) {
  const t0 = performance.now();
  const handle = problem.handle ?? problem.world?.handle ?? prepare(problem.theory ?? '');
  const qWires = readWires(problem.query, 'query');
  const plan = planOf(handle, qWires);
  const extra = queryFacts(handle, qWires);
  let world = problem.world ?? null;
  if (extra.length) world = fork(handle, {add: extra}, world);
  const {text, leaf} = world ? worldText(world) : {text: '', leaf: null};
  const probe = probeText(plan.qp, leaf, 'p');
  const before = handle.engine.stats.incremental || 0;
  handle.engine.query(text + probe.lines.join('\n') + '\n');
  if (handle.engine.errors.length) throw new ProgramError('query_rejected', handle.engine.errors[0]);
  const packet = packetOf(handle, plan, handle.engine, 'p', probe.checks);
  return finish(handle, packet, world, t0, before, handle.engine.stats.incremental || 0);
}

/**
 * The same query asked in many sibling worlds of one base, in ONE engine call, so that the parent's saturation is shared.
 * `worlds` are deltas {add, remove, set} (or world objects); returns one packet per world plus `stats`.
 */
export function askMany(handle, worlds, queryText) {
  const t0 = performance.now();
  const qWires = readWires(queryText, 'query');
  const plan = planOf(handle, qWires);
  const forks = worlds.map(w => (w.kind === 'worlds-sopr-world' ? w : fork(handle, w)));
  const parts = [], checks = [];
  forks.forEach((w, i) => {
    const {text, leaf} = worldText(w, `w${i}_`);
    const probe = probeText(plan.qp, leaf, `p${i}_`);
    parts.push(text, probe.lines.join('\n') + '\n');
    checks.push(probe.checks);
  });
  const before = handle.engine.stats.incremental || 0;
  handle.engine.query(parts.join(''));
  if (handle.engine.errors.length) throw new ProgramError('query_rejected', handle.engine.errors[0]);
  // the engine is lazy: saturation happens when the rows are read, so the continuation counter is read after the packets are built
  const raw = forks.map((w, i) => packetOf(handle, plan, handle.engine, `p${i}_`, checks[i]));
  const after = handle.engine.stats.incremental || 0;
  const packets = raw.map((p, i) => finish(handle, p, forks[i], t0, before, after, true));
  return {packets, stats: {worlds: forks.length, incrementalContinuations: after - before, ms: Math.round(performance.now() - t0)}};
}

export const worldsSopr = {...capabilities, capabilities, available, prepare, ask, fork, askMany};
export default worldsSopr;
