/**
 * The scored joint KnowledgeLinker (linking proposal sections 3.4 and 3.5; DS014 "KnowledgeLinker: scoring and ambiguity").
 *
 * The circuit author writes entity and relation strings as the message has them. The KnowledgeLinker joins them to the symbols of ONE base memory: every
 * relation phrase and every entity string becomes a set of scored candidates, the constraints the memory declares prune or support
 * the candidates of a proposition together (a relation's role classes against the entities the message names, a lexeme's
 * `restrict`), and the outcome is either one binding with the alternatives it did not take, or an explicit ambiguity that the
 * caller turns into a clarification. Nothing here guesses: when the evidence does not separate two candidates by MARGIN, both are
 * returned and the user is asked. Scores are integers so that reports can show them; the decision is made in named stages
 * (`decided_by`), so a report says why a candidate won.
 *
 * Language data only: the closed set of function words below, the lexicon of the memory in use, no predicate or entity names.
 */
import {phraseKey} from './text-keys.mjs';

/** The score of each kind of evidence (words and numbers of the proposal, section 3.4). */
export const SCORES = Object.freeze({
  lexicon: 100,          // an id, label, alias or lexeme form of the memory equals the phrase
  description: 90,       // the memory's gloss of the predicate equals the phrase
  listed: 80,            // reviewed relation lexicon (function-word tables) reaches a predicate the memory declares
  dictionary: 90,        // the first (canonical) translation of the phrase equals a lexicon form
  otherTranslation: 85,  // another translation
  synonym: 80,           // a listed English synonym
  span: 70,              // the phrase of an unparsed relation span near the wire
  headVerb: 50,          // same head verb, other particles (queries only)
  typeSupport: 10,       // an entity of the message is of the class the role declares
  coherence: 3,          // the predicate's domain is the domain of an entity of the message
  notability: 5,         // the candidate entity is far more notable than the next one (never decides alone)
  labelForm: 10,         // where the role expects a class: the surface is the class's id or label, not only an alias of it
  missingRole: -2,       // a declared role a query leaves open
});
/**
 * Evaluation hook: the linker stages can be switched off to reproduce earlier linkers in the linking suite (`tools/eval/linking/suite.mjs
 * --linker exact|scored|scored-no-head`). The product always runs with everything on.
 */
export const mode = {scored: true, headVerb: true};
export function configureLinker(options) { Object.assign(mode, options); return {...mode}; }

/** Candidates within MARGIN of the best are not separated by soft evidence: the user is asked. */
export const MARGIN = 10;
/** A lexeme without a declared weight counts as the midpoint of the 1 to 10 scale when weights are compared. */
export const NEUTRAL_WEIGHT = 5;

/** Role names of a lexicon predicate in argument order, or null for an unnamed predicate of arity above two. */
export function predicateRoleNames(predicate) {
  if (!predicate) return null;
  if (predicate.namedRoles) return predicate.roles.map(role => role.name);
  return predicate.arity <= 2 ? ['subject', 'object'].slice(0, predicate.arity) : null;
}

/** All declared forms of `predicate` equal to the phrase key, by authority: lexeme form, label, alias, id, description. */
export function matchedForm(lexicon, predicateId, text) {
  const key = phraseKey(text), predicate = lexicon?.predicates?.[predicateId];
  if (!predicate) return null;
  for (const lexeme of predicate.lexemes ?? []) for (const form of lexeme.forms) if (phraseKey(form) === key) return {kind: 'lexeme', id: lexeme.id, text: form, language: lexeme.language};
  const labels = new Set(Object.values(predicate.labels ?? {}));
  for (const alias of predicate.aliases ?? []) if (phraseKey(alias.surface) === key && !(predicate.lexemes ?? []).some(l => l.language === alias.language && l.forms.includes(alias.surface))) return {kind: labels.has(alias.surface) ? 'label' : 'alias', text: alias.surface, language: alias.language};
  if (phraseKey(predicate.id) === key) return {kind: 'id', text: predicate.id};
  if (predicate.description && phraseKey(predicate.description) === key) return {kind: 'description', text: predicate.description};
  return null;
}

const isVariable = value => typeof value === 'string' && value.startsWith('?');
const stringValues = values => [...(values ?? new Map())].filter(([, value]) => typeof value === 'string' && !isVariable(value) && value.trim());

/** Entities (ids) a role string names in the lexicon: exact, then accent-folded, any language. Memoized per call site. */
function entityHits(lexicon, value, memo) {
  if (!memo.has(value)) memo.set(value, lexicon.matching(value, {language: 'auto', kind: 'entity'}).found.map(entry => entry.id));
  return memo.get(value);
}
/** Is the entity in the class (itself, its kind, `is_a` closure)? The root class `entity` and non-class value types hold for everything. */
function inClass(lexicon, id, type) {
  if (!type || type === 'entity' || !lexicon.isClass(type)) return true;
  return lexicon.classesOf(id).has(type);
}

/**
 * Score one predicate as the reading of a relation phrase. `values` maps role name -> the string a proposition wrote there.
 * Returns {id, roles, score, tier, form, weight, hard, support, soft, missing}; `hard` lists constraint violations (`restrict`,
 * `type_clash`) that remove the candidate when another one remains.
 */
export function scoreRelation(lexicon, predicate, text, {used, exact, values, via = 'lexicon', memo = new Map()}) {
  const key = phraseKey(text), names = predicateRoleNames(predicate);
  const form = matchedForm(lexicon, predicate.id, text);
  const tier = via === 'headVerb' ? SCORES.headVerb : !form ? SCORES.listed : form.kind === 'description' ? SCORES.description : SCORES.lexicon;
  const lexemes = (predicate.lexemes ?? []).filter(l => l.forms.some(f => phraseKey(f) === key));
  const hard = [];
  let support = 0, coherent = false;
  const strings = stringValues(values);
  // Entities the message names in the roles of this predicate, against the classes the memory declares for them.
  const roleType = name => predicate.roles?.find(r => r.name === name)?.type;
  const restrictOk = lexeme => lexeme.restrict.every(({role, class: cls}) => {
    const value = values?.get(role);
    if (typeof value !== 'string' || isVariable(value)) return true;
    const hits = entityHits(lexicon, value, memo);
    return !hits.length || hits.some(id => lexicon.classesOf(id).has(cls));
  });
  const applicable = lexemes.filter(restrictOk);
  if (lexemes.length && !applicable.length) hard.push('restrict');
  for (const [name, value] of strings) {
    const hits = entityHits(lexicon, value, memo), type = roleType(name);
    if (!hits.length) continue;
    if (hits.some(id => lexicon.entities[id]?.domain && lexicon.entities[id].domain === predicate.domain)) coherent = true;
    if (!type || type === 'entity' || !lexicon.isClass(type)) continue;
    if (hits.some(id => inClass(lexicon, id, type))) support++; else hard.push(`type_clash:${name}`);
  }
  const weights = applicable.map(l => l.weight).filter(w => Number.isFinite(w));
  const weight = weights.length ? Math.max(...weights) : null;
  const missing = exact || !names ? 0 : Math.max(0, names.length - used.length);
  const soft = (support && !hard.some(h => h.startsWith('type_clash')) ? SCORES.typeSupport : 0) + (coherent ? SCORES.coherence : 0) + missing * SCORES.missingRole;
  // Direction (DS004 `lexeme` frame): every applicable lexeme of the matched form realizes the object first, so the clause subject plays the predicate's object role.
  const converse = applicable.length > 0 && applicable.every(l => l.converse) && via !== 'headVerb';
  return {id: predicate.id, converse, roles: names, score: tier + (weight === null ? 0 : weight - NEUTRAL_WEIGHT) + soft, tier, form, weight, hard, support, soft, missing, facts: predicate.factCount ?? 0};
}

/**
 * The decision among scored candidates, in named stages. Returns {chosen, by, scored, tied}: `chosen` is null when the candidates are
 * not separated (an ambiguity the caller reports), `by` names the stage that decided:
 *   only_candidate  a single candidate
 *   constraint      the memory's constraints (`restrict`, role classes) removed all but one
 *   form_tier       the best form authority leads the others by MARGIN
 *   facts           only some of the equally good readings have facts in the memory (the lexicon counts `holds` facts per predicate)
 *   weight          the lexemes declare distinct weights (the validator demands them for a shared form)
 *   evidence        the soft evidence (class support, coherence) leads by MARGIN
 */
export function decide(candidates) {
  const scored = [...candidates].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (!mode.scored && scored.length > 1) return {chosen: null, by: null, scored, tied: scored};     // the exact linker of M1: any tie is an ambiguity
  if (scored.length <= 1) return {chosen: scored[0] ?? null, by: scored.length ? 'only_candidate' : null, scored, tied: []};
  let live = scored.filter(c => !c.hard.length), by = 'constraint';
  if (!live.length) live = scored;                      // a constraint never removes the last reading
  else if (live.length === 1) return {chosen: live[0], by, scored, tied: []};
  const topTier = Math.max(...live.map(c => c.tier));
  let tiered = live.filter(c => c.tier > topTier - MARGIN);
  if (tiered.length === 1) return {chosen: tiered[0], by: 'form_tier', scored, tied: []};
  // Memory evidence: when only some of the equally good readings have facts in the memory, the others cannot answer anything there.
  const answerable = tiered.filter(c => c.facts > 0);
  if (answerable.length && answerable.length < tiered.length) {
    tiered = answerable;
    if (tiered.length === 1) return {chosen: tiered[0], by: 'facts', scored, tied: []};
  }
  const topWeight = Math.max(...tiered.map(c => c.weight ?? NEUTRAL_WEIGHT));
  const weighed = tiered.filter(c => (c.weight ?? NEUTRAL_WEIGHT) === topWeight);
  if (weighed.length === 1) return {chosen: weighed[0], by: 'weight', scored, tied: []};
  const rest = [...weighed].sort((a, b) => b.soft - a.soft);
  if (rest[0].soft - rest[1].soft >= MARGIN) return {chosen: rest[0], by: 'evidence', scored, tied: []};
  return {chosen: null, by: null, scored, tied: rest.filter(c => rest[0].soft - c.soft < MARGIN)};
}

const PARTICLES = new Set(['at', 'for', 'in', 'on', 'to', 'of', 'with', 'from', 'by', 'about', 'into', 'onto', 'out', 'up', 'down', 'over', 'off', 'after', 'before', 'under']);
const headCache = new WeakMap();
/** head word -> predicate ids whose form is that word followed only by particles (the `headVerb` tier). */
function headIndex(lexicon) {
  if (headCache.has(lexicon)) return headCache.get(lexicon);
  const index = new Map();
  for (const key of lexicon.predicatesByKey.keys()) {
    const [head, ...rest] = key.split(' ');
    if (head && rest.every(t => PARTICLES.has(t))) for (const id of lexicon.predicatesByKey.get(key)) (index.get(head) ?? index.set(head, new Set()).get(head)).add(id);
  }
  headCache.set(lexicon, index);
  return index;
}
/** Predicates reachable from a phrase by its head word alone (the phrase is the head plus particles only). */
export function headVerbPredicates(lexicon, text) {
  const [head, ...rest] = phraseKey(text).split(' ');
  if (!head || !rest.every(t => PARTICLES.has(t))) return [];
  const reached = [...(headIndex(lexicon).get(head) ?? [])].map(id => lexicon.predicates[id]);
  // A fuzzy tier only reaches readings that can answer: when the memory holds facts at all, a predicate without any is not offered.
  return lexicon.factCounts?.size ? reached.filter(p => p.factCount > 0) : reached;
}

/** Does the surface equal the entity's id or one of its labels (not only an alias)? Case and accents folded. */
function labelledBy(entity, surface) {
  const key = value => String(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
  const want = key(surface);
  return key(entity.id) === want || Object.values(entity.labels ?? {}).some(label => key(label) === want);
}

/**
 * Choose among the entities one surface names (same surface, several entities). Class support: when the role declares a class, the
 * entities of that class lead by MARGIN. Form authority, only where the role expects a class: a class whose id or label is the surface
 * leads one that carries it only as an alias ("tool": the class tool before the class device with the alias "tool"), as a relation's
 * label leads a weaker form. Notability and coherence order the options but never decide alone: a namesake is not linked silently.
 * Returns {chosen, by, scored}; `chosen` null means the user must say which.
 */
export function chooseEntity(lexicon, found, {type = null, match = 'exact', domainHints = [], surface = null} = {}) {
  const base = match === 'exact' ? 100 : 85;
  const typed = type && type !== 'entity' && lexicon.isClass(type);
  // When the role declares a class and some namesake is of it, the namesakes that are not are removed (a type clash), not just ranked lower.
  const ofClass = typed ? found.filter(e => inClass(lexicon, e.id, type)) : [];
  const ranked = (ofClass.length ? ofClass : [...found]).map(e => lexicon.entities[e.id] ?? e).sort((a, b) => (b.notability ?? 0) - (a.notability ?? 0));
  const second = ranked[1]?.notability ?? 0;
  const labelled = typed && surface ? ranked.filter(e => labelledBy(e, surface)) : [];
  const authority = labelled.length > 0 && labelled.length < ranked.length;
  const scored = ranked.map((e, i) => {
    const supported = typed && inClass(lexicon, e.id, type);
    const formed = authority && labelled.includes(e);
    const score = base + (supported ? SCORES.typeSupport : 0) + (formed ? SCORES.labelForm : 0) + (i === 0 && (e.notability ?? 0) >= 4 * Math.max(second, 1) ? SCORES.notability : 0) + (e.domain && domainHints.includes(e.domain) ? SCORES.coherence : 0);
    return {id: e.id, label: e.labels?.en ?? e.id, class: e.entityType ?? null, ...(e.description ? {description: e.description} : {}), score, supported: Boolean(supported), ...(formed ? {form: 'label'} : {})};
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (scored.length === 1) return {chosen: scored[0], by: ofClass.length && found.length > 1 ? 'class' : 'only_candidate', scored};
  if (scored[0].score - scored[1].score >= MARGIN) return {chosen: scored[0], by: scored[0].form && !scored[1].form ? 'form_tier' : scored[0].supported ? 'class' : 'evidence', scored};
  return {chosen: null, by: null, scored};
}
