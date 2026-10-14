/**
 * Generators of the large inputs of smoke cases 65 to 69 (datalog-agent): the case folders hold the smoke-size instance (small, hand-checked,
 * run by every strategy that declares the features); these generators build the same circuit shapes at 10^3 to 10^6 facts for the speed
 * table (`node eval/smoke-reasoning/bench/datalog.mjs`) and for the scale tests. Every generator returns {knowledge, query, facts, answer}
 * where `answer` is what the query must return, known by construction (never taken from an engine).
 */

const FACT = (id, text) => `@${id} fact\n  holds ${text}\n`;

const REACH_RULES = `@r_base rule
  when edge ?a ?b
  then reach ?a ?b
@r_step rule
  when reach ?a ?b
  when edge ?b ?c
  then reach ?a ?c
`;
const REACH_PREDICATES = '@edge predicate\n  args source:entity destination:entity\n@reach predicate\n  args source:entity destination:entity\n';

/** Case 65: `components` rings of `size` nodes (components * size edges); the query asks what n0_0 reaches (its whole ring). */
export function ringComponents({components, size}) {
  const out = [REACH_PREDICATES];
  let id = 0, facts = 0;
  for (let c = 0; c < components; c++) for (let i = 0; i < size; i++) { out.push(FACT(`f${id++}`, `edge n${c}_${i} n${c}_${(i + 1) % size}`)); facts++; }
  out.push(REACH_RULES);
  return {
    knowledge: out.join(''), facts,
    query: '@q query\n  where reach n0_0 ?y\n  select ?y\n',
    answer: {rows: Array.from({length: size}, (_, i) => ({y: `n0_${i}`}))}
  };
}

/** Case 68: one small chain `c0 -> ... -> c<chain>` (the asked component) among `components` large rings of `size` nodes: a bound query that magic sets answer without the all-pairs closure of the big rings. */
export function selectiveChain({components, size, chain = 5}) {
  const out = [REACH_PREDICATES];
  let id = 0, facts = 0;
  for (let i = 0; i < chain; i++) { out.push(FACT(`f${id++}`, `edge c${i} c${i + 1}`)); facts++; }
  for (let c = 0; c < components; c++) for (let i = 0; i < size; i++) { out.push(FACT(`f${id++}`, `edge k${c}_${i} k${c}_${(i + 1) % size}`)); facts++; }
  out.push(REACH_RULES);
  return {
    knowledge: out.join(''), facts,
    query: '@q query\n  where reach c0 ?y\n  select ?y\n',
    answer: {rows: Array.from({length: chain}, (_, i) => ({y: `c${i + 1}`}))}
  };
}

/** Case 69: a dense digraph on `nodes` nodes where edge i -> j exists when (i * 7 + j * 3) % 10 < `density`, with the NONLINEAR closure rule reach(x,z) :- reach(x,y), reach(y,z) and a count of all pairs. */
export function denseNonlinear({nodes, density = 3}) {
  const out = [REACH_PREDICATES.replace('@reach predicate\n  args source:entity destination:entity\n', '@reach predicate\n  args source:entity destination:entity\n  closed true\n')];
  let id = 0, facts = 0;
  const adj = Array.from({length: nodes}, () => []);
  for (let i = 0; i < nodes; i++) for (let j = 0; j < nodes; j++) if (i !== j && (i * 7 + j * 3) % 10 < density) { out.push(FACT(`f${id++}`, `edge d${i} d${j}`)); adj[i].push(j); facts++; }
  out.push('@r_base rule\n  when edge ?a ?b\n  then reach ?a ?b\n@r_trans rule\n  when reach ?a ?b\n  when reach ?b ?c\n  then reach ?a ?c\n');
  // the answer by construction: breadth-first search from every node
  let pairs = 0;
  for (let s = 0; s < nodes; s++) {
    const seen = new Set();
    const queue = [...adj[s]];
    for (const v of queue) if (!seen.has(v)) { seen.add(v); queue.push(...adj[v]); }
    pairs += seen.size;
  }
  return {knowledge: out.join(''), facts, query: '@q query\n  mode count\n  where reach ?x ?y\n', answer: {count: pairs}};
}

/** Case 66 at scale: `nodes` nodes, every third one blocked; three layers of negation s1 (not blocked), s2 (not s1), s3 (not s2 and not special). */
export function negationChain({nodes}) {
  const decl = n => `@${n} predicate\n  args subject:entity\n  closed true\n`;
  const out = [decl('node'), decl('blocked'), decl('special'), decl('s1'), decl('s2'), decl('s3')];
  let id = 0, facts = 0;
  for (let i = 0; i < nodes; i++) { out.push(FACT(`f${id++}`, `node n${i}`)); facts++; if (i % 3 === 0) { out.push(FACT(`f${id++}`, `blocked n${i}`)); facts++; } if (i % 7 === 0) { out.push(FACT(`f${id++}`, `special n${i}`)); facts++; } }
  out.push('@r1 rule\n  when node ?x\n  when absent blocked ?x\n  then s1 ?x\n@r2 rule\n  when node ?x\n  when absent s1 ?x\n  then s2 ?x\n@r3 rule\n  when node ?x\n  when absent s2 ?x\n  when absent special ?x\n  then s3 ?x\n');
  // by construction: s1 = not blocked, s2 = blocked, s3 = not s2 and not special = not blocked and not special
  const rows = [];
  for (let i = 0; i < nodes; i++) if (i % 3 !== 0 && i % 7 !== 0) rows.push({x: `n${i}`});
  return {knowledge: out.join(''), facts, query: '@q query\n  where s3 ?x\n  select ?x\n', answer: {rows}};
}

/** Case 67 at scale: `rows` salaries over `departments` departments (salary 100 + (i % 17) * 10); sum, count and max per department and a rule over the sums. */
export function groupAggregates({rows, departments}) {
  const out = ['@salary predicate\n  args subject:entity topic:entity object:integer\n  closed true\n@dept_total predicate\n  args subject:entity object:integer\n@dept_top predicate\n  args subject:entity object:integer\n@dept_size predicate\n  args subject:entity object:integer\n@big_dept predicate\n  args subject:entity\n'];
  let facts = 0;
  const total = new Map(), top = new Map(), size = new Map();
  for (let i = 0; i < rows; i++) {
    const d = i % departments, s = 100 + (i % 17) * 10;
    out.push(FACT(`f${i}`, `salary p${i} d${d} ${s}`)); facts++;
    total.set(d, (total.get(d) ?? 0) + s); top.set(d, Math.max(top.get(d) ?? 0, s)); size.set(d, (size.get(d) ?? 0) + 1);
  }
  out.push(`@a_total aggregate
  over salary ?p ?d ?s
  group ?d
  sum ?s as ?t
  yields dept_total ?d ?t
@a_top aggregate
  over salary ?p ?d ?s
  group ?d
  max ?s as ?m
  yields dept_top ?d ?m
@a_size aggregate
  over salary ?p ?d ?s
  group ?d
  count ?p as ?n
  yields dept_size ?d ?n
`);
  const answerRows = [];
  for (let d = 0; d < departments; d++) if (total.has(d)) answerRows.push({d: `d${d}`, t: total.get(d), m: top.get(d), n: size.get(d)});
  return {knowledge: out.join(''), facts, query: '@q query\n  where dept_total ?d ?t\n  where dept_top ?d ?m\n  where dept_size ?d ?n\n  select ?d ?t ?m ?n\n', answer: {rows: answerRows}};
}
