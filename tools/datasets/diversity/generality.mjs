/**
 * Generality probe (experiment eval-generality-v1, AGENTS.md direction 7 levels b and c).
 * Level b: question forms held out from every development set, the author guide, examples and tests
 * (checked by tools/eval/formalization/generality/heldout-check.mjs). Level c: compositions of two or three known classes.
 * Every case is a small generated memory with its gold answer computed here by construction (plain JavaScript),
 * then checked against the reference oracle and the product path on the memory plus a reviewed gold circuit.
 * Gold definitions (`gold_defs`) are never part of the memory the author or arm A sees.
 * Names come from cultures used by neither the benchmark dev nor its sealed split; ids never appear in questions.
 */
import {GIVEN_NAMES} from './names.mjs';

const CULTURES = ['german', 'polish', 'greek', 'turkish', 'arabic', 'chinese', 'korean', 'vietnamese', 'brazilian', 'scandinavian'];
const PEOPLE = [...new Map(GIVEN_NAMES.filter(x => CULTURES.includes(x.culture))
  .map(x => [x.name.normalize('NFKD').replace(/\p{M}/gu, ''), x])).keys()].filter(n => /^[A-Za-z]+$/.test(n));
const SURNAMES = ['Varga', 'Lindqvist', 'Okafor', 'Petrakis', 'Demir', 'Haddad', 'Nowak', 'Brandt', 'Tanaka', 'Moreau', 'Silva', 'Kowal', 'Yilmaz', 'Pham', 'Rahimi', 'Berg', 'Costa', 'Novak', 'Ozturk', 'Lam'];
const CITIES = ['Arlen', 'Brisk', 'Corvale', 'Dunmore', 'Eskerby', 'Falkirk Vale', 'Glenhaven', 'Harrowgate', 'Ivel', 'Jarrow Point', 'Kestrel Bay', 'Lindor', 'Marisford', 'Northam', 'Oakhurst'];
const SKILLS = ['welding', 'carpentry', 'translation', 'bookkeeping', 'photography', 'beekeeping', 'pottery', 'surveying', 'navigation', 'calligraphy'];

/** Five vocabularies; instance i of a form uses domain i % 5, so no two instances share predicate words. */
export const DOMAINS = [
  {group: 'team', groups: ['Falcon', 'Orbit', 'Delta', 'Harbor'], member: 'member_of', memberText: 'is a member of the team', cred: 'first_aid_certified', credText: 'first-aid certificate', credVerb: 'hold a first-aid certificate',
    home: 'lives_in', homeWord: 'city', join: 'joined_year', joinVerb: 'join', value: 'salary', valueWord: 'salary', skill: 'has_skill', skillWord: 'skills'},
  {group: 'choir', groups: ['Aurora', 'Linden', 'Saint Brigid', 'Riverside'], member: 'sings_in', memberText: 'sings in the choir', cred: 'sight_reading_diploma', credText: 'sight-reading diploma', credVerb: 'hold a sight-reading diploma',
    home: 'resides_in', homeWord: 'town', join: 'enrolled_year', joinVerb: 'enrol in', value: 'concerts_given', valueWord: 'number of concerts given', skill: 'plays_instrument', skillWord: 'instruments'},
  {group: 'lab', groups: ['Photonics', 'Genomics', 'Robotics', 'Materials'], member: 'works_in_lab', memberText: 'works in the lab', cred: 'radiation_cleared', credText: 'radiation clearance', credVerb: 'have radiation clearance',
    home: 'based_in', homeWord: 'city', join: 'hired_year', joinVerb: 'get hired by', value: 'grant_amount', valueWord: 'grant amount', skill: 'masters_technique', skillWord: 'techniques'},
  {group: 'club', groups: ['Rovers', 'Comets', 'Pioneers', 'Wanderers'], member: 'plays_for', memberText: 'plays for the club', cred: 'referee_licensed', credText: 'referee licence', credVerb: 'hold a referee licence',
    home: 'hometown', homeWord: 'hometown', join: 'signed_year', joinVerb: 'sign with', value: 'goals_scored', valueWord: 'goals scored', skill: 'speaks_language', skillWord: 'languages'},
  {group: 'crew', groups: ['Northwind', 'Seafarer', 'Kittiwake', 'Albatross'], member: 'serves_on', memberText: 'serves on the crew', cred: 'diver_certified', credText: 'diving certificate', credVerb: 'hold a diving certificate',
    home: 'home_port', homeWord: 'home port', join: 'boarded_year', joinVerb: 'board', value: 'sea_days', valueWord: 'days at sea', skill: 'trained_in', skillWord: 'trainings'}
];
const GRAPHS = [
  {node: 'station', nodes: 'stations', link: 'rail_link', linkText: 'a direct rail link', hop: 'rail links', names: ['Ashford', 'Bramley', 'Calder', 'Dovecote', 'Elmswell', 'Fenwick', 'Garston', 'Holloway', 'Ickfield', 'Juniper', 'Kirkby', 'Lowmoor']},
  {node: 'hut', nodes: 'huts', link: 'trail_to', linkText: 'a marked trail', hop: 'trails', names: ['Alder Hut', 'Birch Hut', 'Cedar Hut', 'Dune Hut', 'Edge Hut', 'Fir Hut', 'Gorse Hut', 'Heath Hut', 'Iris Hut', 'Juniper Hut', 'Knoll Hut', 'Larch Hut']},
  {node: 'server', nodes: 'servers', link: 'connects_to', linkText: 'a direct network connection', hop: 'connections', names: ['Atlas', 'Boreas', 'Castor', 'Draco', 'Electra', 'Fornax', 'Gemma', 'Hydra', 'Izar', 'Juno', 'Kepler', 'Lyra']},
  {node: 'room', nodes: 'rooms', link: 'door_to', linkText: 'a connecting door', hop: 'doors', names: ['Amber Room', 'Blue Room', 'Coral Room', 'Dusk Room', 'Ember Room', 'Frost Room', 'Gold Room', 'Hazel Room', 'Indigo Room', 'Jade Room', 'Khaki Room', 'Lilac Room']},
  {node: 'airport', nodes: 'airports', link: 'flight_to', linkText: 'a direct flight', hop: 'flights', names: ['Avelin', 'Brenhall', 'Corrin', 'Daleport', 'Easton', 'Farrow', 'Grimsby', 'Hollis', 'Inver', 'Jessop', 'Kilner', 'Lorne']}
];

const slug = s => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const pred = (id, args, {closed = false, label = id.replaceAll('_', ' '), description} = {}) =>
  `@${id} predicate\n  args ${args}\n  label en ${JSON.stringify(label)}\n  description ${JSON.stringify(description ?? `${label}.${closed ? ' The list is complete.' : ''}`)}\n${closed ? '  closed true\n' : ''}`;
const entity = (name, aliases = []) => `@${slug(name)} entity\n  kind entity\n  label en ${JSON.stringify(name)}\n${aliases.map(a => `  alias en ${JSON.stringify(a)}\n`).join('')}`;
const groupEntity = (d, g) => entity(g, [`${g} ${d.group}`, `the ${g} ${d.group}`]);
class Facts {
  constructor() { this.n = 0; this.text = ''; }
  add(atom, extra = '') { this.text += `@f${++this.n} fact\n  holds ${atom}\n${extra}`; return this; }
}
/** Deterministic pseudo-random sequence per (form, index); no global state. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const shuffle = (xs, r) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const people = (r, n, offset) => shuffle(PEOPLE, r).slice(0, n).map((g, i) => `${g} ${SURNAMES[(i + offset) % SURNAMES.length]}`);
const q = lines => `@q query\n${lines.map(s => `  ${s}`).join('\n')}\n`;
const ok = (value, requires) => ({complete: true, requires, ...value});

function memberBase(d, r, groupName, members, others = []) {
  const f = new Facts();
  for (const p of members) f.add(`${d.member} ${slug(p)} ${slug(groupName)}`);
  for (const [p, g] of others) f.add(`${d.member} ${slug(p)} ${slug(g)}`);
  return f;
}
const memberPred = (d, closed = true) => pred(d.member, 'subject:entity object:entity', {closed, label: d.memberText.replace(/^is a /, '').replace(/^/, ''), description: `A person (subject) ${d.memberText} (object, a ${d.group}).${closed ? ' The membership list is complete.' : ''}`});
/** The reviewed model-surface circuit (the circuit language of the formalizer): replayed without a model to separate language from authoring. */
const L = s => JSON.stringify(s);
const M = (rel, roles, polarity = 'affirmed') => ['match', `  relation ${L(rel)}`, ...Object.entries(roles).map(([k, v]) => `  role ${k} ${v}`), `  polarity ${polarity}`, 'end'];
function S({mode = null, select = null, blocks, tail = [], head = '', link = []}) {
  const where = blocks.length === 1 ? ['where ' + blocks[0][0], ...blocks[0].slice(1)] : ['where all', ...blocks.flat().map(x => '  ' + x), 'end'];
  return head + `@q query\n${[...(mode ? [`mode ${mode}`] : []), ...(select ? [`select ${select}`] : []), ...where, ...tail, ...link].map(x => '  ' + x).join('\n')}\n`;
}

/* ---------- level b: held-out forms ---------- */
const HELD_OUT = {
  // "Which X have no Y": closed-world absence over a join variable.
  'which-has-no'(d, i, r) {
    const g = d.groups[i % 4], members = people(r, 6 + i % 3, i), outsiders = people(r, 10, i + 7).slice(8);
    const certified = members.filter((_, j) => (j + i) % 3 === 0);
    const f = memberBase(d, r, g, members, outsiders.map(p => [p, d.groups[(i + 1) % 4]]));
    for (const p of [...certified, outsiders[0]]) f.add(`${d.cred} ${slug(p)}`);
    const k = memberPred(d) + pred(d.cred, 'subject:entity', {closed: true, label: d.credText, description: `A person (subject) holds a ${d.credText}. The register of ${d.credText} holders is complete.`}) + groupEntity(d, g) + f.text;
    const answer = members.filter(p => !certified.includes(p)).map(p => ({p: slug(p)}));
    return {question: `Which members of the ${g} ${d.group} have no ${d.credText}?`, knowledge: k, query: q(['where all', `  ${d.member} ?p ${slug(g)}`, `  absent ${d.cred} ?p`, 'end', 'select ?p']), expected: ok({status: 'supported', rows: answer}, ['facts', 'naf', 'closed_world']), reference: S({select: '?p', blocks: [M(d.member, {subject: '?p', object: L(g)}), M(d.cred, {subject: '?p'}, 'absent')]})};
  },
  // "Do A and B ... the same Z?": equality through a shared variable, yes/no.
  'same-value'(d, i, r) {
    const [a, b, c] = people(r, 3, i), same = i % 2 === 0, cities = shuffle(CITIES, r);
    const f = new Facts().add(`${d.home} ${slug(a)} ${slug(cities[0])}`).add(`${d.home} ${slug(b)} ${slug(same ? cities[0] : cities[1])}`).add(`${d.home} ${slug(c)} ${slug(cities[same ? 1 : 0])}`);
    const k = pred(d.home, 'subject:entity location:entity', {closed: true, label: d.homeWord, description: `The ${d.homeWord} (location) of a person (subject). Every person has exactly one recorded ${d.homeWord}; the list is complete.`}) + entity(a) + entity(b) + f.text;
    return {question: `Do ${a} and ${b} have the same ${d.homeWord}?`, knowledge: k, query: q(['mode exists', 'where all', `  ${d.home} ${slug(a)} ?c`, `  ${d.home} ${slug(b)} ?c`, 'end']), expected: ok({status: same ? 'supported' : 'refuted'}, ['facts', 'closed_world']), reference: S({blocks: [M(d.home, {subject: L(a), location: '?c'}), M(d.home, {subject: L(b), location: '?c'})]})};
  },
  // "Did A ... before B did?": temporal order of two events given as years.
  'before-event'(d, i, r) {
    const [a, b] = people(r, 2, i), ya = 1995 + Math.floor(r() * 20), yb = ya + (i % 2 === 0 ? 1 + i : -(1 + i));
    const k = pred(d.join, 'subject:entity object:integer', {closed: true, label: `year of joining`, description: `The year (object) in which a person (subject) joined their ${d.group}. Each person has one recorded year; the list is complete.`}) + entity(a) + entity(b) + new Facts().add(`${d.join} ${slug(a)} ${ya}`).add(`${d.join} ${slug(b)} ${yb}`).text;
    return {question: `Did ${a} ${d.joinVerb} the ${d.group} before ${b} did?`, knowledge: k, query: q(['mode exists', 'where all', `  ${d.join} ${slug(a)} ?x`, `  ${d.join} ${slug(b)} ?y`, 'end', 'compare ?x below ?y']), expected: ok({status: ya < yb ? 'supported' : 'refuted'}, ['facts']), reference: S({blocks: [M(d.join, {subject: L(a), object: '?x'}), M(d.join, {subject: L(b), object: '?y'})], tail: ['compare ?x below ?y']})};
  },
  // "Which groups have more than N members?": grouped count with a threshold.
  'group-threshold'(d, i, r) {
    const sizes = [3 + i % 2, 5, 2 + i % 3, 6 - i % 2], all = people(r, 30, i), f = new Facts(), n = 3 + i % 2;
    let at = 0;
    d.groups.forEach((g, j) => { for (let m = 0; m < sizes[j]; m++) f.add(`${d.member} ${slug(all[at++])} ${slug(g)}`); });
    const k = memberPred(d) + pred(`is_${d.group}`, 'subject:entity', {closed: true, label: d.group, description: `The entity (subject) is a ${d.group}.`}) + d.groups.map(g => groupEntity(d, g)).join('') + d.groups.reduce((t, g) => t + `@f${g.length}${slug(g)} fact\n  holds is_${d.group} ${slug(g)}\n`, '') + f.text;
    const gold = `@g_size predicate\n  args subject:entity object:integer\n@g_size_agg aggregate\n  over ${d.member} ?p ?g\n  group ?g\n  count ?p as ?n\n  yields g_size ?g ?n\n`;
    return {question: `Which ${d.group}s have more than ${n} members?`, knowledge: k, gold_defs: gold, query: q(['where g_size ?g ?n', `compare ?n above ${n}`, 'select ?g']), expected: ok({status: 'supported', rows: d.groups.filter((_, j) => sizes[j] > n).map(g => ({g: slug(g)}))}, ['facts', 'aggregate']), reference: `@group_size predicate\n  args subject:entity object:integer\n@group_size_count aggregate\n  over ${d.member} ?p ?g\n  group ?g\n  count ?p as ?n\n  yields group_size ?g ?n\n` + S({select: '?g', blocks: [M('group_size', {subject: '?g', object: '?n'})], tail: [`compare ?n above ${n}`]})};
  },
  // "What is the smallest number of hops from X to Y?": shortest path length.
  'fewest-hops'(_d, i, r) {
    const G = GRAPHS[i % 5], names = shuffle(G.names, r), short = 2 + i % 2, long = short + 2;
    const route = (len, from) => Array.from({length: len - 1}, (_, j) => names[from + j]);
    const [x, y] = [names[0], names[1]], shortMid = route(short, 2), longMid = route(long, 2 + short);
    const edges = [], chain = path => path.slice(1).forEach((n, j) => edges.push([path[j], n]));
    chain([x, ...shortMid, y]); chain([x, ...longMid, y]); edges.push([names[10], names[11]]);
    const f = new Facts(); for (const [a, b] of edges) f.add(`${G.link} ${slug(a)} ${slug(b)}`);
    const k = pred(G.link, 'subject:entity object:entity', {closed: true, label: G.linkText, description: `There is ${G.linkText} from one ${G.node} (subject) to another (object). Links are one-way; the list is complete.`}) + entity(x) + entity(y) + f.text;
    // Recursion with arithmetic is rejected (compute_in_cycle), so the reviewed gold circuit enumerates bounded layers.
    const layers = Array.from({length: 8}, (_, j) => j + 1);
    const gold = layers.map(n => `@g_l${n} predicate\n  args subject:entity object:entity\n@g_l${n}_rule rule\n${n === 1 ? `  when ${G.link} ?a ?b\n` : `  when g_l${n - 1} ?a ?m\n  when ${G.link} ?m ?b\n`}  then g_l${n} ?a ?b\n@g_dist_${n} rule\n  when g_l${n} ?a ?b\n  then g_dist ?a ?b ${n}\n`).join('') + `@g_dist predicate\n  args subject:entity object:entity topic:integer\n`;
    return {question: `What is the smallest number of ${G.hop} needed to get from ${x} to ${y}?`, knowledge: k, gold_defs: gold, query: q([`where g_dist ${slug(x)} ${slug(y)} ?n`, 'rank lowest ?n', 'select ?n']), expected: ok({status: 'supported', rows: [{n: short}]}, ['facts', 'rules', 'select']), reference: layers.map(n => `@hop_layer_${n} predicate\n  args subject:entity object:entity\n@hop_layer_${n}_rule rule\n${n === 1 ? `  when ${G.link} ?a ?b\n` : `  when hop_layer_${n - 1} ?a ?m\n  when ${G.link} ?m ?b\n`}  then hop_layer_${n} ?a ?b\n@hop_count_${n} rule\n  when hop_layer_${n} ?a ?b\n  then hop_count ?a ?b ${n}\n`).join('') + `@hop_count predicate\n  args subject:entity object:entity topic:integer\n` + S({select: '?n', blocks: [M('hop_count', {subject: L(x), object: L(y), topic: '?n'})], tail: ['rank lowest ?n']})};
  },
  // "Is there anyone who P and Q?": existential conjunction, yes/no.
  'anyone-both'(d, i, r) {
    const g = d.groups[i % 4], members = people(r, 5, i), outsiders = people(r, 9, i + 3).slice(6), yes = i % 2 === 0;
    const f = memberBase(d, r, g, members, outsiders.map(p => [p, d.groups[(i + 1) % 4]]));
    for (const p of outsiders) f.add(`${d.cred} ${slug(p)}`);
    if (yes) f.add(`${d.cred} ${slug(members[i % 5])}`);
    const k = memberPred(d) + pred(d.cred, 'subject:entity', {closed: true, label: d.credText, description: `A person (subject) holds a ${d.credText}. The register is complete.`}) + groupEntity(d, g) + f.text;
    return {question: `Is there anyone in the ${g} ${d.group} who also holds a ${d.credText}?`, knowledge: k, query: q(['mode exists', 'where all', `  ${d.member} ?p ${slug(g)}`, `  ${d.cred} ?p`, 'end']), expected: ok({status: yes ? 'supported' : 'refuted'}, ['facts', 'closed_world']), reference: S({blocks: [M(d.member, {subject: '?p', object: L(g)}), M(d.cred, {subject: '?p'})]})};
  },
  // "If S were closed, could one still get from X to Y?": a counterfactual supposition over reachability.
  'counterfactual-closure'(_d, i, r) {
    const G = GRAPHS[i % 5], names = shuffle(G.names, r), [x, y] = names, cut = i % 2 === 0;
    const a = names.slice(2, 5), b = names.slice(5, 8), edges = [];
    const chain = path => path.slice(1).forEach((n, j) => edges.push([path[j], n]));
    chain([x, ...a, y]); if (!cut) chain([x, ...b, y]); else chain([x, ...b]);
    const shut = a[1];
    const f = new Facts(); for (const [p, s] of edges) f.add(`${G.link} ${slug(p)} ${slug(s)}`);
    const k = pred(G.link, 'subject:entity object:entity', {closed: true, label: G.linkText, description: `There is ${G.linkText} from one ${G.node} (subject) to another (object). One-way; the list is complete.`}) +
      pred(`closed_${G.node}`, 'subject:entity', {closed: true, label: `closed ${G.node}`, description: `The ${G.node} (subject) is closed and cannot be entered or passed through. The list is complete.`}) +
      pred(`reachable`, 'subject:entity object:entity', {closed: true, label: `reachable`, description: `The ${G.node} (object) can be reached from the ${G.node} (subject) through ${G.hop}, never entering a closed ${G.node}. Derived only from complete lists, so the relation is complete.`}) +
      `@reach_base rule\n  when ${G.link} ?a ?b\n  when absent closed_${G.node} ?a\n  when absent closed_${G.node} ?b\n  then reachable ?a ?b\n@reach_step rule\n  when reachable ?a ?m\n  when ${G.link} ?m ?b\n  when absent closed_${G.node} ?b\n  then reachable ?a ?b\n` +
      entity(x) + entity(y) + entity(shut) + f.text;
    const gold = `@s1 fact\n  holds closed_${G.node} ${slug(shut)}\n  status supposed\n`;
    return {question: `If ${shut} were closed, could one still get from ${x} to ${y}?`, knowledge: k, gold_defs: gold, query: q(['mode exists', `where reachable ${slug(x)} ${slug(y)}`, 'if $s1']), expected: ok(cut ? {status: 'refuted', conditional: ['s1']} : {status: 'supported'}, ['facts', 'rules', 'recursion', 'naf', 'whatif']), reference: `@s stated\n  certainty supposed\n  relation ${L(`closed_${G.node}`)}\n  role subject ${L(shut)}\n  polarity affirmed\n` + S({blocks: [M('reachable', {subject: L(x), object: L(y)})], link: ['if $s']})};
  },
  // "Which ... between Y1 and Y2?": an inclusive numeric range.
  'between-range'(d, i, r) {
    const g = d.groups[i % 4], members = people(r, 7, i), years = members.map(() => 2000 + Math.floor(r() * 20));
    const lo = 2005 + i, hi = lo + 6;
    const f = memberBase(d, r, g, members); members.forEach((p, j) => f.add(`${d.join} ${slug(p)} ${years[j]}`));
    const k = memberPred(d) + pred(d.join, 'subject:entity object:integer', {label: 'year of joining', description: `The year (object) in which a person (subject) joined their ${d.group}.`}) + groupEntity(d, g) + f.text;
    const rows = members.filter((_, j) => years[j] >= lo && years[j] <= hi).map(p => ({p: slug(p)}));
    return {question: `Which members of the ${g} ${d.group} joined between ${lo} and ${hi}, inclusive?`, knowledge: k, query: q(['where all', `  ${d.member} ?p ${slug(g)}`, `  ${d.join} ?p ?y`, 'end', `compare ?y at_least ${lo}`, `compare ?y at_most ${hi}`, 'select ?p']), expected: ok({status: rows.length ? 'supported' : 'refuted', rows}, ['facts']), reference: S({select: '?p', blocks: [M(d.member, {subject: '?p', object: L(g)}), M(d.join, {subject: '?p', object: '?y'})], tail: [`compare ?y at_least ${lo}`, `compare ?y at_most ${hi}`]})};
  },
  // "How many more A than B?": the difference of two counts.
  'count-difference'(d, i, r) {
    const [g1, g2] = [d.groups[i % 4], d.groups[(i + 1) % 4]], n1 = 6 + i, n2 = 3 + i % 3, all = people(r, n1 + n2, i), f = new Facts();
    all.slice(0, n1).forEach(p => f.add(`${d.member} ${slug(p)} ${slug(g1)}`)); all.slice(n1).forEach(p => f.add(`${d.member} ${slug(p)} ${slug(g2)}`));
    const k = memberPred(d) + groupEntity(d, g1) + groupEntity(d, g2) + f.text;
    const gold = `@g_size predicate\n  args subject:entity object:integer\n@g_size_agg aggregate\n  over ${d.member} ?p ?g\n  group ?g\n  count ?p as ?n\n  yields g_size ?g ?n\n@g_gap predicate\n  args subject:entity object:entity topic:integer\n@g_gap_rule rule\n  when g_size ?a ?x\n  when g_size ?b ?y\n  when compute ?d ?x minus ?y\n  then g_gap ?a ?b ?d\n`;
    return {question: `How many more members does the ${g1} ${d.group} have than the ${g2} ${d.group}?`, knowledge: k, gold_defs: gold, query: q([`where g_gap ${slug(g1)} ${slug(g2)} ?d`, 'select ?d']), expected: ok({status: 'supported', rows: [{d: n1 - n2}]}, ['facts', 'aggregate', 'compute_in_rules']), reference: `@group_size predicate\n  args subject:entity object:integer\n@group_size_count aggregate\n  over ${d.member} ?p ?g\n  group ?g\n  count ?p as ?n\n  yields group_size ?g ?n\n@size_gap predicate\n  args subject:entity object:entity topic:integer\n@size_gap_rule rule\n  when group_size ?a ?x\n  when group_size ?b ?y\n  when compute ?d ?x minus ?y\n  then size_gap ?a ?b ?d\n` + S({select: '?d', blocks: [M('size_gap', {subject: L(g1), object: L(g2), topic: '?d'})]})};
  },
  // "Which Z do both A and B have?": intersection of two sets.
  'shared-by-both'(d, i, r) {
    const [a, b, c] = people(r, 3, i), sk = shuffle(SKILLS, r), sa = sk.slice(0, 4), sb = [sk[2 + i % 2], sk[3 + i % 2], sk[5], sk[6]];
    const f = new Facts(); sa.forEach(s => f.add(`${d.skill} ${slug(a)} ${s}`)); sb.forEach(s => f.add(`${d.skill} ${slug(b)} ${s}`)); f.add(`${d.skill} ${slug(c)} ${sk[0]}`);
    const k = pred(d.skill, 'subject:entity object:entity', {label: d.skillWord.replace(/s$/, ''), description: `A person (subject) has the ${d.skillWord.replace(/s$/, '')} (object).`}) + entity(a) + entity(b) + f.text;
    const rows = sa.filter(s => sb.includes(s)).map(s => ({s}));
    return {question: `Which ${d.skillWord} do both ${a} and ${b} have?`, knowledge: k, query: q(['where all', `  ${d.skill} ${slug(a)} ?s`, `  ${d.skill} ${slug(b)} ?s`, 'end', 'select ?s']), expected: ok({status: 'supported', rows}, ['facts', 'conjunction']), reference: S({select: '?s', blocks: [M(d.skill, {subject: L(a), object: '?s'}), M(d.skill, {subject: L(b), object: '?s'})]})};
  }
};

/* ---------- level c: compositions of known classes ---------- */
const COMPOSED = {
  // count + reachability
  'count+reachability'(_d, i, r) {
    const G = GRAPHS[i % 5], names = shuffle(G.names, r), x = names[0], edges = [];
    const reach = names.slice(1, 4 + i), rest = names.slice(4 + i, 9 + i);
    reach.forEach((n, j) => edges.push([j === 0 ? x : reach[j - 1], n]));
    if (reach.length > 2) edges.push([x, reach[2]]);
    rest.slice(1).forEach((n, j) => edges.push([rest[j], n])); if (rest.length) edges.push([rest[0], x]);
    const f = new Facts(); for (const [a, b] of edges) f.add(`${G.link} ${slug(a)} ${slug(b)}`);
    const k = pred(G.link, 'subject:entity object:entity', {closed: true, label: G.linkText, description: `There is ${G.linkText} from one ${G.node} (subject) to another (object). One-way; the list is complete.`}) + entity(x) + f.text;
    const gold = `@g_reach predicate\n  args subject:entity object:entity\n  closed true\n@g_r1 rule\n  when ${G.link} ?a ?b\n  then g_reach ?a ?b\n@g_r2 rule\n  when g_reach ?a ?m\n  when ${G.link} ?m ?b\n  then g_reach ?a ?b\n`;
    const count = new Set(reach).size - (reach.includes(x) ? 1 : 0);
    return {question: `How many ${G.nodes} can be reached from ${x} by following ${G.hop}?`, knowledge: k, gold_defs: gold, query: q(['mode count', `where g_reach ${slug(x)} ?y`, 'select ?y']), expected: ok({status: 'supported', count}, ['facts', 'rules', 'recursion', 'count']), reference: `@reaches predicate\n  args subject:entity object:entity\n  closed true\n@reaches_direct rule\n  when ${G.link} ?a ?b\n  then reaches ?a ?b\n@reaches_step rule\n  when reaches ?a ?m\n  when ${G.link} ?m ?b\n  then reaches ?a ?b\n` + S({mode: 'count', select: '?y', blocks: [M('reaches', {subject: L(x), object: '?y'})]})};
  },
  // superlative + time window
  'superlative+window'(d, i, r) {
    const g = d.groups[i % 4], members = people(r, 8, i), years = members.map((_, j) => 2001 + ((j * 7 + i * 3) % 18)), vals = members.map((_, j) => 10 + ((j * 13 + i * 5) % 37));
    const lo = 2006, hi = 2014, f = memberBase(d, r, g, members);
    members.forEach((p, j) => { f.add(`${d.join} ${slug(p)} ${years[j]}`); f.add(`${d.value} ${slug(p)} ${vals[j]}`); });
    const k = memberPred(d) + pred(d.join, 'subject:entity object:integer', {label: 'year of joining', description: `The year (object) in which a person (subject) joined their ${d.group}.`}) + pred(d.value, 'subject:entity object:integer', {label: d.valueWord, description: `The ${d.valueWord} (object) of a person (subject).`}) + groupEntity(d, g) + f.text;
    const inside = members.map((p, j) => ({p, y: years[j], v: vals[j]})).filter(x => x.y >= lo && x.y <= hi), best = Math.max(...inside.map(x => x.v));
    return {question: `Among the members of the ${g} ${d.group} who joined between ${lo} and ${hi}, who has the highest ${d.valueWord}?`, knowledge: k,
      query: q(['where all', `  ${d.member} ?p ${slug(g)}`, `  ${d.join} ?p ?y`, `  ${d.value} ?p ?v`, 'end', `compare ?y at_least ${lo}`, `compare ?y at_most ${hi}`, 'rank highest ?v', 'select ?p']), expected: ok({status: 'supported', rows: inside.filter(x => x.v === best).map(x => ({p: slug(x.p)}))}, ['facts', 'select']), reference: S({select: '?p', blocks: [M(d.member, {subject: '?p', object: L(g)}), M(d.join, {subject: '?p', object: '?y'}), M(d.value, {subject: '?p', object: '?v'})], tail: [`compare ?y at_least ${lo}`, `compare ?y at_most ${hi}`, 'rank highest ?v']})};
  },
  // closed-world absence + rule chaining
  'absence+rules'(d, i, r) {
    const g = d.groups[i % 4], members = people(r, 7, i), f = memberBase(d, r, g, members);
    const passed = members.filter((_, j) => (j + i) % 4 !== 1), trained = members.filter((_, j) => (j + i) % 3 !== 2), qualified = passed.filter(p => trained.includes(p));
    const registered = qualified.filter((_, j) => j % 2 === 0);
    passed.forEach(p => f.add(`passed_exam ${slug(p)}`)); trained.forEach(p => f.add(`completed_training ${slug(p)}`)); registered.forEach(p => f.add(`on_register ${slug(p)}`));
    const k = memberPred(d) + pred('passed_exam', 'subject:entity', {label: 'passed the exam', description: 'A person (subject) passed the qualifying exam.'}) + pred('completed_training', 'subject:entity', {label: 'completed the training', description: 'A person (subject) completed the mandatory training.'}) +
      pred('qualified', 'subject:entity', {label: 'qualified', description: 'A person (subject) is qualified: derived from passing the exam and completing the training.'}) + pred('eligible', 'subject:entity object:entity', {label: 'eligible', description: `A person (subject) is eligible to represent a ${d.group} (object): a qualified member of it.`}) +
      pred('on_register', 'subject:entity', {closed: true, label: 'on the official register', description: 'A person (subject) is listed on the official register. The register is complete.'}) +
      `@r_qualified rule\n  when passed_exam ?p\n  when completed_training ?p\n  then qualified ?p\n@r_eligible rule\n  when qualified ?p\n  when ${d.member} ?p ?g\n  then eligible ?p ?g\n` + groupEntity(d, g) + f.text;
    const rows = qualified.filter(p => !registered.includes(p)).map(p => ({p: slug(p)}));
    return {question: `Which people eligible to represent the ${g} ${d.group} are missing from the official register?`, knowledge: k, query: q(['where all', `  eligible ?p ${slug(g)}`, '  absent on_register ?p', 'end', 'select ?p']), expected: ok({status: rows.length ? 'supported' : 'refuted', rows}, ['facts', 'rules', 'naf', 'closed_world']), reference: S({select: '?p', blocks: [M('eligible', {subject: '?p', object: L(g)}), M('on_register', {subject: '?p'}, 'absent')]})};
  },
  // count + numeric conditions
  'count+conditions'(d, i, r) {
    const g = d.groups[i % 4], members = people(r, 9, i), years = members.map((_, j) => 2000 + ((j * 5 + i) % 20)), vals = members.map((_, j) => 5 + ((j * 11 + i * 7) % 40));
    const minV = 15 + i, before = 2012, f = memberBase(d, r, g, members, people(r, 12, i + 2).slice(10).map(p => [p, d.groups[(i + 1) % 4]]));
    members.forEach((p, j) => { f.add(`${d.join} ${slug(p)} ${years[j]}`); f.add(`${d.value} ${slug(p)} ${vals[j]}`); });
    const k = memberPred(d) + pred(d.join, 'subject:entity object:integer', {closed: true, label: 'year of joining', description: `The year (object) in which a person (subject) joined their ${d.group}. The list is complete.`}) + pred(d.value, 'subject:entity object:integer', {closed: true, label: d.valueWord, description: `The ${d.valueWord} (object) of a person (subject). The list is complete.`}) + groupEntity(d, g) + f.text;
    const count = members.filter((_, j) => vals[j] > minV && years[j] < before).length;
    return {question: `How many members of the ${g} ${d.group} have a ${d.valueWord} above ${minV} and joined before ${before}?`, knowledge: k,
      query: q(['mode count', 'where all', `  ${d.member} ?p ${slug(g)}`, `  ${d.join} ?p ?y`, `  ${d.value} ?p ?v`, 'end', `compare ?v above ${minV}`, `compare ?y below ${before}`, 'select ?p']), expected: ok({status: count ? 'supported' : 'refuted', count}, ['facts', 'count']), reference: S({mode: 'count', select: '?p', blocks: [M(d.member, {subject: '?p', object: L(g)}), M(d.join, {subject: '?p', object: '?y'}), M(d.value, {subject: '?p', object: '?v'})], tail: [`compare ?v above ${minV}`, `compare ?y below ${before}`]})};
  },
  // multi-hop + temporal
  'multihop+temporal'(_d, i, r) {
    const post = ['chair of the harbour board', 'head of the museum', 'director of the observatory', 'conductor of the city orchestra', 'warden of the national park'][i % 5];
    const postId = slug(post), holders = people(r, 3, i), cities = shuffle(CITIES, r).slice(0, 3), countries = ['Valdoria', 'Estmark', 'Norland'];
    const terms = [['2010-01-01', '2014-06-30'], ['2014-07-01', '2019-12-31'], ['2020-01-01', '2026-12-31']];
    const f = new Facts();
    holders.forEach((p, j) => { f.add(`holds_post ${slug(p)} ${postId}`, `  valid ${terms[j][0]} ${terms[j][1]}\n`); f.add(`born_in ${slug(p)} ${slug(cities[j])}`); f.add(`city_in ${slug(cities[j])} ${slug(countries[j])}`); });
    const pick = i % 3, date = ['2012-03-15', '2017-09-01', '2022-05-20'][pick];
    const k = pred('holds_post', 'subject:entity object:entity', {label: 'holds the post', description: 'A person (subject) holds a post (object) during the validity interval of the fact.'}) + pred('born_in', 'subject:entity location:entity', {label: 'born in', description: 'A person (subject) was born in a city (location).'}) +
      pred('city_in', 'subject:entity location:entity', {label: 'city located in country', description: 'A city (subject) lies in a country (location).'}) + `@${postId} entity\n  kind entity\n  label en ${JSON.stringify(post)}\n` + f.text;
    return {question: `In which country was the person who was ${post} on ${date} born?`, knowledge: k,
      query: q(['where all', `  holds_post ?p ${postId}`, '  born_in ?p ?c', '  city_in ?c ?k', 'end', `at ${date}`, 'select ?k']), expected: ok({status: 'supported', rows: [{k: slug(countries[pick])}]}, ['facts', 'temporal']), reference: S({select: '?k', blocks: [M('holds_post', {subject: '?p', object: L(post)}), M('born_in', {subject: '?p', location: '?c'}), M('city_in', {subject: '?c', location: '?k'})], tail: [`at ${L(date)}`]})};
  }
};

export const HELD_OUT_FORMS = Object.keys(HELD_OUT);
export const COMPOSITIONS = Object.keys(COMPOSED);

/** All generated rows; `per` instances per form, deterministic. */
export function generalityCases({per = 5} = {}) {
  const rows = [];
  for (const [level, table] of [['b', HELD_OUT], ['c', COMPOSED]]) {
    for (const [form, make] of Object.entries(table)) {
      for (let i = 0; i < per; i++) {
        const seed = [...form].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 20261002 + i);
        const c = make(DOMAINS[i % 5], i, rng(seed));
        rows.push({id: `gen-${level}-${form.replace(/\+/g, '-')}-${i + 1}`, level, form, split: 'dev', facts: (c.knowledge.match(/^@f\S* fact$/gm) ?? []).length, depth: 1, ...c, gold_defs: c.gold_defs ?? ''});
      }
    }
  }
  return rows;
}
