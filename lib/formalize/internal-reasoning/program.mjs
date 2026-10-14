/**
 * Assembly of InternalReasoningStepByStep (DS022 "InternalReasoningStepByStep"): the slots the protocol established (stored answers
 * and the values its defaults derived, read from the closure `view`) become the `program` of LocalLLMStepByStep's circuit writer
 * (lib/query-author/step-by-step/circuit.mjs, imported read-only), and `assembleProgram` writes the SOP. Session definitions (a chain
 * of links, a count per group, a difference of counts, the fewest links) come from the same templates as the other protocol
 * (definitions.mjs). The validator is the only gate; this module never decides what the request means, it only maps slots to wires.
 */
import {assembleProgram, paraphraseProgram, matchText} from '../../query-author/step-by-step/circuit.mjs';
import {assemble as assembleA, paraphrase as paraphraseA, statementText} from '../../query-author/step-by-step/assemble.mjs';
import {chainDefinitions, fewestLinks, freeName} from '../../query-author/step-by-step/definitions.mjs';
import {isNumberRole, entityRole, statementOf, rankStatements} from './state.mjs';
import {isMessageAct} from '../../../sop/message-acts.mjs';

const ASKING = new Set(['list', 'value', 'count', 'highest', 'lowest', 'when']);
/** The slot predicates the assembly reads from the closure (the protocol lint checks that every asserted slot is read here or by a rule). */
export const ASSEMBLY_READS = Object.freeze(['kind', 'act', 'emotion', 'query_kind', 'uses', 'place', 'negated_instance', 'chained', 'rank_dropped', 'scope_instance', 'quantifier',
  'polarity', 'options_target', 'option_name', 'exclusion_target', 'measure', 'period', 'has_aspect', 'clause_link', 'clause_pick', 'reach_step', 'reach_avoid', 'reach_start',
  'reach_goal', 'reach_relation', 'fewest_route', 'fewest_step', 'main_instance', 'sided', 'limit_target', 'unused_statement', 'contrast_pick', 'puzzle_goal', 'linked', 'base_kind',
  'clause_name', 'switched_yesno', 'ticked', 'excluded_name', 'limit_kind', 'definition', 'sided_role', 'rank_instance', 'connected', 'statements_none']);
const NOTHING = new Set(['none', 'only_greeting', 'only_thanks', 'only_closing', 'only_apology', 'only_feeling']);
const order = s => Number(String(s).replace(/^\D+/, '')) || 0;
const clone = v => JSON.parse(JSON.stringify(v));

/** The variable of an unknown symbol: unknown_x → ?x, unknown_a3 → ?a3, unknown_w2 → ?w2. */
export const variableOf = u => `?${String(u).replace(/^unknown_/, '')}`;

/** A place value symbol as a circuit term {kind, value}. */
export function termOf(ctx, s) {
  if (ctx.sym.name.has(s)) return {kind: 'entity', value: ctx.sym.name.get(s)};
  if (ctx.sym.number.has(s)) return {kind: 'number', value: ctx.sym.number.get(s)};
  return {kind: 'var', value: variableOf(s)};
}

/** The match of an instance: the statement (or the definition it was re-pointed to) with its places in declared order. */
export function matchOf(ctx, view, i, {repoint = ctx.payload.repoint ?? {}} = {}) {
  if (repoint[i]) return clone(repoint[i]);
  const predicate = statementOf(ctx, i);
  const roles = predicate.roles.map(role => {
    const value = view.rows('place', i, role.name)[0]?.[2];
    return {name: role.name, value: value ? termOf(ctx, value) : {kind: 'var', value: `?f_${i}_${role.name}`}};
  });
  return {predicate: predicate.id, roles, polarity: 'affirmed'};
}

const instancesOf = (view, qq) => view.rows('uses', qq).map(r => r[1]).sort((a, b) => order(a) - order(b));
const one = (view, p, ...prefix) => view.rows(p, ...prefix)[0]?.[prefix.length] ?? null;

/** The query object of query `qq` ('q' main, or a clause asking a second question). */
function queryOf(ctx, view, qq, id, definitions) {
  const instances = ctx.payload.only?.[qq] ?? instancesOf(view, qq);
  if (!instances.length) return null;
  let form = ctx.payload.formOf?.[qq] ?? one(view, 'query_kind', qq) ?? 'yesno';
  if (form === 'statement') form = 'yesno';
  const matches = instances.map(i => {
    const m = matchOf(ctx, view, i);
    if (view.has('negated_instance', i)) m.polarity = statementOf(ctx, i)?.closed === true ? 'absent' : 'negated';
    return m;
  });
  const query = {id, form, matches, compares: [...(ctx.payload.compares?.[qq] ?? [])], excepts: [], links: [], select: null, rank: null, time: null, picked: instances.map(i => statementOf(ctx, i)?.id)};
  // A chain of links instead of one direct link: the recursive definition replaces the statement of that instance.
  for (const [n, i] of instances.entries()) if (view.has('chained', i)) {
    const def = chainDefinitions({lexicon: ctx.lexicon, definitions}, matches[n].predicate);
    definitions.push(def.sop);
    const [subject, object] = ctx.lexicon.predicates[matches[n].predicate].roles;
    matches[n] = {predicate: def.name, roles: [{name: 'subject', value: matches[n].roles.find(r => r.name === subject.name).value}, {name: 'object', value: matches[n].roles.find(r => r.name === object.name).value}], polarity: matches[n].polarity};
  }
  if (view.has('rank_dropped', qq) && (form === 'highest' || form === 'lowest')) form = query.form = 'list';
  // A stored number read for a fixed name is a value, not a count of rows.
  const askedNumeric = matches.some(m => m.roles.some(r => r.value.value === '?x' && isNumberRole(ctx.lexicon.predicates[m.predicate]?.roles?.find(x => x.name === r.name))));
  if (form === 'count' && askedNumeric) form = query.form = 'value';
  if (form === 'every') {
    const scope = instances.filter(i => view.has('scope_instance', i));
    const named = i => view.rows('place', i).some(r => ctx.sym.name.has(r[2]));
    let restriction = matches.filter((_, n) => scope.length ? !scope.includes(instances[n]) : named(instances[n]));
    let scoped = matches.filter(m => !restriction.includes(m));
    if (!restriction.length || !scoped.length) { query.form = 'list'; form = 'list'; }
    else {
      let quantifier = one(view, 'quantifier', qq) ?? 'all';
      if (quantifier === 'at_least') quantifier = ctx.sym.number.size ? `at_least ${[...ctx.sym.number.values()][0]}` : 'all';
      query.every = {restriction, scope: scoped, quantifier};
    }
  }
  if (ASKING.has(form)) query.select = '?x';
  if (form === 'highest' || form === 'lowest') query.rank = {direction: form, value: '?v'};
  if (form === 'yesno' || form === 'why') {
    query.polarity = one(view, 'polarity', qq) ?? 'affirmed';
    if (ctx.payload.fixAbsence && query.polarity === 'absent') query.polarity = 'negated';
    if (matches.length === 1) matches[0].polarity = query.polarity;
  }
  if (ctx.payload.fixAbsence) for (const m of matches) if (m.polarity === 'absent') m.polarity = 'negated';
  // Options and exclusions: the chosen unknown must be one of the offered names, or not the excluded name.
  const target = one(view, 'options_target', qq);
  const options = view.rows('option_name').map(r => ctx.sym.name.get(r[0]));
  if (target && options.length >= 2) query.any = {variable: variableOf(target), values: options};
  if (qq === 'q') for (const [n, u] of view.rows('exclusion_target')) query.excepts.push({variable: variableOf(u), value: ctx.sym.name.get(n)});
  // Time: the asked time of a when-question, the date or period of the request.
  if (form === 'when') {
    const m = matches.find(x => x.roles.some(r => r.value.kind === 'entity')) ?? matches[0];
    const own = m.roles.find(r => r.name === 'time');
    if (own && own.value.kind === 'var') { const v = own.value.value; for (const x of matches) for (const r of x.roles) if (r.value.value === v) r.value = {kind: 'var', value: '?t'}; }
    else if (!own) m.roles.push({name: 'time', value: {kind: 'var', value: '?t'}});
    query.select = '?t';
    const measure = one(view, 'measure', qq);
    query.measure = measure && measure !== 'point' ? measure : null;
  } else if (qq === 'q' && (ctx.sym.date.size || (ctx.payload.dates?.length && view.has('has_aspect', 'date')))) {
    // Readable dates of the message are structure (no aspect needed); dates the model wrote out come with the aspect.
    const dates = ctx.payload.dates ?? [...ctx.sym.date.values()];
    if (dates.length === 1) query.time = {kind: 'at', dates};
    else if (dates.length >= 2) query.time = {kind: one(view, 'period', qq) ?? 'overlaps', dates: dates.slice(0, 2)};
  }
  if (form === 'why') query.select = null;
  return query;
}

/** A clause that states or supposes something: its statement with names in every place, or null. */
function clauseStatement(ctx, view, c) {
  const [i] = instancesOf(view, c);
  if (!i) return null;
  const m = matchOf(ctx, view, i);
  if (m.roles.some(r => r.value.kind !== 'entity')) return null;
  // Statements are anchored to the message: the name as the user wrote it.
  const surface = id => ctx.spans.find(s => s.mention.candidates.some(cand => cand.id === id))?.surface ?? id;
  return {certainty: ctx.sym.clause.get(c).role === 'supposition' ? 'supposed' : 'asserted',
    match: {...m, roles: m.roles.map(r => ({...r, value: {kind: 'entity', value: surface(r.value.value)}})), polarity: one(view, 'polarity', c) ?? 'affirmed'}};
}

/**
 * The program of the established slots: {unclear} | {constraint} | {reachA, stated, links, unparsed} | {definitions, stated, queries,
 * unparsed}, plus `pragmatic` (the acts and feelings of the message).
 */
export function programOf(ctx, view) {
  const kind = one(view, 'kind');
  // The acts and feelings that are message acts of the reply memory (sop/message-acts.mjs); `emotion` asks the emotion question and
  // `request` only checks the kind.
  const pragmatic = [...view.rows('act').map(r => r[0]), ...view.rows('emotion').map(r => r[0])].filter(k => isMessageAct(k));
  const withSignals = p => pragmatic.length ? {...p, pragmatic: [...new Set(pragmatic)]} : p;
  if (!kind) return {unclear: 'relation_not_in_memory'};
  if (NOTHING.has(kind)) return withSignals(pragmatic.length ? {} : {unclear: 'no_request'});
  if (kind === 'puzzle') {
    const c = ctx.payload.puzzle;
    if (!c.unknowns?.length || !c.requirements?.length || !c.goal) return {unclear: 'relation_not_in_memory'};
    return withSignals({constraint: c});
  }
  const definitions = [...(ctx.payload.definitions ?? [])];
  const stated = [], links = [], unparsed = [], queries = [];
  for (const [c, clause] of ctx.sym.clause) {
    if (clause.role === 'supposition') {
      const s = clauseStatement(ctx, view, c);
      if (s) {
        const id = `s${stated.length + 1}`;
        stated.push({id, ...s});
        links.push({keyword: one(view, 'clause_link', c) === 'unless' ? 'unless' : 'if', target: id});
      } else unparsed.push({span: clause.text.replace(/[?.!]+$/, '').trim()});
    } else if (clause.role === 'second') {
      const query = queryOf(ctx, view, c, `q${queries.length + 2}`, definitions);
      if (query) queries.push(query); else unparsed.push({span: clause.text.replace(/[?.!]+$/, '').trim()});
    }
  }
  const qkind = one(view, 'query_kind', 'q');
  if (qkind === 'reach') {
    const step = one(view, 'reach_step', 'q'), start = one(view, 'reach_start', 'q'), goal = one(view, 'reach_goal', 'q');
    if (!step || !start || !goal) return {unclear: 'relation_not_in_memory'};
    const avoid = one(view, 'reach_avoid', 'q');
    const stepId = statementOf(ctx, step).id, dctx = {lexicon: ctx.lexicon, definitions};
    const reach = {step: stepId, avoid: avoid ? statementOf(ctx, avoid).id : null, stepName: freeName(dctx, `allowed_${stepId}`), reachName: freeName(dctx, `reachable_by_${stepId}`),
      start: ctx.sym.name.get(start), goal: ctx.sym.name.get(goal)};
    return withSignals({reachA: {form: 'reach', reach}, stated, links, unparsed});
  }
  const reachRelation = one(view, 'reach_relation', 'q');
  let main = null;
  if (kind === 'reach' && reachRelation) {
    const p = statementOf(ctx, reachRelation);
    const start = one(view, 'reach_start', 'q'), goal = one(view, 'reach_goal', 'q');
    if (start && goal) main = {id: 'q', form: 'yesno', polarity: 'affirmed', compares: [], excepts: [], links: [], select: null, rank: null, time: null, picked: [p.id],
      matches: [{predicate: p.id, roles: [{name: p.roles[0].name, value: {kind: 'entity', value: ctx.sym.name.get(start)}}, {name: p.roles[1].name, value: {kind: 'entity', value: ctx.sym.name.get(goal)}}], polarity: 'affirmed'}]};
  } else if (view.has('fewest_route', 'q')) {
    const step = one(view, 'fewest_step', 'q'), start = one(view, 'reach_start', 'q'), goal = one(view, 'reach_goal', 'q');
    if (step && start && goal) {
      const def = fewestLinks({lexicon: ctx.lexicon, definitions}, statementOf(ctx, step).id);
      definitions.push(def.sop);
      main = {id: 'q', form: 'value', compares: [], excepts: [], links: [], select: '?x', rank: {direction: 'lowest', value: '?x'}, time: null,
        matches: [{predicate: def.name, roles: [{name: 'subject', value: {kind: 'entity', value: ctx.sym.name.get(start)}}, {name: 'object', value: {kind: 'entity', value: ctx.sym.name.get(goal)}}, {name: 'topic', value: {kind: 'var', value: '?x'}}], polarity: 'affirmed'}]};
    }
  } else main = queryOf(ctx, view, 'q', 'q', definitions);
  if (kind === 'statement') {
    const surface = id => ctx.spans.find(s => s.mention.candidates.some(cand => cand.id === id))?.surface ?? id;
    for (const [n, m] of (main?.matches ?? []).entries()) if (m.roles.every(r => r.value.kind === 'entity'))
      stated.push({id: `f${n + 1}`, certainty: 'asserted', match: {...m, roles: m.roles.map(r => ({...r, value: {kind: 'entity', value: surface(r.value.value)}}))}});
    return withSignals(stated.length ? {stated, definitions, queries, unparsed} : {unclear: 'relation_not_in_memory'});
  }
  if (main) queries.unshift({...main, links: [...(main.links ?? []), ...links]});
  else if (queries.length || stated.some(s => s.certainty !== 'supposed')) unparsed.unshift({span: ctx.message.replace(/[?.!]+$/, '').trim()});
  if (!queries.length && !stated.some(s => s.certainty !== 'supposed')) return withSignals({unclear: 'relation_not_in_memory'});
  return withSignals({definitions, stated, queries, unparsed});
}

/** The SOP text of a program (a chain query keeps method A's recursive definitions, as LocalLLMStepByStep writes it). */
export function sopOf(program, lexicon) {
  if (!program.reachA) return assembleProgram(program);
  const signals = program.pragmatic?.length ? assembleProgram({pragmatic: program.pragmatic}) : '';
  let base = assembleA(program.reachA);
  // A chain over a complete (closed) step statement is complete too: absence of a path is then a no, not an unknown.
  const r = program.reachA.reach;
  if (lexicon?.predicates?.[r.step]?.closed === true) base = base.replace(`@${r.reachName} predicate\n  args subject:entity object:entity\n`, `@${r.reachName} predicate\n  args subject:entity object:entity\n  closed true\n`);
  const head = program.stated.map(s => assembleProgram({stated: [s]}).trim()).join('\n');
  const tail = program.links.map(l => `  ${l.keyword} $${l.target}`).join('\n');
  const unparsed = program.unparsed.length ? assembleProgram({unparsed: program.unparsed}).trim() : '';
  return [head, base.trimEnd() + (tail ? `\n${tail}` : ''), unparsed, signals.trim()].filter(Boolean).join('\n') + '\n';
}

/** The deterministic English paraphrase of a program (the confirmation step). */
export function paraphraseOf(program, lexicon) {
  if (program.constraint) return paraphraseA({form: 'puzzle', constraint: program.constraint}, lexicon);
  if (program.reachA) {
    const sup = program.stated.map(s => `Supposing that ${matchText(s.match, lexicon)}:`).join(' ');
    return `${sup ? sup + ' ' : ''}${paraphraseA(program.reachA, lexicon)}`;
  }
  return paraphraseProgram(program, lexicon, {definitionsText: program.definitions?.length ? 'with the counts or chains worked out from the knowledge' : null});
}

/**
 * Alternative readings of the main question, each with one slot changed (the forced contrast shows the first that reads differently):
 * fewer statements (a derived statement alone), another statement with the same places, swapped places, the other truth, the
 * neighbouring kind, the other quantifier, the chain's avoided statement. Each is {slot, program}.
 */
export function flips(ctx, view, program) {
  const out = [];
  const with_ = (slot, change) => { const p = clone(program); if (change(p) !== false) out.push({slot, program: p}); };
  if (program.reachA) {
    const r = program.reachA.reach;
    if (view.rows('reach_avoid', 'q').length && !view.rows('answered', 'ask_reach_avoid').length) return out; // the avoided statement came from the supposition's words
    const unary = ctx.statements.filter(p => p.roles.length === 1);
    if (r.avoid) with_('avoid', p => { p.reachA.reach.avoid = null; });
    else if (unary.length) with_('avoid', p => { p.reachA.reach.avoid = rankStatements(ctx, ctx.message, unary)[0].id; });
    return out;
  }
  const query = program.queries?.[0];
  if (!query || query.id !== 'q') return out;
  const predicateOf = m => ctx.lexicon.predicates[m.predicate];
  const derivedAt = query.matches.length > 1 && query.form !== 'every' ? query.matches.findIndex(m => ctx.statements.find(p => p.id === m.predicate)?.derived && m.roles.some(r => r.value.kind === 'entity')) : -1;
  if (derivedAt >= 0 && !query.compares?.length && !query.rank) with_('statements', p => {
    const q = p.queries[0], keep = q.matches[derivedAt];
    const free = keep.roles.find(r => r.value.kind === 'var');
    if (ASKING.has(q.form) && free) { const v = free.value.value; for (const r of keep.roles) if (r.value.value === v) r.value = {kind: 'var', value: '?x'}; }
    q.matches = [keep];
  });
  if (query.matches.length === 1 && predicateOf(query.matches[0]) && ctx.lexicon.predicates[query.picked?.[0]]) {
    const m = query.matches[0];
    const alternative = rankStatements(ctx, ctx.message).find(p => p.id !== m.predicate && p.roles.length === m.roles.length
      && p.roles.every((r, i) => r.name === m.roles[i].name && isNumberRole(r) === isNumberRole(predicateOf(m)?.roles?.[i] ?? {})));
    if (alternative) with_('statement', p => { p.queries[0].matches[0] = {...m, predicate: alternative.id, roles: alternative.roles.map((r, i) => ({name: r.name, value: m.roles[i].value}))}; });
  }
  const at = query.matches.findIndex(m => m.roles.length === 2 && m.roles.every(r => entityRole(predicateOf(m)?.roles?.find(x => x.name === r.name) ?? {}))
    && new Set(m.roles.map(r => JSON.stringify(r.value))).size === 2 && m.roles.some(r => r.value.kind === 'entity'));
  const swapPredicate = at >= 0 ? predicateOf(query.matches[at]) : null;
  const swapFits = Boolean(swapPredicate) && query.matches[at].roles.every((r, i) => r.value.kind !== 'entity' || (ctx.roleFit(r.value.value, swapPredicate, 1 - i) && !ctx.roleFit.observed(r.value.value, swapPredicate).includes(i)));
  const twin = at >= 0 && query.matches.filter(m => m.predicate === query.matches[at].predicate).length > 1;
  if (at >= 0 && swapFits && !twin) with_('places', p => { const roles = p.queries[0].matches[at].roles; [roles[0].value, roles[1].value] = [roles[1].value, roles[0].value]; });
  if (query.form === 'yesno' || query.form === 'why') {
    const closed = query.matches.length === 1 && predicateOf(query.matches[0])?.closed === true;
    const other = query.polarity === 'affirmed' ? (closed ? 'absent' : 'negated') : 'affirmed';
    with_('truth', p => { const q = p.queries[0]; q.polarity = other; if (q.matches.length === 1) q.matches[0].polarity = other; });
  }
  const forms = {count: 'list', list: 'count', highest: 'lowest', lowest: 'highest', value: 'list'};
  if (forms[query.form] && (!query.rank || query.form === 'highest' || query.form === 'lowest')) with_('kind', p => {
    const q = p.queries[0]; q.form = forms[q.form];
    if (q.rank) q.rank.direction = q.form;
  });
  if (query.form === 'every' && query.every) with_('quantifier', p => { p.queries[0].every.quantifier = p.queries[0].every.quantifier === 'none' ? 'all' : 'none'; });
  return out;
}

export {statementText};
