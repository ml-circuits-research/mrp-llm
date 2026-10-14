/**
 * The generic question protocol of LocalLLMStepByStep (DS022 "LocalLLMStepByStep", methods B, C and D; method A is index.mjs).
 * The small model only answers numbered choices, number lists and lettered lines; the symbolic system decides every next question
 * and writes the circuit (circuit.mjs). Questions, in order:
 *   Q1 kind (14 kinds, cached prefix; `self` asks one question about the assistant) · the message acts (lettered yes/no lines; the emotion question for a feeling) · Q2 aspects checklist ·
 *   names (symbolic linking) · the details of the ticked aspects (limit kinds per number, option and excluded names, the copied
 *   supposition or second question) · Q11 parts and clause roles (D) · Q3 statements of the schema neighbourhood (ranked by
 *   lexical overlap, "show more") · Q4 places (pre-filled when only one reading exists) · negation per statement · Q5 limit ·
 *   Q6 options · Q7 two-sided comparison · Q8 exclusion · Q9 group and quantifier · Q10 definition (chain, per-group count,
 *   difference of counts, fewest links) · time · validator-driven re-asks · Q12 forced-contrast confirmation (B-yesno: yes/no).
 * At most MAX_QUESTIONS questions are asked; optional questions (re-asks, confirmation) are skipped when the budget is spent.
 * The system never reads the user's phrasing with word lists or patterns (AGENTS.md "No hardcoded understanding"): every aspect of the
 * request comes from the model's answers; the system only uses structure (numbers, dates, the memory's names and statements).
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import {entityHints, stem, candidatePredicates} from '../retrieval.mjs';
import {collectNeighbourhood} from '../neighbourhood.mjs';
import {validateQuery, unclearKind} from '../validate.mjs';
import {splitCircuits} from '../session.mjs';
import {readChoice, readChoices, readYesNo, readDates, mentionsTime} from './answers.mjs';
import {POLARITIES, PERIODS, ask as askA} from './prompts.mjs';
import {statementText, phraseOf, LETTERS, assemble as assembleA, paraphrase as paraphraseA} from './assemble.mjs';
import {Unreadable, isNumberRole, standaloneNumbers, linkNames, puzzlePlan, placeName} from './index.mjs';
import {KINDS, QUANTIFIERS, CLAUSE_ROLES, ASPECTS, PROTOCOL_PREFIX, SELF_ASPECTS, INSTRUCTION_ASPECTS, SETTABLE, q} from './questions.mjs';
import {messageActs} from '../../../sop/message-acts.mjs';
import {assembleProgram, paraphraseProgram, matchText} from './circuit.mjs';
import {groupCount, countGap, chainDefinitions, fewestLinks, freeName} from './definitions.mjs';
import {problemCircuit, problemText, problemModeApplies} from './problem.mjs';
import {protocolData} from '../../formalize/protocol-data.mjs';

export {PROTOCOL_PREFIX};
export const MAX_QUESTIONS = 16;
export const SHOWN_STATEMENTS = 8;
/** The methods of eval-stepbystep-protocol-v1 (C and B-cue, which read a regex cue table, were removed on 2026-10-02). */
export const METHODS = Object.freeze({
  B: {clauses: false, confirm: 'contrast'},
  D: {clauses: true, confirm: 'contrast'},
  'B-yesno': {clauses: false, confirm: 'yesno'},
});
const ASKING = new Set(['list', 'value', 'count', 'highest', 'lowest', 'when']);
const fold = s => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replaceAll('_', ' ');
const hash = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const clone = value => JSON.parse(JSON.stringify(value));
const entityRole = role => !isNumberRole(role) && !/^(?:string|text|date|time)$/i.test(String(role.type ?? ''));

/**
 * Observed role fit (symbolic, from the memory's facts): a name fits a place when it occurs in that place of that statement, or when
 * the things that occur there share a statement and place with the name (people with people, teams with teams). Unknown (no facts,
 * no repository) is never a reason to refuse. Cached per request.
 */
function roleFitter({repo, session, statements}) {
  // Without a repository nothing is known: every fit is neutral (the same shape as the full fitter, so no caller meets a missing method).
  if (!repo || !session) return Object.assign(() => true, {observed: () => [], unknownPlaces: () => [], samePlaceKind: () => null});
  const cache = new Map();
  const recall = (p, i, value, limit) => {
    const arity = p.roles.length;
    const pattern = {p: p.id, a: Array.from({length: arity}, (_, j) => j === i && value !== null ? value : `?v${j}`), neg: false};
    try { return repo.recall(session, pattern, {asof: Infinity}, {limit, maxProbes: 400}).rows ?? []; } catch { return []; }
  };
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
        const fillers = [...new Set(recall(predicate, roleIndex, null, 6).map(r => r.atom?.a?.[roleIndex]).filter(v => typeof v === 'string'))].slice(0, 4);
        const theirs = new Set(fillers.flatMap(f => [...signature(f)]));
        if (theirs.size) ok = [...own].some(k => theirs.has(k));
      }
    }
    cache.set(key, ok);
    return ok;
  };
  /**
   * The places of `predicate` that fit an unknown, judged by what fills the unknown's places in the other statements (the things that
   * fill "A is a choir" also fill B of "A sings in the choir B"). Empty when nothing is known.
   */
  fit.unknownPlaces = (matches, variable, predicate) => {
    const theirs = new Set();
    for (const m of matches) {
      const p = statements.find(x => x.id === m.predicate);
      if (!p) continue;
      m.roles.forEach((r, j) => {
        if (r.value.kind !== 'var' || r.value.value !== variable) return;
        const at = p.roles.findIndex(x => x.name === r.name);
        for (const f of new Set(recall(p, at, null, 6).map(row => row.atom?.a?.[at]).filter(v => typeof v === 'string'))) for (const k of signature(f)) theirs.add(k);
      });
    }
    return predicate.roles.map((_, i) => i).filter(i => theirs.has(`${predicate.id}/${i}`));
  };
  /** Whether two places hold the same kind of thing: their recorded fillers share a filler or a statement place. Null when unknown. */
  fit.samePlaceKind = (p1, i1, p2, i2) => {
    const fillers = (p, i) => [...new Set(recall(p, i, null, 6).map(row => row.atom?.a?.[i]).filter(v => typeof v === 'string'))].slice(0, 4);
    const a = fillers(p1, i1), b = fillers(p2, i2);
    if (!a.length || !b.length) return null;
    if (a.some(x => b.includes(x))) return true;
    const sa = new Set(a.flatMap(f => [...signature(f)])), sb = new Set(b.flatMap(f => [...signature(f)]));
    return [...sa].some(k => sb.has(k));
  };
  /** The places of a statement in which the memory records the name. */
  fit.observed = (id, predicate) => predicate.roles.map((_, i) => i).filter(i => signature(id).has(`${predicate.id}/${i}`));
  return fit;
}

/** The statements of the schema neighbourhood as method A builds them (derived relations marked, a stored example when there is one). */
function neighbourhoodStatements({message, lexicon, circuits, repo, session, derived, entities = []}) {
  const neighbourhood = collectNeighbourhood({message, lexicon, circuits, repo, session, entities});
  const statements = neighbourhood.predicates.map(p => {
    const predicate = {...lexicon.predicates[p.id], id: p.id, roles: p.roles?.length ? p.roles : lexicon.predicates[p.id]?.roles};
    const atom = p.examples?.find(e => e.atom && !e.atom.neg)?.atom;
    const isDerived = derived?.has(p.id) || (p.rules ?? []).some(rule => new RegExp(`\\bthen\\s+${p.id}\\b`).test(rule.sop));
    return {...predicate, derived: Boolean(isDerived), ...(atom ? {example: statementText(predicate, atom.a.map(String))} : {})};
  }).filter(p => p.roles?.length);
  // A relation whose whole label is in the request ("older than", "outlive", "part of") is offered even when the bounded neighbourhood
  // filled up with the relations around the named things first (commonsense guard 2026-10-03: the memory's derived older_than,
  // outlived and lived_before were cut by the predicate bound). The memory's labels decide, not a word list.
  const words = new Set((fold(message).match(/[\p{L}\p{N}]+/gu) ?? []).map(w => stem(w)));
  const named = p => { const ws = (fold(phraseOf(p)).match(/[\p{L}\p{N}]+/gu) ?? []).map(w => stem(w)); return ws.length > 0 && ws.every(w => words.has(w)); };
  for (const c of candidatePredicates(message, lexicon, {k: 3, core: []})) {
    const predicate = lexicon.predicates?.[c.id];
    if (!predicate?.roles?.length || statements.some(p => p.id === c.id) || !named(predicate)) continue;
    statements.push({...predicate, id: c.id, derived: Boolean(derived?.has(c.id) || (predicate.factCount ?? 0) === 0)});
  }
  return {neighbourhood, statements};
}

const allStems = text => new Set((fold(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => w.length > 2).map(w => stem(w)));
/**
 * Words too common in the statements of the memory to tell them apart (they occur in more than half of the neighbourhood's statements):
 * derived from the memory's own vocabulary, never from a hand-written stop list.
 */
// Per request (concurrent requests in one process must not share it: 2026-10-02, a module-level set made the statement order of one
// request depend on another request formalized at the same time, so recorded answers could not be replayed).
const commonScope = new AsyncLocalStorage();
const NO_COMMON = new Set();
const commonStems = statements => {
  const df = new Map();
  for (const p of statements) for (const w of allStems(`${phraseOf(p)} ${p.id} ${p.description ?? ''}`)) df.set(w, (df.get(w) ?? 0) + 1);
  return new Set([...df].filter(([, n]) => n > Math.max(2, statements.length / 2)).map(([w]) => w));
};
const stems = text => { const common = commonScope.getStore() ?? NO_COMMON; return new Set([...allStems(text)].filter(w => !common.has(w))); };
/** Statements ranked by lexical overlap of their words with the text; ties keep the neighbourhood order, derived relations first. */
function rankStatements(statements, text) {
  const words = stems(text);
  const score = p => {
    const own = stems(`${phraseOf(p)} ${p.id} ${p.description ?? ''}`);
    let n = 0;
    for (const w of own) if (words.has(w)) n++;
    const head = stems(`${phraseOf(p)} ${p.id}`);
    let h = 0;
    for (const w of head) if (words.has(w)) h++;
    return 2 * h + n + (p.derived ? 0.5 : 0);
  };
  return statements.map((p, i) => ({p, i, s: score(p)})).sort((a, b) => b.s - a.s || a.i - b.i).map(x => ({...x.p, overlap: x.s}));
}

/** The oracle with a question budget. */
function budgeted(oracle) {
  return {
    ...oracle,
    left: () => MAX_QUESTIONS - oracle.steps.length,
    async choice(name, text, max, {zero = false, tokens = 8} = {}) {
      return oracle.read(name, text, t => readChoice(t, max, {zero}), zero ? `Reply with one number from 0 to ${max}.` : `Reply with one number from 1 to ${max}.`, tokens);
    },
  };
}

/** Positions of the linked mentions (the memory's names) in the folded message: [{surface, at, end, mention}], in order. */
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
  // Longest mention wins where two overlap ("the Falcon team" over "Falcon").
  out.sort((a, b) => a.at - b.at || (b.end - b.at) - (a.end - a.at));
  return out.filter((s, i) => !out.some((o, j) => j !== i && o.at <= s.at && o.end >= s.end && (o.end - o.at) > (s.end - s.at)));
}

/* ------------------------------------------------------------------ statements and places */

async function pickStatements(oracle, ctx, text, what, {single = false} = {}) {
  const ranked = rankStatements(ctx.statements, text);
  if (!ranked.length) return [];
  const words = new Set(fold(text).match(/[\p{L}\p{N}]+/gu) ?? []);
  const named = p => phraseOf(p).toLowerCase().split(/\s+/).every(w => words.has(w) || words.has(w.replace(/(ed|s)$/, '')));
  const notes = p => [named(p) ? 'its words are in the request' : '', p.derived ? 'worked out by the rules of the knowledge' : p.example ? `example: ${p.example}` : ''].filter(Boolean).join('; ');
  const line = (p, i) => `${i + 1}. ${statementText(p)}${notes(p) ? `   (${notes(p)})` : ''}`;
  if (single) {
    // A clause whose content words name exactly one statement needs no question ("If Izar were closed" and "A closed server").
    const words = [...stems(text)].filter(w => !stems(ctx.spans.map(sp => sp.surface).join(' ')).has(w));
    const hits = ranked.filter(p => words.some(w => stems(`${phraseOf(p)} ${p.id}`).has(w)));
    if (hits.length === 1) return hits;
  }
  let shown = ranked.slice(0, SHOWN_STATEMENTS), offset = 0;
  for (let page = 0; page < 2; page++) {
    const more = page === 0 && ranked.length > SHOWN_STATEMENTS;
    const max = shown.length + (more ? 1 : 0);
    const prompt = single ? q.clauseStatement(text, shown.map((p, i) => line(p, i).replace(/^\d+\. /, ''))) : q.statements(shown.map(line), more, what);
    const picked = await oracle.read(page ? 'statements_more' : 'statements', prompt, t => single ? (n => n === null ? null : [n])(readChoice(t, max, {zero: true})) : readChoices(t, max), 'Reply with the statement numbers, separated by commas, or 0.', 32);
    if (picked[0] === 0) {
      // The oracle says none fits while exactly one statement shares a content word with the request: asked once (two-signal rule).
      const nameWords = stems(ctx.spans.map(sp => sp.surface).join(' '));
      const words = [...stems(text)].filter(w => !nameWords.has(w));
      const hits = ranked.filter(p => words.some(w => stems(`${phraseOf(p)} ${p.id}`).has(w)));
      if (hits.length === 1 && !single && oracle.left() > 4) {
        const yes = await oracle.choice('statement_check', `Does the request need the statement "${statementText(hits[0])}"${meaning(hits[0]) ? ` (${meaning(hits[0])})` : ''}?\n1. yes\n2. no\nReply with the number only.`, 2);
        if (yes === 1) return hits;
      }
      return [];
    }
    if (more && picked.includes(max)) { offset = SHOWN_STATEMENTS; shown = ranked.slice(SHOWN_STATEMENTS, 2 * SHOWN_STATEMENTS); continue; }
    return picked.filter(n => n <= shown.length).map(n => shown[n - 1]);
  }
  return [];
}

const UNKNOWN = {
  '?x': 'X: the thing the request asks for',
  '?m': 'M: each member of the group the request is about',
  '?v': 'V: the value to compare or rank (highest, lowest, before, more than another)',
  '?w': 'W: a value the request limits (more than a number, between two numbers, before a year)',
  '?p': 'P: another unknown thing (the same P in every statement)',
  '?q': 'Q: a second other unknown thing (the same Q in every statement)',
};

function unknownsFor(form, count, aspects) {
  const out = [];
  if (form === 'every') out.push('?m');
  else if (ASKING.has(form)) out.push('?x');
  if (form === 'highest' || form === 'lowest' || aspects.has('twoSided')) out.push('?v');
  if (aspects.has('limit')) out.push('?w');
  if (count >= 2) out.push('?p');
  if (count >= 3) out.push('?q');
  return out;
}

/** Why a filled statement cannot be right (a name in a number place, a number in a name place), or null. */
function placeProblem(predicate, roles) {
  for (const r of roles) {
    const declared = predicate.roles?.find(x => x.name === r.name) ?? {};
    if (r.value.kind === 'entity' && isNumberRole(declared)) return `${r.name} holds a number, not the name ${r.value.value}`;
    if (r.value.kind === 'number' && !isNumberRole(declared) && declared.type) return `${r.name} holds a name, not the number ${r.value.value}`;
    if (r.value.kind === 'var' && r.value.value === '?v' && !isNumberRole(declared) && declared.type) return `${r.name} holds a name, not the value V`;
  }
  return null;
}

/** The meaning of a statement with letters for its places, from the memory's description ("a person (A) is a member of the team (B)"). */
function meaning(predicate) {
  let text = String(predicate.description ?? '').split(/(?<=\.)\s/)[0];
  let found = 0;
  predicate.roles.forEach((role, i) => { const re = new RegExp(`\\(${role.name}\\b`, 'g'); if (re.test(text)) { found++; text = text.replace(re, `(${LETTERS[i]}`); } });
  return found === predicate.roles.length ? text.replace(/\.$/, '') : null;
}

/** A name fits a place typed by a class of the memory only when it belongs to that class (the validator's class_mismatch, asked first). */
function classFit(lexicon, id, role) {
  const type = role?.type;
  if (!type || type === 'entity' || !lexicon.isClass?.(type)) return true;
  const entity = lexicon.entities?.[id];
  if (!entity) return true;
  return entity.entityType === type || Boolean(lexicon.classesOf?.(id)?.has?.(type));
}

/** Which options fit a place: names and entity unknowns in a name place, numbers and V in a number place, X, P, Q and "anything" in both. */
const fits = (role, option) => {
  const number = isNumberRole(role), v = option.value;
  if (v.kind === 'entity') return !number;
  if (v.kind === 'number') return number;
  if (v.kind === 'var' && (v.value === '?v' || v.value === '?w')) return number || !role.type;
  if (v.kind === 'var' && v.value === '?m') return !number;
  return true;
};

async function fillPlaces(oracle, ctx, predicate, {form, names, unknowns, count, note = '', fixed = {}}) {
  const roles = predicate.roles;
  const asked = unknowns.find(u => u === '?x' || u === '?m');
  if (roles.length === 1 && count === 1 && !Object.keys(fixed).length) {
    if ((form === 'yesno' || form === 'why') && names.length === 1 && ctx.roleFit(names[0], predicate, 0) && classFit(ctx.lexicon, names[0], roles[0])) return [{name: roles[0].name, value: {kind: 'entity', value: names[0]}}];
    if (asked && !names.length) return [{name: roles[0].name, value: {kind: 'var', value: asked}}];
  }
  const options = [...names.map(id => ({text: id, value: {kind: 'entity', value: id}})),
    ...(roles.some(isNumberRole) ? ctx.numbers.filter(n => !ctx.reservedNumbers.has(n)).map(n => ({text: String(n), value: {kind: 'number', value: n}})) : []),
    ...unknowns.map(u => ({text: UNKNOWN[u], value: {kind: 'var', value: u}})),
    {text: count > 1 ? 'anything (not linked to the other statements, not limited by the request)' : 'anything (not limited by the request)', value: {kind: 'any'}}];
  const fitting = (role, i, o) => fits(role, o) && (o.value.kind !== 'entity' || (ctx.roleFit(o.value.value, predicate, i) && classFit(ctx.lexicon, o.value.value, role)));
  const result = roles.map(role => fixed[role.name] ? {name: role.name, value: fixed[role.name]} : null);
  // "anything" is a fresh unknown; W (a limited value) is its own unknown in every statement.
  const take = (i, value) => { result[i] = {name: roles[i].name, value: value.kind === 'any' ? {kind: 'var', value: ctx.fresh()} : value.kind === 'var' && value.value === '?w' ? {kind: 'var', value: `?w${++ctx.limited}`} : value}; };
  const allowedOf = i => options.map((o, k) => fitting(roles[i], i, o) ? k + 1 : 0).filter(Boolean);
  const placed = () => new Set(result.filter(Boolean).filter(r => r.value.kind === 'entity').map(r => r.value.value));
  if (!note) {
    // A name of the request that the memory records in exactly one place of this statement goes there (no question).
    const claims = new Map();
    for (const id of names) {
      const at = ctx.roleFit.observed(id, predicate).filter(i => !result[i]);
      if (at.length === 1) claims.set(at[0], [...(claims.get(at[0]) ?? []), id]);
    }
    for (const [i, ids] of claims) if (ids.length === 1 && !(form === 'yesno' && names.length > roles.length)) take(i, {kind: 'entity', value: ids[0]});
    // The first statement of a question that asks for something: when one place is left and the asked unknown fits it, it goes there.
    const left = roles.map((_, i) => i).filter(i => !result[i]);
    if (asked && !ctx.askedPlaced && left.length === 1 && result.some(Boolean) && allowedOf(left[0]).some(k => options[k - 1].value.value === asked)) take(left[0], {kind: 'var', value: asked});
  }
  const used = placed();
  const open = roles.map((role, i) => ({role, i, letter: LETTERS[i], allowed: result[i] ? [] : allowedOf(i).filter(k => !(options[k - 1].value.kind === 'entity' && used.has(options[k - 1].value.value)))})).filter(x => !result[x.i]);
  for (const x of open.filter(x => x.allowed.length <= 1)) take(x.i, options[(x.allowed[0] ?? options.length) - 1].value);
  const asking = open.filter(x => x.allowed.length > 1);
  if (!asking.length) return result;
  const letters = asking.map(x => x.letter);
  const kinds = x => isNumberRole(x.role) ? 'a number' : 'a name or an unknown';
  const sense = meaning(predicate);
  const head = `For the statement "${statementText(predicate)}"${sense ? ` (meaning: ${sense})` : ''}`;
  const ask = async extra => {
    const prompt = `${extra}${head}, what are ${letters.join(' and ')} in the request?\nChoices:\n${options.map((o, i) => `${i + 1}. ${o.text}`).join('\n')}\n${asking.map(x => `${x.letter} (${kinds(x)}) is one of: ${x.allowed.join(', ')}`).join('\n')}\nReply with one line per letter, like "${letters[0]}: ${asking[0].allowed[0]}".`;
    const text = String(await oracle.ask('places', prompt, 48)).replace(/\b([A-D])\s*[:=]\s*(?:0|none|nothing|anything|any)\b/gi, `$1: ${options.length}`);
    const picked = {};
    for (const m of text.matchAll(/\b([A-D])\b\s*(?:[:=\-–)]|is|->)\s*(\d{1,3})\b/g)) if (letters.includes(m[1]) && !(m[1] in picked)) picked[m[1]] = Number(m[2]);
    const taken = new Set(result.filter(Boolean).map(r => options.findIndex(o => o.value.kind === r.value.kind && o.value.value === r.value.value) + 1).filter(Boolean));
    for (const x of asking) {
      let n = picked[x.letter];
      // A choice that does not fit the place (or a name already used in the statement) is asked again for that place only.
      if (!x.allowed.includes(n) || (options[n - 1].value.kind !== 'any' && taken.has(n))) {
        const allowed = x.allowed.filter(k => !taken.has(k));
        n = allowed[(await oracle.choice('place', `${head}, which is ${x.letter} in the request?\n${allowed.map((k, j) => `${j + 1}. ${options[k - 1].text}`).join('\n')}\nReply with the number only.`, allowed.length)) - 1];
      }
      if (options[n - 1].value.kind !== 'any') taken.add(n);
      take(x.i, options[n - 1].value);
    }
    return result.map(r => ({...r}));
  };
  let filled = await ask(note);
  const problem = placeProblem(predicate, filled);
  if (problem && oracle.left() > 2) filled = await ask(`Not possible: ${problem}. `);
  return filled;
}

const vars = matches => new Set(matches.flatMap(m => m.roles.filter(r => r.value.kind === 'var').map(r => r.value.value)));

/** Groups of matches linked by a shared unknown or name. */
function components(matches) {
  const keys = m => new Set(m.roles.map(r => JSON.stringify(r.value)));
  const groups = [];
  for (const m of matches) {
    const own = keys(m);
    const linked = groups.filter(g => g.some(x => [...keys(x)].some(k => own.has(k))));
    const merged = [m, ...linked.flat()];
    for (const g of linked) groups.splice(groups.indexOf(g), 1);
    groups.push(merged);
  }
  return groups;
}

/** Statements that share nothing with the rest of the question: one yes/no-style choice per gap, to join an unknown of each. */
async function connect(oracle, ctx, query) {
  for (let round = 0; round < 3; round++) {
    const groups = components(query.matches);
    if (groups.length < 2) return;
    const main = groups.find(g => g.some(m => m.roles.some(r => ['?x', '?m'].includes(r.value.value)))) ?? groups[0];
    const other = groups.find(g => g !== main);
    const declared = m => r => ctx.lexicon.predicates[m.predicate]?.roles?.find(x => x.name === r.name) ?? {};
    const places = g => g.flatMap(m => m.roles.filter(r => r.value.kind === 'var').map(r => ({m, r, number: isNumberRole(declared(m)(r))})));
    const target = places(main).sort((a, b) => Number(['?x', '?m'].includes(b.r.value.value)) - Number(['?x', '?m'].includes(a.r.value.value)));
    const uses = v => query.matches.reduce((n, m) => n + m.roles.filter(r => r.value.kind === 'var' && r.value.value === v).length, 0)
      + [...(query.compares ?? []), query.rank?.value ?? '', query.select ?? ''].filter(t => new RegExp(`\\${v}\\b`).test(t)).length;
    const free = places(other).filter(p => /^\?a\d+$/.test(p.r.value.value) || (uses(p.r.value.value) === 1 && !['?x', '?m'].includes(p.r.value.value)));
    const pairs = target.flatMap(t => free.filter(f => f.number === t.number).map(f => [t, f])).slice(0, 4);
    if (!pairs.length) return;
    const show = (p, letter) => {
      const predicate = ctx.lexicon.predicates[p.m.predicate];
      const values = predicate.roles.map(role => { const r = p.m.roles.find(x => x.name === role.name); return r === p.r ? letter : r.value.kind === 'var' ? 'something' : String(r.value.value); });
      return statementText(predicate, values);
    };
    // Places that hold different kinds of things (recorded fillers) cannot be the same thing.
    const placeOf = p => { const predicate = ctx.lexicon.predicates[p.m.predicate]; return predicate ? [predicate, predicate.roles.findIndex(x => x.name === p.r.name)] : null; };
    const kind = ([t, f]) => { const a = placeOf(t), b = placeOf(f); return a && b ? ctx.roleFit.samePlaceKind(a[0], a[1], b[0], b[1]) : null; };
    const plausible = pairs.filter(pair => kind(pair) !== false);
    if (!plausible.length) return;
    const sure = plausible.filter(pair => kind(pair) === true);
    const lines = plausible.map(([t, f]) => `"${show(t, 'Y')}" and "${show(f, 'Y')}"`);
    // One question has connected statements: with a single way to connect them (or one way the recorded facts support) there is
    // nothing to ask; a link between numbers is always asked.
    const single = plausible.length === 1 && !plausible[0][0].number ? plausible[0] : sure.length === 1 && !sure[0][0].number ? sure[0] : null;
    const n = single ? plausible.indexOf(single) + 1 : oracle.left() <= 3 ? 0 : await oracle.choice('connect', `The statements of the question must be linked by one shared thing Y. Which link is right?\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\nReply with the number only.`, lines.length);
    if (!n) return;
    const [t, f] = plausible[n - 1];
    const from = f.r.value.value, to = t.r.value.value;
    for (const m of query.matches) for (const r of m.roles) if (r.value.kind === 'var' && r.value.value === from) r.value = {kind: 'var', value: to};
  }
}
const letterOf = v => ({'?x': 'X', '?m': 'M', '?v': 'V', '?w': 'W', '?p': 'P', '?q': 'Q'}[v] ?? 'Y');

const SIDED = [['same', 'they have the same value'], ['below', 'the first named has the smaller, earlier or fewer one'], ['above', 'the first named has the larger, later or more one'], ['both', 'something both of them have'], ['difference', 'how many more one has than the other']];

/** The two names (in message order) and the kind of a two-sided comparison (one numbered question). */
async function twoSidedKind(oracle, ctx) {
  const ids = [...new Set(ctx.names.filter(id => !ctx.reserved.has(id)))].slice(0, 2);
  if (ids.length < 2) return null;
  const n = await oracle.choice('two_sided', q.twoSided(`${ids[0]} and ${ids[1]}`, SIDED.map(([, t]) => t)), SIDED.length, {zero: true});
  return n ? {ids, kind: SIDED[n - 1][0]} : null;
}

/**
 * Q7: two named things compared with each other. The statement is used twice, once per name, in the same place; the other places are
 * a shared unknown ("the same town", "both have") or two values compared ("before X did"); "how many more" is a difference of counts.
 */
async function twoSidedMatches(oracle, ctx, predicate, form, sided) {
  const {ids, kind} = sided;
  const names = predicate.roles.filter(entityRole);
  if (!names.length || predicate.roles.length < 2) return null;
  let slot = names[0];
  if (names.length > 1) {
    const letters = predicate.roles.map((r, i) => entityRole(r) ? LETTERS[i] : null).filter(Boolean);
    const letter = await oracle.read('name_place', q.nameLetter(statementText(predicate), letters, `${ids[0]} (and ${ids[1]})`), t => { const m = /\b([A-D])\b/.exec(String(t)); return m && letters.includes(m[1]) ? m[1] : null; }, `Reply with one of ${letters.join(', ')}.`, 4);
    slot = predicate.roles[LETTERS.indexOf(letter)];
  }
  const others = predicate.roles.filter(r => r !== slot);
  if (kind === 'difference') {
    if (predicate.roles.length !== 2) return null;
    const size = groupCount(ctx, predicate, slot.name, others[0].name), gap = countGap(ctx, size.name);
    ctx.definitions.push(size.sop, gap.sop);
    return {form: 'value', matches: [{predicate: gap.name, roles: [{name: 'subject', value: {kind: 'entity', value: ids[0]}}, {name: 'object', value: {kind: 'entity', value: ids[1]}}, {name: 'topic', value: {kind: 'var', value: '?x'}}], polarity: 'affirmed'}]};
  }
  const compared = others.find(isNumberRole) ?? others[0];
  const copy = (id, value) => ({predicate: predicate.id, polarity: 'affirmed', roles: predicate.roles.map(r => ({name: r.name, value: r === slot ? {kind: 'entity', value: id} : r === compared ? value : {kind: 'var', value: `?s_${r.name}`}}))});
  if (kind === 'above' || kind === 'below') return {matches: [copy(ids[0], {kind: 'var', value: '?a'}), copy(ids[1], {kind: 'var', value: '?b'})], compares: [`?a ${kind} ?b`]};
  const shared = {kind: 'var', value: ASKING.has(form) ? '?x' : '?a0'};
  return {matches: [copy(ids[0], shared), copy(ids[1], shared)]};
}

/**
 * A yes/no question whose two names fill the same place of one statement used twice, the other places joined by a shared unknown (the
 * reading "they have the same value"), when the checklist did not tick a two-sided comparison: the comparison is asked once (commonsense
 * guard 2026-10-03: "Was Newton older than Einstein?" was read as "born on the same day"). Structure decides when to ask, the model
 * how they compare; "same" keeps the reading.
 */
async function comparedPair(oracle, ctx, query) {
  if (query.form !== 'yesno' || oracle.left() < 4) return false;
  const ids = [...new Set(ctx.names.filter(id => !ctx.reserved.has(id)))].slice(0, 2);
  if (ids.length < 2) return false;
  const byPredicate = new Map();
  for (const m of query.matches) byPredicate.set(m.predicate, [...(byPredicate.get(m.predicate) ?? []), m]);
  for (const [id, pair] of byPredicate) {
    if (pair.length !== 2) continue;
    const [a, b] = pair;
    const differ = a.roles.filter((r, i) => r.value.kind === 'entity' && b.roles[i]?.value.kind === 'entity' && r.value.value !== b.roles[i].value.value);
    if (differ.length !== 1 || !ids.every(x => [a, b].some(m => m.roles.some(r => r.value.kind === 'entity' && r.value.value === x)))) continue;
    const shared = a.roles.filter((r, i) => r !== differ[0] && r.value.kind === 'var' && b.roles[i]?.value.kind === 'var' && r.value.value === b.roles[i].value.value);
    if (!shared.length) continue;
    const predicate = ctx.statements.find(p => p.id === id) ?? {...ctx.lexicon.predicates[id], id};
    const sided = await twoSidedKind(oracle, ctx);
    if (!sided || sided.kind === 'same') return false;
    const built = await twoSidedMatches(oracle, ctx, predicate, query.form, sided);
    if (!built || built.form) return false;
    query.matches = [...query.matches.filter(m => m !== a && m !== b), ...built.matches];
    query.compares.push(...(built.compares ?? []));
    return true;
  }
  return false;
}

/** Statements and places of one question: a query object, or null when no statement fits. */
async function relational(oracle, ctx, {text, form, names, id = 'q', what = 'the request', picked = null, sided = null}) {
  picked ??= await pickStatements(oracle, ctx, text, what);
  if (!picked.length) return null;
  const unknowns = unknownsFor(form, picked.length, ctx.aspects);
  const query = {id, form, matches: [], compares: [], excepts: [], links: [], select: null, rank: null, time: null, picked: picked.map(p => p.id)};
  let rest = picked;
  if (sided) {
    const at = picked.findIndex(p => p.roles.some(entityRole) && p.roles.length >= 2);
    const built = at >= 0 ? await twoSidedMatches(oracle, ctx, picked[at], form, sided) : null;
    if (built) {
      query.matches.push(...built.matches);
      query.compares.push(...(built.compares ?? []));
      if (built.form) { query.form = built.form; query.select = '?x'; return query; }
      rest = picked.filter((_, i) => i !== at);
    }
  }
  const twoNames = new Set(sided?.ids ?? []);
  const asked = form === 'every' ? '?m' : '?x';
  for (const predicate of rest) {
    ctx.askedPlaced = vars(query.matches).has(asked);
    query.matches.push({predicate: predicate.id, roles: await fillPlaces(oracle, ctx, predicate, {form, names: names.filter(n => !twoNames.has(n) || rest.length === picked.length), unknowns, count: picked.length}), polarity: 'affirmed'});
  }
  ctx.askedPlaced = false;
  // No place holds the asked thing but exactly one unknown fills a name place: that unknown is the asked thing.
  if ((ASKING.has(form) || form === 'every') && !vars(query.matches).has(asked)) {
    const candidates = [...new Set(query.matches.flatMap(m => m.roles.filter(r => r.value.kind === 'var' && entityRole(ctx.lexicon.predicates[m.predicate]?.roles?.find(x => x.name === r.name) ?? {})).map(r => r.value.value)))];
    if (candidates.length === 1) for (const m of query.matches) for (const r of m.roles) if (r.value.value === candidates[0]) r.value = {kind: 'var', value: asked};
  }
  // The asked thing must have a place: the places of the first statement are asked once more.
  if ((ASKING.has(form) || form === 'every') && !vars(query.matches).has(asked) && rest.length) {
    const at = query.matches.findIndex(m => m.predicate === rest[0].id);
    query.matches[at].roles = await fillPlaces(oracle, ctx, rest[0], {form, names, unknowns, count: picked.length, note: `Not possible: one place must be ${UNKNOWN[asked].slice(3)}. `});
  }
  // Every place holds a name: the request can only be a yes/no question about these statements (as in method A).
  if (ASKING.has(form) && !vars(query.matches).size) {
    const statement = query.matches.map(m => matchText(m, ctx.lexicon)).join(' and ');
    if (await oracle.choice('yes_no_switch', `Every place is a name of the request. Does the request ask\n1. whether ${statement} is true\n2. for something else that is not named in the request\nReply with the number only.`, 2) === 1) query.form = 'yesno';
  }
  if ((query.form === 'highest' || query.form === 'lowest') && !vars(query.matches).has('?v')) {
    const at = picked.findIndex(p => p.roles.some(isNumberRole));
    const m = at >= 0 ? query.matches.findIndex(x => x.predicate === picked[at].id) : -1;
    if (m >= 0) query.matches[m].roles = await fillPlaces(oracle, ctx, picked[at], {form, names, unknowns, count: picked.length, note: 'Not possible: one place must be the value to compare. '});
  }
  // A superlative without a value place: the statement that holds the compared value is asked once; none drops the ranking.
  if (query.rank && !vars(query.matches).has('?v')) {
    const chosen = new Set(query.matches.map(m => m.predicate));
    const numeric = rankStatements(ctx.statements, text).filter(p => !chosen.has(p.id) && p.roles.length === 2 && p.roles.some(isNumberRole) && p.roles.some(entityRole)).slice(0, 6);
    const n = numeric.length && oracle.left() > 3 ? await oracle.choice('rank_value', `Which statement holds the value to compare (the ${query.form} one)?\n${numeric.map((p, i) => `${i + 1}. ${statementText(p)}`).join('\n')}\n0. none of these\nReply with the number only.`, numeric.length, {zero: true}) : 0;
    if (n) {
      const p = numeric[n - 1];
      query.matches.push({predicate: p.id, roles: p.roles.map(r => ({name: r.name, value: {kind: 'var', value: isNumberRole(r) ? '?v' : '?x'}})), polarity: 'affirmed'});
      query.picked = [...(query.picked ?? []), p.id];
    } else { query.rank = null; query.form = 'list'; }
  }
  if (query.matches.length > 1) await connect(oracle, ctx, query);
  // A stored number read for a fixed name is a value, not a count of rows.
  const askedNumeric = query.matches.some(m => m.roles.some(r => r.value.value === '?x' && isNumberRole(ctx.lexicon.predicates[m.predicate]?.roles?.find(x => x.name === r.name) ?? {})));
  if (query.form === 'count' && askedNumeric) query.form = 'value';
  query.select = ASKING.has(query.form) ? '?x' : null;
  query.rank = query.form === 'highest' || query.form === 'lowest' ? {direction: query.form, value: '?v'} : null;
  return query;
}

/** Truth of a yes/no or why question, and the negated statement of a list question ("which … have no …"). */
async function polarities(oracle, ctx, query, text) {
  const closed = m => ctx.lexicon.predicates[m.predicate]?.closed === true;
  if (query.form === 'yesno' || query.form === 'why') {
    const options = POLARITIES.filter(([kind]) => kind !== 'absent' || (query.matches.length === 1 && closed(query.matches[0])));
    const n = ctx.aspects.has('negation') || options.length > 2 ? await oracle.choice('truth', q.truth(options), options.length) : 1;
    query.polarity = options[n - 1][0];
    if (query.matches.length === 1) query.matches[0].polarity = query.polarity;
    return;
  }
  if (!ctx.aspects.has('negation') || query.matches.length < 2) return;
  const lines = query.matches.map(m => matchText(m, ctx.lexicon));
  const n = await oracle.choice('negated', `Does the request say that one of these does NOT hold?\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n0. none\nReply with the number only.`, lines.length, {zero: true});
  if (!n) return;
  const m = query.matches[n - 1];
  m.polarity = closed(m) ? 'absent' : 'negated';
}

/** The asked unknown's place in a statement added later: by observed fit, else one letter question. */
async function askedPlace(oracle, ctx, query, predicate, variable) {
  const entity = predicate.roles.map((r, i) => entityRole(r) ? i : -1).filter(i => i >= 0);
  if (entity.length === 1) return entity[0];
  const fitting = ctx.roleFit.unknownPlaces(query.matches, variable, predicate).filter(i => entity.includes(i));
  if (fitting.length === 1) return fitting[0];
  const letters = entity.map(i => LETTERS[i]);
  const letter = await oracle.read('asked_place', q.nameLetter(statementText(predicate), letters, `${letterOf(variable)} (${UNKNOWN[variable]?.slice(3) ?? 'the unknown'})`), t => { const m = /\b([A-D])\b/.exec(String(t)); return m && letters.includes(m[1]) ? m[1] : null; }, `Reply with one of ${letters.join(', ')}.`, 4);
  return LETTERS.indexOf(letter);
}

/** "Which members have no certificate": a list or count question with one statement and a negation gets the statement that does not hold. */
async function negatedStatement(oracle, ctx, query, text) {
  if (!['list', 'count'].includes(query.form) || query.matches.length !== 1 || oracle.left() < 4 || !ctx.aspects.has('negation')) return;
  const chosen = new Set(query.matches.map(x => x.predicate));
  const ranked = rankStatements(ctx.statements, text).filter(p => !chosen.has(p.id) && p.roles.some(entityRole)).slice(0, SHOWN_STATEMENTS);
  if (!ranked.length) return;
  const n = await oracle.choice('negated_statement', q.notHolding(ranked.map(p => `${statementText(p)}${meaning(p) ? ` (${meaning(p)})` : ''}`)), ranked.length, {zero: true});
  if (!n) return;
  const predicate = ranked[n - 1];
  const at = await askedPlace(oracle, ctx, query, predicate, '?x');
  query.matches.push({predicate: predicate.id, roles: predicate.roles.map((r, i) => ({name: r.name, value: {kind: 'var', value: i === at ? '?x' : ctx.fresh()}})), polarity: predicate.closed === true ? 'absent' : 'negated'});
  query.picked = [...(query.picked ?? []), predicate.id];
}

/**
 * Coverage: a content word of the request that no chosen statement covers but another statement of the knowledge names ("country" and
 * "A city located in country B") is offered once (at most two words): yes adds that statement, joined to the question.
 */
async function coverage(oracle, ctx, query, text) {
  if (!['list', 'value', 'count', 'highest', 'lowest'].includes(query.form) || query.every) return;
  const nameWords = stems(ctx.spans.map(sp => sp.surface).join(' '));
  const covered = stems(query.matches.map(m => { const p = ctx.lexicon.predicates[m.predicate]; return p ? `${phraseOf(p)} ${p.id}` : m.predicate; }).join(' '));
  const missing = [...stems(text)].filter(w => !covered.has(w) && !nameWords.has(w) && !/^\d+$/.test(w));
  const chosen = new Set(query.matches.map(m => m.predicate));
  let asked = 0;
  for (const word of missing) {
    if (asked >= 2 || oracle.left() < 5) return;
    const candidates = rankStatements(ctx.statements, text).filter(p => !chosen.has(p.id) && stems(`${phraseOf(p)} ${p.id}`).has(word));
    if (candidates.length !== 1) continue;
    const predicate = candidates[0];
    asked++;
    const yes = await oracle.choice('coverage', `The request also says "${(new RegExp(`[\\p{L}-]*${word}[\\p{L}-]*`, 'iu').exec(text) ?? [word])[0]}". Does it need the statement "${statementText(predicate)}"${meaning(predicate) ? ` (${meaning(predicate)})` : ''}?\n1. yes\n2. no\nReply with the number only.`, 2);
    if (yes !== 1) continue;
    chosen.add(predicate.id);
    const unknowns = unknownsFor(query.form, query.matches.length + 1, ctx.aspects);
    ctx.askedPlaced = vars(query.matches).has('?x');
    query.matches.push({predicate: predicate.id, roles: await fillPlaces(oracle, ctx, predicate, {form: query.form, names: ctx.names.filter(id => !ctx.reserved.has(id)), unknowns: [...new Set([...unknowns, '?p'])], count: query.matches.length + 1}), polarity: 'affirmed'});
    ctx.askedPlaced = false;
    query.picked = [...(query.picked ?? []), predicate.id];
    await connect(oracle, ctx, query);
  }
}

/* ------------------------------------------------------------------ aspects */

/** Q2: the aspects the request has (the model's checklist; an aspect without anything in the request to build it from is dropped). */
async function detectAspects(oracle, ctx) {
  const picked = await oracle.read('aspects', q.aspects(), t => readChoices(t, ASPECTS.length), 'Reply with the numbers separated by commas, or 0.', 24);
  const model = new Set(picked[0] === 0 ? [] : picked.map(n => ASPECTS[n - 1][0]));
  const possible = {limit: ctx.numbers.length > 0, options: ctx.names.length >= 2, exclusion: ctx.names.length >= 1, twoSided: ctx.names.length >= 2, chain: ctx.names.length >= 1, fewest: ctx.names.length >= 2};
  return new Set([...model].filter(aspect => possible[aspect] !== false));
}

/** The names of the request that one aspect picks out (options, exclusions): all of them when they are exactly two options, else asked. */
async function namesFor(oracle, ctx, name, question, {all = 0} = {}) {
  const names = ctx.names.filter(id => !ctx.reserved.has(id));
  if (all && names.length === all) return names;
  if (!names.length) return [];
  const picked = await oracle.read(name, question(names), t => readChoices(t, names.length), 'Reply with the numbers separated by commas, or 0.', 16);
  return picked[0] === 0 ? [] : picked.map(n => names[n - 1]);
}

/** A part of the request the model copies (a supposition, a second question): kept only when it is a verbatim part of the message. */
async function copiedPart(oracle, ctx, name, what) {
  const answer = String(await oracle.ask(name, q.copyPart(what), 64)).trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!answer || /^0\b/.test(answer)) return null;
  const at = fold(ctx.message).indexOf(fold(answer));
  return at >= 0 ? ctx.message.slice(at, at + answer.length) : null;
}

const compareVar = (ctx, query) => {
  const used = vars(query.matches);
  for (let k = 1; k < 20; k++) if (!used.has(`?n${k}`)) return `?n${k}`;
  return ctx.fresh();
};

/** Q5: each limit of the request (ctx.limits, read from the model's limit kinds) becomes a comparison of a value or of a count per group. */
async function applyLimits(oracle, ctx, query, limits) {
  for (const limit of limits) {
    const targets = [];
    const subject = query.form === 'every' ? '?m' : '?x';
    for (const m of query.matches) {
      const predicate = ctx.lexicon.predicates[m.predicate];
      for (const r of m.roles) {
        const role = predicate?.roles?.find(x => x.name === r.name) ?? {};
        if (isNumberRole(role) && r.value.kind === 'var') targets.push({text: `the ${r.name} in "${matchText(m, ctx.lexicon)}"`, apply: () => { for (const [c, n] of limit.comparisons) query.compares.push(`${r.value.value} ${c} ${n}`); }});
      }
      const asked = m.roles.find(r => r.value.kind === 'var' && (r.value.value === '?x' || r.value.value === '?m'));
      const counted = m.roles.find(r => r !== asked && r.value.kind === 'var' && entityRole(predicate?.roles?.find(x => x.name === r.name) ?? {}));
      if (asked && counted && predicate?.roles?.length === 2) targets.push({text: `how many ${counted.name}s each ${asked.value.value.slice(1).toUpperCase()} has in "${statementText(predicate)}" (a count)`, apply: () => {
        const def = groupCount(ctx, predicate, asked.name, counted.name);
        ctx.definitions.push(def.sop);
        const n = compareVar(ctx, query);
        Object.assign(m, {predicate: def.name, roles: [{name: 'subject', value: asked.value}, {name: 'object', value: {kind: 'var', value: n}}], polarity: 'affirmed'});
        for (const [c, k] of limit.comparisons) query.compares.push(`${n} ${c} ${k}`);
      }});
    }
    const chosen = new Set(query.matches.map(m => m.predicate));
    for (const p of rankStatements(ctx.statements, ctx.message).filter(p => !chosen.has(p.id) && p.roles.length === 2 && p.roles.some(isNumberRole) && p.roles.some(entityRole)).slice(0, 3)) {
      targets.push({text: `the value in "${statementText(p)}"`, apply: () => {
        const n = compareVar(ctx, query);
        query.matches.push({predicate: p.id, roles: p.roles.map(r => ({name: r.name, value: {kind: 'var', value: isNumberRole(r) ? n : subject}})), polarity: 'affirmed'});
        for (const [c, k] of limit.comparisons) query.compares.push(`${n} ${c} ${k}`);
      }});
    }
    const subjectVar = vars(query.matches).has(subject) ? subject : '?x';
    targets.push({text: 'how many things each one has according to another statement (a count)', apply: async () => {
      const binary = rankStatements(ctx.statements, `${limit.span} ${ctx.message}`).filter(p => p.roles.length === 2 && p.roles.every(entityRole)).slice(0, SHOWN_STATEMENTS);
      if (!binary.length) return;
      // A literal limit must be used: with one candidate statement there is nothing to ask.
      const k = binary.length === 1 ? 1 : await oracle.choice('limit_statement', `Which statement says what is counted in "${limit.span}"?\n${binary.map((p, i) => `${i + 1}. ${statementText(p)}${meaning(p) ? ` (${meaning(p)})` : ''}`).join('\n')}\n0. none of these\nReply with the number only.`, binary.length, {zero: true});
      if (!k) return;
      const predicate = binary[k - 1];
      const fitting = ctx.roleFit.unknownPlaces(query.matches, subjectVar, predicate);
      const letter = fitting.length === 1 ? LETTERS[fitting[0]] : await oracle.read('count_place', q.nameLetter(statementText(predicate), ['A', 'B'], `${letterOf(subjectVar)} (each of the things the request asks for)`), t => { const m = /\b([AB])\b/.exec(String(t)); return m ? m[1] : null; }, 'Reply with A or B.', 4);
      const group = predicate.roles[LETTERS.indexOf(letter)], counted = predicate.roles.find(r => r !== group);
      const def = groupCount(ctx, predicate, group.name, counted.name);
      ctx.definitions.push(def.sop);
      const n = compareVar(ctx, query);
      query.matches.push({predicate: def.name, roles: [{name: 'subject', value: {kind: 'var', value: subjectVar}}, {name: 'object', value: {kind: 'var', value: n}}], polarity: 'affirmed'});
      for (const [c, v] of limit.comparisons) query.compares.push(`${n} ${c} ${v}`);
    }});
    const direct = targets.filter(t => t.text.startsWith('the ') && !t.text.startsWith('the value in'));
    // One limit and one number place the oracle left unknown: the two signals agree, no question. Several number places: the one whose
    // statement shares a word with the words next to the limit ("goals scored above 28").
    const near = stems(ctx.message.slice(Math.max(0, (limit.at ?? 0) - 40), (limit.at ?? 0) + limit.span.length + 20));
    const close = direct.filter(t => [...stems(t.text)].some(w => near.has(w)));
    const n = targets.length === 1 ? 1 : direct.length === 1 && limits.length === 1 ? targets.indexOf(direct[0]) + 1 : close.length === 1 ? targets.indexOf(close[0]) + 1 : await oracle.choice('limit', q.limitTarget(limit.span, targets.map(t => t.text)), targets.length, {zero: true});
    if (n) await targets[n - 1].apply();
  }
}

/** Entity-typed unknowns of a query, for options and exclusions. */
function entityUnknowns(ctx, query) {
  const out = [];
  for (const m of query.matches) {
    const predicate = ctx.lexicon.predicates[m.predicate];
    for (const r of m.roles) if (r.value.kind === 'var' && entityRole(predicate?.roles?.find(x => x.name === r.name) ?? {}) && !out.some(o => o.variable === r.value.value))
      out.push({variable: r.value.value, text: `${UNKNOWN[r.value.value]?.slice(0, 1) ?? 'the unknown'} in "${matchText(m, ctx.lexicon)}"`});
  }
  return out.sort((a, b) => Number(b.variable === '?x') - Number(a.variable === '?x'));
}

async function pickUnknown(oracle, name, prompt, unknowns) {
  if (!unknowns.length) return null;
  if (unknowns.length === 1 || unknowns[0].variable === '?x') return unknowns[0].variable;
  const n = await oracle.choice(name, prompt(unknowns.map(u => u.text)), unknowns.length, {zero: true});
  return n ? unknowns[n - 1].variable : null;
}

const idOf = (ctx, span) => span.mention.candidates.map(c => c.id).find(id => ctx.names.includes(id)) ?? span.mention.candidates[0]?.id;

/** Q6: a choice between named options restricts an unknown to them. */
async function applyOptions(oracle, ctx, query) {
  const names = ctx.options;
  if (names.length < 2) return;
  const variable = await pickUnknown(oracle, 'options', list => q.optionsTarget(names.join(' or '), list), entityUnknowns(ctx, query));
  if (variable) query.any = {variable, values: names};
}

/** Q8: an exclusion ("not X", "besides X"). */
async function applyExclusions(oracle, ctx, query) {
  for (const id of ctx.exclusions) {
    if (!id || query.matches.some(m => m.roles.some(r => r.value.value === id))) continue;
    const variable = await pickUnknown(oracle, 'exclusion', list => q.exclusionTarget(id, list), entityUnknowns(ctx, query));
    if (variable) query.excepts.push({variable, value: id});
  }
}

/** Q9: the group and the scope of a quantified question. */
async function applyEvery(oracle, ctx, query) {
  let restriction = query.matches.filter(m => m.roles.some(r => r.value.kind === 'entity'));
  let scope = query.matches.filter(m => !restriction.includes(m));
  if (!restriction.length || !scope.length) {
    if (query.matches.length < 2) return false;
    const n = await oracle.choice('scope', q.scope(query.matches.map(m => matchText(m, ctx.lexicon))), query.matches.length);
    scope = [query.matches[n - 1]];
    restriction = query.matches.filter((_, i) => i !== n - 1);
  }
  const n = await oracle.choice('quantifier', q.quantifier(), QUANTIFIERS.length);
  let quantifier = QUANTIFIERS[n - 1][0];
  if (quantifier === 'at_least') quantifier = ctx.numbers.length ? `at_least ${ctx.numbers[0]}` : 'all';
  query.every = {restriction, scope, quantifier};
  query.select = null;
  return true;
}

/** Q10: a chain of links instead of one direct link (a count or list over everything reachable). */
async function applyChain(oracle, ctx, query) {
  const binary = query.matches.filter(m => m.roles.length === 2 && m.roles.every(r => entityRole(ctx.lexicon.predicates[m.predicate]?.roles?.find(x => x.name === r.name) ?? {})));
  const m = binary.find(x => x.roles.some(r => r.value.kind === 'entity') && x.roles.some(r => r.value.kind === 'var'));
  if (!m) return false;
  if (await oracle.choice('chain', q.chain(statementText(ctx.lexicon.predicates[m.predicate])), 2) !== 1) return false;
  const def = chainDefinitions(ctx, m.predicate);
  ctx.definitions.push(def.sop);
  const [subject, object] = ctx.lexicon.predicates[m.predicate].roles;
  m.predicate = def.name;
  m.roles = [{name: 'subject', value: m.roles.find(r => r.name === subject.name).value}, {name: 'object', value: m.roles.find(r => r.name === object.name).value}];
  return true;
}

/** The start and the end of a chain: one name each, asked (two names in the request: the end is the other one). */
async function startAndGoal(oracle, names) {
  const start = names[(await oracle.choice('start', q.pickName('the starting point', names), names.length)) - 1];
  const rest = names.filter(n => n !== start);
  const goal = rest.length === 1 ? rest[0] : rest[(await oracle.choice('goal', q.pickName('the end point', rest), rest.length)) - 1];
  return {start, goal};
}

/**
 * Reachability: a relation of the knowledge that already is reachability (derived by its rules) is asked directly; otherwise the
 * chain is written from the step statement and the statement the chain avoids (method A's definitions). Start and end are asked;
 * names that only occur in a supposition are not candidates.
 */
async function reachQuestion(oracle, ctx, state) {
  const text = state.mainText;
  const supposed = new Set(state.clauses.filter(c => ['supposition', 'fact'].includes(c.role)).flatMap(c => mentionSpans(c.text, ctx.mentions).map(sp => idOf(ctx, sp))));
  const names = ctx.names.filter(id => !supposed.has(id));
  const binary = ctx.statements.filter(p => p.roles.length === 2 && p.roles.every(entityRole));
  if (!binary.length || names.length < 2) return false;
  let start = null, goal = null;
  const ends = async () => { if (!start) ({start, goal} = await startAndGoal(oracle, names)); };
  const known = rankStatements(binary.filter(p => p.derived && /reach|route|path|connect|access/i.test(`${p.id} ${phraseOf(p)}`)), text).slice(0, 4);
  if (known.length) {
    const n = await oracle.choice('reach_relation', `Does one of these statements of the knowledge already say what the request asks?\n${known.map((p, i) => `${i + 1}. ${statementText(p)}   (worked out by the rules of the knowledge)`).join('\n')}\n0. none of these\nReply with the number only.`, known.length, {zero: true});
    if (n) {
      await ends();
      const p = known[n - 1];
      state.query = {id: 'q', form: 'yesno', polarity: 'affirmed', matches: [{predicate: p.id, roles: [{name: p.roles[0].name, value: {kind: 'entity', value: start}}, {name: p.roles[1].name, value: {kind: 'entity', value: goal}}], polarity: 'affirmed'}],
        compares: [], excepts: [], links: [], select: null, rank: null, time: null, picked: [p.id]};
      state.form = 'yesno';
      return true;
    }
  }
  const steps = rankStatements(binary.filter(p => !p.derived), text);
  if (!steps.length) return false;
  const step = steps.length === 1 ? steps[0] : steps[(await oracle.choice('step', askA.step(steps.slice(0, SHOWN_STATEMENTS).map((p, i) => `${i + 1}. ${statementText(p)}${p.example ? `   (example: ${p.example})` : ''}`)), Math.min(SHOWN_STATEMENTS, steps.length))) - 1];
  const unary = rankStatements(ctx.statements.filter(p => p.roles.length === 1 && entityRole(p.roles[0])), text).slice(0, SHOWN_STATEMENTS);
  // The statement the chain avoids: named by the words of a supposition the model copied when exactly one fits, else asked.
  const avoidText = state.clauses.filter(c => c.role === 'supposition').map(c => c.text).join(' ');
  const nameWords = stems(ctx.spans.map(sp => sp.surface).join(' '));
  const avoidWords = [...stems(avoidText)].filter(w => !nameWords.has(w));
  const named = unary.filter(p => avoidWords.some(w => stems(`${phraseOf(p)} ${p.id}`).has(w)));
  const avoid = named.length === 1 ? unary.indexOf(named[0]) + 1 : unary.length ? await oracle.choice('avoid', askA.avoid(unary.map((p, i) => `${i + 1}. ${statementText(p)}`)), unary.length, {zero: true}) : 0;
  await ends();
  state.avoidByCue = named.length === 1;
  state.reachPlan = {form: 'reach', reach: {step: step.id, avoid: avoid ? unary[avoid - 1].id : null, stepName: freeName(ctx, `allowed_${step.id}`), reachName: freeName(ctx, `reachable_by_${step.id}`), start, goal}};
  return true;
}

/** Q10: the fewest links from one named thing to another. */
async function fewestQuery(oracle, ctx) {
  const binary = ctx.statements.filter(p => p.roles.length === 2 && p.roles.every(entityRole));
  if (!binary.length || ctx.names.length < 2) return null;
  const ranked = rankStatements(binary, ctx.message);
  const step = ranked.length === 1 ? ranked[0] : ranked[(await oracle.choice('step', q.stepStatement(ranked.slice(0, 8).map(p => statementText(p))), Math.min(8, ranked.length))) - 1];
  const {start, goal} = await startAndGoal(oracle, ctx.names);
  const def = fewestLinks(ctx, step.id);
  ctx.definitions.push(def.sop);
  return {id: 'q', form: 'value', matches: [{predicate: def.name, roles: [{name: 'subject', value: {kind: 'entity', value: start}}, {name: 'object', value: {kind: 'entity', value: goal}}, {name: 'topic', value: {kind: 'var', value: '?x'}}], polarity: 'affirmed'}],
    compares: [], excepts: [], links: [], select: '?x', rank: {direction: 'lowest', value: '?x'}, time: null};
}

async function applyTime(oracle, ctx, query) {
  if (query.form === 'when') {
    const m = query.matches.find(x => x.roles.some(r => r.value.kind === 'entity')) ?? query.matches[0];
    // A statement that declares a time place keeps it: its unknown is the asked time.
    const own = m.roles.find(r => r.name === 'time');
    if (own && own.value.kind === 'var') { const v = own.value.value; for (const x of query.matches) for (const r of x.roles) if (r.value.value === v) r.value = {kind: 'var', value: '?t'}; }
    else if (!own) m.roles.push({name: 'time', value: {kind: 'var', value: '?t'}});
    query.select = '?t';
    // Since when, until when or how long: one numbered question (the time measures of sop/enums.mjs).
    query.measure = [null, null, 'start', 'end', 'duration'][await oracle.choice('measure', q.measure(), 4)] ?? null;
    return;
  }
  // A date written in the request is structure (date normalisation), like a number; the model's checklist may add one in words.
  let dates = readDates(ctx.message);
  if (!dates.length && (!ctx.aspects.has('date') || !mentionsTime(ctx.message))) return;
  if (!dates.length) dates = readDates(await oracle.ask('dates', askA.dates(), 48));
  if (dates.length === 1) query.time = {kind: 'at', dates};
  else if (dates.length >= 2) {
    const n = await oracle.choice('period', askA.period(dates[0], dates[1]), PERIODS.length);
    query.time = {kind: PERIODS[n - 1][0], dates: dates.slice(0, 2)};
  }
}

/* ------------------------------------------------------------------ clauses */

/** Names of a clause: its own linked mentions, else the one name of the request, else the name the model says the part is about. */
async function clauseNames(oracle, ctx, text) {
  const own = mentionSpans(text, ctx.mentions).map(s => idOf(ctx, s)).filter(id => id && ctx.names.includes(id));
  if (own.length) return [...new Set(own)];
  if (ctx.names.length === 1) return [ctx.names[0]];
  if (ctx.names.length > 1 && oracle.left() > 3) {
    const n = await oracle.choice('clause_name', q.clauseName(text, ctx.names), ctx.names.length, {zero: true});
    return n ? [ctx.names[n - 1]] : [];
  }
  return [];
}

/** A clause that states or supposes something: one statement with names only. */
async function clauseStatement(oracle, ctx, clause, certainty) {
  const [predicate] = await pickStatements(oracle, ctx, clause.text, 'the part', {single: true});
  if (!predicate) return null;
  const names = await clauseNames(oracle, ctx, clause.text);
  const roles = await fillPlaces(oracle, ctx, predicate, {form: 'yesno', names, unknowns: [], count: 1});
  if (roles.some(r => r.value.kind === 'var')) return null; // a statement needs names in every place
  // Statements are anchored to the message: the name as the user wrote it.
  const surface = id => ctx.spans.find(s => idOf(ctx, s) === id)?.surface ?? id;
  const polarity = ctx.aspects.has('negation') && await oracle.choice('clause_truth', q.clauseTruth(clause.text), 2) === 2 ? 'negated' : 'affirmed';
  return {certainty, match: {predicate: predicate.id, roles: roles.map(r => ({name: r.name, value: r.value.kind === 'entity' ? {kind: 'entity', value: surface(r.value.value)} : r.value})), polarity}};
}

/** Q11: the role of each extra part the model copied, and the link of a supposition or a time limit. */
async function clauseRoles(oracle, ctx, extras) {
  const out = [];
  for (const clause of extras) {
    const role = clause.role ?? CLAUSE_ROLES[(await oracle.choice('clause_role', q.clauseRole(clause.text), CLAUSE_ROLES.length)) - 1][0];
    out.push({...clause, role, link: clause.link ?? await clauseLink(oracle, role, clause.text)});
  }
  return out;
}

/** The link keyword of a supposition (if, unless) or of a time limit (before, after, when), from one numbered question. */
async function clauseLink(oracle, role, text) {
  if (role === 'supposition') return (await oracle.choice('supposition_link', q.supposition(text), 2)) === 2 ? 'unless' : 'if';
  if (role === 'time') return [null, 'before', 'after', 'when'][await oracle.choice('time_link', q.timeLink(text), 3)];
  return null;
}

/** The parts of a request (method D): the model copies them; only verbatim parts count, the first is the main question. */
async function requestParts(oracle, ctx) {
  const answer = String(await oracle.ask('parts', q.parts(), 160));
  const lines = answer.split('\n').map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim().replace(/^["'`]+|["'`]+$/g, '').trim()).filter(Boolean);
  const parts = [];
  for (const line of lines) {
    const at = fold(ctx.message).indexOf(fold(line));
    if (at >= 0 && line.length >= 3 && !parts.some(p => p.text === line)) parts.push({text: ctx.message.slice(at, at + line.length), at});
  }
  if (parts.length < 2) return {main: ctx.message, extras: []};
  return {main: parts[0].text, extras: parts.slice(1).map(p => ({text: p.text.replace(/[?.!,;]+$/, '').trim(), kind: 'sub'}))};
}

/* ------------------------------------------------------------------ the program */

/** Builds the main question of the program from the kind on. */
async function mainQuestion(oracle, ctx, state, from) {
  const {form} = state;
  const text = state.mainText;
  if (form === 'puzzle') {
    state.puzzle = await puzzlePlan(oracle, state.puzzle ?? {form: 'puzzle'}, Math.max(state.puzzle ? 2 : 1, from));
    return;
  }
  if (form === 'reach') {
    if (await reachQuestion(oracle, ctx, state)) return;
    // No chain can be built: whether one thing reaches another stays a yes/no question over the statements.
    state.form = 'yesno';
    return mainQuestion(oracle, ctx, state, from);
  }
  if (ctx.aspects.has('fewest') && ['value', 'count', 'lowest', 'list'].includes(form)) {
    state.query = await fewestQuery(oracle, ctx);
    if (state.query) return;
  }
  const effective = form === 'statement' ? 'yesno' : form;
  if (from <= 1) state.picked = await pickStatements(oracle, ctx, text, 'the request');
  if (!state.picked.length) {
    // Q10: none fits directly; a chain, a per-group count or the fewest links can be worked out from the statements.
    if (oracle.left() > 4 && ctx.statements.length && form !== 'statement') {
      const n = await oracle.choice('definition', q.definition(), 3, {zero: true});
      if (n === 3) { state.query = await fewestQuery(oracle, ctx); if (state.query) return; }
      if (n === 1 || n === 2) state.picked = await pickStatements(oracle, ctx, text, 'the request');
      state.definition = n;
    }
    if (!state.picked.length) { state.query = null; return; }
  }
  const sided = ctx.aspects.has('twoSided') ? await twoSidedKind(oracle, ctx) : null;
  const query = await relational(oracle, ctx, {text, form: effective, names: [...ctx.names, ...ctx.classNames].filter(id => !ctx.reserved.has(id)), picked: state.picked, sided});
  if (!sided && query) await comparedPair(oracle, ctx, query);
  state.query = query;
  await coverage(oracle, ctx, query, text);
  await polarities(oracle, ctx, query, text);
  await negatedStatement(oracle, ctx, query, text);
  if (state.definition === 1 || (ctx.aspects.has('chain') && ['count', 'list'].includes(query.form))) await applyChain(oracle, ctx, query);
  // A quantified question needs a group and a scope: with a single statement it can only be a yes/no question about it.
  if (query.form === 'every' && !await applyEvery(oracle, ctx, query)) { query.form = 'yesno'; query.select = null; await polarities(oracle, ctx, query, text); }
  if (ctx.limits.length && !(query.form === 'every' && /^at_least/.test(query.every?.quantifier ?? ''))) await applyLimits(oracle, ctx, query, ctx.limits);
  if (ctx.aspects.has('options')) await applyOptions(oracle, ctx, query);
  if (ctx.aspects.has('exclusion')) await applyExclusions(oracle, ctx, query);
  await applyTime(oracle, ctx, query);
  if (query.form === 'why') { query.select = null; }
  if (form === 'statement') state.statements = query.matches;
}

const LIMIT_WORDS = ['above', 'below', 'at_least', 'at_most', 'equal'];
/** The limits of the request: for each standalone number (at most two), the model says which limit it sets, if any. */
async function limitsFromNumbers(oracle, ctx) {
  const out = [];
  for (const number of ctx.numbers.filter(n => !ctx.reservedNumbers.has(n)).slice(0, 2)) {
    const n = await oracle.choice('limit_kind', q.limitKind(number), 5, {zero: true});
    const at = ctx.message.search(new RegExp(`(?<![\\w.-])${String(number).replace('-', '\\-')}(?![\\w.-])`));
    if (n) out.push({span: String(number), at: Math.max(0, at), comparisons: [[LIMIT_WORDS[n - 1], number]]});
  }
  return out;
}

function programOf(ctx, state) {
  return {...programBody(ctx, state), ...(ctx.pragmatic.length ? {pragmatic: ctx.pragmatic.map(kind => (ctx.actSpans[kind] ? {kind, span: ctx.actSpans[kind]} : kind))} : {})};
}

function programBody(ctx, state) {
  // Nothing asked or stated: the message acts alone (a greeting, thanks, a feeling), else `unclear no_request`.
  if (state.form === 'none') return ctx.pragmatic.length ? {} : {unclear: 'no_request'};
  if (state.form === 'self') return state.query ? {queries: [state.query]} : {unclear: 'relation_not_in_memory'};
  if (state.form === 'instruction') return state.instruction ? {instructions: [state.instruction]} : {unclear: 'no_request'};
  if (state.form === 'puzzle') return {constraint: state.puzzle.constraint};
  const stated = [], links = [], unparsed = [], queries = [];
  for (const [i, s] of (state.clauses ?? []).entries()) {
    const id = `s${i + 1}`;
    if (s.statement) {
      stated.push({id, ...s.statement});
      if (s.role === 'supposition') links.push({keyword: s.link === 'unless' ? 'unless' : 'if', target: id});
      else if (s.role === 'time' && ['before', 'after', 'when', 'while'].includes(s.link)) links.push({keyword: s.link, target: id});
      else if (s.link && ['because', 'although'].includes(s.link)) links.push({keyword: s.link, target: id});
    } else if (s.query) queries.push(s.query);
    else if (s.unparsed) unparsed.push({span: s.text.replace(/[?.!]+$/, '').trim()});
  }
  if (state.form === 'reach' && state.reachPlan?.reach) {
    return {reachA: state.reachPlan, stated, links, unparsed, pragmatic: ctx.pragmatic};
  }
  if (state.form === 'statement') {
    for (const [i, m] of (state.statements ?? []).entries()) if (m.roles.every(r => r.value.kind === 'entity')) {
      const surface = id => ctx.spans.find(s => idOf(ctx, s) === id)?.surface ?? id;
      stated.push({id: `f${i + 1}`, certainty: 'asserted', match: {...m, roles: m.roles.map(r => ({...r, value: {kind: 'entity', value: surface(r.value.value)}}))}});
    }
    return stated.length ? {stated, definitions: ctx.definitions, queries, unparsed} : {unclear: 'relation_not_in_memory'};
  }
  if (state.query) queries.unshift({...state.query, links: [...(state.query.links ?? []), ...links]});
  else if (queries.length || stated.some(s => s.certainty !== 'supposed')) unparsed.unshift({span: state.mainText.replace(/[?.!]+$/, '').trim()});
  if (!queries.length && !stated.some(s => s.certainty !== 'supposed')) return {unclear: 'relation_not_in_memory'};
  return {definitions: [...ctx.definitions], stated, queries, unparsed};
}

function sopOf(program, lexicon = null) {
  if (program.reachA) {
    const signals = program.pragmatic?.length ? assembleProgram({pragmatic: program.pragmatic}) : '';
    let base = assembleA(program.reachA);
    // A chain over a complete (closed) step statement is complete too: absence of a path is then a no, not an unknown.
    const r = program.reachA.reach;
    if (lexicon?.predicates?.[r.step]?.closed === true) base = base.replace(`@${r.reachName} predicate\n  args subject:entity object:entity\n`, `@${r.reachName} predicate\n  args subject:entity object:entity\n  closed true\n`);
    const head = [...program.stated.map(s => assembleProgram({stated: [s]}).trim())].join('\n');
    const tail = program.links.map(l => `  ${l.keyword} $${l.target}`).join('\n');
    const unparsed = program.unparsed.length ? assembleProgram({unparsed: program.unparsed}).trim() : '';
    return [head, base.trimEnd() + (tail ? `\n${tail}` : ''), unparsed, signals.trim()].filter(Boolean).join('\n') + '\n';
  }
  return assembleProgram(program);
}

function paraphraseOf(program, lexicon) {
  if (program.constraint) return paraphraseA({form: 'puzzle', constraint: program.constraint}, lexicon);
  if (program.reachA) {
    const sup = program.stated.map(s => `Supposing that ${matchText(s.match, lexicon)}:`).join(' ');
    return `${sup ? sup + ' ' : ''}${paraphraseA(program.reachA, lexicon)}`;
  }
  return paraphraseProgram(program, lexicon, {definitionsText: program.definitions?.length ? 'with the counts or chains worked out from the knowledge' : null});
}

/* ------------------------------------------------------------------ confirmation */

/** Alternative readings of the main question, each with one slot changed: the forced contrast shows one of them. */
function flips(ctx, state) {
  const out = [];
  const query = state.query;
  if (state.form === 'reach' && state.reachPlan?.reach) {
    const unary = ctx.statements.filter(p => p.roles.length === 1);
    const r = state.reachPlan.reach;
    if (state.avoidByCue) return out; // decided by the words of the request, not by the oracle
    if (r.avoid) out.push({slot: 'avoid', apply: s => { s.reachPlan.reach.avoid = null; }});
    else if (unary.length) out.push({slot: 'avoid', apply: s => { s.reachPlan.reach.avoid = rankStatements(unary, ctx.message)[0].id; }});
    return out;
  }
  if (!query) return out;
  // Fewer statements: a derived statement of the knowledge that holds the request's names may answer alone (its rules do the rest).
  const derivedAt = query.matches.length > 1 && query.form !== 'every' ? query.matches.findIndex(m => ctx.statements.find(p => p.id === m.predicate)?.derived && m.roles.some(r => r.value.kind === 'entity')) : -1;
  if (derivedAt >= 0 && !query.compares?.length && !query.rank) out.push({slot: 'statements', apply: s => {
    const keep = s.query.matches[derivedAt];
    const free = keep.roles.find(r => r.value.kind === 'var');
    if (ASKING.has(s.query.form) && free) { const v = free.value.value; for (const r of keep.roles) if (r.value.value === v) r.value = {kind: 'var', value: '?x'}; }
    s.query.matches = [keep];
    s.query.picked = [keep.predicate];
  }});
  if (query.matches.length === 1 && query.picked?.length === 1 && ctx.lexicon.predicates[query.matches[0].predicate]) {
    const m = query.matches[0];
    // The alternative keeps the role structure (same role names and kinds), so the asked place stays the same kind of place.
    const alternative = rankStatements(ctx.statements, state.mainText).find(p => p.id !== m.predicate && p.roles.length === m.roles.length && p.roles.every((r, i) => r.name === m.roles[i].name && isNumberRole(r) === isNumberRole(ctx.lexicon.predicates[m.predicate]?.roles?.[i] ?? {})));
    if (alternative) out.push({slot: 'statement', apply: s => { s.query.matches[0] = {...m, predicate: alternative.id, roles: alternative.roles.map((r, i) => ({name: r.name, value: m.roles[i].value}))}; s.query.picked = [alternative.id]; }});
  }
  const at = query.matches.findIndex(m => m.roles.length === 2 && m.roles.every(r => entityRole(ctx.lexicon.predicates[m.predicate]?.roles?.find(x => x.name === r.name) ?? {})) && new Set(m.roles.map(r => JSON.stringify(r.value))).size === 2 && m.roles.some(r => r.value.kind === 'entity'));
  // Swapping the places of a statement is offered only when the swapped names still fit their places (observed role fit).
  const swapPredicate = at >= 0 ? ctx.lexicon.predicates[query.matches[at].predicate] : null;
  const swapFits = Boolean(swapPredicate) && query.matches[at].roles.every((r, i) => r.value.kind !== 'entity' || (ctx.roleFit(r.value.value, swapPredicate, 1 - i) && !ctx.roleFit.observed(r.value.value, swapPredicate).includes(i)));
  const twin = at >= 0 && query.matches.filter(m => m.predicate === query.matches[at].predicate).length > 1;
  if (at >= 0 && swapFits && !twin) out.push({slot: 'places', apply: s => { const roles = s.query.matches[at].roles; [roles[0].value, roles[1].value] = [roles[1].value, roles[0].value]; }});
  if (query.form === 'yesno' || query.form === 'why') {
    const closed = query.matches.length === 1 && ctx.lexicon.predicates[query.matches[0].predicate]?.closed === true;
    const other = query.polarity === 'affirmed' ? (closed ? 'absent' : 'negated') : 'affirmed';
    out.push({slot: 'truth', apply: s => { s.query.polarity = other; if (s.query.matches.length === 1) s.query.matches[0].polarity = other; }});
  }
  const forms = {count: 'list', list: 'count', highest: 'lowest', lowest: 'highest', value: 'list'};
  if (forms[query.form] && (!query.rank || query.form === 'highest' || query.form === 'lowest')) out.push({slot: 'kind', apply: s => {
    const f = forms[s.query.form];
    s.query.form = f;
    if (s.query.rank) s.query.rank.direction = f;
  }});
  if (query.form === 'every') out.push({slot: 'quantifier', apply: s => { s.query.every.quantifier = s.query.every.quantifier === 'none' ? 'all' : 'none'; }});
  return out;
}

/* ------------------------------------------------------------------ requests about the assistant */

/** The entity of the assistant in the self layer (config/knowledge/assistant-v1). */
const SELF = 'mrp_llm';
const selfMatch = (predicate, roles) => ({predicate, roles: roles.map(([name, value]) => ({name, value: value.startsWith('?') ? {kind: 'var', value} : {kind: 'entity', value}})), polarity: 'affirmed'});

/**
 * Kind `self`: one numbered question (what about the assistant), then a fixed circuit over the self layer. A random fact or examples
 * sample the answers (`order random`, `limit`) of one of the relations the memory holds most facts of, picked with a seeded choice:
 * the data decides, not the words. Returns the query, or null when the memory has no self layer or the model chose "none of these".
 */
async function selfQuery(oracle, ctx) {
  // A message act that can be the whole request (do you have feelings?, your favourite film?): the self layer may not answer it, so
  // 0 is offered and leaves the message to the act's reply (P-2.1).
  const other = ctx.standalone?.length ? actQuestions().selfOther() : null;
  const n = await oracle.choice('self', q.self(ctx.message, other), SELF_ASPECTS.length, {zero: Boolean(other)});
  if (n === 0) return null;
  const aspect = SELF_ASPECTS[(n || 1) - 1][0];
  const has = id => Boolean(ctx.lexicon?.predicates?.[id]);
  const query = {id: 'q', form: 'list', select: '?x', matches: []};
  if (aspect === 'describe' && has('description')) query.matches.push(selfMatch('description', [['subject', SELF], ['object', '?x']]));
  else if (aspect === 'abilities' && has('can_do')) query.matches.push(selfMatch('can_do', [['subject', SELF], ['object', '?x']]));
  else if (aspect === 'topics' && has('knows_about')) query.matches.push(selfMatch('knows_about', [['subject', SELF], ['topic', '?x']]));
  else if (aspect === 'size' && has('memory_size')) { query.select = '?x ?v'; query.matches.push(selfMatch('memory_size', [['subject', '?x'], ['object', '?v']])); }
  else if (aspect === 'random_fact' || aspect === 'examples') {
    // A fact worth telling: a relation with facts, two places, not a class membership (the memory marks those with `reading class`).
    const ranked = Object.values(ctx.lexicon?.predicates ?? {}).filter(p => (p.factCount ?? 0) > 0 && (p.roles?.length ?? p.args?.length) === 2 && !(p.readings ?? []).includes('class'))
      .sort((a, b) => b.factCount - a.factCount || a.id.localeCompare(b.id)).slice(0, 20);
    if (!ranked.length) return null;
    const p = ranked[Math.abs(hash(ctx.message + Date.now())) % ranked.length];
    const roles = (p.roles?.length ? p.roles.map(r => r.name) : ['subject', 'object']);
    query.select = '?x ?y';
    query.matches.push(selfMatch(p.id, [[roles[0], '?x'], [roles[1], '?y']]));
    query.sample = {limit: aspect === 'random_fact' ? 1 : 5};
  }
  return query.matches.length ? query : null;
}

/** Kind `instruction`: what the instruction asks; the words of a prefix or suffix are copied verbatim from the message. Null when unreadable. */
async function instructionOf(oracle, ctx) {
  const n = await oracle.choice('instruction', q.instruction(ctx.message), INSTRUCTION_ASPECTS.length);
  const aspect = INSTRUCTION_ASPECTS[(n || 1) - 1][0];
  if (aspect === 'list') return {do: 'list'};
  if (aspect === 'cancel') {
    const k = await oracle.choice('instruction_stop', q.instructionStop(), SETTABLE.length, {zero: true});
    return k ? {do: 'cancel', kind: SETTABLE[k - 1][0]} : {do: 'cancel'};
  }
  if (aspect === 'prefix' || aspect === 'suffix') {
    const text = await copiedPart(oracle, ctx, 'instruction_text', aspect === 'prefix' ? 'the exact words every answer should start with' : 'the exact words every answer should end with');
    const words = text?.replace(/^[«“”"'‘’]+|[»“”"'‘’]+$/g, '').trim();
    return words ? {do: 'set', kind: aspect, text: words} : null;
  }
  return {do: 'set', kind: aspect};
}

/* ------------------------------------------------------------------ the driver */

/**
 * The questions about the message acts (P-2.1, 2026-10-03): the acts and their groups are data of the reply memory
 * (sop/message-acts.mjs), the texts are protocol data (formalizer-protocol-v1 0070-acts.sop). Coarse first (one lettered yes/no line per
 * group, and a last line for a request), then fine (the acts of each ticked group as a numbered list), so no menu lists every act.
 */
export function actQuestions(acts = messageActs(), data = protocolData()) {
  const text = key => {
    const t = data.one('protocol_text', key);
    if (t === null) throw new Error(`the protocol has no text ${key} (formalizer-protocol-v1 0070-acts.sop)`);
    return t;
  };
  const fill = (t, vars) => String(t).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  const groups = acts.groups;
  const letters = ACT_LETTERS.slice(0, groups.length + 1);
  const line = a => (a.examples.length ? `${a.description} (${fill(text('act_example'), {examples: a.examples.map(e => JSON.stringify(e)).join('; ')})})` : a.description);
  return {
    groups, letters,
    coarse: message => fill(text('acts_coarse'), {message, lines: [...groups.map(g => g.line), text('acts_request_line')].map((l, i) => `${letters[i]}. ${l}`).join('\n')}),
    fine: (message, group) => fill(text('acts_fine'), {message, group: group.line, choices: group.acts.map((a, i) => `${i + 1}. ${line(a)}`).join('\n')}),
    copy: what => fill(text('act_copy'), {what}),
    besides: (message, act) => fill(text('act_besides'), {message, act: act.description}),
    selfOther: () => text('self_other'),
  };
}
const ACT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A part of the message the model copies for an act (cv_act_span): kept only when it is a verbatim part of the message. */
async function copiedVerbatim(oracle, message, name, question) {
  const answer = String(await oracle.ask(name, question, 32)).trim().split('\n')[0].replace(/^["'`«“‘]+|["'`»”’.!]+$/g, '').trim();
  if (!answer || /^0\b/.test(answer)) return null;
  const at = fold(message).indexOf(fold(answer));
  return at >= 0 ? message.slice(at, at + answer.length) : null;
}

/**
 * Q1: the kind of answer; then the message acts (P-2.1): the coarse question (one lettered yes/no line per group of acts of the reply
 * memory, and a last line for a request), the fine question for every ticked group, the verbatim part an act copies (the user's name).
 * When Q1 said "nothing to look up" but the last line says there is a question and no act can be the whole request, the kind is asked
 * once more without "nothing". When Q1 asks for a lookup or about the assistant but an act can be the whole request ("how are you",
 * "tell me a joke", "are you a real person?"), the model is asked whether the message also asks about the world; "no" makes it a
 * message of acts only, answered by the act's reply. Returns {form, pragmatic: [kind],
 * spans: {kind: span}, standalone: [kind]}.
 */
export async function firstQuestion(oracle, text, {acts = messageActs(), data = protocolData()} = {}) {
  let form = KINDS[(await oracle.read('kind', q.kind(text), t => readChoice(t, KINDS.length), `Reply with one number from 1 to ${KINDS.length}.`, 8)) - 1][0];
  const Q = actQuestions(acts, data);
  const n = Q.letters.length;
  // One yes/no line per group, and a last line for a request (lettered lines: the oracle's answer format, read structurally).
  const read = t => {
    const out = new Map();
    for (const m of String(t).matchAll(/\b([A-Z])\s*[:.)-]\s*(yes|no)\b/gi)) if (Q.letters.includes(m[1].toUpperCase())) out.set(m[1].toUpperCase(), m[2].toLowerCase() === 'yes');
    return out.size === n ? out : /^\s*(?:0|none)\b/i.test(String(t)) ? new Map() : null;
  };
  const lines = await oracle.read('acts', Q.coarse(text), read, `Reply with ${n} lines, one per letter, like "A: no".`, 8 * n);
  const request = lines.get(Q.letters[n - 1]) === true;
  const found = [];
  for (const [i, group] of Q.groups.entries()) {
    if (!lines.get(Q.letters[i])) continue;
    const picked = await oracle.read(`acts_${group.id}`, Q.fine(text, group), t => readChoices(t, group.acts.length), 'Reply with the numbers separated by commas, or 0.', 16);
    if (picked[0] !== 0) for (const k of picked) if (!found.includes(group.acts[k - 1])) found.push(group.acts[k - 1]);
  }
  const spans = {};
  for (const act of found.filter(a => a.span)) {
    const copied = await copiedVerbatim(oracle, text, `act_${act.kind}`, Q.copy(act.span));
    if (copied) spans[act.kind] = copied;
  }
  const standalone = found.filter(a => a.standalone);
  if (form === 'none' && request && !standalone.length) {
    // Two signals disagree ("nothing to look up" and "a question"): the kind is asked once more without "nothing".
    const kinds = KINDS.filter(([kind]) => kind !== 'none');
    const k = await oracle.read('kind_again', q.kindAgain(kinds), t => readChoice(t, kinds.length, {zero: true}), `Reply with one number from 0 to ${kinds.length}.`, 8);
    if (k) form = kinds[k - 1][0];
  } else if (!['none', 'instruction'].includes(form) && standalone.length) {
    // The act may be the whole request: does the message also ask about the world? (asked about the first such act)
    const besides = await oracle.read('act_besides', Q.besides(text, standalone[0]), t => readChoice(t, 2), 'Reply with 1 or 2.', 8);
    if (besides === 2) form = 'none';
  }
  return {form, pragmatic: found.map(a => a.kind), spans, standalone: standalone.map(a => a.kind)};
}

/**
 * Formalize one message with the generic protocol. `method` is B, D or B-yesno (METHODS); the other arguments are those
 * of method A's `stepByStepQuery`, and the result has the same shape.
 */
export function protocolQuery(args) {
  const {message, lexicon, circuits = [], repo = null, session = null, derived = null} = args;
  const near = neighbourhoodStatements({message: String(message ?? '').trim(), lexicon, circuits, repo, session, derived});
  return commonScope.run(commonStems(near.statements), () => protocolQueryIn({...args, near}));
}

async function protocolQueryIn({near, expression = null, message, lexicon, circuits = [], repo = null, session = null, derived = null, oracle: base, validate = validateQuery, method = 'D', model = null, onProgress = () => {}}) {
  const settings = METHODS[method];
  if (!settings) throw new TypeError(`unknown step-by-step method ${JSON.stringify(method)}`);
  const started = Date.now();
  const oracle = budgeted(base);
  const text = String(message ?? '').trim();
  const mentions = entityHints(text, lexicon);
  const {neighbourhood, statements} = near;
  let counter = 0;
  const ctx = {message: text, lexicon, statements, mentions, spans: mentionSpans(text, mentions), method: settings, names: [], numbers: standaloneNumbers(text), aspects: new Set(), definitions: [],
    limits: [], options: [], exclusions: [], pragmatic: [], actSpans: {}, standalone: [], classNames: [],
    reserved: new Set(), reservedNumbers: new Set(), fresh: () => `?a${++counter}`, limited: 0, roleFit: roleFitter({repo, session, statements})};
  const retrieval = {mode: 'id', predicates: statements.map(p => p.id), neighbourhood,
    entities: mentions.map(m => ({surface: m.surface, candidates: m.candidates.map(c => c.id), strong: /\s/.test(m.surface) || /^\p{Lu}/u.test(m.surface)}))};
  const state = {form: null, mainText: text, clauses: []};
  let program = null, sop = '', validation = null, reason = null, confirmed = null, retried = null, contrast = null;
  const hints = new Set(mentions.flatMap(m => m.candidates.map(c => c.id)));
  const check = () => {
    // Problem mode (problem.mjs): the system already wrote the whole circuit from the problem answers.
    if (state.form === 'problem') {
      sop = state.problem?.sop ?? assembleProgram({unclear: 'relation_not_in_memory'});
      // The problem's names live in the names of its values (`cost_plan_a`), so the memory-name check (mention_not_used) does not apply.
      validation = validate({sop, message: text, lexicon, circuits, repo, session, mode: 'id', hints, mentions: []});
      program = validation.program ?? {};
      return;
    }
    program = programOf(ctx, state);
    sop = sopOf(program, lexicon);
    validation = validate({sop, message: text, lexicon, circuits, repo, session, mode: 'id', hints, mentions: retrieval.entities});
  };
  const build = async from => {
    if (from <= 0) {
      onProgress({phase: 'kind'});
      const first = await firstQuestion(oracle, text);
      ctx.pragmatic = first.pragmatic;
      ctx.actSpans = first.spans;
      ctx.standalone = first.standalone;
      const n = KINDS.findIndex(([kind]) => kind === first.form) + 1;
      state.form = KINDS[n - 1][0];
      if (state.form === 'none') return;
      // A request about the assistant or its memory: one numbered question; the circuit asks the self layer (assistant-v1).
      if (state.form === 'self') { state.query = await selfQuery(oracle, ctx); if (!state.query && ctx.standalone.length) state.form = 'none'; else hints.add(SELF); return; }
      // An instruction about the answers: one numbered question, then the copied words or the kind to stop.
      if (state.form === 'instruction') { state.instruction = await instructionOf(oracle, ctx); return; }
      // A problem that gives its own data: the problem questions write the circuit (DS014 "Problems that state their own data").
      // A request whose kind is not "problem" is asked once whether it gives its own data (word problems are often read as "a value").
      // The gate, its kinds, the problem questions and the fallback kind are protocol data (formalizer-protocol-v1/0060-problem.sop).
      const data = protocolData();
      // A message whose structure cannot state its own data (fp_problem_needs) is not a problem: the gate is not asked, and a first
      // answer "problem" is asked again without that kind.
      const applies = problemModeApplies(text, data);
      if (!applies && state.form === 'problem') {
        const kinds = KINDS.filter(([kind]) => !['problem', 'none'].includes(kind));
        const n = await oracle.read('kind_again', q.kindAgain(kinds), t => readChoice(t, kinds.length, {zero: true}), `Reply with one number from 0 to ${kinds.length}.`, 8);
        state.form = n ? kinds[n - 1][0] : data.one('problem_fallback_kind') ?? 'value';
        if (state.form === 'self') { state.query = await selfQuery(oracle, ctx); if (!state.query && ctx.standalone.length) state.form = 'none'; else hints.add(SELF); return; }
        if (state.form === 'instruction') { state.instruction = await instructionOf(oracle, ctx); return; }
      }
      if (applies && data.rows('own_data_kind').some(r => r[0] === state.form) && readYesNo(await oracle.ask('own_data', problemText(data, 'ask_own_data'), 8)) === true) { state.asked = state.form; state.form = 'problem'; }
      if (state.form === 'problem' && expression) {
        // The expression path for a problem with numbers (dual-formalization work; coordinator decision 2026-10-03): one question, a
        // program over v1..vn, statically analysed and lowered to the circuit. Its exchanges are recorded as steps; the problem
        // questions run only when it does not deliver a valid circuit.
        const {expressionFormalize} = await import('../../formalize/expression-program.mjs');
        const started = Date.now();
        const r = await expressionFormalize({message: text, lexicon, chat: async (messages, maxTokens) => expression.chat(messages, maxTokens)});
        for (const a of r.attempts ?? []) base.steps.push({name: 'expression', ok: a.answer !== null, ms: 0, input_tokens: 0, output_tokens: 0, cached: null, evaluated: null, answer: String(a.answer ?? a.reason ?? '').slice(0, 4000)});
        if (r.status === 'ok') {
          const v = validate({sop: r.lowered.sop, message: text, lexicon, circuits, repo, session, mode: 'id', hints, mentions: []});
          if (v.ok) { state.problem = {sop: r.lowered.sop, report: {kind: 'expression', lines: r.analysis.program.lines.length, answers: r.analysis.program.answers.length, ms: Date.now() - started}}; return; }
        }
        state.expression = r.status;
      }
      if (state.form === 'problem') {
        onProgress({phase: 'problem'});
        state.problem = await problemCircuit(oracle, {message: text, lexicon, data});
        if (state.problem) return;
        // The problem questions could not be read: the request goes through the general protocol with the kind it was given.
        state.form = state.asked && state.asked !== 'problem' ? state.asked : data.one('problem_fallback_kind') ?? 'value';
      }
      if (state.form !== 'puzzle') ctx.names = await linkNames(oracle, text, lexicon, mentions);
      // A word of the request that names exactly one class of the memory ("a city", "birds", "a hand") is not a name hint in free text,
      // but it can fill a place that holds a class ("A is a B", "A part of B"): it is offered for the places only, where the typed and
      // observed role fit keep it out of places it does not fit (commonsense guard 2026-10-03: "Is Albert Einstein a city?").
      if (state.form !== 'puzzle') ctx.classNames = entityHints(text, lexicon, {classes: true}).filter(m => !mentions.some(x => x.surface === m.surface) && m.candidates.length === 1 && lexicon.isClass?.(m.candidates[0].id)).map(m => m.candidates[0].id).filter(id => !ctx.names.includes(id));
      // The neighbourhood was collected around the unambiguous names only; a name the model linked (Lyon among two candidates)
      // seeds it now, and the statements around it join the list (chat guard, 2026-10-03: "Is Lyon in Europe?" had no statement).
      const seeded = ctx.names.filter(id => !near.neighbourhood.seeds?.includes?.(id));
      if (seeded.length) {
        const more = neighbourhoodStatements({message: text, lexicon, circuits, repo, session, derived, entities: ctx.names});
        const have = new Set(ctx.statements.map(p => p.id));
        ctx.statements = [...ctx.statements, ...more.statements.filter(p => !have.has(p.id))];
        retrieval.predicates = ctx.statements.map(p => p.id);
      }
      if (state.form !== 'puzzle') ctx.aspects = await detectAspects(oracle, ctx);
      // The details of the ticked aspects come from the model: option names, excluded names, the limit each number sets. They are
      // reserved, so they are not offered as places.
      if (ctx.aspects.has('options')) ctx.options = await namesFor(oracle, ctx, 'option_names', q.optionNames, {all: 2});
      for (const id of ctx.options) ctx.reserved.add(id);
      if (ctx.aspects.has('exclusion')) ctx.exclusions = (await namesFor(oracle, ctx, 'excluded_names', q.exclusionNames)).filter(id => !ctx.options.includes(id));
      for (const id of ctx.exclusions) ctx.reserved.add(id);
      if (ctx.aspects.has('limit')) ctx.limits = await limitsFromNumbers(oracle, ctx);
      for (const l of ctx.limits) for (const [, k] of l.comparisons) ctx.reservedNumbers.add(k);
      // Parts: the model copies them (D), or copies the supposition and the second question the checklist ticked (B).
      let extras = [];
      if (settings.clauses) {
        const parts = await requestParts(oracle, ctx);
        state.mainText = parts.main;
        extras = parts.extras;
      } else {
        const supposition = ctx.aspects.has('supposition') ? await copiedPart(oracle, ctx, 'supposition_part', 'the supposition (the "if" part)') : null;
        if (supposition) extras.push({text: supposition, kind: 'sub', role: 'supposition'});
        const second = ctx.aspects.has('second') ? await copiedPart(oracle, ctx, 'second_part', 'the second question') : null;
        if (second && second !== text) extras.push({text: second, kind: 'second', role: 'second'});
        let main = text;
        for (const e of extras) main = main.replace(e.text, ' ');
        if (extras.length && /\p{L}/u.test(main)) state.mainText = main.replace(/\s+/g, ' ').replace(/^[\s,;:]+|[\s,;:]+$/g, '').trim();
      }
      state.clauses = state.form === 'puzzle' ? [] : await clauseRoles(oracle, ctx, extras);
      for (const c of state.clauses) if (c.role === 'same') state.mainText = `${state.mainText} ${c.text}`;
      state.clauses = state.clauses.filter(c => !['same', 'ignore'].includes(c.role));
    }
    if (state.form === 'none' || state.form === 'self' || state.form === 'problem') return;
    onProgress({phase: 'details'});
    await mainQuestion(oracle, ctx, state, from);
    if (from <= 0) for (const clause of state.clauses) {
      if (['supposition', 'fact', 'time'].includes(clause.role)) {
        clause.statement = await clauseStatement(oracle, ctx, clause, clause.role === 'supposition' ? 'supposed' : 'asserted');
        if (!clause.statement) clause.unparsed = true;
      } else if (clause.role === 'second') {
        const kind = KINDS[(await oracle.choice('clause_kind', q.clauseKind(clause.text), KINDS.length)) - 1][0];
        const names = await clauseNames(oracle, ctx, clause.text);
        const query = ['yesno', 'list', 'value', 'count', 'highest', 'lowest', 'when', 'why'].includes(kind)
          ? await relational(oracle, ctx, {text: clause.text, form: kind, names, id: `q${state.clauses.indexOf(clause) + 2}`, what: `the part "${clause.text}"`}) : null;
        if (query) { await polarities(oracle, ctx, query, clause.text); await applyTime(oracle, {...ctx, aspects: new Set()}, query); clause.query = query; } else clause.unparsed = true;
      }
    }
  };
  /** Validator-driven re-asks (bounded). */
  const repair = async () => {
    for (let round = 0; round < 2 && !validation.ok && oracle.left() > 2; round++) {
      const codes = new Set(validation.problems.map(p => p.code));
      const query = state.query;
      if (!query) return;
      let changed = false;
      if (codes.has('mention_not_used')) {
        for (const problem of validation.problems.filter(p => p.code === 'mention_not_used').slice(0, 2)) {
          const surface = JSON.parse(/"((?:\\.|[^"\\])*)"/.exec(problem.message)?.[0] ?? '""');
          const mention = mentions.find(m => m.surface === surface);
          const id = mention?.candidates.map(c => c.id).find(c => ctx.names.includes(c)) ?? mention?.candidates[0]?.id;
          if (!id) continue;
          const ranked = rankStatements(ctx.statements, ctx.message).slice(0, SHOWN_STATEMENTS);
          const n = await oracle.choice('unused_name', q.unusedName(surface, ranked.map(p => statementText(p))), ranked.length, {zero: true});
          if (!n) continue;
          const roles = await placeName(oracle, ranked[n - 1], id, ctx.fresh);
          query.matches.push({predicate: ranked[n - 1].id, roles, polarity: 'affirmed'});
          await connect(oracle, ctx, query);
          changed = true;
        }
      } else if (codes.has('answer_not_selected') || codes.has('unbound_query_variable') || codes.has('class_mismatch')) {
        const at = Math.max(0, query.matches.findIndex(m => validation.problems.some(p => p.message.includes(m.predicate))));
        const predicate = ctx.statements.find(p => p.id === query.matches[at]?.predicate);
        if (predicate) {
          const note = codes.has('class_mismatch') ? `Not possible: ${validation.problems.find(p => p.code === 'class_mismatch').message.split(';')[0]}. ` : 'Not possible: one place must be the thing the request asks for. ';
          query.matches[at].roles = await fillPlaces(oracle, ctx, predicate, {form: query.form, names: ctx.names.filter(id => !ctx.reserved.has(id)), unknowns: unknownsFor(query.form, query.matches.length, ctx.aspects), count: query.matches.length, note});
          if (ASKING.has(query.form)) query.select = query.select ?? '?x';
          changed = true;
        }
      } else if (codes.has('absence_needs_closed')) {
        for (const m of query.matches) if (m.polarity === 'absent') m.polarity = 'negated';
        if (query.polarity === 'absent') query.polarity = 'negated';
        changed = true;
      }
      if (!changed) return;
      check();
    }
  };
  /** Q12: the forced contrast between the reading and one with a slot changed (B-yesno: the old yes/no confirmation). */
  const confirm = async () => {
    if (!validation.ok || ['none', 'puzzle', 'self', 'problem'].includes(state.form) || oracle.left() < 1 || program.unclear) return;
    if (settings.confirm === 'yesno') {
      confirmed = readYesNo(await oracle.ask('confirm', q.confirm(paraphraseOf(program, lexicon)), 8));
      if (confirmed === false && oracle.left() > 2) {
        const parts = ['the kind of answer', 'the statements used', 'the names and their places'];
        const part = readChoice(await oracle.ask('wrong_part', q.wrongPart(parts), 8), parts.length);
        if (part) {
          retried = parts[part - 1];
          const before = {state: clone(state), program, sop, validation};
          await build(part - 1); check();
          if (!validation.ok) ({program, sop, validation} = before), Object.assign(state, before.state);
        }
      }
      return;
    }
    const alternatives = flips(ctx, state);
    if (!alternatives.length) return;
    const flip = alternatives[0];
    const other = clone(state);
    flip.apply(other);
    const otherProgram = programOf(ctx, other);
    const shown = [paraphraseOf(program, lexicon), paraphraseOf(otherProgram, lexicon)];
    if (shown[0] === shown[1]) return;
    const swap = hash(text) % 2 === 1;
    const n = await oracle.choice('contrast', q.contrast(swap ? [shown[1], shown[0]] : shown), 3);
    const pick = n === 3 ? 'neither' : (n === 1) !== swap ? 'reading' : 'flipped';
    contrast = {slot: flip.slot, pick};
    confirmed = pick === 'reading';
    if (pick === 'flipped') {
      const otherSop = sopOf(otherProgram, lexicon);
      const otherValidation = validate({sop: otherSop, message: text, lexicon, circuits, repo, session, mode: 'id', hints, mentions: retrieval.entities});
      if (otherValidation.ok) { Object.assign(state, other); program = otherProgram; sop = otherSop; validation = otherValidation; retried = flip.slot; }
    } else if (pick === 'neither' && oracle.left() > 6) {
      const parts = ['the kind of answer', 'the statements used', 'the names and their places'];
      const part = readChoice(await oracle.ask('wrong_part', q.wrongPart(parts), 8), parts.length);
      if (part) {
        retried = parts[part - 1];
        const before = {state: clone(state), program, sop, validation, definitions: [...ctx.definitions]};
        ctx.definitions.length = 0;
        try { await build(part - 1); check(); } catch (error) { if (!(error instanceof Unreadable)) throw error; validation = {ok: false}; }
        if (!validation.ok) { Object.assign(state, before.state); ({program, sop, validation} = before); ctx.definitions.splice(0, ctx.definitions.length, ...before.definitions); }
      }
    }
  };
  let fallback = null;
  try {
    await build(0);
    check();
    await repair();
    // A statement the repair added for the second name can make the "same value" reading of two names: asked once (comparedPair).
    if (state.query && !ctx.aspects.has('twoSided') && state.query.matches.length > 1 && await comparedPair(oracle, ctx, state.query)) check();
    await confirm();
    // The strategy writes every circuit itself: when the oracle's answers cannot be assembled into a valid circuit after the bounded
    // re-asks, it says honestly that it could not formalize the request from this knowledge instead of returning an invalid circuit.
    // The oracle named something in the request that the knowledge does not know, and no question of the circuit holds any name,
    // number or comparison: the circuit would answer a different, unrestricted question.
    const listed = base.steps.find(st => st.name === 'names');
    const unrestricted = (program.queries ?? []).length && program.queries.every(qq => !(qq.matches ?? []).some(m => m.roles.some(r => r.value.kind !== 'var')) && !qq.compares?.length && !qq.any && !qq.excepts?.length && !qq.every);
    if (validation.ok && !['self', 'instruction'].includes(state.form) && unrestricted && ((listed && !/^\s*none\b/i.test(listed.answer)) || mentions.length || ctx.names.length)) validation = {...validation, ok: false, problems: [{code: 'request_name_unknown', message: 'the request names something the knowledge does not know'}]};
    if (!validation.ok) {
      fallback = {sop, problems: validation.problems.map(p => p.code)};
      program = {unclear: 'relation_not_in_memory'};
      sop = assembleProgram(program);
      validation = validate({sop, message: text, lexicon, circuits, repo, session, mode: 'id', hints, mentions: retrieval.entities});
    }
  } catch (error) {
    if (!(error instanceof Unreadable) && error.code !== 'oracle_failed') throw error;
    reason = error.message;
  }
  const usage = {turns: base.steps.length, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0};
  for (const s of base.steps) { usage.input_tokens += s.input_tokens; usage.output_tokens += s.output_tokens; usage.cache_read_tokens += s.cached ?? 0; }
  const ok = !reason && validation?.ok === true;
  const status = ok ? 'validated' : reason ? 'failed' : 'invalid';
  const unclear = ok ? unclearKind(validation.program) : null;
  const report = {method, form: state.form, aspects: [...ctx.aspects], pragmatic: ctx.pragmatic, ...(Object.keys(ctx.actSpans).length ? {act_spans: ctx.actSpans} : {}), clauses: state.clauses.map(c => ({text: c.text, role: c.role})),
    picked: state.query?.picked ?? null, ...(state.problem ? {problem: state.problem.report} : {}), ...(state.expression ? {expression: state.expression} : {}), contrast, confirmed, retried, questions: base.steps.length, ...(fallback ? {fallback} : {})};
  return {
    circuits: ok ? splitCircuits(sop).parts.map(p => ({file: 'query.sop', role: 'query', text: p.text, origin: 'local_llm_step_by_step'})) : [],
    ok, status, sop, validation, program: validation?.program ?? null, unclear,
    rounds: 1, runs: [{round: 0, phase: 'step_by_step', ok: !reason, duration_ms: Date.now() - started, usage}], usage,
    duration_ms: Date.now() - started, backend: 'step-by-step', model, report: JSON.stringify(report),
    context_version: `step-by-step-${method}`, mode: 'id', retrieval, vocabulary_dialog: {max_rounds: 0, rounds: 0, expansions: []},
    steps: base.steps, confirmed, retried, contrast, method, ...(fallback ? {fallback} : {}), ...(reason ? {reason} : {}),
    unlinked: (validation?.advice ?? []).map(a => ({code: a.code, message: a.message})),
  };
}
