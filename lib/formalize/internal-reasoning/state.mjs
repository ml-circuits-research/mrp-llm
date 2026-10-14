/**
 * The state of one InternalReasoningStepByStep formalization (DS022 "InternalReasoningStepByStep"): the facts the protocol reasons
 * over and the symbols they use. Observations come from structure and memory data only (AGENTS.md "No hardcoded understanding"):
 * the names of the memory found in the message (entity hints), standalone numbers and readable dates, the statements of the schema
 * neighbourhood with their places and shapes, which statements the content words of the request name (the memory's own vocabulary),
 * and where the memory records a name (role fit from the facts). Nothing here reads the phrasing of the request with word lists.
 *
 * Symbols keep the engine's terms simple and safe: names n1.., numbers num1.., dates d1.., mentions m1.., statements st1..,
 * statement instances i1.. (one use of a statement in a query), clauses c1 (supposition) and c2 (second question), fresh unknowns
 * unknown_a1.. and unknown_w1... The text of every symbol (the entity id, the number, the statement sentence) lives in `ctx`.
 */
import {entityHints, stem} from '../../query-author/retrieval.mjs';
import {collectNeighbourhood} from '../../query-author/neighbourhood.mjs';
import {statementText, phraseOf, LETTERS} from '../../query-author/step-by-step/assemble.mjs';
import {readDates, mentionsTime} from '../../query-author/step-by-step/answers.mjs';

export const isNumberRole = role => ['integer', 'number', 'int'].includes(String(role?.type ?? '').toLowerCase());
export const entityRole = role => !isNumberRole(role) && !/^(?:string|text|date|time)$/i.test(String(role?.type ?? ''));
export const fold = s => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replaceAll('_', ' ');
/** Standalone integers of the message (structure: digits not inside a word, a date or a decimal). */
export const standaloneNumbers = message => [...new Set([...String(message).matchAll(/(?<![\w.-])-?\d+(?![\w.-])/g)].map(m => Number(m[0])).filter(Number.isSafeInteger))];

/* ------------------------------------------------------------------------------------------------------ the fact store */

const TERM = /^(?:[a-z][a-z0-9_]*|-?\d+)$/;
/** The namespace of the protocol memory's wire ids and predicates (config/knowledge/formalizer-protocol-v1): the code names them without it. */
export const NS = 'fp_';
export const stripNs = s => String(s).startsWith(NS) ? String(s).slice(NS.length) : String(s);

/** A set of ground atoms `pred arg…` (symbols and integers only), rendered as `fact` wires for the engine. */
export class Facts {
  constructor() { this.map = new Map(); this.origin = new Map(); }
  static key(p, args) { return [p, ...args].join(' '); }
  add(p, ...args) {
    const terms = args.map(String);
    for (const t of [p, ...terms]) if (!TERM.test(t)) throw new TypeError(`not a protocol term: ${JSON.stringify(t)} in ${p}`);
    const key = Facts.key(p, terms);
    if (this.map.has(key)) return false;
    this.map.set(key, {p, args: terms});
    return true;
  }
  has(p, ...args) { return this.map.has(Facts.key(p, args.map(String))); }
  /** Rows of `p` whose first arguments equal `prefix`. */
  rows(p, ...prefix) {
    const out = [];
    for (const f of this.map.values()) if (f.p === p && prefix.every((x, i) => f.args[i] === String(x))) out.push(f.args);
    return out;
  }
  first(p, ...prefix) { return this.rows(p, ...prefix)[0] ?? null; }
  remove(test) { let n = 0; for (const [k, f] of this.map) if (test(f)) { this.map.delete(k); n++; } return n; }
  get size() { return this.map.size; }
  /** The facts as SOP `fact` wires (ids are positional; the engine does not keep them). */
  text() { let n = 0; const out = []; for (const f of this.map.values()) out.push(`@s${++n} fact\n  holds ${[NS + f.p, ...f.args].join(' ')}\n`); return out.join(''); }
}

/* ------------------------------------------------------------------------------------------------------ memory data */

/** Words too common in the statements of the memory to tell them apart (derived from the memory's vocabulary, no stop list). */
export function commonStems(statements) {
  const df = new Map();
  for (const p of statements) for (const w of allStems(`${phraseOf(p)} ${p.id} ${p.description ?? ''}`)) df.set(w, (df.get(w) ?? 0) + 1);
  return new Set([...df].filter(([, n]) => n > Math.max(2, statements.length / 2)).map(([w]) => w));
}
const allStems = text => new Set((fold(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => w.length > 2).map(w => stem(w)));

/** The meaning of a statement with letters for its places, from the memory's description ("a person (A) is a member of the team (B)"). */
export function meaning(predicate) {
  let text = String(predicate.description ?? '').split(/(?<=\.)\s/)[0];
  let found = 0;
  (predicate.roles ?? []).forEach((role, i) => { const re = new RegExp(`\\(${role.name}\\b`, 'g'); if (re.test(text)) { found++; text = text.replace(re, `(${LETTERS[i]}`); } });
  return found && found === predicate.roles.length ? text.replace(/\.$/, '') : null;
}

/** A name fits a place typed by a class of the memory only when it belongs to that class. */
export function classFit(lexicon, id, role) {
  const type = role?.type;
  if (!type || type === 'entity' || !lexicon.isClass?.(type)) return true;
  const entity = lexicon.entities?.[id];
  if (!entity) return true;
  return entity.entityType === type || Boolean(lexicon.classesOf?.(id)?.has?.(type));
}

/**
 * Observed role fit from the memory's facts: a name fits a place when it occurs there, or when the things that occur there share a
 * statement and place with the name. Unknown (no facts, no repository) is never a reason to refuse. Cached per request.
 */
export function roleFitter({repo, session, statements}) {
  if (!repo || !session) return Object.assign(() => true, {observed: () => [], unknownPlaces: () => [], samePlaceKind: () => null});
  const cache = new Map();
  const recall = (p, i, value, limit) => {
    const pattern = {p: p.id, a: Array.from({length: p.roles.length}, (_, j) => j === i && value !== null ? value : `?v${j}`), neg: false};
    try { return repo.recall(session, pattern, {asof: Infinity}, {limit, maxProbes: 400}).rows ?? []; } catch { return []; }
  };
  const fillers = (p, i, n = 6) => [...new Set(recall(p, i, null, n).map(r => r.atom?.a?.[i]).filter(v => typeof v === 'string'))].slice(0, 4);
  const signature = id => {
    const key = `sig:${id}`;
    if (!cache.has(key)) {
      const out = new Set();
      for (const p of statements) p.roles.forEach((role, i) => { if (!isNumberRole(role) && recall(p, i, id, 1).length) out.add(`${p.id}/${i}`); });
      cache.set(key, out);
    }
    return cache.get(key);
  };
  const fit = (id, predicate, roleIndex) => {
    if (!predicate?.roles || !statements.some(p => p.id === predicate.id)) return true;
    const key = `${id}|${predicate.id}|${roleIndex}`;
    if (cache.has(key)) return cache.get(key);
    let ok = true;
    const own = signature(id);
    if (own.size) {
      if (own.has(`${predicate.id}/${roleIndex}`)) ok = true;
      else if ([...own].some(k => k.startsWith(`${predicate.id}/`))) ok = false;
      else {
        const theirs = new Set(fillers(predicate, roleIndex).flatMap(f => [...signature(f)]));
        if (theirs.size) ok = [...own].some(k => theirs.has(k));
      }
    }
    cache.set(key, ok);
    return ok;
  };
  fit.observed = (id, predicate) => predicate.roles.map((_, i) => i).filter(i => signature(id).has(`${predicate.id}/${i}`));
  /** The places of `predicate` that fit an unknown, judged by what fills the unknown's places in the given (statement, place) pairs. */
  fit.unknownPlaces = (pairs, predicate) => {
    const theirs = new Set();
    for (const [p, at] of pairs) for (const f of fillers(p, at)) for (const k of signature(f)) theirs.add(k);
    return predicate.roles.map((_, i) => i).filter(i => theirs.has(`${predicate.id}/${i}`));
  };
  /** Whether two places hold the same kind of thing (their recorded fillers share a filler or a statement place); null when unknown. */
  fit.samePlaceKind = (p1, i1, p2, i2) => {
    const a = fillers(p1, i1), b = fillers(p2, i2);
    if (!a.length || !b.length) return null;
    if (a.some(x => b.includes(x))) return true;
    const sa = new Set(a.flatMap(f => [...signature(f)])), sb = new Set(b.flatMap(f => [...signature(f)]));
    return [...sa].some(k => sb.has(k));
  };
  return fit;
}

/** Positions of the linked mentions in the folded message: [{surface, at, end, mention}], longest first where two overlap. */
export function mentionSpans(message, mentions = []) {
  const text = fold(message), out = [];
  for (const m of mentions) {
    const surface = fold(m.surface);
    if (!surface) continue;
    let at = text.indexOf(surface);
    while (at >= 0) {
      const before = text[at - 1], after = text[at + surface.length];
      if (!(before && /[\p{L}\p{N}]/u.test(before)) && !(after && /[\p{L}\p{N}]/u.test(after))) out.push({surface: m.surface, at, end: at + surface.length, mention: m});
      at = text.indexOf(surface, at + 1);
    }
  }
  out.sort((a, b) => a.at - b.at || (b.end - b.at) - (a.end - a.at));
  return out.filter((s, i) => !out.some((o, j) => j !== i && o.at <= s.at && o.end >= s.end && (o.end - o.at) > (s.end - s.at)));
}

/* ------------------------------------------------------------------------------------------------------ the context */

/**
 * Observes a request: the context with its symbols and the initial facts. `derived` is the set of relations the memory's rules derive.
 */
export function observe({message, lexicon, circuits = [], repo = null, session = null, derived = null, budget = {total: 16, reserve: 3}}) {
  const text = String(message ?? '').trim();
  const facts = new Facts();
  const neighbourhood = collectNeighbourhood({message: text, lexicon, circuits, repo, session});
  const statements = neighbourhood.predicates.map(p => {
    const predicate = {...lexicon.predicates[p.id], id: p.id, roles: p.roles?.length ? p.roles : lexicon.predicates[p.id]?.roles};
    const atom = p.examples?.find(e => e.atom && !e.atom.neg)?.atom;
    const isDerived = derived?.has(p.id) || (p.rules ?? []).some(rule => new RegExp(`\\bthen\\s+${p.id}\\b`).test(rule.sop));
    return {...predicate, derived: Boolean(isDerived), ...(atom ? {example: statementText(predicate, atom.a.map(String))} : {})};
  }).filter(p => p.roles?.length);
  const mentions = entityHints(text, lexicon);
  const ctx = {
    message: text, lexicon, circuits, repo, session, neighbourhood, statements, mentions, spans: mentionSpans(text, mentions),
    common: commonStems(statements), roleFit: roleFitter({repo, session, statements}),
    sym: {name: new Map(), nameOf: new Map(), number: new Map(), statement: new Map(), statementOf: new Map(), mention: new Map(), date: new Map(), clause: new Map(), instance: new Map()},
    counters: {name: 0, number: 0, statement: 0, mention: 0, date: 0, instance: 0, fresh: 0, limited: 0},
    payload: {puzzle: {}, limits: {}, flips: null, notes: {}},
    budget: {total: budget.total, reserve: budget.reserve, asked: 0, repairs: 0, maxRepairs: 2},
  };
  ctx.stems = t => new Set([...allStems(t)].filter(w => !ctx.common.has(w)));
  facts.add('start');
  // Statements of the schema neighbourhood: their places, shape, arity, whether the rules derive them and whether they are complete.
  for (const p of statements) {
    const s = statementSymbol(ctx, p);
    facts.add('candidate_statement', s);
    facts.add('statement_arity', s, p.roles.length);
    for (const role of p.roles) facts.add('statement_role', s, role.name, isNumberRole(role) ? 'number' : entityRole(role) ? 'entity' : 'other');
    facts.add('statement_shape', s, shapeOf(p));
    if (p.derived) facts.add('derived_statement', s);
    if (p.closed === true) facts.add('closed_statement', s);
  }
  // Content words of the request (without the words of the names) that name a statement of the memory (its own vocabulary).
  const hits = lexemeHits(ctx, text);
  for (const p of hits) facts.add('lexeme_hit', ctx.sym.statementOf.get(p.id));
  if (hits.length === 1) facts.add('single_hit', ctx.sym.statementOf.get(hits[0].id));
  // Names of the memory in the message: one mention per surface, its candidates (named things), whether it has exactly one.
  addMentions(ctx, facts, mentions);
  // Standalone numbers (the first two may set a limit) and readable dates.
  standaloneNumbers(text).forEach((value, i) => { const s = numberSymbol(ctx, value); facts.add('number', s); if (i < 2) facts.add('limit_candidate', s); });
  const dates = readDates(text);
  for (const d of dates) facts.add('date', dateSymbol(ctx, d));
  facts.add('date_count', dates.length);
  if (!dates.length && mentionsTime(text)) facts.add('year_only');
  return {ctx, facts};
}

export function shapeOf(p) {
  const roles = p.roles ?? [];
  if (roles.length === 1 && entityRole(roles[0])) return 'unary_entity';
  if (roles.length === 2 && roles.every(entityRole)) return 'binary_entity';
  if (roles.length === 2 && roles.some(isNumberRole) && roles.some(entityRole)) return 'entity_number';
  return 'other';
}

/** Statements whose head words are named by the content words of `text` (the words of the names left out). */
export function lexemeHits(ctx, text) {
  const nameWords = ctx.stems(ctx.spans.map(s => s.surface).join(' '));
  const words = [...ctx.stems(text)].filter(w => !nameWords.has(w));
  return rankStatements(ctx, text).filter(p => words.some(w => ctx.stems(`${phraseOf(p)} ${p.id}`).has(w)));
}

/** Statements ranked by lexical overlap of their words with the text; ties keep the neighbourhood order, derived relations first. */
export function rankStatements(ctx, text, statements = ctx.statements) {
  const words = ctx.stems(text);
  const score = p => {
    let n = 0, h = 0;
    for (const w of ctx.stems(`${phraseOf(p)} ${p.id} ${p.description ?? ''}`)) if (words.has(w)) n++;
    for (const w of ctx.stems(`${phraseOf(p)} ${p.id}`)) if (words.has(w)) h++;
    return 2 * h + n + (p.derived ? 0.5 : 0);
  };
  return statements.map((p, i) => ({p, i, s: score(p)})).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.p);
}

export function addMentions(ctx, facts, mentions) {
  for (const m of mentions) {
    if ([...ctx.sym.mention.values()].some(x => x.surface === m.surface)) continue;
    const s = `m${++ctx.counters.mention}`;
    ctx.sym.mention.set(s, m);
    facts.add('mention', s);
    for (const c of m.candidates) { const n = nameSymbol(ctx, c.id); facts.add('name', n); facts.add('mention_candidate', s, n); }
    if (m.candidates.length === 1 && !m.partial) facts.add('single_candidate', s);
  }
}

export function nameSymbol(ctx, id) {
  if (!ctx.sym.nameOf.has(id)) { const s = `n${++ctx.counters.name}`; ctx.sym.nameOf.set(id, s); ctx.sym.name.set(s, id); }
  return ctx.sym.nameOf.get(id);
}
export function numberSymbol(ctx, value) {
  for (const [s, v] of ctx.sym.number) if (v === value) return s;
  const s = `num${++ctx.counters.number}`;
  ctx.sym.number.set(s, value);
  return s;
}
export function statementSymbol(ctx, p) {
  if (!ctx.sym.statementOf.has(p.id)) { const s = `st${++ctx.counters.statement}`; ctx.sym.statementOf.set(p.id, s); ctx.sym.statement.set(s, p); }
  return ctx.sym.statementOf.get(p.id);
}
function dateSymbol(ctx, date) { const s = `d${++ctx.counters.date}`; ctx.sym.date.set(s, date); return s; }

/** A new use of statement `st` in query `qq` (an instance), after the instances the query already has. */
export function newInstance(ctx, facts, qq, st) {
  const i = `i${++ctx.counters.instance}`;
  const before = facts.rows('uses', qq).map(r => r[1]);
  ctx.sym.instance.set(i, {query: qq, statement: st});
  facts.add('uses', qq, i);
  facts.add('instance_of', i, st);
  if (!before.length) facts.add('main_instance', qq, i);
  else facts.add('instance_after', i, before.at(-1));
  return i;
}

/** A fresh unknown symbol ("anything", or a limited value W of its own). */
export function freshUnknown(ctx, facts, kind = 'a') {
  const s = kind === 'w' ? `unknown_w${++ctx.counters.limited}` : `unknown_a${++ctx.counters.fresh}`;
  facts.add('unknown', s);
  return s;
}

/** The statement (memory predicate) of a statement symbol, or of an instance. */
export const statementOf = (ctx, s) => ctx.sym.statement.get(s) ?? ctx.sym.statement.get(ctx.sym.instance.get(s)?.statement) ?? null;

/** The text shown for a symbol: the entity id, the number, the date, the clause text, the statement sentence. */
export function textOf(ctx, s) {
  if (ctx.sym.name.has(s)) return ctx.sym.name.get(s);
  if (ctx.sym.number.has(s)) return String(ctx.sym.number.get(s));
  if (ctx.sym.date.has(s)) return ctx.sym.date.get(s);
  if (ctx.sym.clause.has(s)) return ctx.sym.clause.get(s).text;
  if (ctx.sym.mention.has(s)) return ctx.sym.mention.get(s).surface;
  if (ctx.sym.statement.has(s)) return statementText(ctx.sym.statement.get(s));
  return s;
}
