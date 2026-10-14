/** Family generators. Each returns a case spec:
 *   {family, variant, inspired_by, canon, facts, lateFacts, rules, plan, expect, mentioned, answers, worldOnly,
 *    predicates, paraphrases, contrast?}
 * `canon` is the canonical (verification) IR; `plan` tells the realizer what the message says:
 *   {clauses: [{canon, past?}], certainty, speaker, question, assumed: [{canon, basis}]}
 * Clause i becomes surface `stated[i]`; `plan.assumed` become surface `assumed`; the question becomes the
 * surface query. Families are grounded in the mined inventory: status balance, proof depth and negation
 * (ProofWriter), paraphrase and high-overlap contrast (QQP/PAWS), ambiguity (AmbigNQ), declarative claims
 * (QA2D), plus the operator families (joins, temporal, boundaries, filters, count, constraints), six of the seven
 * formerly blocked families (formalized like any other message) and `unclear`. Universal questions, question
 * words and interpretation assumptions live in families-questions.mjs.
 */
import { PREDICATES } from './domains.mjs';
import { canonical, emptyCanon } from './ir.mjs';

const EXCLUDED = new Set(['caused_outage', 'wants_to_move', 'plans_to_leave', 'commutes_by', 'pays_with', 'closed_for', 'delayed_by', 'sick_from', 'quit_over']);
// Authored-only predicates (families-expansion.mjs) have no generated forms; generic families never draw them.
const isBinary = id => PREDICATES[id].roles.length === 2 && !EXCLUDED.has(id) && !PREDICATES[id].authored;
/** Predicates the generic families draw from. The main corpus excludes the out-of-distribution domains; the OOD
 * suite uses only them (`usePredicatePool('ood')`), or the predicates with held-out constructions
 * (`usePredicatePool('ood_construction')`). A live binding, so every family sees the current pool. */
export let binary = Object.keys(PREDICATES).filter(id => isBinary(id) && !PREDICATES[id].ood);
export let poolName = 'main';
export function usePredicatePool(name) {
  poolName = name;
  // `ood_construction`: in-distribution predicates that have held-out constructions (domains.mjs HELDOUT_CONSTRUCTIONS).
  const inPool = id => name === 'ood' ? PREDICATES[id].ood : name === 'ood_construction' ? !PREDICATES[id].ood && ['en', 'ro'].every(l => PREDICATES[id][l].some(c => c.oodOnly)) : !PREDICATES[id].ood;
  binary = Object.keys(PREDICATES).filter(id => isBinary(id) && inPool(id));
}
const UNARY_CHAIN = ['trained', 'certified', 'authorized', 'eligible', 'vaccinated'];
export const VAR = { id: '?x' };

export function fill(k, relation, fixed = {}) {
  const bindings = {};
  for (const [role, type] of PREDICATES[relation].roles) bindings[role] = fixed[role] ?? k.world.make(type, { role });
  return bindings;
}
export const where = p => ({ relation: p.relation, args: p.args, negated: p.polarity === 'negated' });
export const entities = bindings => Object.values(bindings).filter(value => value && typeof value === 'object' && value.id && !value.id.startsWith('?'));
export const date = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const firstRole = relation => PREDICATES[relation].roles[0][0];
export const base = (family, variant, inspired_by, extra) => ({ family, variant, inspired_by, facts: [], lateFacts: [], rules: [], answers: [], worldOnly: [], paraphrases: 1, ...extra });

// ---------------------------------------------------------------- lookup (ProofWriter status balance)
export function lookup(k) {
  const relation = k.random.pick(binary);
  const bindings = fill(k, relation);
  const status = k.random.weighted([['supported', 4], ['refuted', 3], ['unknown', 4]]);
  const asked = canonical(relation, bindings);
  const facts = status === 'supported' ? [asked] : status === 'refuted' ? [canonical(relation, bindings, { polarity: 'negated' })] : [];
  facts.push(canonical(relation, fill(k, relation, { [firstRole(relation)]: bindings[firstRole(relation)] })));
  const canon = emptyCanon();
  canon.query = { ask: 'whether', where: [where(asked)] };
  return base('lookup', status, ['proofwriter', 'qqp'], { canon, facts, plan: { clauses: [], question: { ask: 'whether', prop: asked } }, expect: status,
    mentioned: entities(bindings), predicates: [relation], paraphrases: k.random.pick([1, 2, 2]),
    contrast: status === 'supported' && k.random.chance(0.5) ? () => roleSwapContrast(k, relation, bindings, facts) : null });
}
/** PAWS-style high-overlap contrast: the same words with the arguments swapped. */
function roleSwapContrast(k, relation, bindings, facts) {
  const [a, b] = PREDICATES[relation].roles;
  if (a[1] !== b[1]) return null;
  const asked = canonical(relation, { [a[0]]: bindings[b[0]], [b[0]]: bindings[a[0]] });
  const canon = emptyCanon();
  canon.query = { ask: 'whether', where: [where(asked)] };
  return base('contrast', 'argument_swap', ['paws'], { canon, facts, plan: { clauses: [], question: { ask: 'whether', prop: asked } }, expect: 'unknown', mentioned: entities(bindings), predicates: [relation], sameFrames: true });
}

// ---------------------------------------------------------------- wh selection and count
function selection(k, family, ask) {
  const relation = k.random.pick(ask === 'count' ? binary.filter(id => !PREDICATES[id].noCount) : binary);
  const roles = PREDICATES[relation].roles;
  const focusIndex = k.random.int(2);
  const [focus, focusType] = roles[focusIndex], [fixedRole, fixedType] = roles[1 - focusIndex];
  const fixed = k.world.make(fixedType, { role: fixedRole });
  const answers = Array.from({ length: ask === 'count' ? 1 + k.random.int(4) : k.random.weighted([[1, 5], [2, 3], [3, 1]]) }, () => k.world.make(focusType, { role: focus }));
  const facts = answers.map(answer => canonical(relation, { [focus]: answer, [fixedRole]: fixed }));
  const decoy = fill(k, relation);
  facts.push(canonical(relation, decoy));
  const asked = canonical(relation, { [focus]: VAR, [fixedRole]: fixed });
  const canon = emptyCanon();
  canon.query = { ask, select: ['?x'], where: [where(asked)] };
  return base(family, `${focus}_${PREDICATES[relation].domain}`, ['qa2d', 'qqp'], { canon, facts, plan: { clauses: [], question: { ask, prop: asked, focus } }, expect: 'supported',
    mentioned: [fixed], answers, worldOnly: entities(decoy), predicates: [relation], paraphrases: k.random.pick([1, 2, 2, 3]) });
}
export const whSelect = k => selection(k, 'wh_select', 'which');
export const count = k => selection(k, 'count', 'count');

// ---------------------------------------------------------------- filter (besides X)
export function filter(k) {
  const relation = k.random.pick(binary.filter(id => PREDICATES[id].roles[0][1] === 'person'));
  const [[focus, focusType], [fixedRole, fixedType]] = PREDICATES[relation].roles;
  const fixed = k.world.make(fixedType, { role: fixedRole }), excluded = k.world.make(focusType, { role: focus });
  const answers = Array.from({ length: 1 + k.random.int(2) }, () => k.world.make(focusType, { role: focus }));
  const facts = [excluded, ...answers].map(entity => canonical(relation, { [focus]: entity, [fixedRole]: fixed }));
  const asked = canonical(relation, { [focus]: VAR, [fixedRole]: fixed });
  const canon = emptyCanon();
  canon.query = { ask: 'which', select: ['?x'], where: [where(asked)], filter: [`?x != "${excluded.id}"`] };
  return base('filter', 'besides', ['qqp'], { canon, facts, plan: { clauses: [], question: { ask: 'which', prop: asked, focus, exclude: excluded } }, expect: 'supported',
    mentioned: [fixed, excluded], answers, predicates: [relation], paraphrases: k.random.pick([1, 2]) });
}

// ---------------------------------------------------------------- joins (authored texts with their propositions)
export const P = (relation, roles, polarity = 'affirmed') => ({ relation, roles, polarity });
const JOINS = [
  { id: 'employee_of_company_in_town', legs: ['works_at', 'located_in'], select: true,
    build: k => ({ town: k.world.make('city'), company: k.world.make('company'), answer: k.world.make('person') }),
    facts: s => [canonical('works_at', { employee: s.answer, employer: s.company }), canonical('located_in', { site: s.company, town: s.town })],
    where: s => [{ relation: 'works_at', args: ['?x', '?c'], negated: false }, { relation: 'located_in', args: ['?c', s.town.id], negated: false }],
    texts: { en: [['Who works at a company in {town}?', t => [P('work at', [['subject', '?x'], ['object', '?c']]), P('be in', [['subject', '?c'], ['location', t.town]])]],
      ['Which people are employed by a firm based in {town}?', t => [P('be employed by', [['subject', '?x'], ['object', '?c']]), P('be based in', [['subject', '?c'], ['location', t.town]])]],
      ['Name the people working for companies located in {town}.', t => [P('work for', [['subject', '?x'], ['object', '?c']]), P('be located in', [['subject', '?c'], ['location', t.town]])]]],
      ro: [['Cine lucrează la o firmă din {town}?', t => [P('lucra la', [['subject', '?x'], ['object', '?c']]), P('fi în', [['subject', '?c'], ['location', t.town]])]],
        ['Ce oameni sunt angajați la o companie cu sediul în {town}?', t => [P('fi angajat la', [['subject', '?x'], ['object', '?c']]), P('avea sediul în', [['subject', '?c'], ['location', t.town]])]]] } },
  { id: 'grandparents', legs: ['parent_of'], select: true,
    build: k => ({ child: k.world.make('person'), middle: k.world.make('person'), answer: k.world.make('person') }),
    facts: s => [canonical('parent_of', { parent: s.answer, child: s.middle }), canonical('parent_of', { parent: s.middle, child: s.child })],
    where: s => [{ relation: 'parent_of', args: ['?x', '?m'], negated: false }, { relation: 'parent_of', args: ['?m', s.child.id], negated: false }],
    // "Grandparents" would be decomposed into two parent legs by the model (a paraphrase); only literal compositions are asked.
    texts: { en: [['Who is a parent of a parent of {child}?', t => [P('be a parent of', [['subject', '?x'], ['object', '?m']]), P('be a parent of', [['subject', '?m'], ['object', t.child]])]],
      ['Who is a parent of one of the parents of {child}?', t => [P('be a parent of', [['subject', '?x'], ['object', '?m']]), P('be a parent of', [['subject', '?m'], ['object', t.child]])]]],
      ro: [['Cine e părintele unui părinte al lui {child}?', t => [P('fi părintele lui', [['subject', '?x'], ['object', '?m']]), P('fi părintele lui', [['subject', '?m'], ['object', t.child]])]],
        ['Cine e părintele unuia dintre părinții lui {child}?', t => [P('fi părintele lui', [['subject', '?x'], ['object', '?m']]), P('fi părintele lui', [['subject', '?m'], ['object', t.child]])]]] } },
  { id: 'doctor_of_allergic', legs: ['treats', 'allergic_to'], select: true,
    build: k => ({ allergen: k.world.make('substance'), patient: k.world.make('person'), answer: k.world.make('person') }),
    facts: s => [canonical('treats', { doctor: s.answer, patient: s.patient }), canonical('allergic_to', { person: s.patient, allergen: s.allergen })],
    where: s => [{ relation: 'treats', args: ['?x', '?p'], negated: false }, { relation: 'allergic_to', args: ['?p', s.allergen.id], negated: false }],
    texts: { en: [['Which doctors treat someone who is allergic to {allergen}?', t => [P('treat', [['subject', '?x'], ['object', '?p']]), P('be allergic to', [['subject', '?p'], ['object', t.allergen]])]],
      ['Who treats a patient with an allergy to {allergen}?', t => [P('treat', [['subject', '?x'], ['object', '?p']]), P('have an allergy to', [['subject', '?p'], ['object', t.allergen]])]]],
      ro: [['Ce medici tratează pe cineva alergic la {allergen}?', t => [P('trata', [['subject', '?x'], ['object', '?p']]), P('fi alergic la', [['subject', '?p'], ['object', t.allergen]])]]] } },
  { id: 'coach_of_players_team', legs: ['coaches', 'plays_for'], select: true,
    build: k => ({ player: k.world.make('person'), team: k.world.make('team'), answer: k.world.make('person') }),
    facts: s => [canonical('coaches', { coach: s.answer, team: s.team }), canonical('plays_for', { player: s.player, team: s.team })],
    where: s => [{ relation: 'coaches', args: ['?x', '?t'], negated: false }, { relation: 'plays_for', args: [s.player.id, '?t'], negated: false }],
    texts: { en: [['Who coaches the team {player} plays for?', t => [P('coach', [['subject', '?x'], ['object', '?t']]), P('play for', [['subject', t.player], ['object', '?t']])]],
      ['Which coach trains the team that {player} is on?', t => [P('train', [['subject', '?x'], ['object', '?t']]), P('be on', [['subject', t.player], ['object', '?t']])]]],
      ro: [['Cine antrenează echipa la care joacă {player}?', t => [P('antrena', [['subject', '?x'], ['object', '?t']]), P('juca la', [['subject', t.player], ['object', '?t']])]]] } },
  { id: 'manager_lives_in', legs: ['manages', 'lives_in'], select: false,
    build: k => ({ manager: k.world.make('person'), town: k.world.make('city'), report: k.world.make('person') }),
    facts: s => [canonical('manages', { manager: s.manager, report: s.report }), canonical('lives_in', { resident: s.report, town: s.town })],
    where: s => [{ relation: 'manages', args: [s.manager.id, '?r'], negated: false }, { relation: 'lives_in', args: ['?r', s.town.id], negated: false }],
    texts: { en: [['Does {manager} manage anyone who lives in {town}?', t => [P('manage', [['subject', t.manager], ['object', '?r']]), P('live in', [['subject', '?r'], ['location', t.town]])]],
      ['Is anyone who reports to {manager} based in {town}?', t => [P('report to', [['subject', '?r'], ['object', t.manager]]), P('be based in', [['subject', '?r'], ['location', t.town]])]]],
      ro: [['{manager} coordonează pe cineva care locuiește în {town}?', t => [P('coordona', [['subject', t.manager], ['object', '?r']]), P('locui în', [['subject', '?r'], ['location', t.town]])]]] } },
];
export function join(k) {
  const spec = k.random.pick(JOINS);
  const slots = spec.build(k);
  const canon = emptyCanon();
  canon.query = spec.select ? { ask: 'which', select: ['?x'], where: spec.where(slots) } : { ask: 'whether', where: spec.where(slots) };
  const hidden = ['company', 'middle', 'patient', 'team', 'report'];
  return base('join', spec.id, ['qa2d', 'proofwriter'], { canon, facts: spec.facts(slots), plan: { clauses: [], question: { custom: spec.texts, slots, ask: canon.query.ask, id: `join.${spec.id}` } },
    expect: 'supported', mentioned: Object.entries(slots).filter(([name]) => name !== 'answer' && !hidden.includes(name)).map(([, e]) => e),
    answers: slots.answer ? [slots.answer] : [], worldOnly: Object.entries(slots).filter(([name]) => hidden.includes(name)).map(([, e]) => e), predicates: [...new Set(spec.legs)] });
}

// ---------------------------------------------------------------- temporal (at / during / boundaries / stated intervals)
export function temporal(k) {
  const relation = k.random.pick(['works_at', 'lives_in', 'plays_for', 'coaches', 'manages', 'studies_at', 'maintains', 'married_to']);
  const bindings = fill(k, relation);
  const y = 2018 + k.random.int(5), m = 1 + k.random.int(12);
  const from = date(y, m, 1), until = date(y + 2 + k.random.int(3), 1 + k.random.int(12), 1);
  const facts = [canonical(relation, bindings, { time: { from, until } })];
  const variant = k.random.weighted([['at_inside', 3], ['at_inclusive_start', 2], ['at_exclusive_end', 2], ['at_before', 2], ['during_year', 2], ['stated_interval', 3]]);
  const asked = canonical(relation, bindings);
  const canon = emptyCanon();
  const q = (extra, time) => { canon.query = { ask: 'whether', where: [where(asked)], ...extra }; return { ask: 'whether', prop: asked, past: true, time }; };
  let question, expect = 'supported';
  if (variant === 'at_inside') { const at = date(y + 1, 1 + k.random.int(12), 1 + k.random.int(27)); question = q({ at }, { at }); }
  if (variant === 'at_inclusive_start') question = q({ at: from }, { at: from });
  if (variant === 'at_exclusive_end') { question = q({ at: until }, { at: until }); expect = 'unknown'; }
  if (variant === 'at_before') { const at = date(y - 1, 1 + k.random.int(12), 1 + k.random.int(27)); question = q({ at }, { at }); expect = 'unknown'; }
  if (variant === 'during_year') { const during = [date(y + 1, 1, 1), date(y + 2, 1, 1)]; question = q({ during }, { during }); }
  if (variant === 'stated_interval') {
    const statedProp = canonical(relation, bindings, { time: { from, until } });
    canon.stated.push({ ...statedProp, certainty: 'asserted' });
    const at = k.random.chance(0.5) ? until : from;
    question = q({ at }, { at }); question.pronoun = true;
    return base('temporal', `stated_interval_${at === until ? 'end' : 'start'}`, ['ambignq', 'proofwriter'], { canon, plan: { clauses: [{ canon: statedProp }], certainty: 'asserted', question }, expect: at === until ? 'unknown' : 'supported', mentioned: entities(bindings), predicates: [relation] });
  }
  return base('temporal', variant, ['ambignq', 'squad'], { canon, facts, plan: { clauses: [], question }, expect, mentioned: entities(bindings), predicates: [relation], paraphrases: k.random.pick([1, 2]) });
}

// ---------------------------------------------------------------- attached statements (stated + query)
export function attached(k) {
  const relation = k.random.pick(binary);
  const bindings = fill(k, relation);
  const certainty = k.random.weighted([['asserted', 6], ['hedged', 2], ['supposed', 2]]);
  const speaker = certainty === 'asserted' && k.random.chance(0.25) ? k.world.make('person') : null;
  const s = canonical(relation, bindings);
  const canon = emptyCanon();
  canon.stated.push({ ...s, certainty, ...(speaker ? { speaker: speaker.id } : {}) });
  const variant = k.random.weighted([['same', 3], ['other_filler', 3]]);
  const [[r0, t0], [r1]] = PREDICATES[relation].roles;
  let question, expect = 'supported';
  const extra = [];
  if (variant === 'same') { question = { ask: 'whether', prop: s, pronoun: true }; canon.query = { ask: 'whether', where: [where(s)] }; }
  if (variant === 'other_filler') { const other = k.world.make(t0, { role: r0 }); const q = canonical(relation, { ...bindings, [r0]: other }); question = { ask: 'whether', prop: q }; canon.query = { ask: 'whether', where: [where(q)] }; expect = 'unknown'; extra.push(other); }
  if (variant === 'wh_other_role') { const q = canonical(relation, { [r0]: VAR, [r1]: bindings[r1] }); question = { ask: 'which', prop: q, focus: r0 }; canon.query = { ask: 'which', select: ['?x'], where: [where(q)] }; }
  return base('attached', `${certainty}${speaker ? '_speaker' : ''}_${variant}`, ['qqp', 'qa2d'], { canon, plan: { clauses: [{ canon: s }], certainty, speaker, question }, expect,
    mentioned: [...entities(bindings), ...extra, ...(speaker ? [speaker] : [])], predicates: [relation], paraphrases: k.random.pick([1, 2]),
    contrast: certainty === 'asserted' && !speaker && variant === 'same' && k.random.chance(0.5) ? () => negationContrast(relation, bindings) : null });
}
/** PAWS-style minimal pair: the statement is negated, the question is the same. */
function negationContrast(relation, bindings) {
  const s = canonical(relation, bindings, { polarity: 'negated' }), asked = canonical(relation, bindings);
  const canon = emptyCanon();
  canon.stated.push({ ...s, certainty: 'asserted' });
  canon.query = { ask: 'whether', where: [where(asked)] };
  return base('contrast', 'negated_statement', ['paws'], { canon, plan: { clauses: [{ canon: s }], certainty: 'asserted', question: { ask: 'whether', prop: asked, pronoun: true } }, expect: 'refuted', mentioned: entities(bindings), predicates: [relation], sameFrames: true });
}

// ---------------------------------------------------------------- negation
export function negation(k) {
  const relation = k.random.pick(binary);
  const bindings = fill(k, relation);
  const variant = k.random.pick(['negative_query_supported', 'negative_query_unknown', 'denied_in_world']);
  const positive = canonical(relation, bindings), negative = canonical(relation, bindings, { polarity: 'negated' });
  const canon = emptyCanon();
  if (variant === 'denied_in_world') {
    canon.query = { ask: 'whether', where: [where(positive)] };
    return base('negation', variant, ['proofwriter'], { canon, facts: [negative], plan: { clauses: [], question: { ask: 'whether', prop: positive } }, expect: 'refuted', mentioned: entities(bindings), predicates: [relation], paraphrases: k.random.pick([1, 2]) });
  }
  canon.query = { ask: 'whether', where: [where(negative)] };
  return base('negation', variant, ['paws', 'proofwriter'], { canon, facts: variant === 'negative_query_supported' ? [negative] : [], plan: { clauses: [], question: { ask: 'whether', prop: negative } },
    expect: variant === 'negative_query_supported' ? 'supported' : 'unknown', mentioned: entities(bindings), predicates: [relation], paraphrases: k.random.pick([1, 2]) });
}

// ---------------------------------------------------------------- closure and world assumptions
export function closureAssumption(k) {
  const relation = k.random.pick(['attended', 'borrowed', 'certified', 'trained', 'vaccinated', 'travelled_to', 'allergic_to']);
  const roles = PREDICATES[relation].roles;
  const shared = roles.length === 2 ? k.world.make(roles[1][1]) : null;
  const listed = Array.from({ length: 2 + k.random.int(2) }, () => k.world.make(roles[0][1]));
  const asked = k.world.make(roles[0][1]);
  const binding = person => roles.length === 2 ? { [roles[0][0]]: person, [roles[1][0]]: shared } : { [roles[0][0]]: person };
  const canon = emptyCanon();
  const clauses = listed.map(person => ({ canon: canonical(relation, binding(person)) }));
  for (const c of clauses) canon.stated.push({ ...c.canon, certainty: 'asserted' });
  const closure = canonical(relation, binding(asked), { polarity: 'negated' });
  canon.assumed.push({ ...closure, basis: 'closure' });
  canon.query = { ask: 'whether', where: [where(closure)] };
  return base('closure_assumption', PREDICATES[relation].domain, ['proofwriter'], { canon, plan: { clauses, certainty: 'asserted', question: { ask: 'whether', prop: closure }, assumed: [{ canon: closure, basis: 'closure' }] },
    expect: 'unknown', mentioned: [...listed, asked, ...(shared ? [shared] : [])], predicates: [relation] });
}
const STILL = {
  works_at: { en: [['Does {S} still work at {O}?', 'work at', 'object'], ['Is {S} still employed by {O}?', 'be employed by', 'object']], ro: [['{S} mai lucrează la {O}?', 'lucra la', 'object'], ['{S} încă lucrează la {O}?', 'lucra la', 'object']] },
  lives_in: { en: [['Does {S} still live in {O}?', 'live in', 'location']], ro: [['{S} mai locuiește în {O}?', 'locui în', 'location'], ['{S} încă stă în {O}?', 'sta în', 'location']] },
  plays_for: { en: [['Is {S} still playing for {O}?', 'play for', 'object']], ro: [['{S} mai joacă la {O}?', 'juca la', 'object']] },
};
/** "Is Ana *still* at Acme?" presupposes an earlier state the user did not assert: an `implicature` assumption. */
function implicatureAssumption(k) {
  const relation = k.random.pick(Object.keys(STILL));
  const bindings = fill(k, relation);
  const [[r0], [r1]] = PREDICATES[relation].roles;
  const earlier = canonical(relation, bindings);
  const canon = emptyCanon();
  // "Still" presupposes that the state held before now; the assumption is that earlier state, not the asked present one.
  // The presupposition is stated without a time: the message names none (DS014 presupposition convention).
  canon.assumed.push({ ...earlier, basis: 'implicature' });
  canon.query = { ask: 'whether', where: [where(earlier)] };
  const custom = Object.fromEntries(['en', 'ro'].map(language => [language, STILL[relation][language].map(([text, rel, orole]) => [text, t => [P(rel, [['subject', t.S], [orole, t.O]])]])]));
  return base('world_assumption', 'implicature_still', ['ambignq'], { canon, facts: k.random.chance(0.5) ? [earlier] : [],
    plan: { clauses: [], question: { custom, slots: { S: bindings[r0], O: bindings[r1] }, ask: 'whether', id: `still.${relation}` }, assumed: [{ canon: earlier, basis: 'implicature' }] },
    expect: null, mentioned: entities(bindings), predicates: [relation] });
}
export function worldAssumption(k) {
  if (k.random.chance(0.4)) return implicatureAssumption(k);
  // Only relations that are asymmetric by their meaning: supply and dependency can be mutual.
  const relation = k.random.pick(['manages', 'parent_of']);
  const [[r0], [r1]] = PREDICATES[relation].roles;
  const bindings = fill(k, relation);
  const s = canonical(relation, bindings);
  const reversed = { [r0]: bindings[r1], [r1]: bindings[r0] };
  const assumption = canonical(relation, reversed, { polarity: 'negated' });
  const canon = emptyCanon();
  canon.stated.push({ ...s, certainty: 'asserted' });
  canon.assumed.push({ ...assumption, basis: 'world' });
  const q = canonical(relation, reversed);
  canon.query = { ask: 'whether', where: [where(q)] };
  return base('world_assumption', PREDICATES[relation].domain, ['paws', 'proofwriter'], { canon, plan: { clauses: [{ canon: s }], certainty: 'asserted', question: { ask: 'whether', prop: q }, assumed: [{ canon: assumption, basis: 'world', reuse: 'stated' }] },
    expect: 'unknown', mentioned: entities(bindings), predicates: [relation] });
}

// ---------------------------------------------------------------- rule depth (ProofWriter)
export function proofDepth(k) {
  const chain = k.random.shuffle(UNARY_CHAIN).slice(0, 4);
  const depth = k.random.weighted([[0, 3], [1, 4], [2, 3], [3, 2]]);
  const person = k.world.make('person');
  const status = k.random.weighted([['supported', 4], ['refuted', 2], ['unknown', 3]]);
  const rules = [];
  for (let i = 0; i < depth; i++) {
    rules.push({ when: [`${chain[i]} ?x`], then: `${chain[i + 1]} ?x` });
    if (status === 'refuted') rules.push({ when: [`not ${chain[i]} ?x`], then: `not ${chain[i + 1]} ?x` });
  }
  const baseFact = canonical(chain[0], { [firstRole(chain[0])]: person }, { polarity: status === 'refuted' ? 'negated' : 'affirmed' });
  const target = canonical(chain[depth], { [firstRole(chain[depth])]: person });
  const userStates = k.random.chance(0.5) && status !== 'unknown' && depth > 0;
  const canon = emptyCanon();
  if (userStates) canon.stated.push({ ...baseFact, certainty: 'asserted' });
  canon.query = { ask: 'whether', where: [where(target)] };
  const facts = status === 'unknown' || userStates ? [] : [baseFact];
  if (status === 'unknown') facts.push(canonical(chain[3], { [firstRole(chain[3])]: k.world.make('person') }));
  return base('proof_depth', `depth_${depth}_${status}`, ['proofwriter'], { depth, canon, facts, rules, plan: { clauses: userStates ? [{ canon: baseFact }] : [], certainty: 'asserted', question: { ask: 'whether', prop: target, pronoun: userStates } },
    expect: status, mentioned: [person], predicates: [...new Set([...chain, chain[depth]])] });
}

// ---------------------------------------------------------------- ambiguity (AmbigNQ): entity reference and time dependency
/** Two entities that share a short name and differ by a location or event qualifier (AmbigNQ location and
 * event qualifiers). Returns [first, second] with `sharedAlias` set; the full labels carry the qualifier. */
const SHARED = [
  { type: 'clinic', en: ['Riverside Medical Centre', t => `the Riverside Medical Centre in ${t}`], ro: ['Centrul Medical Riverside', t => `Centrul Medical Riverside din ${t}`], qualifier: 'location_qualifier' },
  { type: 'school', en: ['Saint Andrew High School', t => `Saint Andrew High School in ${t}`], ro: ['Liceul Sfântul Andrei', t => `Liceul Sfântul Andrei din ${t}`], qualifier: 'location_qualifier' },
  { type: 'event', en: ['the book fair', t => `the ${t} book fair`], ro: ['târgul de carte', t => `târgul de carte de ${t}`], qualifier: 'event_qualifier', seasons: [['spring', 'primăvară'], ['autumn', 'toamnă'], ['winter', 'iarnă']] },
  { type: 'event', en: ['the chess tournament', t => `the ${t} chess tournament`], ro: ['turneul de șah', t => `turneul de șah de ${t}`], qualifier: 'event_qualifier', seasons: [['junior', 'juniori'], ['open', 'open'], ['regional', 'regional']] },
];
function sharedPair(k) {
  const sc = k.random.pick(SHARED);
  const make = index => {
    let en, ro;
    if (sc.seasons) { const [e, r] = sc.seasons[index]; en = sc.en[1](e); ro = sc.ro[1](r); }
    else { const town = k.world.place(); en = sc.en[1](town); ro = sc.ro[1](town); }
    return k.world.add({ id: slugOf(en), type: sc.type, gender: sc.type === 'event' ? 'm' : /^(Clinica|Centrul)/.test(ro) ? 'm' : 'n', labels: { en, ro }, short: null, sharedAlias: { en: sc.en[0], ro: sc.ro[0] } });
  };
  return { sc, pair: [make(0), make(1)] };
}
const slugOf = text => text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const SENSE = { en: [['Who made {work}?', 'make'], ['Do you know who made {work}?', 'make']], ro: [['Cine a făcut {work}?', 'face'], ['Știi cine a făcut {work}?', 'face']] };

export function ambiguity(k) {
  // Predicate-sense ambiguity lives in the interpretation family, where the model also states its reading.
  const variant = k.random.weighted([['entity_reference', 2], ['entity_reference_resolved', 1], ['time_dependency', 2], ['time_resolved', 1], ['qualifier', 2], ['qualifier_resolved', 2]]);
  const canon = emptyCanon();
  if (variant.startsWith('qualifier')) {
    const { sc, pair } = sharedPair(k);
    const person = k.world.make('person');
    const relation = sc.type === 'event' ? 'attended' : sc.type === 'school' ? 'studies_at' : 'works_at';
    const [r0, r1] = PREDICATES[relation].roles.map(([role]) => role);
    const facts = [canonical(relation, { [r0]: person, [r1]: pair[0] })];
    const asked = canonical(relation, { [r0]: person, [r1]: pair[0] });
    const resolved = variant === 'qualifier_resolved';
    canon.query = { ask: 'whether', where: [resolved ? where(asked) : { relation, args: [person.id, JSON.stringify(sc.en[0])], negated: false }] };
    return base('ambiguity', `${sc.qualifier}${resolved ? '_resolved' : ''}`, ['ambignq'], { canon, facts, plan: { clauses: [], question: { ask: 'whether', prop: asked, past: sc.type === 'event' }, styles: { [pair[0].id]: resolved ? 'short' : 'alias' } },
      expect: resolved ? 'supported' : 'clarify', mentioned: [person, pair[0]], worldOnly: [pair[1]], predicates: [relation], ambiguousMention: resolved ? null : '*shared*' });
  }
  if (variant === 'predicate_sense') {
    const work = k.world.make('work'), author = k.world.make('person'), publisher = k.world.make('company');
    const facts = [canonical('wrote', { author, work }), canonical('published', { publisher, work })];
    canon.query = { ask: 'which', select: ['?x'], where: [{ relation: 'wrote', args: ['?x', work.id], negated: false }] };
    const custom = Object.fromEntries(['en', 'ro'].map(language => [language, SENSE[language].map(([text, rel]) => [text, t => [P(rel, [['subject', '?x'], ['object', t.work]])]])]));
    return base('ambiguity', 'property_or_role', ['ambignq'], { canon, facts, plan: { clauses: [], question: { custom, slots: { work }, ask: 'which', id: 'sense.make' } },
      expect: 'clarify', mentioned: [work], worldOnly: [author, publisher], predicates: ['wrote', 'published'], senseAmbiguous: true });
  }
  if (variant.startsWith('entity_reference')) {
    const relation = k.random.pick(['works_at', 'lives_in', 'plays_for', 'studies_at']);
    const [[r0], [r1, t1]] = PREDICATES[relation].roles;
    const first = k.world.make('person'), second = k.world.person({ first: first.short }), place = k.world.make(t1, { role: r1 });
    const facts = [canonical(relation, { [r0]: first, [r1]: place }), canonical(relation, { [r0]: second, [r1]: k.world.make(t1, { role: r1 }) })];
    const asked = canonical(relation, { [r0]: first, [r1]: place });
    const resolved = variant === 'entity_reference_resolved';
    canon.query = { ask: 'whether', where: [resolved ? where(asked) : { relation, args: [JSON.stringify(first.short), place.id], negated: false }] };
    return base('ambiguity', variant, ['ambignq'], { canon, facts, plan: { clauses: [], question: { ask: 'whether', prop: asked }, styles: { [first.id]: resolved ? 'full' : 'short' } },
      expect: resolved ? 'supported' : 'clarify', mentioned: [first, place], worldOnly: [second], predicates: [relation], ambiguousMention: resolved ? null : first.short });
  }
  const relation = k.random.pick(['coaches', 'manages', 'maintains']);
  const [[r0, t0], [r1, t1]] = PREDICATES[relation].roles;
  const fixed = k.world.make(t1, { role: r1 }), early = k.world.make(t0, { role: r0 }), late = k.world.make(t0, { role: r0 });
  const facts = [canonical(relation, { [r0]: early, [r1]: fixed }, { time: { from: '2018-01-01', until: '2022-01-01' } }), canonical(relation, { [r0]: late, [r1]: fixed }, { time: { from: '2022-01-01' } })];
  const asked = canonical(relation, { [r0]: VAR, [r1]: fixed });
  if (variant === 'time_dependency') {
    canon.query = { ask: 'which', select: ['?x'], where: [where(asked)] };
    return base('ambiguity', variant, ['ambignq'], { canon, facts, plan: { clauses: [], question: { ask: 'which', prop: asked, focus: r0, past: false } }, expect: 'supported', mentioned: [fixed], answers: [late], worldOnly: [early], predicates: [relation] });
  }
  const year = 2019 + k.random.int(3), during = [date(year, 1, 1), date(year + 1, 1, 1)];
  canon.query = { ask: 'which', select: ['?x'], where: [where(asked)], during };
  return base('ambiguity', variant, ['ambignq'], { canon, facts, plan: { clauses: [], question: { ask: 'which', prop: asked, focus: r0, past: true, time: { during } } }, expect: 'supported', mentioned: [fixed], answers: [early], worldOnly: [late], predicates: [relation] });
}

// ---------------------------------------------------------------- claim check (QA2D direction reversed: a declarative to verify is a query)
export function claimCheck(k) {
  const relation = k.random.pick(binary);
  const bindings = fill(k, relation);
  const status = k.random.weighted([['supported', 2], ['refuted', 1], ['unknown', 2]]);
  const negatedClaim = k.random.chance(0.35);
  const p = canonical(relation, bindings, { polarity: negatedClaim ? 'negated' : 'affirmed' });
  const opposite = canonical(relation, bindings, { polarity: negatedClaim ? 'affirmed' : 'negated' });
  const canon = emptyCanon();
  canon.query = { ask: 'whether', where: [where(p)] };
  return base('claim_check', `${negatedClaim ? 'negated_' : ''}${status}`, ['qa2d'], { canon, facts: status === 'supported' ? [p] : status === 'refuted' ? [opposite] : [],
    plan: { clauses: [], question: { ask: 'whether', prop: p, claimCheck: true } }, expect: status, mentioned: entities(bindings), predicates: [relation] });
}

// ---------------------------------------------------------------- statements only (no question; the model states and asks nothing)
export function statementOnly(k) {
  const relation = k.random.pick(binary);
  const n = 1 + k.random.int(2);
  const canon = emptyCanon();
  const clauses = [], mentioned = [];
  for (let i = 0; i < n; i++) {
    const bindings = fill(k, relation);
    const p = canonical(relation, bindings, { polarity: k.random.chance(0.2) ? 'negated' : 'affirmed' });
    canon.stated.push({ ...p, certainty: 'asserted' });
    clauses.push({ canon: p });
    mentioned.push(...entities(bindings));
  }
  return base('statement_only', `${n}_statements`, ['qa2d'], { canon, plan: { clauses, certainty: 'asserted', question: null }, expect: 'stated', mentioned, predicates: [relation] });
}

// ---------------------------------------------------------------- finite constraints
// Every bound in a target is stated in the message (counts start at 0), so the model never invents a number.
const CONSTRAINTS = [
  { id: 'capacity_possible', task: 'possible', make: r => { const lo = 2 + r.int(4), hi = lo + 4 + r.int(8), n = lo + r.int(hi - lo + 1); return { vars: [['?x', lo, hi]], require: [], claim: `?x == ${n}`, n: { lo, hi, k: n }, expect: 'possible' }; },
    text: { en: ['The room fits between {lo} and {hi} people. Could exactly {k} of us fit?', 'A group of {lo} to {hi} guests is expected. Is it possible that {k} come?', 'The bus takes {lo} to {hi} passengers. Can exactly {k} ride?'], ro: ['Sala are loc pentru {lo} până la {hi} oameni. Putem fi exact {k}?', 'Se așteaptă între {lo} și {hi} invitați. E posibil să vină {k}?', 'Autobuzul ia între {lo} și {hi} pasageri. Pot merge exact {k}?'] } },
  { id: 'capacity_impossible', task: 'possible', make: r => { const lo = 2 + r.int(4), hi = lo + 3 + r.int(6), n = hi + 1 + r.int(5); return { vars: [['?x', lo, hi]], require: [], claim: `?x == ${n}`, n: { lo, hi, k: n }, expect: 'impossible' }; },
    text: { en: ['The van seats between {lo} and {hi} people. Can {k} people fit in it?', 'Each table takes {lo} to {hi} guests. Could one table seat {k}?'], ro: ['Duba are între {lo} și {hi} locuri. Încap {k} oameni?', 'La o masă stau între {lo} și {hi} invitați. Pot sta {k} la o masă?'] } },
  { id: 'below_possible', task: 'possible', make: r => { const lo = 1 + r.int(4), hi = lo + 5 + r.int(8), n = lo + 1 + r.int(3); return { vars: [['?x', lo, hi]], require: [], claim: `?x < ${n}`, n: { lo, hi, k: n }, expect: 'possible' }; },
    text: { en: ['A shift needs between {lo} and {hi} nurses. Could fewer than {k} be on duty?', 'The course runs with {lo} to {hi} students. Is it possible to have fewer than {k}?'], ro: ['O tură are nevoie de {lo} până la {hi} asistente. Pot fi mai puțin de {k} de serviciu?', 'Cursul merge cu {lo} până la {hi} studenți. E posibil să fie sub {k}?'] } },
  { id: 'minimum_entailed', task: 'prove', make: r => { const hi = 20 + r.int(20), m = 5 + r.int(8), n = m - 1 - r.int(3); return { vars: [['?x', 0, hi]], require: [`?x >= ${m}`], claim: `?x > ${n}`, n: { hi, m, k: n }, expect: 'entailed' }; },
    text: { en: ['The hall holds at most {hi} people and at least {m} signed up. Does that guarantee more than {k}?', 'We have room for {hi} and a minimum of {m} registrations. Must there be more than {k}?'], ro: ['Sala are cel mult {hi} locuri și s-au înscris cel puțin {m} oameni. Înseamnă sigur că sunt mai mult de {k}?', 'Avem loc pentru {hi} și minimum {m} înscrieri. Trebuie să fie peste {k}?'] } },
  { id: 'minimum_not_entailed', task: 'prove', make: r => { const hi = 20 + r.int(20), m = 3 + r.int(5), n = m + 2 + r.int(5); return { vars: [['?x', 0, hi]], require: [`?x >= ${m}`], claim: `?x > ${n}`, n: { hi, m, k: n }, expect: 'unknown' }; },
    text: { en: ['At most {hi} tickets exist and at least {m} were sold. Is it certain that more than {k} were sold?', 'With at most {hi} orders and a minimum of {m}, must there be over {k}?'], ro: ['Sunt cel mult {hi} bilete și s-au vândut cel puțin {m}. E sigur că s-au vândut peste {k}?', 'Cu cel mult {hi} comenzi și minimum {m}, trebuie să fie peste {k}?'] } },
  { id: 'every_value_above', task: 'prove', make: r => { const lo = 3 + r.int(5), hi = lo + 3 + r.int(6), n = r.chance(0.5) ? lo - 1 - r.int(2) : lo + 1; return { vars: [['?x', lo, hi]], require: [], claim: `?x > ${n}`, n: { lo, hi, k: n }, expect: n < lo ? 'entailed' : 'unknown' }; },
    text: { en: ['Every team has between {lo} and {hi} members. Must a team have more than {k}?', 'A box holds {lo} to {hi} jars. Does every box hold more than {k}?'], ro: ['Fiecare echipă are între {lo} și {hi} membri. Trebuie să aibă o echipă mai mult de {k}?', 'O cutie are între {lo} și {hi} borcane. Are orice cutie peste {k}?'] } },
];
export function constraint(k) {
  const spec = k.random.pick(CONSTRAINTS);
  const made = spec.make(k.random);
  const canon = emptyCanon();
  canon.constraint = { task: spec.task, vars: made.vars, require: made.require, claim: made.claim };
  return base('constraint', spec.id, ['squad'], { canon, plan: { clauses: [], question: { customNumbers: spec.text, numbers: made.n, id: `constraint.${spec.id}` } }, expect: made.expect, mentioned: [], predicates: [] });
}

// ---------------------------------------------------------------- the seven formerly blocked families: formalized like any message
// Each family draws from at least five scenarios over different domains, so no family is a single lexical shortcut.
const one = (relation, entity) => canonical(relation, { [firstRole(relation)]: entity });
const CAUSAL = [
  { observe: 'down', cause: 'caused_outage', effectRole: 'effect', causeRole: 'cause', effectType: 'system', causeType: 'system' },
  { observe: 'ill', cause: 'sick_from', effectRole: 'person', causeRole: 'cause', effectType: 'person', causeType: 'food' },
  { observe: 'closed_today', cause: 'closed_for', effectRole: 'venue', causeRole: 'event', effectType: 'venue', causeType: 'event' },
  { observe: 'postponed', cause: 'delayed_by', effectRole: 'event', causeRole: 'cause', effectType: 'event', causeType: 'system' },
  { observe: 'resigned', cause: 'quit_over', effectRole: 'person', causeRole: 'cause', effectType: 'person', causeType: 'person' },
];
export function causal(k) {
  const sc = k.random.pick(CAUSAL);
  const effect = k.world.make(sc.effectType), cause = k.world.make(sc.causeType);
  const observation = one(sc.observe, effect);
  const link = canonical(sc.cause, { [sc.effectRole]: effect, [sc.causeRole]: cause });
  const variant = k.random.pick(['whether_caused', 'which_cause']);
  const canon = emptyCanon();
  const clauses = [];
  if (variant !== 'hedged_cause' || k.random.chance(0.5)) { canon.stated.push({ ...observation, certainty: 'asserted' }); clauses.push({ canon: observation }); }
  const facts = k.random.chance(0.6) ? [link] : [];
  if (variant === 'which_cause') {
    const q = canonical(sc.cause, { [sc.effectRole]: effect, [sc.causeRole]: VAR });
    canon.query = { ask: 'which', select: ['?x'], where: [where(q)] };
    return base('causal', `${sc.cause}_which`, ['squad', 'proofwriter'], { canon, facts: [link], plan: { clauses, certainty: 'asserted', question: { ask: 'which', prop: q, focus: sc.causeRole, pronoun: true } }, expect: 'supported', mentioned: [effect], answers: [cause], predicates: [sc.observe, sc.cause] });
  }
  if (variant === 'hedged_cause') {
    canon.stated.push({ ...link, certainty: 'hedged' });
    canon.query = { ask: 'whether', where: [where(observation)] };
    return base('causal', `${sc.cause}_hedged`, ['proofwriter'], { canon, facts: [], plan: { clauses: [...clauses, { canon: link }], certainty: 'hedged', question: { ask: 'whether', prop: observation, pronoun: true } }, expect: null, mentioned: [effect, cause], predicates: [sc.observe, sc.cause] });
  }
  canon.query = { ask: 'whether', where: [where(link)] };
  return base('causal', `${sc.cause}_whether`, ['qa2d', 'proofwriter'], { canon, facts, plan: { clauses, certainty: 'asserted', question: { ask: 'whether', prop: link, pronoun: true } }, expect: facts.length ? 'supported' : 'unknown', mentioned: [effect, cause], predicates: [sc.observe, sc.cause] });
}

const ABDUCTION = [
  { observe: 'absent', explain: s => one('ill', s), type: 'person', extra: [] },
  { observe: 'down', explain: s => one('overloaded', s), type: 'system', extra: [] },
  { observe: 'ill', explain: (s, k) => canonical('sick_from', { person: s, cause: k.world.make('food') }), type: 'person', past: true },
  // Being away at an event explains an absence from work, not "staying home": that observation phrase is excluded.
  { observe: 'absent', explain: (s, k) => canonical('attended', { attendee: s, event: k.world.make('event') }), type: 'person', past: true, exclude: ['stay home'] },
];
const EXPLAIN_FRAMES = { id: 'abduction', en: ['Is that because {S}?', 'Could it be that {S}?', 'Maybe {S}?', 'Is it possible that {S}?', 'Would that be because {S}?'], ro: ['Oare pentru că {S}?', 'Poate că {S}?', 'Crezi că {S}?', 'E din cauză că {S}?', 'Nu cumva {S}?'] };
export function abduction(k) {
  const sc = k.random.pick(ABDUCTION);
  const subject = k.world.make(sc.type);
  const obs = one(sc.observe, subject), hyp = sc.explain(subject, k);
  const canon = emptyCanon();
  const status = k.random.chance(0.4) ? 'supported' : 'unknown';
  canon.stated.push({ ...obs, certainty: 'asserted' });
  canon.query = { ask: 'whether', where: [where(hyp)] };
  return base('abduction', `${sc.observe}_explained`, ['proofwriter'], { canon, facts: status === 'supported' ? [hyp] : [],
    // The observation comes first: "Is that because …?" refers back to it.
    plan: { clauses: [{ canon: obs, ...(sc.exclude ? { exclude: sc.exclude } : {}) }], statementFirst: true, certainty: 'asserted', question: { ask: 'whether', prop: hyp, pronoun: true, frames: EXPLAIN_FRAMES, past: sc.past ?? false } },
    expect: status, mentioned: entities(hyp.bindings), predicates: [sc.observe, hyp.relation] });
}

const DEFAULTS = [
  { membership: (p, k) => canonical('works_at', { employee: p, employer: k.world.make('clinic') }), property: 'vaccinated' },
  { membership: (p, k) => canonical('teaches', { teacher: p, subject: k.world.make('course') }), property: 'certified' },
  { membership: (p, k) => canonical('maintains', { engineer: p, system: k.world.make('system') }), property: 'authorized' },
  { membership: (p, k) => canonical('plays_for', { player: p, team: k.world.make('team') }), property: 'trained' },
  { membership: (p, k) => canonical('coaches', { coach: p, team: k.world.make('team') }), property: 'certified' },
  { membership: (p, k) => canonical('studies_at', { student: p, school: k.world.make('school') }), property: 'vaccinated' },
];
export function defaultException(k) {
  const sc = k.random.pick(DEFAULTS);
  const person = k.world.make('person');
  const membership = sc.membership(person, k), dflt = one(sc.property, person);
  const exception = k.random.chance(0.4);
  const canon = emptyCanon();
  canon.stated.push({ ...membership, certainty: 'asserted' });
  const clauses = [{ canon: membership }], assumed = [];
  if (exception) { const n = canonical(sc.property, { [firstRole(sc.property)]: person }, { polarity: 'negated' }); canon.stated.push({ ...n, certainty: 'asserted' }); clauses.push({ canon: n }); }
  else { canon.assumed.push({ ...dflt, basis: 'default' }); assumed.push({ canon: dflt, basis: 'default' }); }
  canon.query = { ask: 'whether', where: [where(dflt)] };
  return base('default_exception', `${membership.relation}_${sc.property}_${exception ? 'exception' : 'default'}`, ['proofwriter'], { canon, plan: { clauses, certainty: 'asserted', question: { ask: 'whether', prop: dflt, pronoun: true, distinctFromStated: exception }, assumed },
    expect: exception ? 'refuted' : 'unknown', mentioned: entities(membership.bindings), predicates: [membership.relation, sc.property] });
}

const COUNTERFACTUAL = [
  { condition: (p, k) => canonical('attended', { attendee: p, event: k.world.make('event') }), outcome: 'eligible' },
  { condition: p => one('trained', p), outcome: 'authorized' },
  { condition: p => one('certified', p), outcome: 'eligible' },
  { condition: (p, k) => canonical('works_at', { employee: p, employer: k.world.make('company') }), outcome: 'eligible' },
  { condition: p => one('vaccinated', p), outcome: 'authorized' },
  { condition: (p, k) => canonical('studies_at', { student: p, school: k.world.make('school') }), outcome: 'certified' },
];
export function counterfactual(k) {
  const sc = k.random.pick(COUNTERFACTUAL);
  const person = k.world.make('person');
  const positive = sc.condition(person, k);
  const negatedSupposition = k.random.chance(0.5);
  const supposition = canonical(positive.relation, positive.bindings, { polarity: negatedSupposition ? 'negated' : 'affirmed' });
  const outcome = one(sc.outcome, person);
  const canon = emptyCanon();
  canon.stated.push({ ...supposition, certainty: 'supposed' });
  canon.query = { ask: 'whether', where: [where(outcome)] };
  const pattern = positive.args.map((arg, i) => i === 0 ? '?x' : arg).join(' ');
  const rules = [{ when: [`${negatedSupposition ? 'not ' : ''}${positive.relation} ${pattern}`], then: `${negatedSupposition ? 'not ' : ''}${sc.outcome} ?x` }];
  return base('counterfactual', `${positive.relation}_${sc.outcome}${negatedSupposition ? '_negated' : ''}`, ['proofwriter'], { canon, facts: [], rules,
    plan: { clauses: [{ canon: supposition, past: true }], certainty: 'supposed', question: { ask: 'whether', prop: outcome, pronoun: true } }, expect: negatedSupposition ? 'refuted' : 'supported', mentioned: entities(supposition.bindings), predicates: [positive.relation, sc.outcome] });
}

const PLANNING = [
  { id: 'prerequisites', relation: 'requires', fixedRole: 'goal', fixedType: 'document', focus: 'prerequisite', focusType: 'document', prefix: { en: ['I want to apply soon.', 'I am putting my papers together.', 'Next week I file the application.'], ro: ['Vreau să depun actele curând.', 'Îmi strâng actele.', 'Săptămâna viitoare depun cererea.'] } },
  { id: 'where_to_get', relation: 'issued', fixedRole: 'document', fixedType: 'document', focus: 'office', focusType: 'office', prefix: { en: ['My old document expired last month.', 'I have some paperwork to renew.', 'I lost my papers on the train.'], ro: ['Actul meu vechi a expirat luna trecută.', 'Am niște acte de reînnoit.', 'Mi-am pierdut actele în tren.'] } },
  { id: 'where_to_buy', relation: 'sells', fixedRole: 'product', fixedType: 'product', focus: 'seller', focusType: 'company', prefix: { en: ['I am fixing things up this weekend.', 'We have run out of supplies at the office.', 'My neighbour asked me to buy a few things.'], ro: ['Weekendul ăsta repar prin casă.', 'Nu mai avem provizii la birou.', 'Vecinul m-a rugat să cumpăr câteva lucruri.'] } },
  { id: 'who_teaches', relation: 'teaches', fixedRole: 'subject', fixedType: 'course', focus: 'teacher', focusType: 'person', prefix: { en: ['I want to start lessons in the autumn.', 'My son needs extra lessons.', 'I am planning to take up a new subject this year.'], ro: ['Vreau să încep lecții la toamnă.', 'Fiul meu are nevoie de meditații.', 'Plănuiesc să mă apuc de o materie nouă anul ăsta.'] } },
  { id: 'who_coaches', relation: 'coaches', fixedRole: 'team', fixedType: 'team', focus: 'coach', focusType: 'person', prefix: { en: ['My daughter wants to try out for a team.', 'I am thinking of joining a local club.'], ro: ['Fiica mea vrea să intre într-o echipă.', 'Mă gândesc să mă înscriu la un club.'] } },
  { id: 'who_maintains', relation: 'maintains', fixedRole: 'system', fixedType: 'system', focus: 'engineer', focusType: 'person', prefix: { en: ['I need to schedule a migration.', 'We plan an upgrade on Friday.'], ro: ['Trebuie să programez o migrare.', 'Plănuim un upgrade vineri.'] } },
];
export function planning(k) {
  const sc = k.random.pick(PLANNING);
  const fixed = k.world.make(sc.fixedType, { role: sc.fixedRole });
  const answers = Array.from({ length: 1 + k.random.int(2) }, () => k.world.make(sc.focusType, { role: sc.focus }));
  const asked = canonical(sc.relation, { [sc.fixedRole]: fixed, [sc.focus]: VAR });
  const canon = emptyCanon();
  canon.query = { ask: 'which', select: ['?x'], where: [where(asked)] };
  const i = k.random.int(sc.prefix.en.length);
  return base('planning', sc.id, ['qa2d'], { canon, facts: answers.map(a => canonical(sc.relation, { [sc.fixedRole]: fixed, [sc.focus]: a })),
    plan: { clauses: [], question: { ask: 'which', prop: asked, focus: sc.focus, prefix: { en: sc.prefix.en[i], ro: sc.prefix.ro[Math.min(i, sc.prefix.ro.length - 1)] } } },
    expect: 'supported', mentioned: [fixed], answers, predicates: [sc.relation] });
}

const INTENTIONS = [
  { relation: 'wants_to_move', other: 'destination', type: 'city' },
  { relation: 'plans_to_leave', other: 'employer', type: 'company' },
  { relation: 'wants_to_learn', other: 'subject', type: 'course' },
  { relation: 'plans_to_attend', other: 'event', type: 'event' },
];
export function intention(k) {
  const person = k.world.make('person');
  // Reported and asked intentions are related pairs (moving and leaving a job; learning and a workshop).
  const [a, b] = k.random.pick([[INTENTIONS[0], INTENTIONS[1]], [INTENTIONS[1], INTENTIONS[0]], [INTENTIONS[2], { relation: 'studies_at', other: 'school', type: 'school' }]]);
  const canon = emptyCanon();
  const make = sc => canonical(sc.relation, { [firstRole(sc.relation)]: person, [sc.other]: k.world.make(sc.type) });
  if (k.random.chance(0.5)) {
    const said = make(a), q = make(b);
    canon.stated.push({ ...said, certainty: 'asserted', speaker: person.id });
    canon.query = { ask: 'whether', where: [where(q)] };
    return base('intention', `reported_${a.relation}_asked_${b.relation}`, ['ambignq'], { canon, plan: { clauses: [{ canon: said }], certainty: 'asserted', speaker: person, question: { ask: 'whether', prop: q, pronoun: true } }, expect: 'unknown', mentioned: [...entities(said.bindings), ...entities(q.bindings)], predicates: [a.relation, b.relation] });
  }
  const q = make(a);
  const status = k.random.chance(0.5) ? 'supported' : 'unknown';
  canon.query = { ask: 'whether', where: [where(q)] };
  return base('intention', `asked_${a.relation}`, ['ambignq'], { canon, facts: status === 'supported' ? [q] : [], plan: { clauses: [], question: { ask: 'whether', prop: q } }, expect: status, mentioned: entities(q.bindings), predicates: [a.relation] });
}

// PAWS-style high-overlap contrast pairs as a family of their own: the same words, the arguments swapped.
const SYMMETRIC_TYPES = Object.keys(PREDICATES).filter(id => PREDICATES[id].roles.length === 2 && !PREDICATES[id].ood && PREDICATES[id].roles[0][1] === PREDICATES[id].roles[1][1] && !EXCLUDED.has(id) && !['quit_over'].includes(id));
export function contrastPair(k) {
  const relation = k.random.pick(SYMMETRIC_TYPES);
  const bindings = fill(k, relation);
  const asked = canonical(relation, bindings);
  const canon = emptyCanon();
  canon.query = { ask: 'whether', where: [where(asked)] };
  const facts = [asked];
  return base('contrast', 'argument_swap_pair', ['paws'], { canon, facts, plan: { clauses: [], question: { ask: 'whether', prop: asked } }, expect: 'supported', mentioned: entities(bindings), predicates: [relation],
    contrast: () => roleSwapContrast(k, relation, bindings, facts) });
}

// ---------------------------------------------------------------- two questions in one message (QQP multi-question shape)
export function multiQuestion(k) {
  const person = k.world.make('person');
  const personFirst = binary.filter(id => PREDICATES[id].roles[0][1] === 'person' && PREDICATES[id].roles[1][1] !== 'person');
  const [r1, r2] = k.random.sample(personFirst, 2);
  const b1 = fill(k, r1, { [firstRole(r1)]: person }), b2 = fill(k, r2, { [firstRole(r2)]: person });
  const p1 = canonical(r1, b1), p2 = canonical(r2, b2);
  const s1 = k.random.pick(['supported', 'unknown']), s2 = k.random.pick(['supported', 'unknown']);
  const facts = [...(s1 === 'supported' ? [p1] : []), ...(s2 === 'supported' ? [p2] : [])];
  const canon = emptyCanon();
  canon.query = { ask: 'whether', where: [where(p1)] };
  return base('multi_question', `${PREDICATES[r1].domain}+${PREDICATES[r2].domain}`, ['qqp'], { canon, facts,
    plan: { clauses: [], question: { ask: 'whether', prop: p1 }, question2: { ask: 'whether', prop: p2, pronoun: true } },
    expect: s1, expect2: s2, mentioned: [...entities(b1), ...entities(b2)], predicates: [r1, r2] });
}

export const FAMILIES = {
  lookup, wh_select: whSelect, count, filter, join, temporal, attached, negation, closure_assumption: closureAssumption, world_assumption: worldAssumption,
  proof_depth: proofDepth, ambiguity, claim_check: claimCheck, statement_only: statementOnly, constraint, abduction, default_exception: defaultException, counterfactual, planning, causal, intention,
  contrast: contrastPair, multi_question: multiQuestion,
};
export const FORMERLY_BLOCKED = ['abduction', 'default_exception', 'counterfactual', 'planning', 'causal', 'intention', 'general_quantification'];
