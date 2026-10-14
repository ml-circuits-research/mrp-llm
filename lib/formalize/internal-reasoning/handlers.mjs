/**
 * The handlers of InternalReasoningStepByStep's answer formats (DS022 "InternalReasoningStepByStep"). A handler renders the planned
 * question from the protocol's data (its text, choices or the option source it names), asks the model through the oracle, reads the
 * short answer structurally and asserts the slot facts the answer establishes. Option lists are built from structure and memory data
 * (the statements of the schema neighbourhood ranked by the memory's own words, the names of the request, the places of the chosen
 * statements); when a numbered question has exactly one option and the protocol marks it `auto_single`, there is no choice to ask
 * and the option is taken (reported as a question avoided). Handlers never interpret the request's phrasing.
 */
import {entityHints} from '../../query-author/retrieval.mjs';
import {statementText, phraseOf, LETTERS} from '../../query-author/step-by-step/assemble.mjs';
import {matchText} from '../../query-author/step-by-step/circuit.mjs';
import {groupCount, countGap} from '../../query-author/step-by-step/definitions.mjs';
import {readDates, readYesNo} from '../../query-author/step-by-step/answers.mjs';
import {problemCircuit, problemText, problemModeApplies} from '../../query-author/step-by-step/problem.mjs';
import {protocolData} from '../protocol-data.mjs';
import {questionText, READERS, AGAIN, numberedLines, fill} from './render.mjs';
import {isNumberRole, entityRole, fold, rankStatements, lexemeHits, meaning, classFit, addMentions, nameSymbol, numberSymbol, newInstance, freshUnknown, statementOf, textOf} from './state.mjs';
import {matchOf, variableOf, termOf} from './program.mjs';

export const SHOWN_STATEMENTS = 8;
const order = s => Number(String(s).replace(/^\D+/, '')) || 0;
const hash = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Ask with a structural reader; an unreadable answer is asked once more with the expected format (then Unreadable). */
async function read(h, name, prompt, format, opts = {}, maxTokens = 24) {
  return h.oracle.read(name, prompt, t => READERS[format](t, opts), AGAIN[format]?.(opts) ?? 'Reply in the format asked.', maxTokens);
}

/** Names of the request in message order (the linked meanings of its mentions; reserved names left out when `free`). */
export function requestNames(h, {free = false, qq = 'q'} = {}) {
  const linked = free ? h.view.rows('place_name', qq).map(r => r[1]) : h.view.rows('name_in_request').map(r => r[0]);
  const at = n => { const id = h.ctx.sym.name.get(n); const s = h.ctx.spans.find(sp => sp.mention.candidates.some(c => c.id === id)); return s ? s.at : 1e9; };
  return [...new Set(linked)].sort((a, b) => at(a) - at(b) || order(a) - order(b));
}

const notesOf = (h, text) => p => {
  const words = new Set(fold(text).match(/[\p{L}\p{N}]+/gu) ?? []);
  const named = phraseOf(p).toLowerCase().split(/\s+/).every(w => words.has(w) || words.has(w.replace(/(ed|s)$/, '')));
  return [named ? 'its words are in the request' : '', p.derived ? 'worked out by the rules of the knowledge' : p.example ? `example: ${p.example}` : ''].filter(Boolean).join('; ');
};
const statementLine = (h, text) => { const notes = notesOf(h, text); return p => `${statementText(p)}${notes(p) ? `   (${notes(p)})` : ''}`; };
const withMeaning = p => `${statementText(p)}${meaning(p) ? ` (${meaning(p)})` : ''}`;
const sym = (h, p) => h.ctx.sym.statementOf.get(p.id);
const queryText = (h, qq) => qq === 'q' ? h.ctx.mainText ?? h.ctx.message : h.ctx.sym.clause.get(qq)?.text ?? h.ctx.message;

/** The option sources a question may name with `choices_from` (structure and memory data only). */
const SOURCES = {
  mention_candidates: h => h.ctx.sym.mention.get(h.arg).candidates.map(c => ({value: nameSymbol(h.ctx, c.id), text: `${c.id}${c.description ? ` (${c.description})` : ''}`})),
  request_names: h => requestNames(h).map(n => ({value: n, text: h.ctx.sym.name.get(n)})),
  excludable_names: h => requestNames(h).filter(n => !h.view.has('option_name', n)).map(n => ({value: n, text: h.ctx.sym.name.get(n)})),
  polarities: h => {
    const instances = h.view.rows('uses', h.arg).map(r => r[1]);
    const closed = instances.length === 1 && statementOf(h.ctx, instances[0])?.closed === true;
    return h.def.choices.filter(c => c.value !== 'absent' || closed).map(c => ({value: c.value, text: c.text}));
  },
  derived_binary: h => rankStatements(h.ctx, h.ctx.message, h.ctx.statements.filter(p => p.derived && p.roles.length === 2 && p.roles.every(entityRole))).slice(0, 4)
    .map(p => ({value: sym(h, p), text: `${statementText(p)}   (worked out by the rules of the knowledge)`})),
  nonderived_binary: h => rankStatements(h.ctx, h.ctx.message, h.ctx.statements.filter(p => !p.derived && p.roles.length === 2 && p.roles.every(entityRole))).slice(0, SHOWN_STATEMENTS)
    .map(p => ({value: sym(h, p), text: `${statementText(p)}${p.example ? `   (example: ${p.example})` : ''}`})),
  binary: h => rankStatements(h.ctx, h.ctx.message, h.ctx.statements.filter(p => p.roles.length === 2 && p.roles.every(entityRole))).slice(0, SHOWN_STATEMENTS).map(p => ({value: sym(h, p), text: statementText(p)})),
  unary: h => rankStatements(h.ctx, h.ctx.message, h.ctx.statements.filter(p => p.roles.length === 1 && entityRole(p.roles[0]))).slice(0, SHOWN_STATEMENTS).map(p => ({value: sym(h, p), text: statementText(p)})),
  clause_statements: h => rankStatements(h.ctx, h.ctx.sym.clause.get(h.arg).text).slice(0, SHOWN_STATEMENTS).map(p => ({value: sym(h, p), text: statementText(p)})),
};

/** The placeholder values every question may use. */
function varsOf(h) {
  const {ctx, arg} = h;
  const dates = ctx.payload.dates ?? [...ctx.sym.date.values()];
  const unknowns = (ctx.payload.puzzle.unknowns ?? []).map(u => u.name);
  const goal = ctx.payload.puzzle.goal;
  const statement = /\{\{statement\}\}/.test(h.def?.text ?? '') ? matchesOf(h, arg).map(({m}) => matchText(m, ctx.lexicon)).join(' and ') : '';
  return {prefix: h.prefix.firstTurn, message: ctx.message, arg: textOf(ctx, arg), surface: ctx.sym.mention.get(arg)?.surface ?? '', clause: ctx.sym.clause.get(arg)?.text ?? '',
    date1: dates[0] ?? '', date2: dates[1] ?? '', unknown_names: unknowns.join(', '), direction: goal === 'min' ? 'smallest' : 'largest', form: h.view.rows('query_kind', arg)[0]?.[1] ?? '', statement};
}

/** Asserts the value of an answer: `asserts [arg] value`; `true` asserts `asserts arg`, `false` nothing. */
function assertValue(h, predicate, value) {
  if (!predicate || value === 'false' || value === false) return;
  const args = h.arg !== 'none' ? [h.arg] : [];
  if (value === 'true' || value === true) h.facts.add(predicate, ...args);
  else h.facts.add(predicate, ...args, value);
}

/** Numbered choices (one or several) from static choices or an option source. */
async function numbered(h, {many = false} = {}) {
  const def = h.def;
  const vars = varsOf(h);
  const options = def.from ? SOURCES[def.from](h) : def.choices.map(c => ({value: c.value, text: c.text ? fill(c.text, vars) : String(c.value), asserts: c.asserts}));
  if (!options.length) return {empty: true};
  if (!many && def.auto && options.length === 1) { assertValue(h, options[0].asserts ?? def.asserts, options[0].value); return {avoided: 'single option'}; }
  const prompt = questionText(h.protocol, h.action, {...vars, options});
  const answer = await read(h, h.action.replace(/^ask_/, ''), prompt, many ? 'numbers' : 'number', {max: options.length, zero: Boolean(def.zero)}, many ? 24 : 8);
  const picked = many ? (answer[0] === 0 ? [] : answer) : (answer ? [answer] : []);
  const slotMode = h.protocol.rows('slot_mode').find(r => r[0] === def.establishes)?.[1];
  for (const n of slotMode === 'one' ? picked.slice(0, 1) : picked) assertValue(h, options[n - 1].asserts ?? def.asserts, options[n - 1].value);
  return {picked: picked.map(n => options[n - 1].value)};
}

/* ------------------------------------------------------------------------------------------------- statements */

/** Forget the statements of a query and everything established on them (the wrong part was "the statements used"). */
function resetStatements(h, qq) {
  const {ctx, facts} = h;
  const instances = new Set(facts.rows('uses', qq).map(r => r[1]));
  facts.remove(f => f.args.some(a => instances.has(a)) || (f.p === 'statements_none' && f.args[0] === qq));
  const dependent = new Set(h.protocol.rows('statement_dependent').map(r => r[0]));
  facts.remove(f => f.p === 'answered' && dependent.has(f.args[0]));
  for (const p of ['sided', 'sided_role', 'sided_pending', 'rank_dropped', 'connected', 'disconnected', 'switched_yesno', 'polarity', 'quantifier', 'measure', 'period', 'limit_target', 'options_target', 'exclusion_target', 'reasked'])
    facts.remove(f => f.p === p);
  for (const key of ['repoint', 'only', 'formOf', 'compares', 'definitions', 'sided', 'connect', 'problems', 'dates']) delete ctx.payload[key];
  ctx.payload.fixAbsence = false;
}

async function statements(h) {
  const qq = h.arg, text = queryText(h, qq);
  if (h.action === 'ask_statements_again') resetStatements(h, qq);
  const ranked = rankStatements(h.ctx, text);
  const line = statementLine(h, text);
  const what = qq === 'q' ? 'the request' : `the part "${text}"`;
  let shown = ranked.slice(0, SHOWN_STATEMENTS);
  for (let page = 0; page < 2; page++) {
    const more = page === 0 && ranked.length > SHOWN_STATEMENTS;
    const max = shown.length + (more ? 1 : 0);
    const prompt = questionText(h.protocol, h.action, {options: shown.map(p => ({text: line(p)})), more: more ? `\n${shown.length + 1}. none of these; show other statements` : '', what});
    const picked = await read(h, page ? 'statements_more' : 'statements', prompt, 'numbers', {max}, 32);
    if (picked[0] === 0) { h.facts.add('statements_none', qq); return {picked: []}; }
    if (more && picked.includes(max)) { shown = ranked.slice(SHOWN_STATEMENTS, 2 * SHOWN_STATEMENTS); continue; }
    const chosen = picked.filter(n => n <= shown.length).map(n => shown[n - 1]);
    for (const p of chosen) newInstance(h.ctx, h.facts, qq, sym(h, p));
    if (!chosen.length) h.facts.add('statements_none', qq);
    return {picked: chosen.map(p => p.id)};
  }
  h.facts.add('statements_none', qq);
  return {picked: []};
}

/** The two-signal check: the model said no statement fits while exactly one statement shares a content word with the request. */
async function statementCheck(h) {
  const st = h.view.rows('single_hit')[0]?.[0];
  if (!st) return {empty: true};
  const p = statementOf(h.ctx, st);
  const answer = await read(h, 'statement_check', questionText(h.protocol, h.action, {statement: statementText(p), meaning: meaning(p) ? ` (${meaning(p)})` : ''}), 'number', {max: 2}, 4);
  if (answer === 1) newInstance(h.ctx, h.facts, h.arg, st);
  return {picked: answer === 1 ? [p.id] : []};
}

/* ------------------------------------------------------------------------------------------------- places */

/** Which options fit a place: names and entity unknowns in a name place, numbers and V or W in a number place, others in both. */
const fits = (role, option) => {
  const number = isNumberRole(role), v = option.value;
  if (option.kind === 'name') return !number;
  if (option.kind === 'number') return number;
  if (v === 'unknown_v' || v === 'unknown_w') return number || !role.type;
  if (v === 'unknown_m') return !number;
  return true;
};
const ASKED_FIRST = ['unknown_m', 'unknown_x', 'unknown_v', 'unknown_w', 'unknown_p', 'unknown_q'];

/**
 * The places of one statement instance: the defaults of the protocol already placed some (read from the closure); a place with a
 * single fitting option takes it; the asked unknown goes into the one place left when no earlier statement holds it; the rest is
 * asked as lettered lines, and a choice that does not fit its place is asked again for that place alone.
 */
async function places(h, {again = false} = {}) {
  const {ctx, view, facts, arg: i} = h;
  const qq = ctx.sym.instance.get(i)?.query;
  const predicate = statementOf(ctx, i);
  if (!qq || !predicate) return {empty: true};
  const roles = predicate.roles;
  const names = requestNames(h, {free: true, qq});
  const unknowns = view.rows('offered', qq).map(r => r[1]).sort((a, b) => ASKED_FIRST.indexOf(a) - ASKED_FIRST.indexOf(b));
  const count = view.rows('uses', qq).length;
  const reservedNumbers = new Set(view.rows('limit_kind').map(r => r[0]));
  const asked = unknowns.find(u => u === 'unknown_x' || u === 'unknown_m');
  let note = '';
  if (again) {
    const violation = view.rows('violation').find(([, w]) => w === i || w === qq)?.[0];
    const problem = ctx.payload.problems?.find(p => p.instance === i);
    note = problem?.note ?? h.protocol.notes.get(violation) ?? '';
    facts.remove(f => f.p === 'place' && f.args[0] === i);
  }
  const options = [...names.map(n => ({kind: 'name', value: n, text: ctx.sym.name.get(n)})),
    ...(roles.some(isNumberRole) ? [...ctx.sym.number.keys()].filter(n => !reservedNumbers.has(n) && facts.has('number', n)).map(n => ({kind: 'number', value: n, text: String(ctx.sym.number.get(n))})) : []),
    ...unknowns.map(u => ({kind: 'unknown', value: u, text: h.protocol.rows('unknown_text').find(r => r[0] === u)?.[1] ?? u})),
    {kind: 'any', value: 'any', text: count > 1 ? 'anything (not linked to the other statements, not limited by the request)' : 'anything (not limited by the request)'}];
  const misfit = (n, r) => view.has('misfit', n, h.ctx.sym.statementOf.get(predicate.id), r.name) || !classFit(ctx.lexicon, ctx.sym.name.get(n), r);
  const fitting = (role, o) => fits(role, o) && (o.kind !== 'name' || !misfit(o.value, role));
  // Places the defaults of the protocol settled (a name recorded in exactly one place, a single name or the asked unknown).
  const result = roles.map(role => again ? null : view.rows('place', i, role.name)[0]?.[2] ?? null);
  const placedNames = () => new Set(result.filter(v => v && ctx.sym.name.has(v)));
  const take = (k, value) => {
    const v = value === 'any' ? freshUnknown(ctx, facts) : value === 'unknown_w' ? freshUnknown(ctx, facts, 'w') : value;
    result[k] = v;
  };
  const allowedOf = k => options.map((o, n) => fitting(roles[k], o) ? n + 1 : 0).filter(Boolean);
  let auto = 0;
  if (!again && h.protocol.heuristics.has('asked_into_last_place')) {
    // The first statement of a question that asks for something: the one place left takes the asked unknown when it fits there.
    const left = roles.map((_, k) => k).filter(k => !result[k]);
    const askedPlaced = view.rows('uses', qq).some(([, j]) => j !== i && view.rows('place', j).some(r => r[2] === asked));
    if (asked && !askedPlaced && left.length === 1 && result.some(Boolean) && allowedOf(left[0]).some(n => options[n - 1].value === asked)) { take(left[0], asked); auto++; }
  }
  const used = placedNames();
  const open = roles.map((role, k) => ({role, k, letter: LETTERS[k], allowed: result[k] ? [] : allowedOf(k).filter(n => !(options[n - 1].kind === 'name' && used.has(options[n - 1].value)))})).filter(x => !result[x.k]);
  if (h.protocol.heuristics.has('single_allowed_option')) for (const x of open.filter(x => x.allowed.length <= 1)) { take(x.k, options[(x.allowed[0] ?? options.length) - 1].value); auto++; }
  const asking = open.filter(x => !result[x.k]);
  if (asking.length) {
    const letters = asking.map(x => x.letter);
    const kinds = x => isNumberRole(x.role) ? 'a number' : 'a name or an unknown';
    const sense = meaning(predicate);
    const example = `${letters[0]}: ${asking[0].allowed[0]}`;
    const prompt = questionText(h.protocol, again ? 'ask_places_again' : 'ask_places', {note, statement: statementText(predicate), meaning: sense ? ` (meaning: ${sense})` : '', letters: letters.join(' and '),
      options, allowed: asking.map(x => `${x.letter} (${kinds(x)}) is one of: ${x.allowed.join(', ')}`).join('\n'), example});
    const picked = await read(h, again ? 'places_again' : 'places', prompt, 'letters', {letters, max: options.length, example, texts: options.map(o => o.text)}, 48);
    const taken = new Set(result.filter(Boolean).map(v => options.findIndex(o => o.value === v) + 1).filter(Boolean));
    for (const x of asking) {
      let n = picked[x.letter];
      if (!x.allowed.includes(n) || (options[n - 1].kind !== 'any' && taken.has(n))) {
        // A choice that does not fit the place (or a name already used in the statement) is asked again for that place only.
        const allowed = x.allowed.filter(k => !taken.has(k) || options[k - 1].kind === 'any');
        if (allowed.length === 1) n = allowed[0];
        else {
          const head = `For the statement "${statementText(predicate)}"${sense ? ` (meaning: ${sense})` : ''}`;
          const k = await read(h, 'place', questionText(h.protocol, 'ask_place', {head, letter: x.letter, options: allowed.map(k2 => ({text: options[k2 - 1].text}))}), 'number', {max: allowed.length}, 8);
          n = allowed[k - 1];
        }
      }
      if (options[n - 1].kind !== 'any') taken.add(n);
      take(x.k, options[n - 1].value);
    }
  }
  roles.forEach((role, k) => { if (result[k] && !view.rows('place', i, role.name).some(r => r[2] === result[k] && !again)) facts.add('place', i, role.name, result[k]); });
  // After the last statement of a question that asks for something: when no place holds the asked unknown and exactly one other
  // unknown fills a name place, that unknown is the asked thing (one renaming, no question).
  if (asked && h.protocol.heuristics.has('asked_from_single_unknown') && !view.rows('waits').length) renameAsked(h, qq, asked);
  return asking.length ? {auto, asked: asking.length} : {avoided: 'every place settled by a default or by a single fitting option'};
}

function renameAsked(h, qq, asked) {
  const {ctx, facts, view} = h;
  const instances = view.rows('uses', qq).map(r => r[1]);
  const placeOf = j => { const out = new Map(view.rows('place', j).map(r => [r[1], r[2]])); for (const r of facts.rows('place', j)) out.set(r[1], r[2]); return out; };
  const all = instances.map(j => [j, placeOf(j)]);
  if (all.some(([j, m]) => (statementOf(ctx, j)?.roles ?? []).some(r => !m.has(r.name)))) return;
  if (all.some(([, m]) => [...m.values()].includes(asked))) return;
  const candidates = new Set();
  for (const [j, m] of all) for (const [role, v] of m) {
    const declared = statementOf(ctx, j)?.roles.find(r => r.name === role);
    if (/^unknown_a\d+$/.test(v) && entityRole(declared)) candidates.add(v);
  }
  if (candidates.size !== 1) return;
  const [from] = candidates;
  facts.remove(f => f.p === 'place' && instances.includes(f.args[0]) && f.args[2] === from);
  for (const [j, m] of all) for (const [role, v] of m) if (v === from) facts.add('place', j, role, asked);
}

async function placeQuestion(h) { return places(h, {again: false}); }
async function placesAgain(h) { return places(h, {again: true}); }

/* ------------------------------------------------------------------------------------------------- two-sided comparison */

const SIDED_FORMS = new Set(['list', 'value', 'count', 'highest', 'lowest', 'when']);

async function sided(h) {
  const {ctx, view, facts, arg: qq} = h;
  const ids = requestNames(h, {free: true, qq}).slice(0, 2);
  if (ids.length < 2) return {empty: true};
  const vars = {pair: `${ctx.sym.name.get(ids[0])} and ${ctx.sym.name.get(ids[1])}`};
  const options = h.def.choices.map(c => ({value: c.value, text: c.text}));
  const n = await read(h, 'two_sided', questionText(h.protocol, h.action, {...vars, options}), 'number', {max: options.length, zero: true}, 8);
  if (!n) return {picked: []};
  const kind = options[n - 1].value;
  facts.add('sided', qq, kind);
  const instances = view.rows('uses', qq).map(r => r[1]).sort((a, b) => order(a) - order(b));
  const i = instances.find(j => { const p = statementOf(ctx, j); return p.roles.length >= 2 && p.roles.some(entityRole); });
  if (!i) return {picked: [kind]};
  facts.add('sided_instance', qq, i);
  ctx.payload.sided = {qq, i, ids, kind};
  const entityRoles = statementOf(ctx, i).roles.filter(entityRole);
  if (entityRoles.length > 1) facts.add('sided_pending', qq);
  else buildSided(h, entityRoles[0]);
  return {picked: [kind]};
}

async function sidedRole(h) {
  const s = h.ctx.payload.sided;
  const predicate = statementOf(h.ctx, s.i);
  const letters = predicate.roles.map((r, k) => entityRole(r) ? LETTERS[k] : null).filter(Boolean);
  const letter = await read(h, 'name_place', questionText(h.protocol, h.action, {statement: statementText(predicate), pair_names: `${h.ctx.sym.name.get(s.ids[0])} (and ${h.ctx.sym.name.get(s.ids[1])})`}), 'letter', {letters}, 4);
  const role = predicate.roles[LETTERS.indexOf(letter)];
  h.facts.add('sided_role', s.qq, role.name);
  buildSided(h, role);
  return {picked: [role.name]};
}

/** The two copies of the compared statement (or the difference of two counts), as places and session definitions. */
function buildSided(h, slot) {
  const {ctx, facts} = h;
  const {qq, i, ids, kind} = ctx.payload.sided;
  const predicate = statementOf(ctx, i);
  const others = predicate.roles.filter(r => r !== slot);
  const placeAll = (j, values) => { for (const r of predicate.roles) facts.add('place', j, r.name, values(r)); };
  if (kind === 'difference' && predicate.roles.length === 2) {
    const dctx = {lexicon: ctx.lexicon, definitions: ctx.payload.definitions ??= []};
    const size = groupCount(dctx, predicate, slot.name, others[0].name);
    dctx.definitions.push(size.sop);
    const gap = countGap(dctx, size.name);
    dctx.definitions.push(gap.sop);
    (ctx.payload.repoint ??= {})[i] = {predicate: gap.name, roles: [{name: 'subject', value: {kind: 'entity', value: ctx.sym.name.get(ids[0])}}, {name: 'object', value: {kind: 'entity', value: ctx.sym.name.get(ids[1])}}, {name: 'topic', value: {kind: 'var', value: '?x'}}], polarity: 'affirmed'};
    (ctx.payload.only ??= {})[qq] = [i];
    (ctx.payload.formOf ??= {})[qq] = 'value';
    placeAll(i, r => r === slot ? ids[0] : 'unknown_x');
    return;
  }
  const compared = others.find(isNumberRole) ?? others[0];
  const shared = r => { const u = `unknown_s_${r.name}`; facts.add('unknown', u); return u; };
  const second = newInstance(ctx, facts, qq, ctx.sym.statementOf.get(predicate.id));
  facts.add('sided_instance', qq, second);
  // Both copies are written as matches (re-pointed), and their places are stated so that no place of the protocol stays open.
  const copy = (j, values) => {
    (ctx.payload.repoint ??= {})[j] = {predicate: predicate.id, polarity: 'affirmed', roles: predicate.roles.map(r => ({name: r.name, value: termOf(ctx, values(r))}))};
    for (const r of predicate.roles) if (!h.view.rows('place', j, r.name).length) facts.add('place', j, r.name, values(r));
  };
  if (kind === 'above' || kind === 'below') {
    for (const u of ['unknown_ca', 'unknown_cb']) facts.add('unknown', u);
    copy(i, r => r === slot ? ids[0] : r === compared ? 'unknown_ca' : shared(r));
    copy(second, r => r === slot ? ids[1] : r === compared ? 'unknown_cb' : shared(r));
    (ctx.payload.compares ??= {})[qq] = [...(ctx.payload.compares[qq] ?? []), `?ca ${kind} ?cb`];
    return;
  }
  const value = SIDED_FORMS.has(h.view.rows('query_kind', qq)[0]?.[1]) ? 'unknown_x' : 'unknown_a0';
  facts.add('unknown', value);
  copy(i, r => r === slot ? ids[0] : r === compared ? value : shared(r));
  copy(second, r => r === slot ? ids[1] : r === compared ? value : shared(r));
}

/* ------------------------------------------------------------------------------------------------- after the places */

const instancesOf = (h, qq) => h.view.rows('uses', qq).map(r => r[1]).sort((a, b) => order(a) - order(b));
const matchesOf = (h, qq) => instancesOf(h, qq).map(i => ({i, m: matchOf(h.ctx, h.view, i)}));

async function negated(h) {
  const items = matchesOf(h, h.arg);
  const options = items.map(({m}) => ({text: matchText(m, h.ctx.lexicon)}));
  const n = await read(h, 'negated', questionText(h.protocol, h.action, {options}), 'number', {max: options.length, zero: true}, 8);
  if (n) h.facts.add('negated_instance', items[n - 1].i);
  return {picked: n ? [items[n - 1].i] : []};
}

/** The place of the asked unknown in a statement added later: the one entity place, the place the recorded fillers fit, else asked. */
async function askedPlace(h, predicate, variable, what, followUp) {
  const entity = predicate.roles.map((r, k) => entityRole(r) ? k : -1).filter(k => k >= 0);
  if (entity.length === 1) return entity[0];
  const pairs = [];
  for (const {i, m} of matchesOf(h, 'q')) {
    const p = statementOf(h.ctx, i);
    m.roles.forEach(r => { if (r.value.kind === 'var' && r.value.value === variable && p) pairs.push([p, p.roles.findIndex(x => x.name === r.name)]); });
  }
  const fitting = h.ctx.roleFit.unknownPlaces(pairs, predicate).filter(k => entity.includes(k));
  if (fitting.length === 1) return fitting[0];
  const letters = entity.map(k => LETTERS[k]);
  const letter = await read(h, followUp.replace(/^ask_/, ''), questionText(h.protocol, followUp, {statement: statementText(predicate), what}), 'letter', {letters}, 4);
  return LETTERS.indexOf(letter);
}

async function negatedStatement(h) {
  const chosen = new Set(instancesOf(h, 'q').map(i => statementOf(h.ctx, i).id));
  const ranked = rankStatements(h.ctx, queryText(h, 'q')).filter(p => !chosen.has(p.id) && p.roles.some(entityRole)).slice(0, SHOWN_STATEMENTS);
  if (!ranked.length) return {empty: true};
  const n = await read(h, 'negated_statement', questionText(h.protocol, h.action, {options: ranked.map(p => ({text: withMeaning(p)}))}), 'number', {max: ranked.length, zero: true}, 8);
  if (!n) return {picked: []};
  const predicate = ranked[n - 1];
  const at = await askedPlace(h, predicate, '?x', 'X (the thing the request asks for)', 'ask_asked_place');
  const i = newInstance(h.ctx, h.facts, 'q', sym(h, predicate));
  predicate.roles.forEach((r, k) => h.facts.add('place', i, r.name, k === at ? 'unknown_x' : freshUnknown(h.ctx, h.facts)));
  h.facts.add('negated_instance', i);
  return {picked: [predicate.id]};
}

async function chain(h) {
  const i = h.view.rows('chainable', h.arg)[0]?.[1];
  if (!i) return {empty: true};
  const answer = await read(h, 'chain', questionText(h.protocol, h.action, {statement: statementText(statementOf(h.ctx, i))}), 'number', {max: 2}, 4);
  if (answer === 1) h.facts.add('chained', i);
  return {picked: [answer === 1 ? 'chain' : 'direct']};
}

async function scope(h) {
  const items = matchesOf(h, h.arg);
  const options = items.map(({m}) => ({text: matchText(m, h.ctx.lexicon)}));
  if (options.length === 1) { h.facts.add('scope_instance', items[0].i); return {avoided: 'single option'}; }
  const n = await read(h, 'scope', questionText(h.protocol, h.action, {options}), 'number', {max: options.length}, 8);
  h.facts.add('scope_instance', items[n - 1].i);
  return {picked: [items[n - 1].i]};
}

/** A comparison variable not used by the query: ?n1, ?n2, … (symbols unknown_n1, …). */
function compareUnknown(h) {
  const used = new Set([...h.view.rows('place').map(r => r[2]), ...h.facts.rows('place').map(r => r[2])]);
  for (let k = 1; k < 20; k++) if (!used.has(`unknown_n${k}`) && !(h.ctx.payload.usedCompare ??= new Set()).has(k)) { h.ctx.payload.usedCompare.add(k); h.facts.add('unknown', `unknown_n${k}`); return `unknown_n${k}`; }
  return freshUnknown(h.ctx, h.facts);
}

/** A query match that is not a statement of the memory (a session definition): its own instance symbol, re-pointed. */
function definitionInstance(h, qq, match) {
  const i = `i${++h.ctx.counters.instance}`;
  h.ctx.sym.instance.set(i, {query: qq, statement: null});
  h.facts.add('uses', qq, i);
  (h.ctx.payload.repoint ??= {})[i] = match;
  return i;
}

const LIMIT_WORDS = ['above', 'below', 'at_least', 'at_most', 'equal'];

/** Q5: what a limit applies to: a number place, a count per group, another statement's value, or a count by another statement. */
async function limitTarget(h) {
  const {ctx, view, facts, arg: num} = h;
  const comparator = view.rows('limit_kind', num)[0]?.[1];
  const value = ctx.sym.number.get(num);
  if (!comparator || value === undefined) return {empty: true};
  const compare = (variable) => { (ctx.payload.compares ??= {}).q = [...(ctx.payload.compares.q ?? []), `${variable} ${comparator} ${value}`]; };
  const subject = view.rows('query_kind', 'q')[0]?.[1] === 'every' ? '?m' : '?x';
  const targets = [];
  for (const {i, m} of matchesOf(h, 'q')) {
    const predicate = ctx.lexicon.predicates[m.predicate];
    for (const r of m.roles) {
      const role = predicate?.roles?.find(x => x.name === r.name) ?? {};
      if (isNumberRole(role) && r.value.kind === 'var') targets.push({text: `the ${r.name} in "${matchText(m, ctx.lexicon)}"`, direct: true, apply: () => compare(r.value.value)});
    }
    const asked = m.roles.find(r => r.value.kind === 'var' && (r.value.value === '?x' || r.value.value === '?m'));
    const counted = m.roles.find(r => r !== asked && r.value.kind === 'var' && entityRole(predicate?.roles?.find(x => x.name === r.name) ?? {}));
    if (asked && counted && predicate?.roles?.length === 2) targets.push({text: `how many ${counted.name}s each ${asked.value.value.slice(1).toUpperCase()} has in "${statementText(predicate)}" (a count)`, apply: () => {
      const dctx = {lexicon: ctx.lexicon, definitions: ctx.payload.definitions ??= []};
      const def = groupCount(dctx, predicate, asked.name, counted.name);
      dctx.definitions.push(def.sop);
      const n = variableOf(compareUnknown(h));
      (ctx.payload.repoint ??= {})[i] = {predicate: def.name, roles: [{name: 'subject', value: asked.value}, {name: 'object', value: {kind: 'var', value: n}}], polarity: 'affirmed'};
      compare(n);
    }});
  }
  const chosen = new Set(matchesOf(h, 'q').map(({m}) => m.predicate));
  for (const p of rankStatements(ctx, ctx.message).filter(p => !chosen.has(p.id) && p.roles.length === 2 && p.roles.some(isNumberRole) && p.roles.some(entityRole)).slice(0, 3)) {
    targets.push({text: `the value in "${statementText(p)}"`, apply: () => {
      const u = compareUnknown(h);
      const i = newInstance(ctx, facts, 'q', sym(h, p));
      for (const r of p.roles) facts.add('place', i, r.name, isNumberRole(r) ? u : subject === '?m' ? 'unknown_m' : 'unknown_x');
      compare(variableOf(u));
    }});
  }
  targets.push({text: 'how many things each one has according to another statement (a count)', apply: async () => {
    const span = String(value);
    const binary = rankStatements(ctx, `${span} ${ctx.message}`).filter(p => p.roles.length === 2 && p.roles.every(entityRole)).slice(0, SHOWN_STATEMENTS);
    if (!binary.length) return;
    const k = binary.length === 1 ? 1 : await read(h, 'limit_statement', questionText(h.protocol, 'ask_limit_statement', {arg: span, options: binary.map(p => ({text: withMeaning(p)}))}), 'number', {max: binary.length, zero: true}, 8);
    if (!k) return;
    const predicate = binary[k - 1];
    const at = await askedPlace(h, predicate, subject, `${subject.slice(1).toUpperCase()} (each of the things the request asks for)`, 'ask_count_place');
    const group = predicate.roles[at], counted = predicate.roles.find(r => r !== group);
    const dctx = {lexicon: ctx.lexicon, definitions: ctx.payload.definitions ??= []};
    const def = groupCount(dctx, predicate, group.name, counted.name);
    dctx.definitions.push(def.sop);
    const n = variableOf(compareUnknown(h));
    definitionInstance(h, 'q', {predicate: def.name, roles: [{name: 'subject', value: {kind: 'var', value: subject}}, {name: 'object', value: {kind: 'var', value: n}}], polarity: 'affirmed'});
    compare(n);
  }});
  const direct = targets.filter(t => t.direct);
  const limits = view.rows('limit_kind').length;
  // One limit and one number place the model left unknown: the two signals agree, no question. Several number places: the one
  // whose statement shares a word with the words next to the number.
  const at = Math.max(0, ctx.message.search(new RegExp(`(?<![\\w.-])${String(value).replace('-', '\\-')}(?![\\w.-])`)));
  const near = ctx.stems(ctx.message.slice(Math.max(0, at - 40), at + String(value).length + 20));
  const close = direct.filter(t => [...ctx.stems(t.text)].some(w => near.has(w)));
  let n = null, avoided = null;
  if (targets.length === 1) { n = 1; avoided = 'single option'; }
  else if (direct.length === 1 && limits === 1) { n = targets.indexOf(direct[0]) + 1; avoided = 'the one number place'; }
  else if (close.length === 1) { n = targets.indexOf(close[0]) + 1; avoided = 'the number place named next to the limit'; }
  else n = await read(h, 'limit', questionText(h.protocol, h.action, {arg: String(value), options: targets.map(t => ({text: t.text}))}), 'number', {max: targets.length, zero: true}, 8);
  if (n) { await targets[n - 1].apply(); facts.add('limit_target', num, `t${n}`); }
  return {picked: n ? [targets[n - 1].text] : [], ...(avoided ? {avoided} : {})};
}

/** Entity-typed unknowns of the main query, X first. */
function entityUnknowns(h) {
  const out = [];
  for (const {m} of matchesOf(h, 'q')) {
    const predicate = h.ctx.lexicon.predicates[m.predicate];
    for (const r of m.roles) if (r.value.kind === 'var' && entityRole(predicate?.roles?.find(x => x.name === r.name) ?? {}) && !out.some(o => o.variable === r.value.value))
      out.push({variable: r.value.value, text: `${r.value.value.slice(1).toUpperCase()} in "${matchText(m, h.ctx.lexicon)}"`});
  }
  return out.sort((a, b) => Number(b.variable === '?x') - Number(a.variable === '?x'));
}
const unknownSymbol = variable => `unknown_${variable.slice(1)}`;

async function pickUnknown(h, vars, predicate, arg) {
  const unknowns = entityUnknowns(h);
  if (!unknowns.length) return {empty: true};
  if (unknowns.length === 1 || (h.def.autoFirst && unknowns[0].variable === '?x')) { h.facts.add(predicate, arg, unknownSymbol(unknowns[0].variable)); return {avoided: unknowns.length === 1 ? 'single option' : 'the asked unknown'}; }
  const n = await read(h, h.action.replace(/^ask_/, ''), questionText(h.protocol, h.action, {...vars, options: unknowns}), 'number', {max: unknowns.length, zero: true}, 8);
  if (n) h.facts.add(predicate, arg, unknownSymbol(unknowns[n - 1].variable));
  return {picked: n ? [unknowns[n - 1].variable] : []};
}

async function optionsTarget(h) {
  const names = h.view.rows('option_name').map(r => h.ctx.sym.name.get(r[0]));
  return pickUnknown(h, {options: names.join(' or ')}, 'options_target', h.arg);
}

async function exclusionTarget(h) {
  const id = h.ctx.sym.name.get(h.arg);
  if (matchesOf(h, 'q').some(({m}) => m.roles.some(r => r.value.value === id))) return {empty: true};
  return pickUnknown(h, {arg: id}, 'exclusion_target', h.arg);
}

async function rankValue(h) {
  const chosen = new Set(matchesOf(h, h.arg).map(({m}) => m.predicate));
  const numeric = rankStatements(h.ctx, queryText(h, h.arg)).filter(p => !chosen.has(p.id) && p.roles.length === 2 && p.roles.some(isNumberRole) && p.roles.some(entityRole)).slice(0, 6);
  const form = h.view.rows('query_kind', h.arg)[0]?.[1] ?? 'highest';
  const n = numeric.length ? await read(h, 'rank_value', questionText(h.protocol, h.action, {form, options: numeric.map(p => ({text: statementText(p)}))}), 'number', {max: numeric.length, zero: true}, 8) : 0;
  if (!n) { h.facts.add('rank_dropped', h.arg); return {picked: []}; }
  const p = numeric[n - 1];
  const i = newInstance(h.ctx, h.facts, h.arg, sym(h, p));
  for (const r of p.roles) h.facts.add('place', i, r.name, isNumberRole(r) ? 'unknown_v' : 'unknown_x');
  h.facts.add('rank_instance', h.arg, i);
  return {picked: [p.id]};
}

/** Links two groups of statements that share nothing: the options were computed with the observation `disconnected`. */
async function connect(h) {
  const pairs = h.ctx.payload.connect?.[h.arg];
  if (!pairs?.plausible.length) { h.facts.add('connected', h.arg); return {empty: true}; }
  let n;
  if (pairs.single) n = pairs.plausible.indexOf(pairs.single) + 1;
  else n = await read(h, 'connect', questionText(h.protocol, h.action, {options: pairs.plausible.map(p => ({text: p.text}))}), 'number', {max: pairs.plausible.length}, 8);
  const {from, to} = pairs.plausible[n - 1];
  for (const r of [...h.view.rows('place'), ...h.facts.rows('place')]) if (r[2] === from) { h.facts.remove(f => f.p === 'place' && f.args[0] === r[0] && f.args[1] === r[1]); h.facts.add('place', r[0], r[1], to); }
  h.facts.add('connected', h.arg);
  return pairs.single ? {avoided: 'one plausible link'} : {picked: [`${from}=${to}`]};
}

async function ends(h) {
  const names = requestNames(h, {free: true});
  if (names.length < 2) return {empty: true};
  const options = names.map(n => ({value: n, text: h.ctx.sym.name.get(n)}));
  const s = await read(h, 'start', questionText(h.protocol, 'ask_ends', {options}), 'number', {max: options.length}, 8);
  const start = names[s - 1];
  const rest = options.filter(o => o.value !== start);
  const g = rest.length === 1 ? 1 : await read(h, 'goal', questionText(h.protocol, 'ask_goal', {options: rest}), 'number', {max: rest.length}, 8);
  h.facts.add('reach_start', h.arg, start);
  h.facts.add('reach_goal', h.arg, rest[g - 1].value);
  return {picked: [start, rest[g - 1].value]};
}

/* ------------------------------------------------------------------------------------------------- text answers */

async function names(h) {
  const answer = await h.oracle.ask('names', questionText(h.protocol, h.action, {}), 64);
  const listed = READERS.lines(answer).filter(s => !/^none\b/i.test(s)).slice(0, 6);
  for (const name of listed) addMentions(h.ctx, h.facts, entityHints(name, h.ctx.lexicon));
  return {picked: listed};
}

/** A copied part of the request (the supposition, a second question): kept only when it is a verbatim part of the message. */
async function copy(h) {
  const answer = READERS.copy(await h.oracle.ask(h.action.replace(/^ask_/, ''), questionText(h.protocol, h.action, {}), 64));
  if (!answer || /^0\b/.test(answer)) return {picked: []};
  const at = fold(h.ctx.message).indexOf(fold(answer));
  if (at < 0) return {picked: [], unread: answer};
  const text = h.ctx.message.slice(at, at + answer.length).replace(/[?.!,;]+$/, '').trim();
  const role = h.action === 'ask_supposition_part' ? 'supposition' : 'second';
  if (role === 'second' && fold(text) === fold(h.ctx.message.replace(/[?.!]+$/, ''))) return {picked: []};
  const c = role === 'supposition' ? 'c1' : 'c2';
  h.ctx.sym.clause.set(c, {text, role});
  h.facts.add('clause', c);
  h.facts.add('clause_role', c, role);
  const instance = `i${++h.ctx.counters.instance}`;
  h.ctx.sym.instance.set(instance, {query: c, statement: null});
  h.facts.add('clause_instance', c, instance);
  // The main text without the copied part ranks the statements of the main question.
  const main = (h.ctx.mainText ?? h.ctx.message).replace(h.ctx.message.slice(at, at + answer.length), ' ').replace(/\s+/g, ' ').replace(/^[\s,;:]+|[\s,;:]+$/g, '').trim();
  if (/\p{L}/u.test(main)) h.ctx.mainText = main;
  // Observations of the clause: its own mentions, the one statement its content words name, the one unary statement (avoid hint).
  for (const span of h.ctx.spans) if (fold(text).includes(fold(span.surface))) for (const cand of span.mention.candidates) h.facts.add('clause_own_name', c, nameSymbol(h.ctx, cand.id));
  const hits = lexemeHits(h.ctx, text);
  if (role === 'supposition' && hits.length === 1) h.facts.add('clause_single_hit', c, sym(h, hits[0]));
  const unary = hits.filter(p => p.roles.length === 1 && entityRole(p.roles[0]));
  if (role === 'supposition' && unary.length === 1) h.facts.add('avoid_hint', c, sym(h, unary[0]));
  return {picked: [text]};
}

async function dates(h) {
  const answer = await h.oracle.ask('dates', questionText(h.protocol, h.action, {}), 48);
  h.ctx.payload.dates = readDates(answer);
  return {picked: h.ctx.payload.dates};
}

async function puzzleUnknowns(h) {
  h.ctx.payload.puzzle.unknowns = await read(h, 'unknowns', questionText(h.protocol, h.action, {}), 'unknowns', {}, 64);
  return {picked: h.ctx.payload.puzzle.unknowns.map(u => u.name)};
}
async function puzzleConditions(h) {
  const names = (h.ctx.payload.puzzle.unknowns ?? []).map(u => u.name);
  h.ctx.payload.puzzle.requirements = await read(h, 'conditions', questionText(h.protocol, h.action, varsOf(h)), 'conditions', {names}, 128);
  return {picked: h.ctx.payload.puzzle.requirements.length};
}
async function puzzleAim(h) {
  const out = await numbered(h);
  h.ctx.payload.puzzle.goal = h.facts.rows('puzzle_goal')[0]?.[0] ?? null;
  return out;
}
async function puzzleExpression(h) {
  const names = (h.ctx.payload.puzzle.unknowns ?? []).map(u => u.name);
  h.ctx.payload.puzzle.objective = await read(h, 'objective', questionText(h.protocol, h.action, varsOf(h)), 'expression', {names}, 48);
  return {picked: [h.ctx.payload.puzzle.objective]};
}
async function puzzleClaim(h) {
  const names = (h.ctx.payload.puzzle.unknowns ?? []).map(u => u.name);
  h.ctx.payload.puzzle.claim = await read(h, 'claim', questionText(h.protocol, h.action, varsOf(h)), 'comparison', {names}, 48);
  return {picked: [h.ctx.payload.puzzle.claim]};
}

/* ------------------------------------------------------------------------------------------------- validator and confirmation */

/** A name of the request that the circuit did not use: which statement it belongs to, and which place it takes there. */
async function unusedName(h) {
  const id = h.ctx.sym.name.get(h.arg);
  // The name as the user wrote it (the validator's mention), as the question shows it.
  const surface = h.ctx.payload.unusedSurface?.[h.arg] ?? id;
  const ranked = rankStatements(h.ctx, h.ctx.message).slice(0, SHOWN_STATEMENTS);
  const n = await read(h, 'unused_name', questionText(h.protocol, h.action, {arg: surface, options: ranked.map(p => ({text: statementText(p)}))}), 'number', {max: ranked.length, zero: true}, 8);
  if (!n) return {picked: []};
  const predicate = ranked[n - 1];
  const letters = predicate.roles.map((_, k) => LETTERS[k]);
  const at = predicate.roles.length === 1 ? 0 : LETTERS.indexOf(await read(h, 'name_place', questionText(h.protocol, 'ask_name_letter', {statement: statementText(predicate), what: id}), 'letter', {letters}, 4));
  const i = newInstance(h.ctx, h.facts, 'q', sym(h, predicate));
  predicate.roles.forEach((r, k) => h.facts.add('place', i, r.name, k === at ? h.arg : freshUnknown(h.ctx, h.facts)));
  h.facts.add('unused_statement', h.arg, i);
  return {picked: [predicate.id]};
}

/** The forced contrast: the assembled reading against one with a slot changed (shown in an order fixed by the message). */
async function contrast(h) {
  const c = h.ctx.payload.contrast;
  if (!c) return {empty: true};
  const swap = hash(h.ctx.message) % 2 === 1;
  const shown = swap ? [c.flipped, c.reading] : [c.reading, c.flipped];
  const prompt = questionText(h.protocol, h.action, {options: shown.map(text => ({text})), neither: 3});
  const n = await read(h, 'contrast', prompt, 'number', {max: 3}, 8);
  const pick = n === 3 ? 'neither' : (n === 1) !== swap ? 'reading' : 'flipped';
  h.facts.add('contrast_pick', pick);
  return {picked: [pick]};
}

/** The kind of answer asked again (a violation, the model said the kind was wrong, or "nothing to look up" for a message that asks). */
async function kindAgain(h) {
  const {facts, view} = h;
  const current = view.rows('kind')[0]?.[0];
  const kinds = h.protocol.questions.get('ask_kind').choices;
  const violation = view.rows('violation').find(([v]) => v === 'every_unsplit');
  const shown = kinds.find(c => c.value === current)?.text?.replace(/ \(for example:.*$/, '') ?? current;
  const asks = current === 'none';
  const note = violation ? h.protocol.notes.get('every_unsplit') : asks ? h.protocol.notes.get('request_without_kind') : `Not possible: the request does not want ${shown}. `;
  const at = kinds.findIndex(c => c.value === current) + 1;
  const text = questionText(h.protocol, h.action, {note}).replace(asks ? /$^/ : /\s*0\. none[^\n?]*(?= Reply)/, '');
  const n = await h.oracle.read('kind_again', text, t => { const k = READERS.number(t, {max: kinds.length, zero: asks}); return k === null || k === at ? (k === 0 ? 0 : null) : k; },
    `Reply with one number from ${asks ? 0 : 1} to ${kinds.length}, not ${at}.`, 8);
  if (!n) return {picked: [current]};
  const kind = kinds[n - 1].value;
  facts.remove(f => f.p === 'kind');
  facts.add('kind', kind);
  // The answers that depend on the kind are asked again.
  const dependent = new Set(h.protocol.rows('kind_dependent').map(r => r[0]));
  const values = new Set([...dependent].map(q => h.protocol.questions.get(q)?.asserts).filter(Boolean));
  facts.remove(f => (f.p === 'answered' && dependent.has(f.args[0])) || values.has(f.p) || f.p === 'contrast_pick');
  return {picked: [kind]};
}

/** What the message also does: one yes/no line per act (the last line: whether it asks or states something at all). */
async function acts(h) {
  const choices = h.def.choices;
  const letters = 'ABCDEFGH'.slice(0, choices.length).split('');
  const prompt = questionText(h.protocol, h.action, {message: h.ctx.message, letters: choices.map((c, i) => `${letters[i]}. ${c.text}`).join('\n')});
  const read = t => { const out = new Map(); for (const m of String(t).matchAll(/\b([A-H])\s*[:.)-]\s*(yes|no)\b/gi)) out.set(m[1].toUpperCase(), m[2].toLowerCase() === 'yes'); return out.size === letters.length ? out : /^\s*(?:0|none)\b/i.test(String(t)) ? new Map() : null; };
  const lines = await h.oracle.read('acts', prompt, read, `Reply with ${letters.length} lines, one per letter, like "A: no".`, 56);
  const picked = choices.filter((_, i) => lines.get(letters[i])).map(c => c.value);
  for (const value of picked) h.facts.add(h.def.asserts, value);
  return {picked};
}

/** A content word of the request that no chosen statement covers and that names exactly one other statement: is it needed? */
async function coverage(h) {
  const st = h.arg, p = statementOf(h.ctx, st), word = h.ctx.payload.uncovered?.[st] ?? '';
  const answer = await read(h, 'coverage', questionText(h.protocol, h.action, {word, statement: statementText(p), meaning: meaning(p) ? ` (${meaning(p)})` : ''}), 'number', {max: 2}, 4);
  h.facts.add('covered', st);
  if (answer === 1) newInstance(h.ctx, h.facts, 'q', st);
  return {picked: [answer === 1 ? 'yes' : 'no']};
}

/** The handler of every answer format the protocol names (render.mjs ANSWER_FORMATS). */
export const HANDLERS = Object.freeze({
  number: h => numbered(h), numbers: h => numbered(h, {many: true}), statements, statement_check: statementCheck, sided, sided_role: sidedRole, places: h => h.action === 'ask_places_again' ? placesAgain(h) : placeQuestion(h),
  negated, negated_statement: negatedStatement, chain, scope, limit_target: limitTarget, options_target: optionsTarget, exclusion_target: exclusionTarget,
  rank_value: rankValue, connect, ends, names, copy, dates, unknowns: puzzleUnknowns, conditions: puzzleConditions, expression: puzzleExpression,
  comparison: puzzleClaim, unused_name: unusedName, contrast, kind_again: kindAgain, acts, coverage, own_data: ownData, problem,
});
/**
 * The own-data gate (formalizer-protocol-v1/0060-problem.sop, shared with LocalLLMStepByStep): a yes makes the kind `problem` and keeps
 * the first kind for the fallback. One yes/no question; an unreadable answer counts as no.
 */
async function ownData(h) {
  // A message whose structure cannot state its own data (fp_problem_needs) is not asked.
  if (!problemModeApplies(h.ctx.message, protocolData())) return {picked: ['no'], avoided: 'the message cannot state its own data (structure)'};
  const yes = readYesNo(await h.oracle.ask('own_data', problemText(protocolData(), 'ask_own_data'), 8)) === true;
  if (!yes) return {picked: ['no']};
  h.ctx.payload.askedKind = h.facts.rows('kind')[0]?.[0] ?? null;
  h.facts.remove(f => f.p === 'kind');
  h.facts.add('kind', 'problem');
  return {picked: ['yes']};
}

/**
 * The problem questions (the same protocol data and code as LocalLLMStepByStep's problem mode): the circuit is kept for the assembly.
 * When they cannot be read, the request goes on with the first kind (or the protocol's fallback kind), and the gate is not asked again.
 */
async function problem(h) {
  const data = protocolData();
  const result = !problemModeApplies(h.ctx.message, data) ? null : await problemCircuit(h.oracle, {message: h.ctx.message, lexicon: h.ctx.lexicon, data});
  if (result) { h.ctx.payload.problem = result; return {picked: [result.report.kind]}; }
  const back = h.ctx.payload.askedKind && h.ctx.payload.askedKind !== 'problem' ? h.ctx.payload.askedKind : data.one('problem_fallback_kind') ?? 'value';
  h.facts.remove(f => f.p === 'kind');
  h.facts.add('kind', back);
  h.facts.add('answered', 'ask_own_data', 'none');
  return {picked: [], avoided: `the problem questions could not be read; formalized as ${back}`};
}

/** Questions whose number format needs a step after the answer (the puzzle goal is kept for the constraint). */
export const AFTER = Object.freeze({ask_puzzle_aim: puzzleAim});

export {numberedLines};
