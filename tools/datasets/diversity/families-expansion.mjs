/** Expansion families (DS015 "Expansion families"; owner decisions Q-LANG-1..7 and conventions C1–C12 of DS014).
 *
 * Each family authors whole messages (EN and RO) together with their targets, through the custom path of
 * generate.mjs: a variant is `[template, values => shape, extra]`, where the shape may state propositions, ask one
 * or more queries, pose a constraint, and use the words-only query fields (`compare`, `rank`, `quantifier`,
 * `order`, `fragment`, `except`). Targets are canonical English (Q-DATA-6): a Romanian variant writes the English
 * phrase and records its own phrase as `source_relation` (the relation-phrase convention is checked on it).
 * The designs come from the gap list of the data-expansion proposal, never from an evaluation suite.
 */
import { PREDICATES } from './domains.mjs';
import { canonical, emptyCanon } from './ir.mjs';
import { base, entities, date } from './families.mjs';

const P = (relation, roles, polarity = 'affirmed') => ({ relation, roles, polarity });
/** A proposition of a Romanian variant: the English phrase plus the message's own phrase. */
const R = (relation, source, roles, polarity = 'affirmed') => ({ relation, source_relation: source, roles, polarity });
const pick = (k, list) => list[k.random.int(list.length)];
const q = value => JSON.stringify(value);
/** Amount of money as written: EN "350 lei"; RO puts "de" from 20 up ("350 de lei"); the target is English. */
const amount = (n, language) => language === 'ro' && (n % 100 >= 20 || (n >= 100 && n % 100 === 0)) ? `${n} de lei` : `${n} lei`;
/** A person whose surname differs from every person already in the case ("Mr Kovalenko" must name one person). */
const person = k => {
  const taken = new Set(k.world.list().filter(e => e.type === 'person').map(e => e.surname));
  for (let attempt = 0; attempt < 30; attempt++) { const p = k.world.make('person'); if (!taken.has(p.surname)) return p; }
  return k.world.make('person');
};

// ---------------------------------------------------------------- coordination (C5)
const COORD = [
  { relation: 'works_at', role: 'object', type: 'company', en: ['work at', '{A} and {B} work at {O}. Does {C} work at {O} too?', '{A} and {B} both work at {O}. What about {C}, does {C} work at {O}?'],
    ro: ['lucra la', '{A} și {B} lucrează la {O}. Lucrează și {C} la {O}?', 'Atât {A} cât și {B} lucrează la {O}. {C} lucrează la {O}?'] },
  { relation: 'lives_in', role: 'location', type: 'city', en: ['live in', '{A} and {B} live in {O}. Does {C} live in {O} as well?', '{A} and {B} both live in {O}. Does {C} live in {O}?'],
    ro: ['locui în', '{A} și {B} locuiesc în {O}. Locuiește și {C} în {O}?', 'Și {A}, și {B} locuiesc în {O}. {C} locuiește în {O}?'] },
  { relation: 'plays_for', role: 'object', type: 'team', en: ['play for', '{A} and {B} play for {O}. Does {C} play for {O} too?'], ro: ['juca la', '{A} și {B} joacă la {O}. Joacă și {C} la {O}?'] },
  { relation: 'studies_at', role: 'object', type: 'school', en: ['study at', '{A} and {B} study at {O}. Does {C} study at {O} too?'], ro: ['învăța la', '{A} și {B} învață la {O}. Învață și {C} la {O}?'] },
];
export function coordination(k) {
  if (k.random.chance(0.3)) return collective(k);
  const sc = pick(k, COORD);
  const [a, b, c] = [person(k), person(k), person(k)];
  const o = k.world.make(sc.type);
  const [r0, r1] = PREDICATES[sc.relation].roles.map(([name]) => name);
  const known = k.random.chance(0.5);
  const facts = known ? [canonical(sc.relation, { [r0]: c, [r1]: o })] : [];
  const canon = emptyCanon();
  canon.stated.push(...[a, b].map(x => ({ ...canonical(sc.relation, { [r0]: x, [r1]: o }), certainty: 'asserted' })));
  canon.query = { ask: 'whether', where: [{ relation: sc.relation, args: [c.id, o.id], negated: false }] };
  const variants = language => sc[language].slice(1).map(template => [template, t => {
    const make = (s, obj) => language === 'en' ? P(sc.en[0], [['subject', s], [sc.role, obj]]) : R(sc.en[0], sc.ro[0], [['subject', s], [sc.role, obj]]);
    return { ask: 'whether', stated: [make(t.A, t.O), make(t.B, t.O)], props: [make(t.C, t.O)] };
  }, { qtype: 'yes_no' }]);
  return base('coordination', `distributive_${sc.relation}`, ['qqp'], { canon, facts,
    plan: { clauses: [], question: { custom: { en: variants('en'), ro: variants('ro') }, slots: { A: a, B: b, C: c, O: o }, ask: 'whether', id: `coordination.${sc.relation}` } },
    expect: known ? 'supported' : 'unknown', mentioned: [a, b, c, o], predicates: [sc.relation] });
}
/** A collective predicate keeps one conjoined value (C5): "Ana and Ion bought the flat together." */
function collective(k) {
  const [a, b] = [person(k), person(k)];
  const flat = k.world.make('asset');
  const group = k.world.add({ id: `${a.id}_and_${b.id}`, type: 'group', gender: 'm', translateLabel: true, labels: { en: `${a.short} and ${b.short}`, ro: `${a.short} și ${b.short}` }, short: null });
  const owns = k.random.chance(0.5);
  const facts = owns ? [canonical('owns', { owner: a, property: flat })] : [];
  const canon = emptyCanon();
  canon.stated.push({ ...canonical('bought_together', { buyers: group, property: flat }), certainty: 'asserted' });
  canon.query = { ask: 'whether', where: [{ relation: 'owns', args: [a.id, flat.id], negated: false }] };
  const custom = {
    en: [['{G} bought {F} together. Does {A} own {F}?', t => ({ ask: 'whether', stated: [P('buy together', [['subject', t.G], ['object', t.F]])], props: [P('own', [['subject', t.A], ['object', t.F]])] }), { qtype: 'yes_no' }]],
    ro: [['{G} au cumpărat împreună {F}. {A} deține {F}?', t => ({ ask: 'whether', stated: [R('buy together', 'cumpăra împreună', [['subject', t.G], ['object', t.F]])], props: [R('own', 'deține', [['subject', t.A], ['object', t.F]])] }), { qtype: 'yes_no' }]],
  };
  return base('coordination', 'collective', ['qqp'], { canon, facts, plan: { clauses: [], question: { custom, slots: { G: group, A: a, F: flat }, ask: 'whether', id: 'coordination.collective' } },
    expect: owns ? 'supported' : 'unknown', mentioned: [group, a, flat], worldOnly: [b], predicates: ['bought_together', 'owns'] });
}

// ---------------------------------------------------------------- several participants (recipient, source, destination)
export function transfer(k) {
  if (k.random.chance(0.45)) return move(k);
  const [a, b, c] = [person(k), person(k), person(k)];
  const n = pick(k, [40, 75, 150, 200, 350, 1200, 2500]), m = pick(k, [60, 90, 300, 500]);
  const facts = [canonical('sent_to', { sender: a, item: q(`${n} lei`), recipient: b })];
  const canon = emptyCanon();
  const variant = k.random.chance(0.5) ? 'who' : 'statement';
  let custom, expect, translated;
  if (variant === 'who') {
    canon.query = { ask: 'which', select: ['?r'], where: [{ relation: 'sent_to', args: [a.id, q(`${n} lei`), '?r'], negated: false }] };
    custom = {
      en: [[`Who did {A} send ${n} lei to?`, t => ({ ask: 'which', select: ['?r'], props: [P('send', [['subject', t.A], ['object', q(`${n} lei`)], ['recipient', '?r']])] }), { qtype: 'wh' }],
        [`I know {A} sent ${n} lei to someone last month. Who was it sent to?`, t => ({ ask: 'which', select: ['?r'], props: [P('send', [['subject', t.A], ['object', q(`${n} lei`)], ['recipient', '?r']])] }), { qtype: 'wh' }]],
      // A transferred amount is a value written as in the message (C11); Romanian users commonly write "350 lei".
      ro: [[`Cui i-a trimis {A} ${n} lei?`, t => ({ ask: 'which', select: ['?r'], props: [R('send', 'trimite', [['subject', t.A], ['object', q(`${n} lei`)], ['recipient', '?r']])] }), { qtype: 'wh' }]],
    };
    expect = 'supported';
  } else {
    const sent = k.random.chance(0.5);
    if (sent) facts.push(canonical('sent_to', { sender: c, item: q(`${m} lei`), recipient: a }));
    canon.stated.push({ ...canonical('sent_to', { sender: a, item: q(`${n} lei`), recipient: b }), certainty: 'asserted' });
    canon.query = { ask: 'whether', where: [{ relation: 'sent_to', args: [c.id, q(`${m} lei`), a.id], negated: false }] };
    const shape = (t, make) => ({ ask: 'whether', stated: [make([['subject', t.A], ['object', q(`${n} lei`)], ['recipient', t.B]])], props: [make([['subject', t.C], ['object', q(`${m} lei`)], ['recipient', t.A]])] });
    custom = {
      en: [[`{A} sent ${n} lei to {B} through the bank. Did {C} send ${m} lei to {A}?`, t => shape(t, roles => P('send', roles)), { qtype: 'yes_no' }]],
      ro: [[`{A} i-a trimis ${n} lei lui {B} prin bancă. {C} i-a trimis ${m} lei lui {A}?`, t => shape(t, roles => R('send', 'trimite', roles)), { qtype: 'yes_no' }]],
    };
    expect = sent ? 'supported' : 'unknown';
  }
  return base('transfer', `send_${variant}`, ['qa2d'], { canon, facts, plan: { clauses: [], question: { custom, slots: { A: a, B: b, C: c }, ask: canon.query.ask, id: `transfer.send.${variant}` } },
    expect, mentioned: variant === 'who' ? [a] : [a, b, c], answers: variant === 'who' ? [b] : [], worldOnly: variant === 'who' ? [c] : [], predicates: ['sent_to'] });
}
function move(k) {
  const [a, b] = [person(k), person(k)];
  const [x, y, x2, y2] = [k.world.make('city'), k.world.make('city'), k.world.make('city'), k.world.make('city')];
  const facts = [canonical('moved', { person: a, origin: x2, destination: y2 })];
  const canon = emptyCanon();
  canon.stated.push({ ...canonical('moved', { person: b, origin: x, destination: y }), certainty: 'asserted' });
  canon.query = { ask: 'which', select: ['?place'], where: [{ relation: 'moved', args: [a.id, '?place', '?to'], negated: false }] };
  const shape = (t, make) => ({ ask: 'which', select: ['?place'], stated: [make([['subject', t.B], ['source', t.X], ['destination', t.Y]])], props: [make([['subject', t.A], ['source', '?place']])] });
  const custom = {
    en: [['{B} moved from {X} to {Y}. Where did {A} move from?', t => shape(t, roles => P('move', roles)), { qtype: 'where' }],
      ['{B} moved from {X} to {Y} a while ago. And where did {A} move from?', t => shape(t, roles => P('move', roles)), { qtype: 'where' }]],
    ro: [['{B} s-a mutat din {X} în {Y}. De unde s-a mutat {A}?', t => shape(t, roles => R('move', 'se muta', roles)), { qtype: 'where' }]],
  };
  return base('transfer', 'move_from', ['qa2d'], { canon, facts, plan: { clauses: [], question: { custom, slots: { A: a, B: b, X: x, Y: y }, ask: 'which', id: 'transfer.move' } },
    expect: 'supported', mentioned: [a, b, x, y], answers: [x2], worldOnly: [y2], predicates: ['moved'] });
}

// ---------------------------------------------------------------- existence ("is there", "există vreo")
export function existence(k) {
  const org = k.world.make('company'), town = k.world.make('city'), p = person(k), other = k.world.make('city');
  const yes = k.random.chance(0.5);
  const facts = [canonical('works_at', { employee: p, employer: org }), canonical('lives_in', { resident: p, town: yes ? town : other })];
  const canon = emptyCanon();
  canon.query = { ask: 'whether', where: [{ relation: 'works_at', args: ['?x', org.id], negated: false }, { relation: 'lives_in', args: ['?x', town.id], negated: false }] };
  const outside = k.random.chance(0.35);
  const props = (t, en, pol = 'affirmed') => en ? [P('work at', [['subject', '?x'], ['object', t.O]]), P('live in', [['subject', '?x'], ['location', t.T]], pol)]
    : [R('work at', 'lucra la', [['subject', '?x'], ['object', t.O]]), R('live in', 'locui în', [['subject', '?x'], ['location', t.T]], pol)];
  if (outside) {
    const custom = {
      en: [['Is there anyone at {O} who works there but does not live in {T}?', t => ({ ask: 'whether', props: props(t, true, 'negated') }), { qtype: 'exists' }]],
      ro: [['Există cineva care lucrează la {O} și nu locuiește în {T}?', t => ({ ask: 'whether', props: props(t, false, 'negated') }), { qtype: 'exists' }]],
    };
    if (!yes) facts.push(canonical('lives_in', { resident: p, town }, { polarity: 'negated' }));
    return base('existence', 'exists_not', ['qa2d'], { canon, facts, plan: { clauses: [], question: { custom, slots: { O: org, T: town }, ask: 'whether', id: 'existence.works_not_lives' } },
      expect: null, mentioned: [org, town], worldOnly: [p, other], predicates: ['works_at', 'lives_in'] });
  }
  const custom = {
    en: [['Is there anyone who works at {O} and lives in {T}?', t => ({ ask: 'whether', props: props(t, true) }), { qtype: 'exists' }],
      ['Does anyone working at {O} live in {T}?', t => ({ ask: 'whether', props: props(t, true) }), { qtype: 'exists' }],
      ['Is there somebody at {O} who works there and lives in {T}?', t => ({ ask: 'whether', props: props(t, true) }), { qtype: 'exists' }]],
    ro: [['Există cineva care lucrează la {O} și locuiește în {T}?', t => ({ ask: 'whether', props: props(t, false) }), { qtype: 'exists' }],
      ['E vreun om care lucrează la {O} și locuiește în {T}?', t => ({ ask: 'whether', props: props(t, false) }), { qtype: 'exists' }]],
  };
  return base('existence', yes ? 'exists' : 'none_known', ['qa2d'], { canon, facts, plan: { clauses: [], question: { custom, slots: { O: org, T: town }, ask: 'whether', id: 'existence.works_lives' } },
    expect: yes ? 'supported' : 'unknown', mentioned: [org, town], worldOnly: [p, other], predicates: ['works_at', 'lives_in'] });
}

// ---------------------------------------------------------------- if/then conditionals (supposition + query)
export function conditional(k) {
  const a = person(k), org = k.world.make('company');
  const negated = k.random.chance(0.35);
  const pol = negated ? 'negated' : 'affirmed';
  const canon = emptyCanon();
  canon.stated.push({ ...canonical('works_at', { employee: a, employer: org }, { polarity: pol }), certainty: 'supposed' });
  canon.query = { ask: 'whether', where: [{ relation: 'authorized', args: [a.id], negated: false }] };
  const shape = (t, en) => ({ ask: 'whether', stated: [{ ...(en ? P('work at', [['subject', t.A], ['object', t.O]], pol) : R('work at', 'lucra la', [['subject', t.A], ['object', t.O]], pol)), certainty: 'supposed' }],
    props: [en ? P('have access to the lab', [['subject', t.A]]) : R('have access to the lab', 'avea acces în laborator', [['subject', t.A]])] });
  const custom = negated ? {
    en: [["If {A} doesn't work at {O}, then does {A} still have access to the lab?", t => shape(t, true), { qtype: 'yes_no' }]],
    ro: [['Dacă {A} nu lucrează la {O}, atunci are {A} acces în laborator?', t => shape(t, false), { qtype: 'yes_no' }]],
  } : {
    en: [['If {A} works at {O}, then does {A} have access to the lab?', t => shape(t, true), { qtype: 'yes_no' }],
      ['Suppose {A} works at {O}: does {A} have access to the lab then?', t => shape(t, true), { qtype: 'yes_no' }]],
    ro: [['Dacă {A} lucrează la {O}, atunci are {A} acces în laborator?', t => shape(t, false), { qtype: 'yes_no' }]],
  };
  return base('conditional', negated ? 'if_not_then' : 'if_then', ['proofwriter'], { canon, rules: [{ when: [`works_at ?x ${org.id}`], then: 'authorized ?x' }],
    plan: { clauses: [], question: { custom, slots: { A: a, O: org }, ask: 'whether', id: `conditional.${negated ? 'if_not' : 'if'}` } },
    expect: null, mentioned: [a, org], predicates: ['works_at', 'authorized'] });
}

// ---------------------------------------------------------------- values, comparisons and superlatives (Q-LANG-1, C11)
export function attributeValue(k) {
  const kind = pick(k, ['cost', 'cost', 'cost_compare', 'age', 'older', 'over', 'oldest', 'cheapest', 'opening']);
  const canon = emptyCanon();
  if (kind === 'cost' || kind === 'cost_compare') {
    const item = k.world.make('asset'), price = 1000 * (5 + k.random.int(60));
    const known = k.random.chance(0.8);
    const facts = known ? [canonical('costs', { item, price: String(price) })] : [];
    const n = kind === 'cost' ? null : 1000 * (5 + k.random.int(60));
    const comparator = pick(k, [['above', 'more than', 'mai mult de'], ['below', 'less than', 'mai puțin de'], ['at_least', 'at least', 'cel puțin']]);
    const compare = n ? { compare: [['?price', comparator[0], String(n)]] } : {};
    canon.query = { ask: n ? 'whether' : 'which', select: ['?price'], where: [{ relation: 'costs', args: [item.id, '?price'], negated: false }] };
    const shape = (t, en) => ({ ask: n ? 'whether' : 'which', ...(n ? {} : { select: ['?price'] }), props: [en ? P('cost', [['subject', t.I], ['object', '?price']]) : R('cost', 'costa', [['subject', t.I], ['object', '?price']])], ...compare });
    const custom = n ? {
      en: [[`Does {I} cost ${comparator[1]} ${n} lei?`, t => shape(t, true), { qtype: 'compare' }], [`Is it true that {I} costs ${comparator[1]} ${n} lei?`, t => shape(t, true), { qtype: 'compare' }]],
      ro: [[`Costă {I} ${comparator[2]} ${amount(n, 'ro')}?`, t => shape(t, false), { qtype: 'compare' }]],
    } : {
      en: [['How much does {I} cost?', t => shape(t, true), { qtype: 'value' }], ['What does {I} cost these days?', t => shape(t, true), { qtype: 'value' }]],
      ro: [['Cât costă {I}?', t => shape(t, false), { qtype: 'value' }], ['Știi cât costă {I}?', t => shape(t, false), { qtype: 'value' }]],
    };
    const holds = n === null ? known : known && ({ above: price > n, below: price < n, at_least: price >= n })[comparator[0]];
    return base('attribute_value', `${kind}_${n ? comparator[0] : 'value'}`, ['squad'], { canon, facts, plan: { clauses: [], question: { custom, slots: { I: item }, ask: canon.query.ask, id: `value.${kind}.${n ? comparator[0] : 'plain'}` } },
      expect: n ? (holds ? 'supported' : null) : known ? 'supported' : 'unknown', mentioned: [item], predicates: ['costs'] });
  }
  if (kind === 'opening') {
    const venue = k.world.make('venue'), hour = pick(k, ['07:00', '08:00', '08:30', '09:00', '10:00']);
    const facts = [canonical('opens_at', { venue, hour: q(hour) })];
    canon.query = { ask: 'which', select: ['?hour'], where: [{ relation: 'opens_at', args: [venue.id, '?hour'], negated: false }] };
    const custom = {
      en: [['What time does {V} open?', t => ({ ask: 'which', select: ['?hour'], props: [P('open at', [['subject', t.V], ['time', '?hour']])] }), { qtype: 'value' }],
        ['When does {V} open in the morning?', t => ({ ask: 'which', select: ['?hour'], props: [P('open at', [['subject', t.V], ['time', '?hour']])] }), { qtype: 'value' }]],
      ro: [['La ce oră se deschide {V}?', t => ({ ask: 'which', select: ['?hour'], props: [R('open at', 'se deschide la', [['subject', t.V], ['time', '?hour']])] }), { qtype: 'value' }]],
    };
    return base('attribute_value', 'opening_time', ['squad'], { canon, facts, plan: { clauses: [], question: { custom, slots: { V: venue }, ask: 'which', id: 'value.opening' } },
      expect: null, mentioned: [venue], predicates: ['opens_at'] });
  }
  if (kind === 'cheapest') {
    const owner = person(k), items = [k.world.make('asset'), k.world.make('asset'), k.world.make('asset')];
    const prices = items.map(() => 1000 * (10 + k.random.int(90)));
    const facts = items.flatMap((item, i) => [canonical('owns', { owner, property: item }), canonical('costs', { item, price: String(prices[i]) })]);
    const lowest = pick(k, [true, false]);
    canon.query = { ask: 'which', select: ['?p'], where: [{ relation: 'owns', args: [owner.id, '?p'], negated: false }, { relation: 'costs', args: ['?p', '?price'], negated: false }] };
    const shape = (t, en) => ({ ask: 'which', select: ['?p'], rank: [lowest ? 'lowest' : 'highest', '?price'],
      props: en ? [P('own', [['subject', t.A], ['object', '?p']]), P('cost', [['subject', '?p'], ['object', '?price']])] : [R('own', 'deține', [['subject', t.A], ['object', '?p']]), R('cost', 'costa', [['subject', '?p'], ['object', '?price']])] });
    const custom = {
      en: [[`Which property that {A} owns costs the ${lowest ? 'least' : 'most'}?`, t => shape(t, true), { qtype: 'superlative' }]],
      ro: [[`Ce proprietate deținută de {A} costă cel mai ${lowest ? 'puțin' : 'mult'}?`, t => shape(t, false), { qtype: 'superlative' }]],
    };
    const best = prices.indexOf(lowest ? Math.min(...prices) : Math.max(...prices));
    return base('attribute_value', lowest ? 'cheapest' : 'most_expensive', ['squad'], { canon, facts, plan: { clauses: [], question: { custom, slots: { A: owner }, ask: 'which', id: `value.rank.${lowest ? 'low' : 'high'}` } },
      expect: null, mentioned: [owner], answers: [items[best]], worldOnly: items.filter((_, i) => i !== best), predicates: ['owns', 'costs'] });
  }
  // Ages: a value, a comparison between two people, a filtered selection and a superlative.
  const org = k.world.make('company');
  const people = [person(k), person(k), person(k)];
  const ages = people.map(() => 20 + k.random.int(60));
  const facts = people.flatMap((p, i) => [canonical('aged', { person: p, age: String(ages[i]) }), canonical('works_at', { employee: p, employer: org })]);
  const [a, b] = people;
  const age = (s, v, en) => en ? P('be old', [['subject', s], ['object', v]]) : R('be old', 'avea ani', [['subject', s], ['object', v]]);
  let custom, ask, slots = { A: a, B: b, O: org }, mentioned = [a];
  if (kind === 'age') {
    ask = 'which';
    custom = { en: [['How old is {A}?', t => ({ ask, select: ['?age'], props: [age(t.A, '?age', true)] }), { qtype: 'value' }]],
      ro: [['Câți ani are {A}?', t => ({ ask, select: ['?age'], props: [age(t.A, '?age', false)] }), { qtype: 'value' }]] };
  } else if (kind === 'older') {
    ask = 'whether'; mentioned = [a, b];
    const shape = (t, en) => ({ ask, props: [age(t.A, '?a', en), age(t.B, '?b', en)], compare: [['?a', 'above', '?b']] });
    custom = { en: [['Is {A} older than {B}?', t => shape(t, true), { qtype: 'compare' }], ['Would you say {A} is older than {B}?', t => shape(t, true), { qtype: 'compare' }]],
      ro: [['Are {A} mai mulți ani decât {B}?', t => shape(t, false), { qtype: 'compare' }]] };
  } else {
    const n = 30 + 5 * k.random.int(8);
    ask = 'which'; mentioned = [org];
    const inOrg = (t, en) => en ? P('work at', [['subject', '?x'], ['object', t.O]]) : R('work at', 'lucra la', [['subject', '?x'], ['object', t.O]]);
    if (kind === 'over') custom = {
      en: [[`Who works at {O} and is over ${n} years old?`, t => ({ ask, select: ['?x'], props: [inOrg(t, true), age('?x', '?age', true)], compare: [['?age', 'above', String(n)]] }), { qtype: 'compare' }]],
      ro: [[`Cine lucrează la {O} și are peste ${n} de ani?`, t => ({ ask, select: ['?x'], props: [inOrg(t, false), age('?x', '?age', false)], compare: [['?age', 'above', String(n)]] }), { qtype: 'compare' }]] };
    else custom = {
      en: [['Who is the oldest person working at {O}?', t => ({ ask, select: ['?x'], props: [inOrg(t, true), age('?x', '?age', true)], rank: ['highest', '?age'] }), { qtype: 'superlative' }]],
      ro: [['Cine are cei mai mulți ani dintre cei care lucrează la {O}?', t => ({ ask, select: ['?x'], props: [inOrg(t, false), age('?x', '?age', false)], rank: ['highest', '?age'] }), { qtype: 'superlative' }]] };
  }
  canon.query = { ask, where: [{ relation: 'aged', args: [a.id, '?age'], negated: false }] };
  return base('attribute_value', kind, ['squad'], { canon, facts, plan: { clauses: [], question: { custom, slots, ask, id: `value.${kind}` } },
    expect: kind === 'age' ? 'supported' : null, mentioned, worldOnly: people.filter(p => !mentioned.includes(p)), predicates: ['aged', 'works_at'] });
}

// ---------------------------------------------------------------- definitions
const MEANINGS = { 'force majeure': 'an event beyond the control of the parties', 'due diligence': 'a careful check before a deal', 'a power of attorney': 'a written authority to act for another person',
  escrow: 'money held by a third party until a deal closes', amortization: 'paying off a debt in regular installments', 'a lien': 'a right to keep property until a debt is paid',
  'the statute of limitations': 'the time limit for bringing a claim', 'a notarized statement': 'a statement certified by a notary', 'a grace period': 'extra time before a penalty applies', 'a deductible': 'the part of a claim the insured pays' };
export function definition(k) {
  if (k.random.chance(0.35)) return twoDefinitions(k);
  const term = k.world.make('term');
  const known = k.random.chance(0.7);
  const facts = known ? [canonical('means', { term, meaning: q(MEANINGS[term.labels.en] ?? 'a defined term') })] : [];
  const canon = emptyCanon();
  canon.query = { ask: 'which', select: ['?m'], where: [{ relation: 'means', args: [term.id, '?m'], negated: false }] };
  const shape = (t, en) => ({ ask: 'which', select: ['?m'], props: [en ? P('mean', [['subject', t.T], ['object', '?m']]) : R('mean', 'însemna', [['subject', t.T], ['object', '?m']])] });
  const custom = {
    en: [['What does {T} mean?', t => shape(t, true), { qtype: 'definition' }], ['What is the meaning of {T}?', t => shape(t, true), { qtype: 'definition' }], ['{T} meaning??', t => shape(t, true), { qtype: 'definition' }]],
    ro: [['Ce înseamnă {T}?', t => shape(t, false), { qtype: 'definition' }], ['Poți să-mi spui ce înseamnă {T}?', t => shape(t, false), { qtype: 'definition' }]],
  };
  return base('definition', known ? 'known' : 'unknown', ['squad'], { canon, facts, plan: { clauses: [], question: { custom, slots: { T: term }, ask: 'which', id: 'definition.mean' } },
    expect: known ? 'supported' : 'unknown', mentioned: [term], predicates: ['means'] });
}

function twoDefinitions(k) {
  const [t1, t2] = [k.world.make('term'), k.world.make('term')];
  const facts = [t1, t2].map(term => canonical('means', { term, meaning: q(MEANINGS[term.labels.en] ?? 'a defined term') }));
  const canon = emptyCanon();
  canon.query = { ask: 'which', select: ['?m'], where: [{ relation: 'means', args: [t1.id, '?m'], negated: false }] };
  const mean = (term, v, en) => en ? P('mean', [['subject', term], ['object', v]]) : R('mean', 'însemna', [['subject', term], ['object', v]]);
  const shape = en => t => ({ ask: 'which', select: ['?m'], props: [mean(t.A, '?m', en)], moreQueries: [{ ask: 'which', select: ['?n'], props: [mean(t.B, '?n', en)] }] });
  const custom = {
    en: [['What do {A} and {B} mean?', shape(true), { qtype: 'definition' }], ['Quick one: what does {A} mean, and what does {B} mean?', shape(true), { qtype: 'definition' }]],
    ro: [['Ce înseamnă {A} și ce înseamnă {B}?', shape(false), { qtype: 'definition' }]],
  };
  return base('definition', 'two_terms', ['squad'], { canon, facts, plan: { clauses: [], question: { custom, slots: { A: t1, B: t2 }, ask: 'which', id: 'definition.two' } },
    expect: 'supported', expect2: 'supported', mentioned: [t1, t2], predicates: ['means'] });
}

// ---------------------------------------------------------------- counts with a condition (compare, except)
export function filteredCount(k) {
  const org = k.world.make('company'), people = Array.from({ length: 3 + k.random.int(3) }, () => person(k));
  const ages = people.map(() => 20 + k.random.int(60));
  const facts = people.flatMap((p, i) => [canonical('works_at', { employee: p, employer: org }), canonical('aged', { person: p, age: String(ages[i]) })]);
  const canon = emptyCanon();
  canon.query = { ask: 'count', select: ['?x'], where: [{ relation: 'works_at', args: ['?x', org.id], negated: false }] };
  const work = (t, en) => en ? P('work at', [['subject', '?x'], ['object', t.O]]) : R('work at', 'lucra la', [['subject', '?x'], ['object', t.O]]);
  if (k.random.chance(0.5)) {
    const n = 30 + 5 * k.random.int(8);
    const custom = {
      en: [[`How many people who work at {O} are over ${n} years old?`, t => ({ ask: 'count', select: ['?x'], props: [work(t, true), P('be old', [['subject', '?x'], ['object', '?age']])], compare: [['?age', 'above', String(n)]] }), { qtype: 'count' }]],
      ro: [[`Câți oameni care lucrează la {O} au peste ${n} de ani?`, t => ({ ask: 'count', select: ['?x'], props: [work(t, false), R('be old', 'avea ani', [['subject', '?x'], ['object', '?age']])], compare: [['?age', 'above', String(n)]] }), { qtype: 'count' }]],
    };
    return base('filtered_count', 'over_age', ['squad'], { canon, facts, plan: { clauses: [], question: { custom, slots: { O: org }, ask: 'count', id: 'count.over_age' } },
      expect: null, mentioned: [org], worldOnly: people, predicates: ['works_at', 'aged'] });
  }
  const excluded = people[0];
  const custom = {
    en: [['How many people work at {O}, not counting {X}?', t => ({ ask: 'count', select: ['?x'], props: [work(t, true)], filter: [`?x != ${t.X}`] }), { qtype: 'count' }],
      ['Apart from {X}, how many people work at {O}?', t => ({ ask: 'count', select: ['?x'], props: [work(t, true)], filter: [`?x != ${t.X}`] }), { qtype: 'count' }]],
    ro: [['Câți oameni lucrează la {O}, fără {X}?', t => ({ ask: 'count', select: ['?x'], props: [work(t, false)], filter: [`?x != ${t.X}`] }), { qtype: 'count' }]],
  };
  return base('filtered_count', 'except', ['squad'], { canon, facts, plan: { clauses: [], question: { custom, slots: { O: org, X: excluded }, ask: 'count', id: 'count.except' } },
    expect: null, mentioned: [org, excluded], worldOnly: people.slice(1), predicates: ['works_at', 'aged'] });
}

// ---------------------------------------------------------------- quantifiers on mode every (Q-LANG-2)
const QUANT = [
  { word: 'most', en: 'Are most players of {T} certified?', ro: 'Majoritatea jucătorilor de la {T} sunt certificați?' },
  { word: 'half', en: 'Are exactly half of the players of {T} certified?', ro: 'Exact jumătate dintre jucătorii de la {T} sunt certificați?' },
  { word: 'not_all', en: 'Is it true that not all players of {T} are certified?', ro: 'E adevărat că nu toți jucătorii de la {T} sunt certificați?' },
  { word: 'none', en: 'Is none of the players of {T} certified?', ro: 'Niciunul dintre jucătorii de la {T} nu e certificat?' },
  { word: 'all', en: 'Are all the players of {T} certified?', ro: 'Toți jucătorii de la {T} sunt certificați?' },
  { word: 'at_least', en: 'Are at least {N} players of {T} certified?', ro: 'Cel puțin {N} jucători de la {T} sunt certificați?' },
];
export function quantified(k) {
  const sc = pick(k, QUANT);
  const team = k.world.make('team'), members = Array.from({ length: 4 + k.random.int(3) }, () => person(k));
  const certified = members.map(() => k.random.chance(0.6));
  const facts = members.flatMap((p, i) => [canonical('plays_for', { player: p, team }), canonical('certified', { [PREDICATES.certified.roles[0][0]]: p }, { polarity: certified[i] ? 'affirmed' : 'negated' })]);
  const n = 2 + k.random.int(3);
  const word = sc.word === 'at_least' ? `at_least ${n}` : sc.word;
  const canon = emptyCanon();
  canon.query = { ask: 'every', where: [{ relation: 'plays_for', args: ['?m', team.id], negated: false }], scope: [{ relation: 'certified', args: ['?m'], negated: false }] };
  const shape = (t, en) => ({ ask: 'every', quantifier: word,
    props: [en ? P('be a player of', [['subject', '?m'], ['object', t.T]]) : R('be a player of', 'fi jucător la', [['subject', '?m'], ['object', t.T]])],
    scope: [en ? P('be certified', [['subject', '?m']]) : R('be certified', 'fi certificat', [['subject', '?m']])] });
  const custom = { en: [[sc.en.replace('{N}', n), t => shape(t, true), { qtype: 'quantified' }]], ro: [[sc.ro.replace('{N}', n), t => shape(t, false), { qtype: 'quantified' }]] };
  return base('quantified', sc.word, ['proofwriter'], { canon, facts, plan: { clauses: [], question: { custom, slots: { T: team }, ask: 'every', id: `quantified.${sc.word}` } },
    expect: null, mentioned: [team], worldOnly: members, predicates: ['plays_for', 'certified'] });
}

// ---------------------------------------------------------------- ordering of two events (Q-LANG-3)
export function ordering(k) {
  const [a, b] = [person(k), person(k)];
  const living = k.random.chance(0.5);
  const relation = living ? 'lives_in' : 'works_at';
  const o = k.world.make(living ? 'city' : 'company');
  const [r0, r1] = PREDICATES[relation].roles.map(([name]) => name);
  const ya = 2012 + k.random.int(10), yb = 2012 + k.random.int(10);
  const facts = [canonical(relation, { [r0]: a, [r1]: o }, { time: { from: date(ya, 3, 1) } }), canonical(relation, { [r0]: b, [r1]: o }, { time: { from: date(yb, 9, 1) } })];
  const word = k.random.chance(0.5) ? 'before' : 'after';
  const canon = emptyCanon();
  canon.query = { ask: 'whether', where: [{ relation, args: [a.id, o.id], negated: false }, { relation, args: [b.id, o.id], negated: false }] };
  const [en, ro, role] = living ? ['live in', 'locui în', 'location'] : ['work at', 'lucra la', 'object'];
  const shape = (t, english) => ({ ask: 'whether', order: ['?t1', word, '?t2'],
    props: [[t.A, '?t1'], [t.B, '?t2']].map(([s, time]) => english ? P(en, [['subject', s], [role, t.O], ['time', time]]) : R(en, ro, [['subject', s], [role, t.O], ['time', time]])) });
  const enText = living ? `Did {A} start living in {O} ${word} {B} did?` : `Did {A} start working at {O} ${word} {B} did?`;
  const roText = living ? `{A} a început să locuiască în {O} ${word === 'before' ? 'înainte de' : 'după'} {B}?` : `{A} a început să lucreze la {O} ${word === 'before' ? 'înainte de' : 'după'} {B}?`;
  const custom = { en: [[enText, t => shape(t, true), { qtype: 'order' }]], ro: [[roText, t => shape(t, false), { qtype: 'order' }]] };
  return base('ordering', `${relation}_${word}`, ['proofwriter'], { canon, facts, plan: { clauses: [], question: { custom, slots: { A: a, B: b, O: o }, ask: 'whether', id: `ordering.${relation}.${word}` } },
    expect: null, mentioned: [a, b, o], predicates: [relation] });
}

// ---------------------------------------------------------------- elliptical follow-ups (Q-LANG-4)
export function fragment(k) {
  if (k.random.chance(0.4)) return fragmentPlace(k);
  const a = person(k);
  const shape = t => ({ ask: 'whether', fragment: 'follow_up', props: [{ roles: [['subject', t.A]], polarity: 'affirmed' }] });
  const custom = {
    en: [['And {A}?', shape, { qtype: 'fragment' }], ['What about {A}?', shape, { qtype: 'fragment' }], ['How about {A}?', shape, { qtype: 'fragment' }], ['ok and {A}?', shape, { qtype: 'fragment' }]],
    ro: [['Dar {A}?', shape, { qtype: 'fragment' }], ['Și {A}?', shape, { qtype: 'fragment' }], ['Dar cu {A} cum rămâne?', shape, { qtype: 'fragment' }]],
  };
  const canon = emptyCanon();
  canon.query = { ask: 'whether', where: [] };
  return base('fragment', 'follow_up', ['qqp'], { canon, plan: { clauses: [], question: { custom, slots: { A: a }, ask: 'whether', id: 'fragment.follow_up' } },
    expect: 'clarify', mentioned: [a], predicates: [] });
}

function fragmentPlace(k) {
  const town = k.world.make('city');
  const shape = t => ({ ask: 'whether', fragment: 'follow_up', props: [{ roles: [['location', t.T]], polarity: 'affirmed' }] });
  const custom = {
    en: [['And in {T}?', shape, { qtype: 'fragment' }], ['What about in {T}?', shape, { qtype: 'fragment' }], ['same question for {T}?', shape, { qtype: 'fragment' }]],
    ro: [['Dar în {T}?', shape, { qtype: 'fragment' }], ['Și în {T}?', shape, { qtype: 'fragment' }]],
  };
  const canon = emptyCanon();
  canon.query = { ask: 'whether', where: [] };
  return base('fragment', 'follow_up_place', ['qqp'], { canon, plan: { clauses: [], question: { custom, slots: { T: town }, ask: 'whether', id: 'fragment.place' } },
    expect: 'clarify', mentioned: [town], predicates: [] });
}

// ---------------------------------------------------------------- first person (Q-LANG-5, C4)
const userEntity = (k, id, en, ro, aliases) => k.world.entities.get(id) ?? k.world.add({ id, type: 'person', gender: 'm', labels: { en, ro }, short: en, surname: null, userAliases: aliases });
export function firstPerson(k) {
  const user = userEntity(k, 'the_user', 'the user', 'the user', ['I', 'me', 'my', 'eu', 'mie', 'meu']);
  const relative = k.random.chance(0.5)
    ? userEntity(k, 'the_users_brother', "the user's brother", 'fratele meu', ['my brother', 'fratele meu'])
    : userEntity(k, 'the_users_sister', "the user's sister", 'sora mea', ['my sister', 'sora mea']);
  const brother = relative.id === 'the_users_brother';
  const org = k.world.make('company');
  const known = k.random.chance(0.5), not = k.random.chance(0.35), pol = not ? 'negated' : 'affirmed';
  const facts = known ? [canonical('works_at', { employee: relative, employer: org })] : [];
  const canon = emptyCanon();
  canon.stated.push({ ...canonical('works_at', { employee: user, employer: org }, { polarity: pol }), certainty: 'asserted' });
  canon.query = { ask: 'whether', where: [{ relation: 'works_at', args: [relative.id, org.id], negated: false }] };
  const U = q('the user'), REL = q(relative.labels.en);
  const shape = en => t => ({ ask: 'whether', stated: [en ? P('work at', [['subject', U], ['object', t.O]], pol) : R('work at', 'lucra la', [['subject', U], ['object', t.O]], pol)],
    props: [en ? P('work at', [['subject', REL], ['object', t.O]]) : R('work at', 'lucra la', [['subject', REL], ['object', t.O]])] });
  const kin = brother ? ['my brother', 'fratele meu', 'și el'] : ['my sister', 'sora mea', 'și ea'];
  const custom = not ? {
    en: [[`I don't work at {O}, but does ${kin[0]} work at {O}?`, shape(true), { qtype: 'yes_no', translated: ['the user', relative.labels.en] }]],
    ro: [[`Eu nu lucrez la {O}, dar ${kin[1]} lucrează la {O}?`, shape(false), { qtype: 'yes_no', translated: ['the user', relative.labels.en] }]],
  } : {
    en: [[`I work at {O}. Does ${kin[0]} work at {O} too?`, shape(true), { qtype: 'yes_no', translated: ['the user', relative.labels.en] }],
      [`I am thinking of changing jobs soon. I work at {O}; does ${kin[0]} also work at {O}?`, shape(true), { qtype: 'yes_no', translated: ['the user', relative.labels.en] }]],
    ro: [[`Eu lucrez la {O}. ${kin[1][0].toUpperCase() + kin[1].slice(1)} lucrează ${kin[2]} la {O}?`, shape(false), { qtype: 'yes_no', translated: ['the user', relative.labels.en] }],
      [`Mă gândesc să-mi schimb jobul curând. Eu lucrez la {O}; ${kin[1]} lucrează ${kin[2]} la {O}?`, shape(false), { qtype: 'yes_no', translated: ['the user', relative.labels.en] }]],
  };
  return base('first_person', brother ? 'brother' : 'sister', ['qa2d'], { canon, facts, plan: { clauses: [], question: { custom, slots: { O: org }, ask: 'whether', id: `first_person.work.${not ? 'not' : 'yes'}` } },
    expect: known ? 'supported' : 'unknown', mentioned: [user, relative, org], predicates: ['works_at'] });
}

// ---------------------------------------------------------------- modality and advice (Q-LANG-6)
export function modality(k) {
  const a = person(k);
  const canon = emptyCanon();
  if (k.random.chance(0.6)) {
    const doc = k.world.make('document');
    const allowed = k.random.chance(0.5);
    const facts = allowed ? [canonical('may_sign', { person: a, document: doc })] : [];
    canon.query = { ask: 'whether', where: [{ relation: 'may_sign', args: [a.id, doc.id], negated: false }] };
    const shape = (t, en) => ({ ask: 'whether', props: [en ? P('be allowed to sign', [['subject', t.A], ['object', t.D]]) : R('be allowed to sign', 'avea voie să semneze', [['subject', t.A], ['object', t.D]])] });
    const custom = {
      en: [['Is {A} allowed to sign {D}?', t => shape(t, true), { qtype: 'yes_no' }], ['Is {A} allowed to sign {D} on their own?', t => shape(t, true), { qtype: 'yes_no' }]],
      ro: [['Are voie {A} să semneze {D}?', t => shape(t, false), { qtype: 'yes_no' }]],
    };
    return base('modality', 'allowed', ['squad'], { canon, facts, plan: { clauses: [], question: { custom, slots: { A: a, D: doc }, ask: 'whether', id: 'modality.allowed' } },
      expect: allowed ? 'supported' : 'unknown', mentioned: [a, doc], predicates: ['may_sign'] });
  }
  const co = k.world.make('company');
  canon.query = { ask: 'whether', where: [{ relation: 'should_accept', args: [a.id, co.id], negated: false }] };
  const shape = (t, en) => ({ ask: 'whether', props: [en ? P('should accept the offer from', [['subject', t.A], ['source', t.C]]) : R('should accept the offer from', 'ar trebui să accepte oferta de la', [['subject', t.A], ['source', t.C]])] });
  const custom = {
    en: [['Should {A} accept the offer from {C}?', t => shape(t, true), { qtype: 'advice' }], ['Honestly, should {A} accept the offer from {C} or not?', t => shape(t, true), { qtype: 'advice' }]],
    ro: [['{A} ar trebui să accepte oferta de la {C}?', t => shape(t, false), { qtype: 'advice' }]],
  };
  return base('modality', 'advice', ['squad'], { canon, plan: { clauses: [], question: { custom, slots: { A: a, C: co }, ask: 'whether', id: 'modality.advice' } },
    expect: 'not_computable', mentioned: [a, co], predicates: ['should_accept'] });
}

// ---------------------------------------------------------------- alternatives and arithmetic (Q-LANG-7)
export function alternativesArithmetic(k) {
  const canon = emptyCanon();
  if (k.random.chance(0.25)) {
    const a = person(k), [x, y] = [k.world.make('company'), k.world.make('company')];
    const atX = k.random.chance(0.5);
    const facts = [canonical('works_at', { employee: a, employer: atX ? x : y })];
    canon.query = { ask: 'whether', where: [{ relation: 'works_at', args: [a.id, x.id], negated: false }] };
    const work = (t, org, en) => en ? P('work at', [['subject', t.A], ['object', org]]) : R('work at', 'lucra la', [['subject', t.A], ['object', org]]);
    const shape = en => t => ({ ask: 'whether', props: [work(t, t.X, en)], moreQueries: [{ ask: 'whether', props: [work(t, t.Y, en)] }] });
    const custom = {
      en: [['Does {A} work at {X} or at {Y}?', shape(true), { qtype: 'alternative' }]],
      ro: [['{A} lucrează la {X} sau la {Y}?', shape(false), { qtype: 'alternative' }]],
    };
    return base('alternatives', 'or_employer', ['qqp'], { canon, facts, plan: { clauses: [], question: { custom, slots: { A: a, X: x, Y: y }, ask: 'whether', id: 'alternatives.or_employer' } },
      expect: atX ? 'supported' : 'unknown', expect2: atX ? 'unknown' : 'supported', mentioned: [a, x, y], predicates: ['works_at'] });
  }
  if (k.random.chance(0.45)) {
    const a = person(k), [x, y] = [k.world.make('city'), k.world.make('city')];
    const inX = k.random.chance(0.5);
    const facts = [canonical('lives_in', { resident: a, town: inX ? x : y })];
    canon.query = { ask: 'whether', where: [{ relation: 'lives_in', args: [a.id, x.id], negated: false }] };
    const live = (t, town, en) => en ? P('live in', [['subject', t.A], ['location', town]]) : R('live in', 'locui în', [['subject', t.A], ['location', town]]);
    const shape = en => t => ({ ask: 'whether', props: [live(t, t.X, en)], moreQueries: [{ ask: 'whether', props: [live(t, t.Y, en)] }] });
    const custom = {
      en: [['Does {A} live in {X} or in {Y}?', shape(true), { qtype: 'alternative' }], ['Does {A} live in {X} or {Y}, do you know?', shape(true), { qtype: 'alternative' }]],
      ro: [['{A} locuiește în {X} sau în {Y}?', shape(false), { qtype: 'alternative' }]],
    };
    return base('alternatives', 'or_question', ['qqp'], { canon, facts, plan: { clauses: [], question: { custom, slots: { A: a, X: x, Y: y }, ask: 'whether', id: 'alternatives.or' } },
      expect: inX ? 'supported' : 'unknown', expect2: inX ? 'unknown' : 'supported', mentioned: [a, x, y], predicates: ['lives_in'] });
  }
  const division = k.random.chance(0.3);
  if (division) {
    const people = 2 + k.random.int(4), total = 100 * (3 + k.random.int(20));
    const constraint = { task: 'possible', vars: [['?share', 0, total]], require: [`?share == ${total} / ${people}`, `?share <= ${total}`], claim: '?share >= 0', select: ['?share'] };
    const custom = {
      en: [[`The bill is ${total} lei and there are ${people} of us. How much does each of us pay?`, () => ({ constraint }), { qtype: 'arithmetic' }]],
      ro: [[`Nota e ${amount(total, 'ro')} și suntem ${people}. Cât plătește fiecare?`, () => ({ constraint }), { qtype: 'arithmetic' }]],
    };
    return base('arithmetic', 'division', ['squad'], { canon: { ...canon, constraint }, plan: { clauses: [], question: { custom, slots: {}, ask: 'whether', id: 'arithmetic.division' } }, expect: 'not_computable', mentioned: [], predicates: [] });
  }
  const percent = pick(k, [5, 9, 15, 19, 20, 25]), total = 100 * (5 + k.random.int(60));
  // Percentages are scaled to integers: the value is in hundredths of a leu (19% of 2380 is 2380 times 19 hundredths).
  // The value is computed by `require`; the claim only asks for a model (a claim of equality makes the search incomplete).
  const constraint = { task: 'possible', vars: [['?amount_hundredths', 0, total * 100]], require: [`?amount_hundredths == ${total} * ${percent}`], claim: '?amount_hundredths >= 0', select: ['?amount_hundredths'] };
  const custom = {
    en: [[`What is ${percent}% of ${total} lei?`, () => ({ constraint }), { qtype: 'arithmetic' }], [`How much is ${percent} percent of ${total} lei?`, () => ({ constraint }), { qtype: 'arithmetic' }]],
    ro: [[`Cât înseamnă ${percent}% din ${amount(total, 'ro')}?`, () => ({ constraint }), { qtype: 'arithmetic' }]],
  };
  return base('arithmetic', 'percentage', ['squad'], { canon: { ...canon, constraint }, plan: { clauses: [], question: { custom, slots: {}, ask: 'whether', id: 'arithmetic.percentage' } }, expect: 'possible', mentioned: [], predicates: [] });
}

// ---------------------------------------------------------------- offered answers (C6) and relative clauses (C9)
export function offeredAnswer(k) {
  const canon = emptyCanon();
  const roll = k.random.int(3);
  if (roll === 2) {
    const a = person(k), o = k.world.make('company'), other = k.world.make('company');
    const right = k.random.chance(0.5);
    const facts = [canonical('works_at', { employee: a, employer: right ? o : other })];
    canon.query = { ask: 'whether', where: [{ relation: 'works_at', args: [a.id, o.id], negated: false }] };
    const work = (t, obj, en) => en ? P('work for', [['subject', t.A], ['object', obj]]) : R('work at', 'lucra la', [['subject', t.A], ['object', obj]]);
    const extra = en => ({ qtype: 'yes_no', alternatives: t => [{ query: { ask: 'which', select: ['?c'], props: [work(t, '?c', en)] } }] });
    const custom = {
      en: [['Who does {A} work for, {O}, right?', t => ({ ask: 'whether', props: [work(t, t.O, true)] }), extra(true)]],
      ro: [['La ce firmă lucrează {A}, la {O}, nu?', t => ({ ask: 'whether', props: [work(t, t.O, false)] }), extra(false)]],
    };
    return base('offered_answer', right ? 'employer_right' : 'employer_wrong', ['qa2d'], { canon, facts, plan: { clauses: [], question: { custom, slots: { A: a, O: o }, ask: 'whether', id: 'offered.works' } },
      expect: right ? 'supported' : 'unknown', mentioned: [a, o], worldOnly: [other], predicates: ['works_at'] });
  }
  if (roll === 1) {
    const a = person(k), x = k.world.make('city'), other = k.world.make('city');
    const right = k.random.chance(0.5);
    const facts = [canonical('lives_in', { resident: a, town: right ? x : other })];
    canon.query = { ask: 'whether', where: [{ relation: 'lives_in', args: [a.id, x.id], negated: false }] };
    const live = (t, town, en) => en ? P('live in', [['subject', t.A], ['location', town]]) : R('live in', 'locui în', [['subject', t.A], ['location', town]]);
    const variant = en => ['', t => ({ ask: 'whether', props: [live(t, t.X, en)] }), { qtype: 'yes_no', alternatives: t => [{ query: { ask: 'which', select: ['?place'], props: [live(t, '?place', en)] } }] }];
    const custom = {
      en: [['Where does {A} live, {X}, right?', ...variant(true).slice(1)], ['Where does {A} live? In {X}, I think?', ...variant(true).slice(1)]],
      ro: [['Unde locuiește {A}, în {X}, nu?', ...variant(false).slice(1)]],
    };
    return base('offered_answer', right ? 'right' : 'wrong', ['qa2d'], { canon, facts, plan: { clauses: [], question: { custom, slots: { A: a, X: x }, ask: 'whether', id: 'offered.lives' } },
      expect: right ? 'supported' : 'unknown', mentioned: [a, x], worldOnly: [other], predicates: ['lives_in'] });
  }
  if (k.random.chance(0.5)) {
    const a = person(k), manager = person(k), town = k.world.make('city');
    const facts = [canonical('manages', { manager, report: a }), canonical('lives_in', { resident: manager, town })];
    canon.query = { ask: 'which', select: ['?place'], where: [{ relation: 'manages', args: ['?p', a.id], negated: false }, { relation: 'lives_in', args: ['?p', '?place'], negated: false }] };
    const shape = en => t => ({ ask: 'which', select: ['?place'], props: en ? [P('manage', [['subject', '?p'], ['object', t.A]]), P('live in', [['subject', '?p'], ['location', '?place']])]
      : [R('manage', 'coordona', [['subject', '?p'], ['object', t.A]]), R('live in', 'locui în', [['subject', '?p'], ['location', '?place']])] });
    const custom = {
      en: [['Where does the person who manages {A} live?', shape(true), { qtype: 'where' }], ['Where does whoever manages {A} live?', shape(true), { qtype: 'where' }]],
      ro: [['Unde locuiește persoana care îl coordonează pe {A}?', shape(false), { qtype: 'where' }]],
    };
    return base('relative_clause', 'manager_home', ['qa2d'], { canon, facts, plan: { clauses: [], question: { custom, slots: { A: a }, ask: 'which', id: 'relative.manager_home' } },
      expect: 'supported', mentioned: [a], answers: [town], worldOnly: [manager], predicates: ['manages', 'lives_in'] });
  }
  const team = k.world.make('team'), coach = person(k), company = k.world.make('company');
  const facts = [canonical('coaches', { coach, team }), canonical('works_at', { employee: coach, employer: company })];
  canon.query = { ask: 'which', select: ['?c'], where: [{ relation: 'coaches', args: ['?p', team.id], negated: false }, { relation: 'works_at', args: ['?p', '?c'], negated: false }] };
  const shape = en => t => ({ ask: 'which', select: ['?c'], props: en ? [P('coach', [['subject', '?p'], ['object', t.T]]), P('work for', [['subject', '?p'], ['object', '?c']])]
    : [R('coach', 'antrena', [['subject', '?p'], ['object', t.T]]), R('work at', 'lucra la', [['subject', '?p'], ['object', '?c']])] });
  const custom = {
    en: [['Which company does the person who coaches {T} work for?', shape(true), { qtype: 'wh' }], ['Who does the coach of {T} work for?', shape(true), { qtype: 'wh' }]],
    ro: [['La ce firmă lucrează cel care antrenează {T}?', shape(false), { qtype: 'wh' }]],
  };
  return base('relative_clause', 'coach_employer', ['qa2d'], { canon, facts, plan: { clauses: [], question: { custom, slots: { T: team }, ask: 'which', id: 'relative.coach_employer' } },
    expect: 'supported', mentioned: [team], answers: [company], worldOnly: [coach], predicates: ['coaches', 'works_at'] });
}

/** The expansion families and their weights in a formalizer-v1 build (about 15% of rows together). */
export const EXPANSION_FAMILIES = {
  coordination, transfer, existence, conditional, attribute_value: attributeValue, definition, filtered_count: filteredCount, quantified, ordering, fragment,
  first_person: firstPerson, modality, alternatives: alternativesArithmetic, offered_answer: offeredAnswer,
};
export const EXPANSION_WEIGHTS = {
  coordination: 0.4, transfer: 0.4, existence: 0.3, conditional: 0.3, attribute_value: 0.75, definition: 0.25, filtered_count: 0.35, quantified: 0.45,
  ordering: 0.35, fragment: 0.3, first_person: 0.35, modality: 0.35, alternatives: 0.4, offered_answer: 0.35,
};
export { entities };
