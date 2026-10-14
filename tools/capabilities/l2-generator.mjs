/**
 * L2 of the capability battery: small knowledge programs over the combination grid, generated from FACTORS by a seeded all-pairs
 * covering array (every pair of levels of any two factors appears in at least one program; invalid pairs are excluded by
 * `compatible`). Each program is answered by the js-reference oracle and by every engine; the metamorphic variants of a program
 * (an irrelevant predicate added, entities renamed, a rule split into two equivalent rules) must give the oracle's answer again.
 *
 * Nothing here interprets language: the factors are the constructs of SOP Lang (DS004) and their levels come from its tables.
 */
import {createHash} from 'node:crypto';
import {COMPUTE_WORDS} from '../../sop/enums.mjs';

export const FACTORS = {
  body: ['join', 'not', 'absent', 'compare', 'compute', 'any', 'all_any', 'order'],
  def: ['rule', 'except', 'priority', 'overrides', 'agg_count', 'agg_sum', 'agg_min', 'agg_max', 'agg_collect', 'integrity'],
  rec: ['none', 'linear', 'compute'],
  num: ['integer', 'decimal'],
  mode: ['select', 'exists', 'count', 'every', 'explain', 'why_not', 'abduce'],
  time: ['none', 'at', 'during', 'overlaps', 'asof'],
  supp: ['none', 'supposed'],
  form: ['none', 'compare', 'rank', 'limit', 'except', 'quantifier'],
  world: ['closed', 'open']
};
const NAMES = Object.keys(FACTORS);
const AGG = ['agg_count', 'agg_sum', 'agg_min', 'agg_max', 'agg_collect'];
/** Aggregates whose value is a number (`collect` gathers a list). */
const NUMERIC_AGG = ['agg_count', 'agg_sum', 'agg_min', 'agg_max'];

/** Constraints of the grid: a combination the language does not allow is an L1 question, never an L2 program. */
export function compatible(row) {
  if (['compare', 'rank'].includes(row.form) && !NUMERIC_AGG.includes(row.def)) return false;
  // why_not and abduce read one state: at an instant, never over an interval (the oracle refuses during and overlaps)
  if (['why_not', 'abduce'].includes(row.mode) && ['during', 'overlaps'].includes(row.time)) return false;
  if (row.form === 'quantifier') return row.mode === 'every';
  if (row.form !== 'none' && !['select', 'count'].includes(row.mode)) return false;
  if (row.form === 'limit' && row.mode !== 'select') return false;
  return true;
}

export function prng(seed) {
  let x = (seed >>> 0) || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; };
}

/**
 * The relational core every wire engine is meant to run: no query time, no host query form, no `explain`. A second covering array
 * over it gives each engine the pairs of the core constructs without a feature it refuses anyway.
 */
export const CORE = {...FACTORS, body: FACTORS.body.filter(b => b !== 'order'), mode: ['select', 'exists', 'count', 'every'], time: ['none'], form: ['none']};

function allRows(factors = FACTORS) {
  const rows = [];
  const rec = (i, acc) => {
    if (i === NAMES.length) { if (compatible(acc)) rows.push({...acc}); return; }
    for (const v of factors[NAMES[i]]) { acc[NAMES[i]] = v; rec(i + 1, acc); }
  };
  rec(0, {});
  return rows;
}

const pairKeys = row => {
  const keys = [];
  for (let i = 0; i < NAMES.length; i++) for (let j = i + 1; j < NAMES.length; j++) keys.push(`${NAMES[i]}=${row[NAMES[i]]}|${NAMES[j]}=${row[NAMES[j]]}`);
  return keys;
};

/** A greedy all-pairs covering array over the valid rows (deterministic for a seed). */
export function coveringArray(seed = 20261002, factors = FACTORS) {
  const rows = allRows(factors), r = prng(seed);
  const uncovered = new Set(rows.flatMap(pairKeys));
  const total = uncovered.size, chosen = [];
  while (uncovered.size) {
    let best = null, bestGain = -1;
    for (let k = 0; k < 300; k++) {
      const row = rows[Math.floor(r() * rows.length)];
      const gain = pairKeys(row).filter(p => uncovered.has(p)).length;
      if (gain > bestGain) { best = row; bestGain = gain; }
    }
    if (bestGain === 0) { // finish deterministically: a row that covers the first uncovered pair
      const first = [...uncovered][0];
      best = rows.find(row => pairKeys(row).includes(first));
    }
    for (const p of pairKeys(best)) uncovered.delete(p);
    chosen.push(best);
  }
  return {rows: chosen, pairs: total};
}

// ------------------------------------------------------------------------------------------------ one program

/**
 * Operands of a compute word inside a recursion (integer, decimal). `divided_by` is left out: halving stays inside any bound forever.
 * A word added to sop/enums.mjs without an entry here is reported by `sweepRows` as not swept in recursion.
 */
export const RECURSION_OPERAND = {plus: ['1', '0.5'], minus: ['1', '0.5'], times: ['2', '2'], power: ['2', '2'], whole_divided_by: ['2', '2'], modulo: ['3', '1.5'],
  rounded_to: ['2', '0.5'], rounded_up_to: ['2', '0.5'], rounded_down_to: ['2', '0.5'], minimum_with: ['3', '1.5'], maximum_with: ['5', '2.5']};

/** One program per compute word and number kind (in a rule feeding a sum) and per word in a bounded recursion: every word is executed. */
export function sweepRows() {
  const base = {def: 'agg_sum', rec: 'none', mode: 'select', time: 'none', supp: 'none', form: 'none', world: 'closed'};
  const rows = [];
  for (const word of COMPUTE_WORDS) for (const num of ['integer', 'decimal']) {
    rows.push({...base, body: 'compute', num, word});
    if (RECURSION_OPERAND[word]) rows.push({...base, body: 'join', def: 'rule', rec: 'compute', num, recWord: word});
  }
  return rows;
}

const ENTS = ['a', 'b', 'c', 'd', 'e'];
const INTERVALS = [['2020-01-01', '2021-01-01'], ['2020-06-01', '2022-01-01'], ['2021-01-01', 'open'], ['beginning', '2021-06-01']];
const QUERY_TIME = {at: '  at 2020-09-01\n', during: '  during 2020-07-01 2020-12-01\n', overlaps: '  overlaps 2021-03-01 2021-09-01\n', asof: '  asof 2021-02-01\n'};

/**
 * The program of one grid row and seed: {id, row, seed, knowledge, query, target}. Base predicates edge/link (entity pairs), val
 * (entity, number) and tag (entity); p1 is the body construct, p2 the recursion level, t (or violation) the definition the query asks.
 */
export function program(row, seed) {
  const r = prng(seed * 2654435761 + 97), pick = xs => xs[Math.floor(r() * xs.length)], int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const closedAll = row.world === 'closed';
  const numType = row.num === 'decimal' ? 'rational' : 'integer';
  const num = () => (row.num === 'decimal' ? pick(['0.5', '1.25', '2.75', '3.5', '0.1', '4.2']) : String(int(1, 9)));
  const decl = (id, args, closed) => `@${id} predicate\n  args ${args}\n${closed ? '  closed true\n' : ''}`;
  const out = [];
  out.push(decl('edge', 'subject:entity object:entity', closedAll));
  out.push(decl('link', 'subject:entity object:entity', closedAll));
  out.push(decl('val', 'subject:entity object:' + numType, closedAll));
  out.push(decl('tag', 'subject:entity', closedAll || row.body === 'absent'));
  let n = 0;
  const fact = (atom, extra = '') => out.push(`@f${n++} fact\n  holds ${atom}\n${extra}`);
  const seen = new Set();
  for (let i = 0; i < 7; i++) {
    const a = pick(ENTS), b = pick(ENTS), key = a + b;
    if (seen.has(key)) continue;
    seen.add(key);
    fact(`edge ${a} ${b}`, (row.time !== 'none' || row.body === 'order') && r() < 0.7 ? `  valid ${pick(INTERVALS).join(' ')}\n` : '');
  }
  for (let i = 0; i < 4; i++) fact(`link ${pick(ENTS)} ${pick(ENTS)}`);
  for (const e of ENTS) if (r() < 0.8) fact(`val ${e} ${num()}`);
  const tagged = ENTS.filter(() => r() < 0.4);
  for (const e of tagged) fact(`tag ${e}`);
  if (row.body === 'not') for (const e of ENTS.filter(x => !tagged.includes(x)).slice(0, 2)) fact(`not tag ${e}`);
  // ---- body: p1 ?x ?y
  const p = [];
  const rules = [];
  p.push(decl('p1', 'subject:entity object:entity', closedAll));
  const k = row.num === 'decimal' ? pick(['1.0', '2.5', '0.75']) : String(int(2, 6));
  const body = {
    join: '  when edge ?x ?y\n  when link ?y ?z\n  then p1 ?x ?z\n',
    not: '  when edge ?x ?y\n  when not tag ?y\n  then p1 ?x ?y\n',
    absent: '  when edge ?x ?y\n  when absent tag ?y\n  then p1 ?x ?y\n',
    compare: `  when edge ?x ?y\n  when val ?y ?n\n  when compare ?n ${pick(['above', 'at_least', 'below', 'at_most', 'not_equal', 'equal'])} ${k}\n  then p1 ?x ?y\n`,
    compute: (() => {
      const word = row.word ?? pick(COMPUTE_WORDS);
      const operand = ['power'].includes(word) ? '2' : ['rounded_to', 'rounded_up_to', 'rounded_down_to'].includes(word) ? (row.num === 'decimal' ? '0.5' : '2') : row.num === 'decimal' ? '1.5' : String(int(2, 4));
      return `  when edge ?x ?y\n  when val ?y ?n\n  when compute ?m ?n ${word} ${operand}\n  when compare ?m at_least ${k}\n  then p1 ?x ?y\n`;
    })(),
    any: '  when any\n    edge ?x ?y\n    link ?x ?y\n  end\n  then p1 ?x ?y\n',
    all_any: '  when all\n    edge ?x ?y\n    any\n      tag ?y\n      link ?y ?x\n    end\n  end\n  then p1 ?x ?y\n',
    order: `  when start_of ?t1 edge ?x ?y\n  when start_of ?t2 edge ?y ?z\n  when order ?t1 ${pick(['before', 'after', 'same_time'])} ?t2\n  then p1 ?x ?z\n`
  }[row.body];
  rules.push(`@r_body rule\n${body}`);
  // ---- recursion: p2 ?x ?y
  p.push(decl('p2', 'subject:entity object:entity', closedAll));
  if (row.rec === 'none') rules.push('@r_p2 rule\n  when p1 ?x ?y\n  then p2 ?x ?y\n');
  else if (row.rec === 'linear') rules.push('@r_p2 rule\n  when p1 ?x ?y\n  then p2 ?x ?y\n', '@r_p2_rec rule\n  when p1 ?x ?m\n  when p2 ?m ?y\n  then p2 ?x ?y\n');
  else {
    const step = row.num === 'decimal' ? '0.5' : '1', bound = row.num === 'decimal' ? '1.5' : '3';
    p.push(decl('dist', 'subject:entity object:entity location:' + numType, closedAll));
    // a growing step (plus, times or power from 2 upward) bounded by a comparison terminates on cycles
    // a step bounded on both sides by comparisons terminates on cycles for every word whose values stay on a finite grid
    const word = row.recWord ?? pick(['plus', 'times', 'power']), start = word === 'plus' ? step : '2', limit = word === 'plus' ? bound : '16';
    const operand = RECURSION_OPERAND[word]?.[row.num === 'decimal' ? 1 : 0] ?? '2';
    rules.push(`@r_dist0 rule\n  when p1 ?x ?y\n  then dist ?x ?y ${start}\n`, `@r_dist rule\n  when dist ?x ?m ?d\n  when p1 ?m ?y\n  when compute ?e ?d ${word} ${operand}\n  when compare ?e at_least 0\n  when compare ?e at_most ${limit}\n  then dist ?x ?y ?e\n`, '@r_p2 rule\n  when dist ?x ?y ?d\n  then p2 ?x ?y\n');
  }
  // ---- definition: the asked relation
  let target;
  if (AGG.includes(row.def)) {
    const fn = row.def.slice(4);
    p.push(decl('t', 'subject:entity object:' + (fn === 'count' ? 'integer' : fn === 'collect' ? 'value' : numType), closedAll));
    const over = fn === 'count' ? '  over p2 ?x ?y\n  group ?x\n  count ?y as ?v\n' : `  over all\n    p2 ?x ?y\n    val ?y ?n\n  end\n  group ?x\n  ${fn} ?n as ?v\n`;
    rules.push(`@a_t aggregate\n${over}  yields t ?x ?v\n`);
    target = {pred: 't', vars: ['?x', '?v'], atom: (x, v = '?v') => `t ${x} ${v}`, numeric: fn === 'collect' ? null : '?v', valued: true};
  } else if (row.def === 'integrity') {
    p.push(decl('violation', 'subject:entity object:entity', closedAll));
    rules.push('@c_t integrity\n  never all\n    p2 ?x ?y\n    tag ?x\n  end\n  witness ?x\n  message "a tagged entity reaches another"\n  severity error\n');
    target = {pred: 'violation', vars: ['?x'], atom: x => `violation c_t ${x}`};
  } else {
    p.push(decl('t', 'subject:entity', closedAll));
    target = {pred: 't', vars: ['?x'], atom: x => `t ${x}`};
    if (row.def === 'rule') rules.push('@r_t rule\n  when p2 ?x ?y\n  then t ?x\n');
    if (row.def === 'except') rules.push('@d_t default\n  when p2 ?x ?y\n  then t ?x\n  except tag ?x\n');
    if (row.def === 'priority') rules.push('@d_t default\n  when p2 ?x ?y\n  then t ?x\n  priority 1\n', '@d_not_t default\n  when link ?x ?z\n  then not t ?x\n  priority 2\n');
    if (row.def === 'overrides') rules.push('@d_t default\n  when p2 ?x ?y\n  then t ?x\n', '@d_not_t default\n  when link ?x ?z\n  then not t ?x\n  except tag ?x\n  overrides $d_t\n');
  }
  // abduction: candidate base facts the explanation may assume
  if (row.mode === 'abduce') for (let i = 0; i < 3; i++) rules.push(`@h${i} hypothesis\n  holds ${pick(['edge', 'link'])} ${pick(ENTS)} ${pick(ENTS)}\n  cost ${int(1, 3)}\n`);
  const knowledge = [...out, ...p, ...rules].join('\n');
  // ---- query
  const ground = pick(ENTS);
  const sel = target.vars.join(' ');
  let q = '@q query\n';
  if (row.mode === 'select') q += `  where ${target.atom('?x')}\n  select ${sel}\n`;
  if (row.mode === 'count') q += `  mode count\n  where ${target.atom('?x')}\n  select ${sel}\n`;
  if (row.mode === 'exists') q += `  mode exists\n  where ${target.atom(ground)}\n`;
  if (row.mode === 'explain') q += `  mode explain\n  where ${target.atom(ground)}\n`;
  if (row.mode === 'why_not') q += `  mode why_not\n  where ${target.atom(ground)}\n`;
  if (row.mode === 'abduce') q += `  mode abduce\n  where ${target.atom(ground)}\n`;
  if (row.mode === 'every') q += target.valued ? `  mode every\n  where ${target.atom('?x')}\n  scope tag ?x\n` : `  mode every\n  where tag ?x\n  scope ${target.atom('?x')}\n`;
  if (row.time !== 'none') q += QUERY_TIME[row.time];
  if (row.form === 'compare') q += `  compare ?v ${pick(['above', 'at_least', 'below', 'at_most'])} ${row.num === 'decimal' && row.def !== 'agg_count' ? '2.5' : '2'}\n`;
  if (row.form === 'rank') q += `  rank ${pick(['highest', 'lowest'])} ?v\n`;
  if (row.form === 'limit') q += '  limit 2\n';
  if (row.form === 'except') q += `  except ?x ${pick(ENTS)}\n`;
  if (row.form === 'quantifier') { const w = pick(['all', 'none', 'not_all', 'most', 'half', 'at_least']); q += `  quantifier ${w}${w === 'at_least' ? ' 2' : ''}\n`; }
  let query = q;
  if (row.supp === 'supposed') query = `@s1 fact\n  holds tag ${pick(ENTS)}\n  status supposed\n\n` + q + '  if $s1\n';
  // the id carries a digest of the text: a program whose text changes (a word added to an enumeration shifts a choice) is a new program
  const id = NAMES.map(f => row[f]).join('-') + (row.word ? '@' + row.word : '') + (row.recWord ? '@rec_' + row.recWord : '') + '#' + seed + '~' + createHash('sha1').update(knowledge + '\0' + query).digest('hex').slice(0, 8);
  return {id, row, seed, knowledge, query, target};
}

// ------------------------------------------------------------------------------------------------ metamorphic relations

/** An irrelevant predicate, facts and rule: nothing the query depends on changes. */
export function addIrrelevant(p) {
  const extra = '\n@noise_rel predicate\n  args subject:entity object:entity\n@noise_out predicate\n  args subject:entity\n@nz1 fact\n  holds noise_rel zz_one zz_two\n@nz2 fact\n  holds noise_rel a zz_two\n@r_noise rule\n  when noise_rel ?x ?y\n  then noise_out ?x\n';
  return {...p, id: p.id + '+irrelevant', relation: 'irrelevant', knowledge: p.knowledge + extra, map: null};
}

/** Entities renamed consistently in the knowledge and the query; the answer rows map back by `map`. */
export function renameEntities(p) {
  const map = Object.fromEntries(ENTS.map((e, i) => [e, 'ent_' + ['kilo', 'lima', 'mike', 'nova', 'oscar'][i]]));
  const rename = text => text.split('\n').map(line => {
    if (!/^\s+(holds|where|scope|except|when|then)\b/.test(line) && !/^\s{4,}\S/.test(line)) return line;
    return line.replace(/(?<=\s)([a-e])(?=\s|$)/g, m => map[m]);
  }).join('\n');
  return {...p, id: p.id + '+rename', relation: 'rename', knowledge: rename(p.knowledge), query: rename(p.query), map: Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]))};
}

/**
 * The first rule with two or more `when` lines whose first condition is a positive atom of distinct variables is split in two: the
 * first condition defines an auxiliary relation with the same argument types, and the rest of the body joins it.
 */
export function splitRule(p) {
  const chunks = p.knowledge.split(/\n(?=@)/);
  const decls = new Map();
  for (const c of chunks) { const m = /^@(\S+) predicate\n  args (.*)\n/.exec(c); if (m) decls.set(m[1], {args: m[2], closed: /closed true/.test(c)}); }
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (!/^@\S+ rule\n/.test(c)) continue;
    const lines = c.split('\n');
    const whens = lines.filter(l => l.startsWith('  when '));
    if (whens.length < 2) continue;
    const toks = whens[0].trim().split(/\s+/).slice(1);
    const [pred, ...terms] = toks;
    if (!decls.has(pred) || !terms.length || !terms.every(t => /^\?[a-z]\w*$/.test(t)) || new Set(terms).size !== terms.length) continue;
    const id = /^@(\S+)/.exec(c)[1], aux = 'aux_' + id.toLowerCase();
    const d = decls.get(pred);
    const auxDecl = `@${aux} predicate\n  args ${d.args}\n${d.closed ? '  closed true\n' : ''}`;
    const first = `@${id}_a rule\n  when ${pred} ${terms.join(' ')}\n  then ${aux} ${terms.join(' ')}\n`;
    const rest = c.replace(/^@(\S+) rule/, `@${id}_b rule`).replace(whens[0], `  when ${aux} ${terms.join(' ')}`);
    const knowledge = [...chunks.slice(0, i), auxDecl, first, rest, ...chunks.slice(i + 1)].join('\n');
    return {...p, id: p.id + '+split', relation: 'split', knowledge, map: null};
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ candidates (Q-LANG-10)

const decls = (...ps) => ps.map(([p, closed]) => `@${p} predicate\n  args subject:entity\n${closed ? '  closed true\n' : ''}`).join('');
const supposed = (id, atom) => `@${id} fact\n  holds ${atom}\n  status supposed\n`;
const candidateQuery = (mode, claim, ids, extra = '') => `@q query\n  mode ${mode}\n  where ${claim}\n${ids.map(id => `  candidate $${id}\n`).join('')}${extra}`;
/**
 * Hand-built programs of `mode effect` and `mode abduce` over candidates (owner decision 2026-10-03): the logic-book items of proposal P-1
 * (171 affirming the back, 91 a rule that does not apply, 541 the story that fits), every effect class, and the pairs with defaults,
 * negation, absence over a closed predicate, recursion, a supposition and a query instant. Only the oracle runs them; every other engine
 * must refuse (`candidate`, `effect`).
 */
export function candidatePrograms() {
  const out = [];
  const add = (name, mode, knowledge, query) => out.push({id: `q:${name}~` + createHash('sha1').update(knowledge + '\0' + query).digest('hex').slice(0, 8), row: {mode, candidates: true}, seed: 0, knowledge, query, target: null});
  // logic:171: wet pavement; "it rained" follows only with the converse of the card's rule
  const rain = decls(['rained'], ['wet']) + '@f1 fact\n  holds wet market\n@r_card rule\n  when rained ?m\n  then wet ?m\n@r_converse rule\n  when wet ?m\n  then rained ?m\n  approval proposed\n';
  add('logic171-effect', 'effect', rain, candidateQuery('effect', 'rained market', ['r_converse']));
  add('logic171-abduce', 'abduce', rain, candidateQuery('abduce', 'rained market', ['r_converse']));
  // logic:91: darkness in the depot has no effect on Rule One
  const shield = decls(['apprentice'], ['at_grinder'], ['dark'], ['wears_shield']) + '@f1 fact\n  holds apprentice sam\n@f2 fact\n  holds at_grinder sam\n@r_one rule\n  when apprentice ?x\n  when at_grinder ?x\n  then wears_shield ?x\n';
  add('logic91-effect', 'effect', shield, supposed('s_dark', 'dark depot') + candidateQuery('effect', 'wears_shield sam', ['s_dark']));
  // logic:541: open gate, closed padlock, no tool marks: only the key story fits
  const gate = decls(['gate_open'], ['padlock_closed'], ['tool_marks'], ['forced_entry'], ['key_entry']) + '@f1 fact\n  holds padlock_closed yard\n@f2 fact\n  holds not tool_marks yard\n'
    + '@r_forced_open rule\n  when forced_entry ?s\n  then gate_open ?s\n@r_forced_marks rule\n  when forced_entry ?s\n  then tool_marks ?s\n@r_key_open rule\n  when key_entry ?s\n  then gate_open ?s\n';
  const stories = supposed('s_forced', 'forced_entry yard') + supposed('s_key', 'key_entry yard');
  add('logic541-abduce', 'abduce', gate, stories + candidateQuery('abduce', 'gate_open yard', ['s_forced', 's_key']));
  add('logic541-effect', 'effect', gate, stories + candidateQuery('effect', 'gate_open yard', ['s_forced', 's_key']));
  // every class over a default: an exception blocks, a strict contrary rule contradicts, a fact against the facts is inconsistent
  const bird = decls(['bird'], ['flies'], ['injured'], ['penguin']) + '@f1 fact\n  holds bird tweety\n@d_flies default\n  when bird ?x\n  then flies ?x\n  except injured ?x\n'
    + '@r_penguin rule\n  when penguin ?x\n  then not flies ?x\n  approval proposed\n@r_never rule\n  when bird ?x\n  then not flies ?x\n  approval proposed\n';
  add('default-classes', 'effect', bird, supposed('s_injured', 'injured tweety') + supposed('s_penguin', 'penguin tweety') + supposed('s_not_bird', 'not bird tweety')
    + candidateQuery('effect', 'flies tweety', ['s_injured', 's_penguin', 'r_penguin', 'r_never', 's_not_bird']));
  // a strict rule against a strict rule: the claim becomes both (contradicts)
  add('strict-both', 'effect', decls(['bird'], ['flies']) + '@f1 fact\n  holds bird tweety\n@r_flies rule\n  when bird ?x\n  then flies ?x\n@r_never rule\n  when bird ?x\n  then not flies ?x\n  approval proposed\n',
    candidateQuery('effect', 'flies tweety', ['r_never']));
  // absence over a closed predicate: a candidate fact of the closed predicate blocks a conclusion that rests on its absence
  const pass = decls(['student'], ['late', true], ['gets_pass']) + '@f1 fact\n  holds student ana\n@r_pass rule\n  when student ?x\n  when absent late ?x\n  then gets_pass ?x\n';
  add('absent-blocks', 'effect', pass, supposed('s_late', 'late ana') + candidateQuery('effect', 'gets_pass ana', ['s_late']));
  // recursion: a candidate edge establishes reachability
  const reach = '@edge predicate\n  args subject:entity object:entity\n@reach predicate\n  args subject:entity object:entity\n@f1 fact\n  holds edge a b\n@f2 fact\n  holds edge c d\n'
    + '@r_step rule\n  when edge ?x ?y\n  then reach ?x ?y\n@r_more rule\n  when edge ?x ?y\n  when reach ?y ?z\n  then reach ?x ?z\n';
  add('recursion-establishes', 'effect', reach, supposed('s_bc', 'edge b c') + supposed('s_ca', 'edge c a') + candidateQuery('effect', 'reach a d', ['s_bc', 's_ca']));
  add('recursion-abduce', 'abduce', reach, supposed('s_bc', 'edge b c') + supposed('s_db', 'edge d b') + candidateQuery('abduce', 'reach a d', ['s_bc', 's_db']));
  // a supposition with `if` holds in every run; the candidate is tried on top of it
  add('supposition-and-candidate', 'effect', shield.replace('@f2 fact\n  holds at_grinder sam\n', ''), supposed('s_grinder', 'at_grinder sam') + supposed('s_dark', 'dark depot')
    + candidateQuery('effect', 'wears_shield sam', ['s_dark'], '  if $s_grinder\n'));
  // a rule and a fact are needed together: both are necessary
  add('rule-and-fact-necessary', 'abduce', decls(['wet'], ['rained'], ['cloudy']) + '@f1 fact\n  holds wet market\n@r_rain rule\n  when wet ?m\n  when cloudy ?m\n  then rained ?m\n  approval proposed\n',
    supposed('s_cloudy', 'cloudy market') + candidateQuery('abduce', 'rained market', ['r_rain', 's_cloudy']));
  // the query instant applies to every run: the candidate is a fact valid at that instant
  add('at-instant', 'effect', decls(['open'], ['staffed'], ['served']) + '@f1 fact\n  holds open shop\n  valid 2020-01-01 2021-01-01\n@r_served rule\n  when open ?s\n  when staffed ?s\n  then served ?s\n',
    '@s_staffed fact\n  holds staffed shop\n  status supposed\n' + candidateQuery('effect', 'served shop', ['s_staffed'], '  at 2020-06-01\n'));
  return out;
}

/** The programs of a tier: `fast` one seed per grid row and one metamorphic variant of every third row; `full` three seeds and all variants. */
export function battery(tier = 'fast') {
  const full = coveringArray(), core = coveringArray(20261003, CORE);
  const rows = [...full.rows.map(row => ({row, grid: 'g'})), ...core.rows.map(row => ({row, grid: 'c'})), ...sweepRows().map(row => ({row, grid: 's'}))], pairs = full.pairs + core.pairs;
  const seeds = tier === 'full' ? [1, 2, 3] : [1];
  const programs = [];
  rows.forEach(({row, grid}, i) => {
    for (const seed of seeds) {
      const base = program(row, grid === 'c' ? seed + 100 : grid === 's' ? seed + 200 : seed);
      base.id = grid + ':' + base.id;
      programs.push(base);
      if (tier === 'full' || i % 3 === 0) {
        const variants = [addIrrelevant(base), base.row.form === 'limit' ? null : renameEntities(base), splitRule(base)].filter(Boolean);
        for (const v of tier === 'full' ? variants : [variants[i % variants.length]]) programs.push({...v, of: base.id});
      }
    }
  });
  // candidates (Q-LANG-10): every program in every tier, with its irrelevant-facts variant
  for (const p of candidatePrograms()) programs.push(p, {...addIrrelevant(p), of: p.id});
  return {programs, rows: rows.length, pairs};
}
