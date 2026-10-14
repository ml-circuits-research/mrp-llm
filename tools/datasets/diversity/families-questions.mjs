/** Question-form families of the model language (DS014 question forms, DS015 quotas): time questions (when, since
 * when, until when, how long, how many times), where, how (means), why (mode explain), universal questions (mode
 * every), conjunctions, interpretation assumptions (an ambiguous word, an ambiguous referent, a presupposition) and
 * the hand-authored query-v2 phenomena re-expressed through the IR (knowledge cutoff, conflicting reports, stated
 * conflict, a defeated supposition, pairs). Each returns a case spec like families.mjs.
 */
import { PREDICATES } from './domains.mjs';
import { canonical, emptyCanon } from './ir.mjs';
import { FAMILIES, P, base, binary, date, entities, fill, firstRole, poolName, where } from './families.mjs';

const quote = text => JSON.stringify(text);
const pickWeighted = (k, entries) => k.random.weighted(entries);

// ---------------------------------------------------------------- time questions (SQuAD/AmbigNQ when/how-long shapes)
const STATES = ['works_at', 'lives_in', 'plays_for', 'coaches', 'studies_at', 'manages', 'maintains', 'owns', 'married_to', 'teaches'];
const EVENTS = ['travelled_to', 'borrowed', 'absent', 'ill', 'down', 'postponed', 'attended', 'resigned'];
const nextDay = iso => new Date(Date.parse(iso + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
/** "When did Ana work at Acme?" (`role time ?t`), "since when" (measure start), "until when" (measure end), "how long"
 * (measure duration) and "how many times" (mode count over distinct validity intervals). */
export function timeQuestion(k) {
  const kind = pickWeighted(k, [['when', 3], ['since', 2], ['until', 2], ['how_long', 2], ['how_many_times', 2]]);
  const ood = poolName === 'ood' || poolName === 'ood_construction';
  const pool = ood ? binary : kind === 'how_many_times' ? EVENTS : STATES;
  const relation = k.random.pick(pool);
  const bindings = fill(k, relation);
  const asked = canonical(relation, bindings);
  const known = k.random.chance(0.85);
  const facts = [];
  const y = 2012 + k.random.int(10), m = 1 + k.random.int(12);
  if (kind === 'how_many_times') {
    const n = 1 + k.random.int(4);
    const days = new Set();
    while (days.size < n) days.add(date(2019 + k.random.int(7), 1 + k.random.int(12), 1 + k.random.int(27)));
    if (known) for (const day of days) facts.push(canonical(relation, bindings, { time: { from: day, until: nextDay(day) } }));
  } else if (known) {
    const from = date(y, m, 1);
    const open = kind === 'since' || (kind !== 'until' && k.random.chance(0.35));
    const until = open ? null : date(y + 1 + k.random.int(6), 1 + k.random.int(12), 1);
    facts.push(canonical(relation, bindings, { time: { from, ...(until ? { until } : {}) } }));
  }
  // A decoy: the same relation for another filler, so the answer is never the only fact.
  const decoyBindings = PREDICATES[relation].roles.length === 1 ? fill(k, relation) : fill(k, relation, { [firstRole(relation)]: bindings[firstRole(relation)] });
  const decoy = canonical(relation, decoyBindings, { time: { from: date(y - 3, 1 + k.random.int(12), 1), until: date(y - 1, 1 + k.random.int(12), 1) } });
  facts.push(decoy);
  const canon = emptyCanon();
  canon.query = { ask: kind === 'how_many_times' ? 'count' : 'which', select: ['?t'], where: [{ ...where(asked), time: '?t' }], ...(kind === 'since' ? { measure: 'start' } : kind === 'until' ? { measure: 'end' } : kind === 'how_long' ? { measure: 'duration' } : {}) };
  return base('time_question', `${kind}_${known ? 'known' : 'unknown'}`, ['squad', 'ambignq'], { canon, facts, plan: { clauses: [], question: { timeQ: { kind, prop: asked } } },
    expect: known ? 'supported' : 'unknown', mentioned: entities(bindings), worldOnly: entities(decoy.bindings), predicates: [relation], paraphrases: k.random.pick([1, 1, 2]) });
}

// ---------------------------------------------------------------- where (location or destination role)
const WHERE = [['lives_in', false], ['located_in', false], ['held_at', true], ['travelled_to', true]];
export function whereQuestion(k) {
  const [relation, past] = k.random.pick(WHERE);
  const [[subjectRole], [placeRole, placeType]] = PREDICATES[relation].roles;
  const subject = k.world.make(PREDICATES[relation].roles[0][1]);
  const known = k.random.chance(0.8);
  const answers = known ? Array.from({ length: relation === 'travelled_to' ? 1 + k.random.int(2) : 1 }, () => k.world.make(placeType)) : [];
  const facts = answers.map(place => canonical(relation, { [subjectRole]: subject, [placeRole]: place }));
  const decoy = fill(k, relation);
  facts.push(canonical(relation, decoy));
  const asked = canonical(relation, { [subjectRole]: subject, [placeRole]: { id: '?place' } });
  const canon = emptyCanon();
  canon.query = { ask: 'which', select: ['?place'], where: [where(asked)] };
  return base('where_question', `${relation}_${known ? 'known' : 'unknown'}`, ['squad', 'qa2d'], { canon, facts, plan: { clauses: [], question: { ask: 'which', prop: asked, focus: placeRole, whKey: 'where', past, variable: '?place' } },
    expect: known ? 'supported' : 'unknown', mentioned: [subject], answers, worldOnly: entities(decoy), predicates: [relation], paraphrases: k.random.pick([1, 2]) });
}

// ---------------------------------------------------------------- how (means or manner: the instrument role)
const HOW = {
  commutes_by: {
    en: [['How does {S} commute?', 'commute'], ['How does {S} get to work?', 'get to work'], ['How does {S} go to work?', 'go to work'], ['Do you know how {S} gets to work?', 'get to work'],
      ['Any idea how {S} commutes?', 'commute'], ['How does {S} get to work, do you know?', 'get to work'], ['What does {S} commute by?', 'commute by'], ['I wonder how {S} goes to work.', 'go to work']],
    ro: [['Cum face {S} naveta?', 'face naveta'], ['Cum ajunge {S} la serviciu?', 'ajunge la serviciu'], ['Cu ce merge {S} la serviciu?', 'merge la serviciu cu'], ['{S} cum face naveta?', 'face naveta'],
      ['Știi cum ajunge {S} la serviciu?', 'ajunge la serviciu'], ['Cu ce face {S} naveta?', 'face naveta cu'], ['Mă întreb cum merge {S} la serviciu.', 'merge la serviciu']],
  },
  pays_with: {
    en: [['How does {S} pay?', 'pay'], ['How does {S} pay, any idea?', 'pay'], ['Do you know how {S} pays?', 'pay'], ['What does {S} pay with?', 'pay with'], ['Any idea how {S} settles the bill?', 'settle the bill']],
    ro: [['Cum plătește {S}?', 'plăti'], ['Cu ce plătește {S}?', 'plăti cu'], ['{S} cum plătește?', 'plăti'], ['Știi cum achită {S}?', 'achita']],
  },
};
export function howQuestion(k) {
  const relation = k.random.pick(Object.keys(HOW));
  const [[subjectRole], [meansRole, meansType]] = PREDICATES[relation].roles;
  const subject = k.world.make('person');
  const known = k.random.chance(0.8);
  const answer = k.world.make(meansType);
  const facts = known ? [canonical(relation, { [subjectRole]: subject, [meansRole]: answer })] : [];
  const other = k.world.make('person');
  facts.push(canonical(relation, { [subjectRole]: other, [meansRole]: k.world.make(meansType) }));
  const canon = emptyCanon();
  canon.query = { ask: 'which', select: ['?how'], where: [{ relation, args: [subject.id, '?how'], negated: false }] };
  const custom = Object.fromEntries(['en', 'ro'].map(language => [language, HOW[relation][language].map(([text, rel]) => [text, t => ({ props: [P(rel, [['subject', t.S], ['instrument', '?how']])], select: ['?how'] }), { qtype: 'how' }])]));
  // Sometimes the user first says how someone else does it ("Ion commutes by tram. How does Ana commute?").
  const clauses = [];
  if (k.random.chance(0.35)) { const said = canonical(relation, { [subjectRole]: other, [meansRole]: k.world.make(meansType) }); canon.stated.push({ ...said, certainty: 'asserted' }); clauses.push({ canon: said }); }
  return base('how_question', `${relation}_${known ? 'known' : 'unknown'}${clauses.length ? '_with_statement' : ''}`, ['squad', 'qqp'], { canon, facts, plan: { clauses, certainty: 'asserted', statementFirst: true, question: { custom, slots: { S: subject }, ask: 'which', id: `how.${relation}`, qtype: 'how' } },
    expect: known ? 'supported' : 'unknown', mentioned: [subject], answers: known ? [answer] : [], worldOnly: [other], predicates: [relation] });
}

// ---------------------------------------------------------------- why (mode explain: the answer is a derivation)
const WHY = [
  { target: 'authorized', from: 'trained', type: 'person' }, { target: 'eligible', from: 'certified', type: 'person' }, { target: 'authorized', from: 'vaccinated', type: 'person' },
  { target: 'down', from: 'overloaded', type: 'system' }, { target: 'absent', from: 'ill', type: 'person' }, { target: 'eligible', from: 'trained', type: 'person' },
];
const WHY_BINARY = [
  { target: 'closed_today', link: 'closed_for', role: 'venue', other: 'event', type: 'venue', otherType: 'event' },
  { target: 'postponed', link: 'delayed_by', role: 'event', other: 'cause', type: 'event', otherType: 'system' },
  { target: 'ill', link: 'sick_from', role: 'person', other: 'cause', type: 'person', otherType: 'food' },
  { target: 'resigned', link: 'quit_over', role: 'person', other: 'cause', type: 'person', otherType: 'person' },
];
const unary = (relation, entity, polarity = 'affirmed') => canonical(relation, { [firstRole(relation)]: entity }, { polarity });
export function whyQuestion(k) {
  const variant = pickWeighted(k, [['derived', 4], ['derived_negated', 2], ['recorded', 2], ['unexplained', 2], ['cause_link', 3]]);
  const canon = emptyCanon();
  if (variant === 'cause_link') {
    const sc = k.random.pick(WHY_BINARY);
    const subject = k.world.make(sc.type), cause = k.world.make(sc.otherType);
    const asked = unary(sc.target, subject);
    canon.query = { ask: 'explain', where: [where(asked)] };
    const rules = [{ when: [`${sc.link} ?x ?y`], then: `${sc.target} ?x` }];
    return base('why_question', `${sc.target}_via_${sc.link}`, ['squad', 'proofwriter'], { canon, facts: [canonical(sc.link, { [sc.role]: subject, [sc.other]: cause })], rules,
      plan: { clauses: [], question: { why: asked, past: ['postponed', 'resigned'].includes(sc.target) } }, expect: 'supported', mentioned: [subject], worldOnly: [cause], predicates: [sc.target, sc.link] });
  }
  const sc = k.random.pick(WHY);
  const subject = k.world.make(sc.type);
  const negated = variant === 'derived_negated';
  const asked = unary(sc.target, subject, negated ? 'negated' : 'affirmed');
  canon.query = { ask: 'explain', where: [where(asked)] };
  const rules = variant.startsWith('derived') ? [{ when: [`${sc.from} ?x`], then: `${sc.target} ?x` }, { when: [`not ${sc.from} ?x`], then: `not ${sc.target} ?x` }] : [];
  const facts = variant === 'derived' ? [unary(sc.from, subject)] : negated ? [unary(sc.from, subject, 'negated')] : variant === 'recorded' ? [asked] : [unary(sc.from, k.world.make(sc.type))];
  return base('why_question', `${sc.target}_${variant}`, ['squad', 'proofwriter'], { canon, facts, rules, plan: { clauses: [], question: { why: asked } },
    expect: variant === 'unexplained' ? 'unknown' : 'supported', mentioned: [subject], predicates: [sc.target, sc.from] });
}

// ---------------------------------------------------------------- universal questions (mode every, ProofWriter quantifiers)
// Restriction phrases carry their relation phrase; `sg` phrases take singular agreement, `pl` plural, `none` the
// determiner "no" (every member, negated scope). The model never rewrites "all" as "nobody … not".
const RESTRICT = {
  works_at: { type: 'company', role: 'employer',
    en: { sg: [['everyone who works at {org}', 'work at'], ['every employee of {org}', 'be an employee of'], ['each person employed by {org}', 'be employed by'], ['everybody working for {org}', 'work for']],
      pl: [['all the people who work at {org}', 'work at'], ['all employees of {org}', 'be an employee of'], ['all the staff employed by {org}', 'be employed by'], ['the people on the staff of {org}', 'be on the staff of']],
      none: [['nobody who works at {org}', 'work at'], ['no employee of {org}', 'be an employee of'], ['no one working for {org}', 'work for']] },
    ro: { sg: [['fiecare om care lucrează la {org}', 'lucra la'], ['oricine lucrează la {org}', 'lucra la'], ['fiecare salariat la {org}', 'fi salariat la']],
      pl: [['toți cei care lucrează la {org}', 'lucra la'], ['toți angajații de la {org}', 'fi angajat la'], ['toți cei angajați la {org}', 'fi angajat la']],
      none: [['nimeni care lucrează la {org}', 'lucra la'], ['niciun angajat de la {org}', 'fi angajat la']] },
    groupEn: [['Which companies have only {prop} employees?', 'be an employee of']], groupRo: [['La ce firme sunt toți angajații {prop}?', 'fi angajat la']] },
  plays_for: { type: 'team', role: 'team',
    en: { sg: [['every player of {org}', 'be a player of'], ['everyone who plays for {org}', 'play for']], pl: [['all the players of {org}', 'be a player of'], ['all the people playing for {org}', 'play for'], ['the players of {org}', 'be a player of']],
      none: [['no player of {org}', 'be a player of'], ['nobody who plays for {org}', 'play for']] },
    ro: { sg: [['fiecare jucător de la {org}', 'fi jucător la'], ['oricine joacă la {org}', 'juca la']], pl: [['toți jucătorii de la {org}', 'fi jucător la'], ['toți cei care joacă la {org}', 'juca la']],
      none: [['niciun jucător de la {org}', 'fi jucător la'], ['nimeni care joacă la {org}', 'juca la']] },
    groupEn: [['Which teams have only {prop} players?', 'be a player of']], groupRo: [['La ce echipe sunt toți jucătorii {prop}?', 'fi jucător la']] },
  studies_at: { type: 'school', role: 'school',
    en: { sg: [['every student at {org}', 'be a student at'], ['everyone who studies at {org}', 'study at']], pl: [['all the students at {org}', 'be a student at'], ['all those enrolled at {org}', 'be enrolled at'], ['the students at {org}', 'be a student at']],
      none: [['no student at {org}', 'be a student at'], ['nobody enrolled at {org}', 'be enrolled at']] },
    ro: { sg: [['fiecare elev de la {org}', 'fi elev la'], ['oricine învață la {org}', 'învăța la']], pl: [['toți elevii de la {org}', 'fi elev la'], ['toți cei înscriși la {org}', 'fi înscris la']],
      none: [['niciun elev de la {org}', 'fi elev la'], ['nimeni înscris la {org}', 'fi înscris la']] } },
  attended: { type: 'event', role: 'event',
    en: { sg: [['everyone who attended {org}', 'attend'], ['each person who took part in {org}', 'take part in']], pl: [['all the people who went to {org}', 'go to'], ['all those who attended {org}', 'attend'], ['the people who attended {org}', 'attend']],
      none: [['nobody who attended {org}', 'attend'], ['no one who went to {org}', 'go to']] },
    ro: { sg: [['oricine a participat la {org}', 'participa la'], ['fiecare participant la {org}', 'fi participant la']], pl: [['toți cei care au participat la {org}', 'participa la'], ['toți participanții la {org}', 'fi participant la']],
      none: [['nimeni care a participat la {org}', 'participa la'], ['niciun participant la {org}', 'fi participant la']] } },
};
// Scope properties: question templates per number with the relation phrase they use.
const SCOPE = {
  certified: { en: { sg: [['Is {R} certified?', 'be certified'], ['Does {R} have a valid certificate?', 'have a valid certificate']], pl: [['Are {R} certified?', 'be certified'], ['Do {R} have a valid certificate?', 'have a valid certificate'], ['Are {R} all certified?', 'be certified']] },
    ro: { sg: [['{R} e certificat?', 'fi certificat'], ['{R} are certificat valabil?', 'avea certificat valabil']], pl: [['{R} sunt certificați?', 'fi certificat'], ['{R} au certificat valabil?', 'avea certificat valabil']], none: [['{R} nu e certificat?', 'fi certificat'], ['{R} nu are certificat valabil?', 'avea certificat valabil']] },
    groupEn: 'certified', groupRo: 'certificați', groupRel: { en: 'be certified', ro: 'fi certificat' } },
  trained: { en: { sg: [['Has {R} completed the safety training?', 'complete the safety training'], ['Is {R} trained?', 'be trained']], pl: [['Have {R} completed the safety training?', 'complete the safety training'], ['Are {R} trained?', 'be trained']] },
    ro: { sg: [['{R} e instruit?', 'fi instruit'], ['{R} a terminat instruirea de siguranță?', 'termina instruirea de siguranță']], pl: [['{R} sunt instruiți?', 'fi instruit'], ['{R} au terminat instruirea de siguranță?', 'termina instruirea de siguranță']], none: [['{R} nu e instruit?', 'fi instruit']] },
    groupEn: 'trained', groupRo: 'instruiți', groupRel: { en: 'be trained', ro: 'fi instruit' } },
  vaccinated: { en: { sg: [['Has {R} had the flu shot?', 'have the flu shot'], ['Is {R} vaccinated against the flu?', 'be vaccinated against the flu']], pl: [['Are {R} vaccinated against the flu?', 'be vaccinated against the flu'], ['Have {R} all had the flu shot?', 'have the flu shot']] },
    ro: { sg: [['{R} s-a vaccinat antigripal?', 'se vaccina antigripal'], ['{R} e vaccinat?', 'fi vaccinat']], pl: [['{R} s-au vaccinat antigripal?', 'se vaccina antigripal'], ['{R} sunt vaccinați?', 'fi vaccinat']], none: [['{R} nu s-a vaccinat antigripal?', 'se vaccina antigripal']] },
    groupEn: 'vaccinated', groupRo: 'vaccinați', groupRel: { en: 'be vaccinated', ro: 'fi vaccinat' } },
};
// "Is anyone who works at X not certified?": the restriction verb is said, never guessed from the entity type.
const EXISTS_NOT = {
  en: [['Is anyone who {who} not {adj}?', 'be {adj}'], ['Is there anyone who {who} and is not {adj}?', 'be {adj}']],
  ro: [['Există cineva care {who} și nu e {adjro}?', 'fi {adjro}'], ['E cineva care {who} și nu e {adjro}?', 'fi {adjro}']],
};
const WHO = {
  works_at: { en: ['works at {org}', 'work at'], ro: ['lucrează la {org}', 'lucra la'] }, plays_for: { en: ['plays for {org}', 'play for'], ro: ['joacă la {org}', 'juca la'] },
  studies_at: { en: ['studies at {org}', 'study at'], ro: ['învață la {org}', 'învăța la'] }, attended: { en: ['attended {org}', 'attend'], ro: ['a participat la {org}', 'participa la'] },
};
const capitalize = text => text ? text[0].toUpperCase() + text.slice(1) : text;
export function universal(k) {
  const restrictionId = k.random.pick(Object.keys(RESTRICT)), propertyId = k.random.pick(Object.keys(SCOPE));
  const r = RESTRICT[restrictionId], pr = SCOPE[propertyId];
  const [memberRole] = PREDICATES[restrictionId].roles[0];
  const role = firstRole(propertyId), closed = PREDICATES[restrictionId].closedRoles.direct;
  const shape = pickWeighted(k, [['every', 6], ['none', 2], ['exists_not', 1], ...(r.groupEn ? [['group', 2]] : [])]);
  const orgs = [k.world.make(r.type), ...(shape === 'group' ? [k.world.make(r.type)] : [])];
  const facts = [], worldOnly = [];
  const outcome = pickWeighted(k, [['all', 4], ['counterexample', 3], ['gap', 2]]);
  // Every member satisfies the scope, except the first member of the (last) restriction for a counterexample
  // (the opposite polarity is known) or a gap (nothing is known about it). "None" questions negate the scope.
  const expected = shape === 'none' ? 'negated' : 'affirmed', opposite = shape === 'none' ? 'affirmed' : 'negated';
  for (const [index, org] of orgs.entries()) {
    const members = Array.from({ length: 2 + k.random.int(2) }, () => k.world.make('person'));
    worldOnly.push(...members);
    for (const [i, p] of members.entries()) {
      facts.push(canonical(restrictionId, { [memberRole]: p, [r.role]: org }));
      const special = i === 0 && index === orgs.length - 1;
      if (!special || outcome === 'all') facts.push(canonical(propertyId, { [role]: p }, { polarity: shape === 'exists_not' ? 'affirmed' : expected }));
      else if (outcome === 'counterexample') facts.push(canonical(propertyId, { [role]: p }, { polarity: shape === 'exists_not' ? 'negated' : opposite }));
    }
  }
  const canon = emptyCanon();
  const texts = {};
  let ask = 'every', select = null;
  for (const language of ['en', 'ro']) {
    const variants = [];
    if (shape === 'group') {
      const [template, rel] = (language === 'en' ? r.groupEn : r.groupRo)[0];
      variants.push([template.replace('{prop}', language === 'en' ? pr.groupEn : pr.groupRo), () => ({ ask: 'every', select: ['?org'], props: [P(rel, [['subject', '?m'], [closed, '?org']])], scope: [P(pr.groupRel[language], [['subject', '?m']])] }), { qtype: 'universal' }]);
    } else if (shape === 'exists_not') {
      const adj = { certified: ['certified', 'certificat'], trained: ['trained', 'instruit'], vaccinated: ['vaccinated against the flu', 'vaccinat'] }[propertyId];
      const [who, whoRel] = WHO[restrictionId][language];
      for (const [template, rel] of EXISTS_NOT[language]) variants.push([template.replace('{who}', who).replace('{adj}', adj[0]).replace('{adjro}', adj[1]), t => ({ ask: 'whether', props: [P(whoRel, [['subject', '?m'], [closed, t.org]]), P(rel.replace('{adj}', adj[0]).replace('{adjro}', adj[1]), [['subject', '?m']], 'negated')] }), { qtype: 'yes_no' }]);
    } else {
      const numbers = shape === 'none' ? ['none'] : ['sg', 'pl'];
      for (const number of numbers) {
        const subjects = r[language][number] ?? [];
        const templates = language === 'en' ? pr.en[number === 'none' ? 'sg' : number] : pr.ro[number];
        // "all" is said once: a template that adds "all" takes a plural phrase without it, and vice versa.
        for (const [phrase, rel] of subjects) for (const [template, scopeRel] of templates ?? []) {
          if (number === 'pl' && /\ball\b/.test(template) === /^all\b/.test(phrase)) continue;
          const text = template.startsWith('{R}') ? template.replace('{R}', capitalize(phrase)) : template.replace('{R}', phrase);
          variants.push([text, t => ({ ask: 'every', props: [P(rel, [['subject', '?m'], [closed, t.org]])], scope: [P(scopeRel, [['subject', '?m']], shape === 'none' ? 'negated' : 'affirmed')] }), { qtype: 'universal' }]);
        }
      }
    }
    texts[language] = variants;
  }
  if (shape === 'exists_not') ask = 'whether';
  if (shape === 'group') select = ['?org'];
  const memberVar = '?m';
  canon.query = { ask, ...(select ? { select } : {}), where: [{ relation: restrictionId, args: [memberVar, shape === 'group' ? '?org' : orgs[0].id], negated: false }], ...(ask === 'every' ? { scope: [{ relation: propertyId, args: [memberVar], negated: shape === 'none' }] } : {}) };
  return base('general_quantification', `${restrictionId}-${propertyId}-${shape}-${outcome}`, ['proofwriter'], { structure: `universal:${shape}`, canon, facts,
    plan: { clauses: [], question: { custom: texts, slots: { org: orgs[0] }, ask, id: `universal.${shape}.${restrictionId}.${propertyId}` } },
    expect: shape === 'exists_not' ? (outcome === 'counterexample' ? 'supported' : 'unknown') : outcome === 'all' ? 'supported' : outcome === 'counterexample' ? (shape === 'group' ? 'supported' : 'refuted') : (shape === 'group' ? 'supported' : 'unknown'),
    mentioned: shape === 'group' ? [] : [orgs[0]], worldOnly: [...worldOnly, ...(shape === 'group' ? orgs : [])], predicates: [restrictionId, propertyId] });
}

// ---------------------------------------------------------------- conjunction of two ground propositions (query-v2 and__heterogeneous)
export function conjunction(k) {
  const personFirst = binary.filter(id => PREDICATES[id].roles[0][1] === 'person' && PREDICATES[id].roles[1][1] !== 'person');
  const [r1, r2] = k.random.sample(personFirst, 2);
  const person = k.world.make('person');
  const p1 = canonical(r1, fill(k, r1, { [firstRole(r1)]: person })), p2 = canonical(r2, fill(k, r2, { [firstRole(r2)]: person }));
  const outcome = pickWeighted(k, [['both', 3], ['one_missing', 2], ['one_denied', 1]]);
  const facts = outcome === 'both' ? [p1, p2] : outcome === 'one_missing' ? [p1] : [p1, canonical(r2, p2.bindings, { polarity: 'negated' })];
  const canon = emptyCanon();
  canon.query = { ask: 'whether', where: [where(p1), where(p2)] };
  return base('conjunction', outcome, ['qqp', 'proofwriter'], { canon, facts, plan: { clauses: [], question: { conj: [p1, p2] } },
    expect: outcome === 'both' ? 'supported' : outcome === 'one_missing' ? 'unknown' : 'refuted', mentioned: [...entities(p1.bindings), ...entities(p2.bindings)], predicates: [r1, r2], paraphrases: k.random.pick([1, 2]) });
}

// ---------------------------------------------------------------- interpretation assumptions (Q-DATA-4)
// The model makes its reading explicit with `assumed`: an ambiguous word ("mean"), an ambiguous referent
// ("refer to"), or a presupposition of the wording (the earlier occurrence that "again" presupposes).
const SENSES = [
  { rel: 'make', relations: ['wrote', 'published'], type: 'work', slot: 'work', reading: { en: ['made', 'wrote'], ro: ['a făcut', 'a scris'] },
    en: ['Who made {work}?', 'Do you know who made {work}?', 'Who actually made {work}?'], ro: ['Cine a făcut {work}?', 'Știi cine a făcut {work}?'], relRo: 'face' },
  { rel: 'have', relations: ['owns', 'borrowed'], type: 'asset', slot: 'work', reading: { en: ['has', 'owns'], ro: ['are', 'deține'] },
    en: ['Who has {work}?', 'Do you know who has {work}?', 'Any idea who has {work}?'], ro: ['Cine are {work}?', 'Știi cine are {work}?'], relRo: 'avea' },
];
const AGAIN = {
  travelled_to: { en: [['Did {S} travel to {O} again?', 'travel to', 'destination'], ['Did {S} fly to {O} again?', 'fly to', 'destination'], ['Has {S} visited {O} again?', 'visit', 'destination']],
    ro: [['{S} a călătorit din nou la {O}?', 'călători la', 'destination'], ['A vizitat {S} iar {O}?', 'vizita', 'destination']] },
  attended: { en: [['Did {S} go to {O} again?', 'go to', 'object'], ['Did {S} attend {O} again?', 'attend', 'object']],
    ro: [['{S} a participat din nou la {O}?', 'participa la', 'object'], ['A mers {S} iar la {O}?', 'merge la', 'object']] },
  borrowed: { en: [['Did {S} borrow {O} again?', 'borrow', 'object']], ro: [['{S} a împrumutat din nou {O}?', 'împrumuta', 'object']] },
};
// Asymmetric hosts only: after a symmetric relation ("Ana is married to Irina. Does she …?") no reading is preferable.
const PRONOUN_HOSTS = ['manages', 'treats', 'parent_of'];
export function interpretation(k) {
  const variant = k.forceVariant ?? pickWeighted(k, [['sense', 3], ['referent', 3], ['again', 2]]);
  const canon = emptyCanon();
  if (variant === 'sense') {
    const sc = k.random.pick(SENSES);
    const work = k.world.make(sc.type === 'asset' ? k.random.pick(['asset', 'work']) : 'work');
    const facts = sc.relations.map(relation => canonical(relation, fill(k, relation, { [PREDICATES[relation].roles[1][0]]: work })));
    canon.query = { ask: 'which', select: ['?x'], where: [{ relation: sc.relations[0], args: ['?x', work.id], negated: false }] };
    const custom = { en: sc.en.map(text => [text, t => [P(sc.rel, [['subject', '?x'], ['object', t.work]])]]), ro: sc.ro.map(text => [text, t => [P(sc.relRo, [['subject', '?x'], ['object', t.work]])]]) };
    // "Who has <a book>?" reads as having borrowed it; "Who has <a property>?" as owning it.
    const reading = sc.rel === 'have' && work.type === 'work' ? { en: ['has', 'has borrowed'], ro: ['are', 'a împrumutat'] } : sc.reading;
    const meta = ({ language }) => ({ relation: language === 'ro' ? 'însemna' : 'mean', roles: [['subject', quote(reading[language][0])], ['object', quote(reading[language][1])]], polarity: 'affirmed', basis: 'disambiguation' });
    return base('interpretation', `sense_${sc.rel}`, ['ambignq'], { canon, facts, plan: { clauses: [], question: { custom, slots: { work }, ask: 'which', id: `sense.${sc.rel}` }, assumed: [{ meta }] },
      expect: 'clarify', mentioned: [work], worldOnly: facts.flatMap(f => entities(f.bindings)).filter(e => e !== work), predicates: sc.relations, senseAmbiguous: true });
  }
  if (variant === 'referent') {
    // Two people of the same gender and a pronoun: the model reads it as the subject of the previous sentence
    // (the documented convention) and says so with `assumed … refer to … basis disambiguation`.
    const host = k.random.pick(PRONOUN_HOSTS);
    // Unisex given names get a gender at allocation, so the second person takes the first one's gender.
    const a = k.world.person({ gender: k.random.pick(['f', 'm']) }), b = k.world.person({ gender: a.gender });
    const gender = a.gender;
    const [[r0], [r1]] = PREDICATES[host].roles;
    const statement = canonical(host, { [r0]: a, [r1]: b });
    const asked = k.random.pick(binary.filter(id => PREDICATES[id].roles[0][1] === 'person' && PREDICATES[id].roles[1][1] !== 'person'));
    const q = canonical(asked, fill(k, asked, { [firstRole(asked)]: a }));
    const known = k.random.chance(0.5);
    canon.stated.push({ ...statement, certainty: 'asserted' });
    canon.query = { ask: 'whether', where: [where(q)] };
    const pronoun = gender === 'f' ? 'she' : 'he';
    // Only when the rendered question really contains the pronoun (a passive or possessive frame may avoid it).
    const meta = ({ values, question }) => new RegExp(`\\b${pronoun}\\b`, 'i').test(question?.text ?? '') ? { relation: 'refer to', roles: [['subject', quote(pronoun)], ['object', quote(values.A)]], polarity: 'affirmed', basis: 'disambiguation' } : null;
    return base('interpretation', `referent_${host}`, ['ambignq'], { canon, facts: known ? [q] : [], languages: ['en'],
      plan: { clauses: [{ canon: statement, direct: true }], certainty: 'asserted', question: { ask: 'whether', prop: q, pronoun: true }, assumed: [{ meta, slots: { A: a } }], statementFirst: true },
      expect: known ? 'supported' : 'unknown', mentioned: [a, b, ...entities(q.bindings)], predicates: [host, asked] });
  }
  const relation = k.random.pick(Object.keys(AGAIN));
  const bindings = fill(k, relation);
  const asked = canonical(relation, bindings);
  const [[r0], [r1]] = PREDICATES[relation].roles;
  const known = k.random.chance(0.5);
  const facts = known ? [asked] : [];
  canon.query = { ask: 'whether', where: [where(asked)] };
  const custom = Object.fromEntries(['en', 'ro'].map(language => [language, AGAIN[relation][language].map(([text, rel, orole]) => [text,
    t => [P(rel, [['subject', t.S], [orole, t.O]])],
    { qtype: 'yes_no', assumed: t => [{ relation: rel, roles: [['subject', t.S], [orole, t.O]], polarity: 'affirmed', basis: 'implicature', meta: true }] }])]));
  return base('interpretation', `again_${relation}`, ['ambignq'], { canon, facts, plan: { clauses: [], question: { custom, slots: { S: bindings[r0], O: bindings[r1] }, ask: 'whether', id: `again.${relation}` } },
    expect: known ? 'supported' : 'unknown', mentioned: entities(bindings), predicates: [relation] });
}

// ---------------------------------------------------------------- query-v2 phenomena re-expressed through the IR
const STATE_ANCHORS = ['works_at', 'lives_in', 'plays_for', 'studies_at', 'coaches'];
export function anchor(k) {
  const variant = pickWeighted(k, [['asof_cutoff', 3], ['conflicting_reports', 2], ['stated_conflict', 2], ['supposition_defeated', 2], ['select_pairs', 2]]);
  const canon = emptyCanon();
  if (variant === 'asof_cutoff') {
    // query-v2 time_asof_early/late: the answer depends on what was known by a date (host knowledge time).
    const relation = k.random.pick(STATE_ANCHORS);
    const bindings = fill(k, relation);
    const asked = canonical(relation, bindings);
    const late = k.random.chance(0.5);
    const fact = canonical(relation, bindings, { time: { from: '2024-01-01', until: '2025-06-01' } });
    const at = date(2024, 2 + k.random.int(9), 1 + k.random.int(27));
    const asof = late ? date(2025, 7 + k.random.int(5), 1 + k.random.int(27)) : date(2023, 7 + k.random.int(5), 1 + k.random.int(27));
    canon.query = { ask: 'whether', where: [where(asked)], at, asof };
    return base('anchor', `asof_${late ? 'late' : 'early'}`, ['squad'], { canon, facts: [], lateFacts: [fact], anchor: 'query-v2/time_asof', plan: { clauses: [], question: { ask: 'whether', prop: asked, past: true, time: { at }, asofDate: asof } },
      expect: late ? 'supported' : 'unknown', mentioned: entities(bindings), predicates: [relation] });
  }
  if (variant === 'conflicting_reports') {
    const relation = k.random.pick(binary);
    const bindings = fill(k, relation);
    const asked = canonical(relation, bindings);
    canon.query = { ask: 'whether', where: [where(asked)] };
    return base('anchor', 'conflicting_reports', ['qqp', 'proofwriter'], { canon, facts: [asked, canonical(relation, bindings, { polarity: 'negated' })], anchor: 'query-v2/conflicted_parent',
      plan: { clauses: [], question: { ask: 'whether', prop: asked } }, expect: 'both', mentioned: entities(bindings), predicates: [relation] });
  }
  if (variant === 'stated_conflict') {
    const relation = k.random.pick(binary);
    const bindings = fill(k, relation);
    const yes = canonical(relation, bindings), no = canonical(relation, bindings, { polarity: 'negated' });
    canon.stated.push({ ...yes, certainty: 'asserted' }, { ...no, certainty: 'asserted' });
    canon.query = { ask: 'whether', where: [where(yes)] };
    return base('anchor', 'stated_conflict', ['paws'], { canon, anchor: 'query-v2/assert_conflict', plan: { clauses: [{ canon: yes }, { canon: no }], certainty: 'asserted', question: { ask: 'whether', prop: yes, pronoun: true } },
      expect: 'both', mentioned: entities(bindings), predicates: [relation] });
  }
  if (variant === 'supposition_defeated') {
    const relation = k.random.pick(binary);
    const bindings = fill(k, relation);
    const s = canonical(relation, bindings);
    canon.stated.push({ ...s, certainty: 'supposed' });
    canon.query = { ask: 'whether', where: [where(s)] };
    return base('anchor', 'supposition_defeated', ['proofwriter'], { canon, facts: [canonical(relation, bindings, { polarity: 'negated' })], anchor: 'query-v2/assume_defeated',
      plan: { clauses: [{ canon: s, direct: true }], certainty: 'supposed', question: { ask: 'whether', prop: s, pronoun: true } }, expect: 'refuted', mentioned: entities(bindings), predicates: [relation] });
  }
  // query-v2 join_pairs: two selected variables through a shared one.
  const town = k.world.make('city'), company = k.world.make('company'), person = k.world.make('person');
  const facts = [canonical('works_at', { employee: person, employer: company }), canonical('located_in', { site: company, town })];
  canon.query = { ask: 'which', select: ['?x', '?c'], where: [{ relation: 'works_at', args: ['?x', '?c'], negated: false }, { relation: 'located_in', args: ['?c', town.id], negated: false }] };
  const texts = {
    en: [['Which people work at which companies in {town}?', t => ({ props: [P('work at', [['subject', '?x'], ['object', '?c']]), P('be in', [['subject', '?c'], ['location', t.town]])], select: ['?x', '?c'] })],
      ['List each person together with the company in {town} they work for.', t => ({ props: [P('work for', [['subject', '?x'], ['object', '?c']]), P('be in', [['subject', '?c'], ['location', t.town]])], select: ['?x', '?c'] })],
      ['Who works where, among the companies based in {town}?', t => ({ props: [P('work at', [['subject', '?x'], ['object', '?c']]), P('be based in', [['subject', '?c'], ['location', t.town]])], select: ['?x', '?c'] })]],
    ro: [['Cine la ce firmă din {town} lucrează?', t => ({ props: [P('lucra la', [['subject', '?x'], ['object', '?c']]), P('fi în', [['subject', '?c'], ['location', t.town]])], select: ['?x', '?c'] })],
      ['Fă-mi o listă cu oamenii și firmele din {town} la care lucrează.', t => ({ props: [P('lucra la', [['subject', '?x'], ['object', '?c']]), P('fi în', [['subject', '?c'], ['location', t.town]])], select: ['?x', '?c'] })]],
  };
  return base('anchor', 'select_pairs', ['qa2d', 'proofwriter'], { canon, facts, anchor: 'query-v2/join_pairs', plan: { clauses: [], question: { custom: texts, slots: { town }, ask: 'which', id: 'pairs.work_town' } },
    expect: 'supported', mentioned: [town], answers: [person], worldOnly: [company], predicates: ['works_at', 'located_in'] });
}

// ---------------------------------------------------------------- visible ambiguity (Q-ARCH-1, AmbigNQ-inspired)
// Ambiguity the text itself shows: a pronoun with two antecedents, a homonym, the scope of "all … not", and
// PP-attachment. Most cases are resolved: the model picks one reading and states it with `assumed … basis
// disambiguation`. A minority, where no reading is clearly preferable, is `unclear kind ambiguous` with readings.
// Timeless questions: a time word here would be a qualifier the target (a query without `at`) drops.
const HOMONYMS = [
  { predicate: 'available', en: { alias: 'the court', senses: [['the tennis court on {street}', 'the tennis court'], ['the courthouse on {street}', 'the courthouse']], questions: ['Is the court free?', 'Is the court available?', 'Do you know if the court is free?'] },
    ro: { alias: 'terenul', senses: [['terenul de tenis de pe {street}', 'terenul de tenis'], ['terenul de construcții de pe {street}', 'terenul de construcții']], questions: ['E liber terenul?', 'Terenul e disponibil?', 'Știi dacă terenul e liber?'] } },
  { predicate: 'open_now', en: { alias: 'the club', senses: [['the tennis club on {street}', 'the tennis club'], ['the night club on {street}', 'the night club']], questions: ['Is the club open?', 'Do you know if the club is open?', 'Any idea if the club is open?'] },
    ro: { alias: 'clubul', senses: [['clubul sportiv de pe {street}', 'clubul sportiv'], ['clubul de noapte de pe {street}', 'clubul de noapte']], questions: ['E deschis clubul?', 'Clubul e deschis?', 'Știi dacă e deschis clubul?'] } },
  { predicate: 'available', en: { alias: 'the hall', senses: [['the sports hall on {street}', 'the sports hall'], ['the concert hall on {street}', 'the concert hall']], questions: ['Is the hall free?', 'Is the hall available?'] },
    ro: { alias: 'sala', senses: [['sala de sport de pe {street}', 'sala de sport'], ['sala de conferințe de pe {street}', 'sala de conferințe']], questions: ['E liberă sala?', 'Sala e disponibilă?'] } },
  // No "bank": DS014 formalizes "Is the bank open?" as a query and the host asks which bank.
];
const STREETS = ['Elm Street', 'Mill Lane', 'Victoriei Avenue', 'Kogălniceanu Street', 'Park Road', 'Unirii Square', 'Station Road', 'Lipscani Street'];
const STREETS_RO = { 'Elm Street': 'strada Ulmilor', 'Mill Lane': 'aleea Morii', 'Victoriei Avenue': 'Calea Victoriei', 'Kogălniceanu Street': 'strada Kogălniceanu', 'Park Road': 'șoseaua Parcului', 'Unirii Square': 'Piața Unirii', 'Station Road': 'strada Gării', 'Lipscani Street': 'strada Lipscani' };
// Scope of "all … not": "every member is not P" (none) or "not every member is P". The resolved reading is the
// surface order (mode every with a negated scope); the unresolved cases list both readings.
const SCOPE_AMBIGUOUS = {
  en: [['All the players of {org} are not certified?', 'be a player of', 'be certified', 'all the players of {org} are not certified', ['no player of {org} is certified', 'not every player of {org} is certified']],
    ['Are all the students at {org} not vaccinated?', 'be a student at', 'be vaccinated', 'all the students at {org} not vaccinated', ['none of the students at {org} is vaccinated', 'not all the students at {org} are vaccinated']]],
  // Romanian messages, English targets and readings (Q-DATA-6): the phrases and readings are the English meaning.
  ro: [['Toți jucătorii de la {org} nu sunt certificați?', 'be a player of', 'be certified', 'toți jucătorii de la {org} nu sunt certificați', ['no player of {org} is certified', 'not every player of {org} is certified']],
    ['Toți elevii de la {org} nu s-au vaccinat?', 'be a student at', 'be vaccinated', 'toți elevii de la {org} nu s-au vaccinat', ['none of the students at {org} is vaccinated', 'not all the students at {org} are vaccinated']]],
};
// PP-attachment: which noun the prepositional phrase modifies. Only ever listed as readings (no reading is preferable).
const PP = {
  en: [['Did {A} call the coach of the team from {town}?', ['the coach is from {town}', 'the team is from {town}']], ['Did {A} meet the doctor with the new clinic?', ['{A} met the doctor who has the new clinic', '{A} met the doctor at the new clinic']],
    ['Did {A} see the engineer with the laptop?', ['the engineer had the laptop', '{A} used the laptop to see the engineer']], ['Did {A} visit the owner of the shop in {town}?', ['the owner is in {town}', 'the shop is in {town}']]],
  // Romanian messages; the readings are written in English (Q-DATA-6).
  ro: [['L-a sunat {A} pe antrenorul echipei din {town}?', ['the coach is from {town}', 'the team is from {town}']], ['A văzut-o {A} pe ingineră cu laptopul?', ['the engineer had the laptop', '{A} used the laptop to see the engineer']],
    ['A vizitat {A} pe proprietarul magazinului din {town}?', ['the owner is in {town}', 'the shop is in {town}']]],
};
export function visibleAmbiguity(k) {
  // A reading is preferable for a pronoun after a single asymmetric statement (the subject; resolved with
  // `assumed`). No reading is preferable for a pronoun after two parallel clauses, a bare homonym, "all … not"
  // and PP-attachment: those list their readings (`unclear kind ambiguous`). Resolved cases are the majority once
  // the interpretation family (senses, referents, presuppositions) is counted.
  const kind = pickWeighted(k, [['pronoun', 3], ['pronoun_parallel', 1.5], ['homonym', 1.5], ['scope', 1], ['pp', 1]]);
  const unresolved = kind !== 'pronoun';
  const canon = emptyCanon();
  const readingsOf = (texts, values) => texts.map(text => text.replace(/\{(\w+)\}/g, (_, slot) => values[slot] ?? ''));
  if (kind === 'pronoun') {
    const spec = interpretation({ ...k, forceVariant: 'referent' });
    return { ...spec, family: 'ambiguity_visible', variant: `pronoun_resolved_${spec.variant}` };
  }
  if (kind === 'pronoun_parallel') {
    const relation = k.random.pick(['works_at', 'lives_in', 'studies_at', 'plays_for']);
    const a = k.world.person({ gender: k.random.pick(['f', 'm']) }), b = k.world.person({ gender: a.gender });
    const [[r0], [r1, t1]] = PREDICATES[relation].roles;
    const first = canonical(relation, { [r0]: a, [r1]: k.world.make(t1) }), second = canonical(relation, { [r0]: b, [r1]: k.world.make(t1) });
    const asked = k.random.pick(binary.filter(id => id !== relation && PREDICATES[id].roles[0][1] === 'person' && PREDICATES[id].roles[1][1] !== 'person'));
    const q = canonical(asked, fill(k, asked, { [firstRole(asked)]: a }));
    const pronoun = a.gender === 'f' ? 'she' : 'he';
    canon.stated.push({ ...first, certainty: 'asserted' }, { ...second, certainty: 'asserted' });
    return base('ambiguity_visible', 'pronoun_parallel_unresolved', ['ambignq'], { canon, asUnclear: true, languages: ['en'],
      plan: { clauses: [{ canon: first, direct: true }, { canon: second, direct: true, noPronoun: true }], certainty: 'asserted', question: { ask: 'whether', prop: q, pronoun: true }, statementFirst: true,
        readings: ({ values }) => [`${pronoun} is ${values.A}`, `${pronoun} is ${values.B}`], readingSlots: { A: a, B: b } },
      expect: 'unclear', mentioned: [a, b, ...entities(first.bindings), ...entities(second.bindings), ...entities(q.bindings)], predicates: [relation, asked] });
  }
  if (kind === 'homonym') {
    const h = k.random.pick(HOMONYMS);
    const street = k.random.pick(STREETS);
    const senses = h.en.senses.map(([label], i) => k.world.add({ id: label.replace('{street}', street).toLowerCase().replace(/^the /, '').replace(/[^a-z0-9]+/g, '_'), type: 'venue', gender: 'm',
      labels: { en: label.replace('{street}', street), ro: h.ro.senses[i][0].replace('{street}', STREETS_RO[street]) }, short: null, sharedAlias: { en: h.en.alias, ro: h.ro.alias } }));
    const asked = canonical(h.predicate, { place: senses[0] });
    canon.query = { ask: 'whether', where: [{ relation: h.predicate, args: [quote(h.en.alias)], negated: false }] };
    const rel = PREDICATES[h.predicate];
    const custom = {};
    // The target is English (Q-DATA-6): relation phrase, the ambiguous common noun ("terenul" -> "the court") and the
    // readings, which paraphrase the corresponding English question with one sense ("Is the sports hall free?").
    const englishOf = (language, i) => language === 'en' ? h.en.questions[i] : h.en.questions[Math.min(i, h.en.questions.length - 1)];
    for (const language of ['en', 'ro']) custom[language] = h[language].questions.map((text, i) => [text, () => [P(rel.en[0].rel, [['subject', quote(language === 'en' ? (text.match(new RegExp(h.en.alias, 'i'))?.[0] ?? h.en.alias) : h.en.alias)]])], {
      qtype: 'yes_no', ...(language === 'en' ? {} : { translated: [h.en.alias] }),
      ...(unresolved ? { unclearReadings: () => h.en.senses.map(([, reading]) => englishOf(language, i).replace(new RegExp(h.en.alias, 'i'), found => found[0] === found[0].toUpperCase() ? reading[0].toUpperCase() + reading.slice(1) : reading)) }
        : {}) }]);
    return base('ambiguity_visible', `homonym_${unresolved ? 'unresolved' : 'resolved'}`, ['ambignq'], { canon, facts: [asked], asUnclear: unresolved,
      plan: { clauses: [], question: { custom, slots: {}, ask: 'whether', id: `homonym.${h.en.alias}` } }, expect: unresolved ? 'unclear' : 'clarify',
      mentioned: [], worldOnly: senses, predicates: [h.predicate], ambiguousMention: '*shared*' });
  }
  if (kind === 'scope') {
    const org = k.world.make(k.random.pick(['team', 'school']));
    const custom = Object.fromEntries(['en', 'ro'].map(language => [language, SCOPE_AMBIGUOUS[language].filter(([, rel]) => (org.type === 'team') === /player/.test(rel)).map(([text, rel, scopeRel, span, readings]) => [text,
      t => ({ ask: 'every', props: [P(rel, [['subject', '?m'], ['object', t.org]])], scope: [P(scopeRel, [['subject', '?m']], 'negated')] }),
      { qtype: 'universal', unclearReadings: t => readings.map(r => r.replace('{org}', JSON.parse(t.org))) }])]));
    const restriction = org.type === 'team' ? 'plays_for' : 'studies_at', property = org.type === 'team' ? 'certified' : 'vaccinated';
    const members = [k.world.make('person'), k.world.make('person')];
    const facts = members.flatMap(p => [canonical(restriction, { [PREDICATES[restriction].roles[0][0]]: p, [PREDICATES[restriction].roles[1][0]]: org }), canonical(property, { [firstRole(property)]: p }, { polarity: 'negated' })]);
    canon.query = { ask: 'every', where: [{ relation: restriction, args: ['?m', org.id], negated: false }], scope: [{ relation: property, args: ['?m'], negated: true }] };
    return base('ambiguity_visible', `scope_${unresolved ? 'unresolved' : 'resolved'}`, ['ambignq', 'proofwriter'], { canon, facts, asUnclear: unresolved,
      plan: { clauses: [], question: { custom, slots: { org }, ask: 'every', id: `scope.${restriction}` } }, expect: unresolved ? 'unclear' : 'supported', mentioned: [org], worldOnly: members, predicates: [restriction, property] });
  }
  const person = k.world.make('person'), town = k.world.make('city');
  const custom = Object.fromEntries(['en', 'ro'].map(language => [language, PP[language].map(([text, readings]) => [text, () => [], { qtype: 'yes_no', unclearReadings: t => readingsOf(readings, { A: JSON.parse(t.A), town: t.town ? JSON.parse(t.town) : '' }) }])]));
  return base('ambiguity_visible', 'pp_attachment_unresolved', ['ambignq'], { canon, asUnclear: true, plan: { clauses: [], question: { custom, slots: { A: person, town }, ask: 'whether', id: 'pp' } },
    expect: 'unclear', mentioned: [person, town], predicates: [] });
}

export const QUESTION_FAMILIES = {
  time_question: timeQuestion, where_question: whereQuestion, how_question: howQuestion, why_question: whyQuestion,
  conjunction, interpretation, anchor, ambiguity_visible: visibleAmbiguity,
};

/** Every family of the generator: families.mjs, the question-form families above, and `general_quantification`
 * (a formerly blocked family), which is now the universal question (mode every). */
export const ALL_FAMILIES = { ...FAMILIES, ...QUESTION_FAMILIES, general_quantification: universal };
