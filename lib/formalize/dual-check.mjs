/**
 * Cross-check of two independent formalizations of one problem (owner, 2026-10-02): the step-by-step question tree and the expression
 * path (lib/formalize/expression-program.mjs). Both are SOP circuits over the same registry numbers; they agree when the engines give
 * the same asked values on the problem's own numbers. Agreement is a confidence signal ("two formalizations agree"); a disagreement
 * names the intermediate values of the expression program the tree does not derive.
 *
 * Perturbation is optional and OFF by default (owner decision 2026-10-03): moving the registry numbers can create invalid problems
 * (fractional people, infeasible constraints, broken puzzles) and caught only a handful of lucky circuits. With `k > 0` the circuits
 * must also agree on k seeded perturbations (each distinct registry number moved, the same move in both). Without perturbation a
 * yes/no answer needs THREE agreeing formalizations to be selected (a coin-flip answer agrees by chance too often); a value needs two.
 * A circuit that only writes its final number is refused before it gets here, statically (its answer must depend on the problem's
 * data through the dataflow: lib/formalize/expression-program.mjs, lib/formalize/fol/to-sop.mjs).
 *
 * Execution is injected: `execute(sop, numbers)` runs a circuit with exactly one query through the product's engines and returns
 * {status, values}; `numbers` are the perturbed numbers the circuit states, which the caller adds to the message it validates against
 * (a stated number must be mentioned). Everything here is structure over SOP text and numbers.
 */
import {createHash} from 'node:crypto';
import {evaluateProgram} from './expression-program.mjs';

export const VERDICTS = Object.freeze(['agree', 'disagree', 'single', 'none']);

/** The wires of a circuit split into queries and the rest; declared value predicates (`args object:value`) and rule heads. */
export function splitCircuit(sop) {
  const blocks = String(sop).split(/\n(?=@)/).map(b => b.replace(/\s+$/, '')).filter(b => b.trim());
  const queries = [], rest = [], valuePredicates = [], heads = new Set();
  for (const b of blocks) {
    const head = /^@(\S+)\s+(\S+)/.exec(b.trim());
    if (head?.[2] === 'query') { queries.push({id: head[1], text: b}); continue; }
    rest.push(b);
    if (head?.[2] === 'predicate' && /\n\s*args\s+object:value\s*$/m.test(b)) valuePredicates.push(head[1]);
    if (head?.[2] === 'rule') for (const m of b.matchAll(/^\s*then\s+(?:not\s+)?(\S+)/gm)) heads.add(m[1]);
  }
  return {rest: rest.join('\n\n') + '\n', queries, valuePredicates, heads: [...heads]};
}

const selectQuery = predicate => `@qv query\n  select ?x\n  where match\n    relation "${predicate}"\n    role object ?x\n    polarity affirmed\n  end\n`;

/** Executes every query of a circuit on its own: [{id, status, values}] (a yes/no query's value is true/false from its status). */
export async function executeQueries(sop, execute, numbers = []) {
  const {rest, queries} = splitCircuit(sop);
  const out = [];
  for (const q of queries) {
    const r = await execute(`${rest}\n${q.text}\n`, numbers);
    const yesNo = !/^\s*select\b/m.test(q.text);
    out.push({id: q.id, rank: /^\s*rank\b/m.test(q.text), status: r.status, values: yesNo ? (r.status === 'supported' ? [true] : r.status === 'refuted' ? [false] : []) : r.values ?? []});
  }
  return out;
}

/** The values a circuit derives for each of its rule-headed value predicates: Map predicate → [values]. */
export async function derivedValues(sop, execute) {
  const {rest, valuePredicates, heads} = splitCircuit(sop);
  const out = new Map();
  for (const p of valuePredicates.filter(x => heads.includes(x))) out.set(p, (await execute(`${rest}\n${selectQuery(p)}`)).values ?? []);
  return out;
}

/** A comparable form of a value: numbers to 9 significant digits, text folded, booleans as is. */
export const norm = v => typeof v === 'number' ? Number(v.toPrecision(9)) : typeof v === 'string' ? (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(Number(v).toPrecision(9)) : v.trim().toLowerCase()) : v;
const same = (a, b) => typeof norm(a) === 'number' && typeof norm(b) === 'number' ? Math.abs(norm(a) - norm(b)) <= 1e-6 * Math.max(1, Math.abs(norm(a))) : norm(a) === norm(b);

/**
 * Whether the expression answers `e` (values) and the tree's query results `t` ([{values, rank}]) say the same. Without a ranking query
 * every program answer must match a tree query's answer one to one (a repeated value does not cover a missing one), and the tree's
 * first answer must be among them (a tree may answer one more part of the question); with one (a choice, whose
 * tree also lists every option's score) every expression answer must be among the tree's values and the tree's top answer among the
 * expression answers. Null when either side is empty.
 */
export function answersAgree(e, t) {
  const all = t.flatMap(q => q.values), first = t.find(q => q.values.length)?.values[0];
  if (!e.length || first === undefined) return null;
  if (!t.some(q => q.rank)) {
    const left = t.filter(q => q.values.length).map(q => q.values[0]);
    if (!e.some(x => same(x, left[0]))) return false;
    for (const x of e) { const k = left.findIndex(f => same(x, f)); if (k < 0) return false; left.splice(k, 1); }
    return true;
  }
  return e.every(x => all.some(y => same(x, y))) && e.some(x => same(x, first));
}

/** A seeded generator (mulberry32) so a case's perturbations are reproducible. */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const decimals = x => (String(x).split('.')[1] ?? '').length;

/** `k` perturbations of the registry: [Map oldValue → newValue] over its distinct values (integers stay integers, signs are kept). */
export function perturbations(registry, {k = 3, seed = 'dual'} = {}) {
  const next = rng(parseInt(createHash('sha256').update(String(seed)).digest('hex').slice(0, 8), 16));
  const distinct = [...new Set(registry.map(v => v.value))];
  return Array.from({length: k}, () => {
    const map = new Map(), used = new Set(distinct);
    for (const x of distinct) {
      let y;
      for (let tries = 0; tries < 20; tries++) {
        // A factor between 0.5 and 1.8: large enough that a rounding or a constant does not hide a different function.
        const f = 0.5 + next() * 1.3;
        if (Number.isInteger(x)) { y = Math.round(x * f); if (y === x) y = x + (x >= 0 ? 1 : -1); }
        else { const p = Math.max(decimals(x), 1); y = Number((x * f).toFixed(p)); }
        if (!used.has(y) && y !== 0) break;
      }
      used.add(y); map.set(x, y);
    }
    return map;
  });
}

/** The circuit with its stated numbers moved by `map` (a stated role value equal to a registry number; other numbers stay). */
export function perturbCircuit(sop, map) {
  return String(sop).split(/\n(?=@)/).map(b => /^@\S+\s+stated\b/.test(b.trim())
    ? b.replace(/^(\s*role\s+\S+\s+)(-?\d+(?:\.\d+)?)\s*$/gm, (line, pre, num) => (map.has(Number(num)) ? `${pre}${map.get(Number(num))}` : line)) : b).join('\n');
}

/**
 * The cross-check of one problem. `expr`: the expression path's result ({status, analysis, lowered, registry}); `treeSop`: the tree's
 * circuit or null. Returns {verdict, original: {expression, tree}, perturbed: [{agree}], divergent, lowering} where `lowering` compares
 * the engines' result of the lowered circuit with the interpreter's (a mismatch is a lowering defect, reported, never hidden).
 */
export async function crossCheck({expr, treeSop = null, execute, registry, k = 0, seed = 'dual'}) {
  const exprOk = expr?.status === 'ok';
  const out = {verdict: 'none', original: {}, perturbed: [], divergent: null, lowering: null};
  let exprEngine = null, interp = null;
  if (exprOk) {
    const values = new Map(registry.map(v => [v.index, v.value]));
    try { interp = evaluateProgram(expr.analysis.program, values); } catch (error) { interp = null; out.lowering = {ok: false, why: `interpreter: ${error.message}`}; }
    exprEngine = await executeQueries(expr.lowered.sop, execute);
    out.original.expression = exprEngine.map(q => q.values[0] ?? null);
    if (interp) {
      const want = expr.analysis.program.answers.map(a => interp[a]);
      const ok = want.every((w, i) => out.original.expression[i] !== null && same(w, out.original.expression[i]));
      out.lowering = {ok, interpreter: want, engines: out.original.expression};
    }
  }
  const tree = treeSop ? await executeQueries(treeSop, execute) : null;
  if (tree) out.original.tree = tree.map(q => q.values.slice(0, 6));
  const treeHas = tree?.some(q => q.values.length);
  const exprHas = exprOk && out.original.expression.some(v => v !== null);
  if (!treeHas || !exprHas) { out.verdict = treeHas || exprHas ? 'single' : 'none'; return out; }
  const eAnswers = out.original.expression.filter(v => v !== null);
  let agree = answersAgree(eAnswers, tree);
  for (const map of perturbations(registry, {k, seed})) {
    let e;
    try { const r = evaluateProgram(expr.analysis.program, new Map(registry.map(v => [v.index, map.get(v.value) ?? v.value]))); e = expr.analysis.program.answers.map(a => r[a]); }
    catch { out.perturbed.push({agree: null, why: 'expression undefined'}); continue; }
    const t = await executeQueries(perturbCircuit(treeSop, map), execute, [...map.values()]);
    const a = answersAgree(e, t);
    out.perturbed.push({agree: a, expression: e, tree: t.map(q => q.values.slice(0, 3))});
    if (a === false) agree = false;
  }
  // With perturbation on, agreement also needs at least one perturbation that both circuits answer; a tree that answers nothing on
  // moved numbers while the program does is not an agreement.
  if (agree && k > 0 && !out.perturbed.some(p => p.agree === true)) agree = false;
  out.verdict = agree ? 'agree' : 'disagree';
  if (!agree && interp) {
    // Which of the program's values the tree never derives (and the tree's derived values the program never computes).
    const treeValues = await derivedValues(treeSop, execute);
    const tv = [...treeValues.values()].flat(), ev = Object.values(interp);
    out.divergent = {expression: Object.entries(interp).filter(([, v]) => !tv.some(t => same(t, v))).map(([n, v]) => `${n}=${v}`),
      tree: [...treeValues].filter(([, vs]) => vs.length && !vs.some(v => ev.some(x => same(x, v)))).map(([p, vs]) => `${p}=${vs.slice(0, 3).join('|')}`)};
  }
  return out;
}

/**
 * N-way formalization (experiments/proposal/formalization-research-directions.md, variant B): several independent candidate circuits
 * of one problem, clustered by agreement on the problem's numbers and on the same perturbations, the largest cluster selected.
 * A candidate is {name, kind: 'expr', result} (an expressionFormalize result) or {name, kind: 'tree', sop}.
 */
const firsts = queries => queries.filter(q => q.values.length).map(q => q.values[0]);

/** A candidate's query results under each condition: [original, ...perturbed] (null where it gives no answer). */
export async function candidateProfile(c, {registry, execute, maps}) {
  if (c.kind === 'expr') {
    if (c.result?.status !== 'ok') return null;
    const program = c.result.analysis.program;
    const original = await executeQueries(c.result.lowered.sop, execute);
    const perturbed = maps.map(map => {
      try { const r = evaluateProgram(program, new Map(registry.map(v => [v.index, map.get(v.value) ?? v.value]))); return program.answers.map(a => ({values: [r[a]]})); }
      catch { return null; }
    });
    return [original, ...perturbed];
  }
  if (!c.sop) return null;
  const out = [await executeQueries(c.sop, execute)];
  for (const map of maps) out.push(await executeQueries(perturbCircuit(c.sop, map), execute, [...map.values()]));
  return out;
}

/** Two profiles agree: on the original numbers; with perturbations, on none disagree and on at least one agree. */
export function profilesAgree(a, b) {
  const at = i => {
    if (!a?.[i] || !b?.[i]) return null;
    const x = answersAgree(firsts(a[i]), b[i]), y = answersAgree(firsts(b[i]), a[i]);
    return x === null && y === null ? null : Boolean(x || y);
  };
  if (at(0) !== true) return false;
  const rest = a.slice(1).map((_, i) => at(i + 1));
  return !rest.includes(false) && (!rest.length || rest.includes(true));
}

/** Clusters of agreeing candidates (each cluster: indices that agree with its first member and with each other), largest first. */
function clustersOf(profiles) {
  const n = profiles.length, agree = Array.from({length: n}, (_, i) => Array.from({length: n}, (_, j) => i === j ? Boolean(profiles[i]) : profilesAgree(profiles[i], profiles[j])));
  const left = new Set(profiles.map((p, i) => (p ? i : -1)).filter(i => i >= 0)), out = [];
  while (left.size) {
    let best = null;
    for (const i of left) { const members = [...left].filter(j => agree[i][j]).filter((j, _, all) => all.every(k => agree[j][k])); if (!best || members.length > best.length) best = members; }
    out.push(best); for (const j of best) left.delete(j);
  }
  return out.sort((x, y) => y.length - x.length || x[0] - y[0]);
}

/**
 * The deterministic selection: the largest cluster of size >= 2 that is strictly larger than the next; otherwise `cascade()` adds one
 * more candidate (a larger tier) and the rule is applied again; still no majority → `unresolved`, never a guess. Returns
 * {status: 'selected'|'unresolved', chosen, answers, clusters: [[names]], cascaded, profiles}.
 */
export async function selectByAgreement(candidates, {registry, execute, k = 0, seed = 'nway', cascade = null}) {
  const maps = perturbations(registry, {k, seed});
  const list = [...candidates], profiles = [];
  for (const c of list) profiles.push(await candidateProfile(c, {registry, execute, maps}));
  // A yes/no cluster (every first answer a boolean) needs three members, a value cluster two.
  const need = c => (firsts(profiles[c[0]][0]).every(v => typeof v === 'boolean') ? 3 : 2);
  const decide = () => { const cl = clustersOf(profiles); return {cl, ok: cl.length && cl[0].length >= need(cl[0]) && (cl.length < 2 || cl[0].length > cl[1].length)}; };
  let {cl, ok} = decide(), cascaded = false;
  if (!ok && cascade) {
    const extra = await cascade();
    if (extra) { list.push(extra); profiles.push(await candidateProfile(extra, {registry, execute, maps})); cascaded = true; ({cl, ok} = decide()); }
  }
  const names = cl.map(c => c.map(i => list[i].name));
  if (!ok) return {status: 'unresolved', chosen: null, answers: [], clusters: names, cascaded, profiles};
  const chosen = cl[0][0];
  return {status: 'selected', chosen: list[chosen].name, answers: firsts(profiles[chosen][0]), clusters: names, cascaded, profiles};
}
