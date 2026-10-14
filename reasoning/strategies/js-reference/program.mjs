/**
 * Compile the wires in force (governance applied, sugar desugared) into the program the evaluator runs.
 *
 * A body is a condition group; `any` groups are expanded into alternatives (disjunctive normal form), and every alternative
 * is ordered so that each leaf has its variables bound when it runs (generators first as written, filters as soon as they are
 * ready). The checks here are the ones the oracle needs for its own correctness, not a second validator: safety of heads and of
 * `absent`/`compare`/`compute`, `absent` only over a closed predicate, stratification of negation as failure and aggregates
 * over the predicate dependency graph (conservative: relation names, polarity ignored), and `compute` outside recursion.
 */
import {tokens, parseCondition, leaves, atomFrom, MAX_ARITY} from './wires.mjs';
import {ProgramError, NotExpressibleError, toTerm, varsOfTerms, parseValidity} from './values.mjs';

const f1 = (w, k) => w.fields.find(f => f.key === k);
const fAll = (w, k) => w.fields.filter(f => f.key === k);
const versionOf = w => Number(f1(w, 'version')?.value ?? 1);

const asTerms = toks => toks.map(toTerm);

/** Convert a parsed condition leaf into the evaluator's leaf shape. */
function convertLeaf(l) {
  switch (l.kind) {
    case 'atom': return {kind: 'atom', mode: l.neg === 'none' ? 'pos' : l.neg, p: l.p, args: asTerms(l.terms)};
    case 'compare': return {kind: 'compare', word: l.word, left: toTerm(l.left), right: toTerm(l.right)};
    case 'compute': return {kind: 'compute', word: l.word, out: l.out, left: toTerm(l.left), right: toTerm(l.right)};
    case 'order': return {kind: 'order', word: l.word, left: l.left, right: l.right};
    case 'timeof': return {kind: 'timeof', which: l.which, out: l.out, p: l.p, args: asTerms(l.terms)};
    default: throw new ProgramError('unsupported_condition', `condition leaf ${l.kind} is not part of the core`);
  }
}

/** Disjunctive normal form of a condition tree: a list of conjunctions of leaves. */
function expand(node) {
  if (node.kind === 'all') return node.children.reduce((acc, c) => acc.flatMap(a => expand(c).map(b => [...a, ...b])), [[]]);
  if (node.kind === 'any') return node.children.flatMap(expand);
  if (node.kind === 'match') throw new ProgramError('unsupported_condition', 'model-surface match blocks are linked by the host, not run by an engine');
  return [[convertLeaf(node)]];
}

/** Parse the condition fields of a wire into alternatives. */
export function conditionAlts(fields, wireId) {
  const children = [];
  for (const f of fields) {
    const problems = [];
    const tree = parseCondition(f, problems);
    if (problems.length || !tree) throw new ProgramError(problems[0]?.code ?? 'bad_condition', problems[0]?.message ?? 'unreadable condition', wireId);
    children.push(tree);
  }
  return expand({kind: 'all', children});
}

const termVars = ts => [...varsOfTerms(ts)];

function leafNeeds(l) {
  switch (l.kind) {
    case 'atom': return l.mode === 'absent' ? termVars(l.args) : [];
    case 'compare': return termVars([l.left, l.right]);
    case 'compute': return termVars([l.left, l.right]);
    case 'order': return [l.left, l.right];
    default: return [];
  }
}

function leafBinds(l) {
  switch (l.kind) {
    case 'atom': return l.mode === 'absent' ? [] : termVars(l.args);
    case 'compute': return [l.out];
    case 'timeof': return [l.out, ...termVars(l.args)];
    default: return [];
  }
}

export const isGenerator = l => l.kind === 'timeof' || (l.kind === 'atom' && l.mode !== 'absent');

/** Order one alternative so every filter runs when its variables are bound; throws the matching safety error otherwise. */
export function orderLeaves(alt, wireId, bound = new Set()) {
  const known = new Set(bound);
  const rest = [...alt], out = [];
  while (rest.length) {
    let i = rest.findIndex(l => !isGenerator(l) && leafNeeds(l).every(v => known.has(v)));
    if (i < 0) i = rest.findIndex(isGenerator);
    if (i < 0) {
      const bad = rest[0];
      throw new ProgramError(bad.kind === 'atom' ? 'unsafe_negation' : 'unsafe_variable', `a ${bad.kind === 'atom' ? 'negated' : bad.kind} condition uses a variable no positive atom binds`, wireId);
    }
    const [leaf] = rest.splice(i, 1);
    out.push(leaf);
    for (const v of leafBinds(leaf)) known.add(v);
  }
  return {leaves: out, bound: known};
}

function readAtom(field, wireId, {allowNeg = false, ground = false} = {}) {
  const a = atomFrom(tokens(field.value), {allowNeg, ground});
  if (a.error) throw new ProgramError(ground ? 'fact_with_variable' : 'bad_atom', `${a.error} in "${field.value}"`, wireId);
  if (a.terms.length > MAX_ARITY) throw new ProgramError('arity_seven', 'arity above six', wireId);
  return {neg: a.neg === 'not', p: a.p, args: asTerms(a.terms)};
}

function parseArgs(w) {
  const v = f1(w, 'args')?.value.trim() ?? '';
  if (v === 'none') return [];
  return tokens(v).map(t => (t.includes(':') ? {role: t.split(':')[0], type: t.split(':')[1]} : {role: null, type: t}));
}

function checkArity(predicates, a, wireId) {
  const decl = predicates.get(a.p);
  if (decl && decl.args.length !== a.args.length) throw new ProgramError('arity_mismatch', `${a.p} is declared with ${decl.args.length} argument(s), used with ${a.args.length}`, wireId);
}

/** Predicate dependency edges {from: body predicate, to: head predicate, strict} of the rules and aggregates. */
function dependencyEdges(rules, aggregates) {
  const edges = [];
  for (const r of rules) for (const alt of r.alts) for (const l of alt.leaves) {
    if (l.kind === 'atom' || l.kind === 'timeof') edges.push({from: l.p, to: r.head.p, strict: l.kind === 'atom' && l.mode === 'absent'});
  }
  for (const a of aggregates) for (const alt of a.alts) for (const l of alt.leaves) {
    if (l.kind === 'atom' || l.kind === 'timeof') edges.push({from: l.p, to: a.yields.p, strict: true});
  }
  return edges;
}

function tarjan(nodes, edges) {
  const succ = new Map(nodes.map(n => [n, []]));
  for (const e of edges) succ.get(e.from).push(e.to);
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [], sccs = [];
  let counter = 0;
  const visit = v => {
    index.set(v, counter); low.set(v, counter); counter++;
    stack.push(v); onStack.add(v);
    for (const w of succ.get(v)) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      sccs.push(comp);
    }
  };
  for (const n of nodes) if (!index.has(n)) visit(n);
  return sccs.reverse(); // sources (bodies) first
}

/** Strata in evaluation order; throws not_stratifiable when negation as failure or an aggregate sits in a cycle. */
function stratify(rules, aggregates) {
  const edges = dependencyEdges(rules, aggregates);
  const nodes = [...new Set(edges.flatMap(e => [e.from, e.to]))];
  for (const r of rules) if (!nodes.includes(r.head.p)) nodes.push(r.head.p);
  const sccs = tarjan(nodes, edges);
  const compOf = new Map();
  sccs.forEach((c, i) => c.forEach(p => compOf.set(p, i)));
  for (const e of edges) {
    if (e.strict && compOf.get(e.from) === compOf.get(e.to)) {
      throw new ProgramError('not_stratifiable', `negation as failure or an aggregate over ${e.from} lies in a cycle with ${e.to}`);
    }
  }
  const recursive = new Set();
  for (const e of edges) if (compOf.get(e.from) === compOf.get(e.to)) recursive.add(compOf.get(e.to));
  // Arithmetic inside a recursion (path lengths, critical paths: DS004 "Exact arithmetic") is allowed: on a finite acyclic relation,
  // or with a `compare` bound in the rule, the closure is finite; otherwise the round budget stops it (`budget_exhausted`, never a
  // wrong answer). The stratum is marked so the router asks for an engine that declares `compute_in_recursion`.
  const arithmetic = new Set();
  for (const r of rules) {
    if (!r.alts.some(a => a.leaves.some(l => l.kind === 'compute'))) continue;
    const c = compOf.get(r.head.p);
    if (r.alts.some(a => a.leaves.some(l => l.kind === 'atom' && compOf.get(l.p) === c))) arithmetic.add(c);
  }
  const strata = [];
  sccs.forEach((comp, i) => {
    const preds = new Set(comp);
    const rs = rules.filter(r => preds.has(r.head.p)), ag = aggregates.filter(a => preds.has(a.yields.p));
    if (rs.length || ag.length) strata.push({preds, rules: rs, aggregates: ag, recursive: recursive.has(i), ...(arithmetic.has(i) ? {arithmetic: true} : {})});
  });
  return {strata, edges};
}

/**
 * Compile wires into a program. `wires` are already in force and desugared.
 * Returns {predicates, closed, facts, rules, aggregates, actions, hypotheses, others, strata, edges, unsupported}.
 */
export function compileProgram(wires, {origin = new Map()} = {}) {
  const predicates = new Map();
  for (const w of wires.filter(x => x.type === 'predicate')) {
    predicates.set(w.id, {id: w.id, args: parseArgs(w), closed: f1(w, 'closed')?.value.trim() === 'true'});
  }
  const closed = new Set([...predicates.values()].filter(p => p.closed).map(p => p.id));
  const claim = w => ({id: origin.get(w.id) ?? w.id, version: versionOf(w)});
  const facts = [], rules = [], aggregates = [], actions = [], hypotheses = [], unsupported = [], codeWires = [];

  for (const w of wires) {
    switch (w.type) {
      case 'predicate': case 'lexeme': case 'entity': case 'reply': case 'pack': case 'policy': case 'query': case 'constraint': case 'stated': break;
      case 'fact': {
        const a = readAtom(f1(w, 'holds'), w.id, {allowNeg: true, ground: true});
        checkArity(predicates, a, w.id);
        facts.push({id: w.id, claim: claim(w), neg: a.neg, p: a.p, args: a.args, status: f1(w, 'status')?.value.trim() ?? 'observed', speaker: f1(w, 'speaker')?.value.trim() ?? null, valid: parseValidity(f1(w, 'valid')?.value)});
        break;
      }
      case 'rule': {
        const head = readAtom(f1(w, 'then'), w.id, {allowNeg: true});
        checkArity(predicates, head, w.id);
        const alts = conditionAlts(fAll(w, 'when'), w.id).map(a => orderLeaves(a, w.id));
        const headVars = termVars(head.args);
        for (const alt of alts) if (!headVars.every(v => alt.bound.has(v))) throw new ProgramError('unsafe_head', `a head variable of ${w.id} is not bound by a positive body atom`, w.id);
        rules.push({id: w.id, source: claim(w), head, alts: alts.map(a => ({leaves: a.leaves}))});
        break;
      }
      case 'aggregate': {
        const specs = ['count', 'sum', 'min', 'max', 'collect'].filter(k => f1(w, k));
        if (specs.length !== 1) throw new ProgramError('aggregate_one_function', 'an aggregate has exactly one of count, sum, min, max, collect', w.id);
        const fn = specs[0], t = tokens(f1(w, fn).value);
        const out = t.at(-1), field = t.length === 3 ? t[0] : null;
        const alts = conditionAlts(fAll(w, 'over'), w.id).map(a => orderLeaves(a, w.id));
        const group = tokens(f1(w, 'group')?.value ?? '');
        const yields = readAtom(f1(w, 'yields'), w.id);
        for (const alt of alts) {
          const unbound = [...group, ...(field ? [field] : [])].filter(v => !alt.bound.has(v));
          if (unbound.length) throw new ProgramError('aggregate_field_unbound', `${unbound[0]} is not bound by the over group`, w.id);
        }
        const rowVars = [...new Set(alts.flatMap(a => [...a.bound]))].sort();
        aggregates.push({id: w.id, source: claim(w), fn, field, out, group, yields, rowVars, alts: alts.map(a => ({leaves: a.leaves}))});
        break;
      }
      case 'action': {
        actions.push({
          id: w.id, source: claim(w), params: tokens(f1(w, 'params')?.value ?? ''), cost: Number(f1(w, 'cost')?.value ?? 1),
          requires: fAll(w, 'requires').map(f => readAtom(f, w.id, {allowNeg: true})),
          adds: fAll(w, 'adds').map(f => readAtom(f, w.id, {allowNeg: true})),
          removes: fAll(w, 'removes').map(f => readAtom(f, w.id, {allowNeg: true}))
        });
        break;
      }
      case 'hypothesis': {
        if (f1(w, 'waive')) { unsupported.push('abduce_waive'); break; }
        const atoms = [...fAll(w, 'holds'), ...fAll(w, 'assume')].map(f => readAtom(f, w.id, {allowNeg: true, ground: true}));
        hypotheses.push({id: w.id, atoms, cost: Number(f1(w, 'cost')?.value ?? 1)});
        break;
      }
      case 'goal': break;
      case 'method': unsupported.push('method'); break;
      case 'norm': unsupported.push('norms_hard'); break;
      case 'procedure': unsupported.push('procedures'); break;
      case 'amendment': unsupported.push('amendment'); break;
      case 'trace': unsupported.push('check_plan'); break;
      case 'code': case 'test': codeWires.push(w.id); break; // programming wires: only the code-sandbox strategy executes them
      case 'argument': break; // evidence for a negotiation, never evidence of facts
      default: throw new ProgramError('unknown_wire_type', `wire type ${w.type} is unknown`, w.id);
    }
  }
  // `code` and `test` wires are valid knowledge, but the answer to a question over them is produced by running the program: every other
  // strategy says so (`not_expressible`, feature code_sandbox) and never answers from the rest of the circuit.
  if (codeWires.length) throw new NotExpressibleError(['code_sandbox'], `wires ${codeWires.slice(0, 3).join(', ')} are programming wires (code, test): only the code-sandbox strategy runs them`);
  for (const r of rules) for (const alt of r.alts) for (const l of alt.leaves) {
    if (l.kind === 'atom' && l.mode === 'absent' && !closed.has(l.p)) throw new ProgramError('absent_needs_closed', `absent ${l.p} needs a predicate declared closed true`, r.id);
  }
  for (const a of aggregates) for (const alt of a.alts) for (const l of alt.leaves) {
    if (l.kind === 'atom' && l.mode === 'absent' && !closed.has(l.p)) throw new ProgramError('absent_needs_closed', `absent ${l.p} needs a predicate declared closed true`, a.id);
  }
  const {strata, edges} = stratify(rules, aggregates);
  return {predicates, closed, facts, rules, aggregates, actions, hypotheses, strata, edges, unsupported: [...new Set(unsupported)]};
}

/**
 * The predicates an abduction must see besides its observation: those of the hypotheses' atoms and every predicate a rule or aggregate
 * derives from them, so the slice holds the admitted facts a hypothesis could contradict (consistency, abduce.mjs).
 */
export function hypothesisReach(program) {
  const reach = new Set(program.hypotheses.flatMap(h => h.atoms.map(a => a.p)));
  for (let grew = true; grew;) {
    grew = false;
    for (const e of program.edges) if (reach.has(e.from) && !reach.has(e.to)) { reach.add(e.to); grew = true; }
  }
  return [...reach];
}

/**
 * Restrict a program to the dependency slice of the seed predicates (wires outside it are `ignored`, as defined in 5.3).
 * Returns {program, ignored}.
 */
export function sliceProgram(program, seeds) {
  const inSlice = new Set(seeds);
  for (let grew = true; grew;) {
    grew = false;
    for (const e of program.edges) if (inSlice.has(e.to) && !inSlice.has(e.from)) { inSlice.add(e.from); grew = true; }
  }
  const keepRule = r => inSlice.has(r.head.p), keepAgg = a => inSlice.has(a.yields.p);
  const ignored = [
    ...program.facts.filter(f => !inSlice.has(f.p)).map(f => f.claim.id),
    ...program.rules.filter(r => !keepRule(r)).map(r => r.source.id),
    ...program.aggregates.filter(a => !keepAgg(a)).map(a => a.source.id)
  ];
  const sliced = {
    ...program,
    facts: program.facts.filter(f => inSlice.has(f.p)),
    rules: program.rules.filter(keepRule),
    aggregates: program.aggregates.filter(keepAgg),
    strata: program.strata.filter(s => [...s.preds].some(p => inSlice.has(p))),
    slice: inSlice
  };
  return {program: sliced, ignored: [...new Set(ignored)].filter(id => !id.startsWith('x_'))};
}

