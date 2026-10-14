/**
 * FOL of a document's sentences → SOP knowledge wires with provenance, deterministically (ingestion v2, owner design 2026-10-03).
 * The FOL role writes formulas over the document's canonical vocabulary; this converter reads them with the formalizer's reader and
 * clausifier (lib/formalize/fol/parse.mjs, to-ir.mjs: facts, rules beyond Horn, negations, comparisons) and writes knowledge wires:
 *   names          a predicate or constant written by the model is folded to the canonical vocabulary (./vocabulary.mjs `lookups`); a
 *                  name the vocabulary lacks is declared from its use and counted (`vocabulary misses`)
 *   functions      a function term in a literal (add, sub, mul, div, mod, pow, min, max, and the date functions of ./dates.mjs) is lifted
 *                  out of the literal into `compute` conditions before clausification; a ground one is evaluated at conversion time
 *   facts          `fact` wires with `quote` (the exact words of the document) and `source` (document, section, line); a fact of a
 *                  sentence the structure pass marked hedged, reported or supposed keeps that `status`
 *   rules          `rule` wires (when/then, comparisons as `compare`, arithmetic as `compute`); a negated condition is `absent` over a
 *                  closed predicate and `not` (explicit evidence) otherwise; a positive rule whose conclusion the document also denies by
 *                  a strict rule (an exception) becomes a `default` (the exception wins: a strict conclusion beats a default); a rule of
 *                  a hedged sentence is a `default` too (it may not hold)
 *   closed         a predicate is closed when all its facts come from table rows (a table lists its rows completely) or it is defined
 *                  only by rules whose conditions are closed (least fixpoint); the auxiliary predicates of the clausifier are closed
 *   Value(q, t)    a named quantity: a one-place predicate `q` with the value
 * What has no knowledge reading (a stated comparison without a condition, a question, a rule that needs the domain of every thing)
 * is reported per unit, never approximated.
 */
import {parseFol, showFol} from '../../formalize/fol/parse.mjs';
import {folToIr, COMPARE, RESERVED, DOMAIN} from '../../formalize/fol/to-ir.mjs';
import {slug} from '../../formalize/fol/to-sop.mjs';
import {DATE_FUNCTIONS, dateCompute, dateEval} from './dates.mjs';

const RESERVED_PREDS = new Set([...Object.keys(COMPARE), ...Object.values(RESERVED)]);
const ARITH = Object.freeze({add: 'plus', sub: 'minus', mul: 'times', div: 'divided_by', mod: 'modulo', pow: 'power', min: 'minimum_with', max: 'maximum_with'});
const WORD = Object.freeze({Lt: 'below', Le: 'at_most', Gt: 'above', Ge: 'at_least', Eq: 'equal', Ne: 'not_equal'});
const FN_PREFIX = '__fn_';
const ROLES = ['subject', 'object', 'topic', 'recipient', 'instrument', 'location', 'source', 'destination'];
const SYMBOL = /^[a-z][a-z0-9_]*$/;

class Reject extends Error {}
const no = why => { throw new Reject(why); };

// ---------------------------------------------------------------- function lifting (AST level, before clausification)

const isNum = t => t && 'num' in t;
function foldGround(fn, nums) {
  if (DATE_FUNCTIONS.includes(fn)) return dateEval(fn, nums);
  const [a, b] = nums;
  switch (fn) {
    case 'add': return nums.reduce((x, y) => x + y, 0);
    case 'mul': return nums.reduce((x, y) => x * y, 1);
    case 'sub': return a - b;
    case 'div': { const q = a / b; return Number.isFinite(q) && Number(q.toFixed(6)) === q ? q : null; }
    case 'mod': return b ? a % b : null;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
    case 'pow': return Number.isInteger(b) ? a ** b : null;
    default: return null;
  }
}

/**
 * A term without functions: ground ones folded, the others replaced by a fresh variable bound by a `__fn_` literal in `binds`. A
 * CamelCase function that is not arithmetic is a relation used as a function (TenureMonths(x) for the y of TenureMonths(x, y)): it is
 * lifted as that relation with one more argument.
 */
function liftTerm(t, binds, fresh) {
  if (!t.fn) return t;
  const args = t.args.map(a => liftTerm(a, binds, fresh));
  if (args.every(isNum)) { const v = foldGround(t.fn, args.map(a => a.num)); if (v !== null && Number.isFinite(v)) return {num: v}; }
  const v = fresh();
  binds.push(bindAtom(t.fn, args, {var: v}));
  return {var: v};
}
function bindAtom(fn, args, out) {
  if (Object.hasOwn(ARITH, fn) || DATE_FUNCTIONS.includes(fn)) return {type: 'atom', pred: FN_PREFIX + fn, args: [...args, out]};
  if (/^[A-Z]/.test(fn) && !RESERVED_PREDS.has(fn)) return {type: 'atom', pred: fn, args: [...args, out]};
  return no(`unknown function ${fn}`);
}
const conj = xs => xs.filter(Boolean).reduce((a, b) => (a ? {type: 'and', a, b} : b), null);
const wrapExists = (vars, n) => vars.reduceRight((a, v) => ({type: 'exists', v, a}), n);
const isCmpAtom = n => n.type === 'atom' && Object.hasOwn(COMPARE, n.pred);

/** An atom with its function terms lifted: {atom, binds, vars}. Value atoms keep their terms (a named quantity's definition). */
function liftAtom(atom, fresh) {
  if (atom.pred === RESERVED.value || !atom.args.some(t => t.fn)) return {atom, binds: [], vars: []};
  const binds = [];
  const before = fresh.count;
  const args = atom.args.map(t => liftTerm(t, binds, fresh));
  return {atom: {...atom, args}, binds, vars: fresh.since(before)};
}

/** A condition with lifted functions: an atom becomes ∃v (binds ∧ atom); Eq(v, f(…)) of a variable binds v by the function itself. */
function liftBody(n, fresh) {
  switch (n.type) {
    case 'atom': {
      if (n.pred === 'Eq' && n.args.length === 2) {
        const [a, b] = n.args, v = a.var && b.fn ? a : b.var && a.fn ? b : null, f = v === a ? b : a;
        if (v) {
          const binds = [], before = fresh.count;
          const args = f.args.map(t => liftTerm(t, binds, fresh));
          if (args.every(isNum)) { const x = foldGround(f.fn, args.map(t => t.num)); if (x !== null && Number.isFinite(x)) return {type: 'atom', pred: 'Eq', args: [v, {num: x}]}; }
          binds.push(bindAtom(f.fn, args, v));
          return wrapExists(fresh.since(before), conj(binds));
        }
      }
      const l = liftAtom(n, fresh);
      return l.binds.length ? wrapExists(l.vars, conj([...l.binds, l.atom])) : n;
    }
    case 'not': return {type: 'not', a: liftBody(n.a, fresh)};
    case 'forall': case 'exists': return {...n, a: liftBody(n.a, fresh)};
    default: return n.a && n.b ? {...n, a: liftBody(n.a, fresh), b: liftBody(n.b, fresh)} : n;
  }
}

/** A conclusion with lifted functions: {head, binds, vars} (the binds join the rule's conditions). A comparison conclusion is kept. */
function liftHead(n, fresh) {
  if (isCmpAtom(n) || (n.type === 'not' && isCmpAtom(n.a))) return {head: n, binds: [], vars: []};
  if (n.type === 'atom') { const l = liftAtom(n, fresh); return {head: l.atom, binds: l.binds, vars: l.vars}; }
  if (n.type === 'not' && n.a.type === 'atom') { const l = liftAtom(n.a, fresh); return {head: {type: 'not', a: l.atom}, binds: l.binds, vars: l.vars}; }
  if (n.type === 'and') { const a = liftHead(n.a, fresh), b = liftHead(n.b, fresh); return {head: {type: 'and', a: a.head, b: b.head}, binds: [...a.binds, ...b.binds], vars: [...a.vars, ...b.vars]}; }
  // A nested implication (curried) and a universal inside the conclusion: their conditions are conditions of the rule.
  if (n.type === 'implies') { const h = liftHead(n.b, fresh); return {head: {type: 'implies', a: liftBody(n.a, fresh), b: h.head}, binds: h.binds, vars: h.vars}; }
  if (n.type === 'forall') { const h = liftHead(n.a, fresh); return {head: {...n, a: h.head}, binds: h.binds, vars: h.vars}; }
  return {head: n, binds: [], vars: []};
}

/**
 * The statements of one formula, each convertible on its own: a top-level conjunction is several statements, an equivalence is its
 * two implications (one direction may have a reading when the other has none), each under the formula's universal quantifiers.
 */
export function statementsOf(ast) {
  const vars = [];
  let n = ast;
  while (n.type === 'forall') { vars.push(n); n = n.a; }
  const wrap = x => vars.reduceRight((a, q) => ({...q, a}), x);
  if (n.type === 'and' && !vars.length) return [...statementsOf(n.a), ...statementsOf(n.b)];
  if (n.type === 'iff') return [wrap({type: 'implies', a: n.b, b: n.a}), wrap({type: 'implies', a: n.a, b: n.b})];
  return [ast];
}

/** A statement with every function term lifted out of its literals. */
export function liftFunctions(ast, fresh) {
  const vars = [];
  let n = ast;
  while (n.type === 'forall') { vars.push(n.v); n = n.a; }
  const wrap = (x, extra = []) => [...vars, ...extra].reduceRight((a, v) => ({type: 'forall', v, a}), x);
  if (n.type === 'implies') {
    const body = liftBody(n.a, fresh);
    const h = liftHead(n.b, fresh);
    return wrap({type: 'implies', a: conj([body, ...h.binds]), b: h.head}, h.vars);
  }
  if (n.type === 'atom' || (n.type === 'not' && n.a.type === 'atom')) {
    const h = liftHead(n, fresh);
    return h.binds.length ? wrap({type: 'implies', a: conj(h.binds), b: h.head}, h.vars) : wrap(h.head);
  }
  return wrap(liftBody(n, fresh));
}

function freshVars(prefix = 'fv') {
  let k = 0;
  const made = [];
  const f = () => { const v = `${prefix}${++k}`; made.push(v); return v; };
  Object.defineProperty(f, 'count', {get: () => made.length});
  f.since = i => made.slice(i);
  return f;
}

// ---------------------------------------------------------------- conversion of one document

/**
 * Converts the FOL of every unit. `units`: [{key, passage, unit: {index, line, text, quote, table, section}, fol: [line], status?}];
 * `look`: ./vocabulary.mjs lookups; `existing`: Map id → {arity, closed} of predicates the memory declares; `prefix`: wire id prefix.
 * Returns {wires, predicates, entities, rejected, stats}; wires are objects rendered by `renderWires` once closure is known.
 */
export function convertDocument({units, look, existing = new Map(), prefix, title}) {
  const wires = [], rejected = [], preds = new Map(), ents = new Map();
  const stats = {formulas: 0, parsed: 0, statements: 0, converted: 0, facts: 0, rules: 0, rejected: 0, vocabulary_misses: new Set(), new_constants: new Set(), questions: 0};
  let aux = 0;
  let auxName = new Map();
  let lineEnts = new Set();
  const usePred = (name, args, how) => {
    if (name.startsWith('__aux')) {
      // The clausifier numbers its auxiliary predicates per call: one name space per formula.
      if (!auxName.has(name)) auxName.set(name, `${prefix}_aux${++aux}`);
      const id = auxName.get(name);
      if (!preds.has(id)) preds.set(id, {id, arity: args.length, aux: true, kinds: args.map(() => new Set()), canon: null, facts: [], rules: [], negRules: []});
      return preds.get(id);
    }
    if (name === DOMAIN) no('a rule about every thing the document names (no class restricts its variable)');
    const canon = look.predicate(name, args.length);
    let id = canon?.id ?? slug(name);
    if (!SYMBOL.test(id)) id = `p_${id}`;
    // One id per arity: a name used with another arity than the memory's or another use gets its arity as a suffix.
    const clash = () => (existing.has(id) && existing.get(id).arity !== args.length) || [...preds.values()].some(p => p.id === id && p.arity !== args.length);
    if (clash()) id = `${id}_${args.length}`;
    if (!canon && !existing.has(id)) stats.vocabulary_misses.add(`${name}/${args.length}`);
    if (!preds.has(id)) preds.set(id, {id, arity: args.length, aux: false, kinds: args.map(() => new Set()), canon, facts: [], rules: [], negRules: [], how: new Set()});
    const p = preds.get(id);
    if (p.arity !== args.length) no(`${name} is used with ${args.length} arguments and elsewhere with ${p.arity}`);
    p.how?.add(how);
    return p;
  };
  const constant = (c, unitText) => {
    const raw = String(c);
    // A quoted text the model wrote (spaces or punctuation inside) is a text value, not a thing.
    if (/[^A-Za-z0-9_]/.test(raw) && !SYMBOL.test(slug(raw))) return {text: raw};
    if (/\s/.test(raw)) return {text: raw};
    const e = look.entity(raw);
    let id = e?.id ?? slug(raw);
    if (!id) no(`the constant ${JSON.stringify(raw)} has no symbol`);
    if (!/^[a-z]/.test(id)) id = `n_${id}`;
    if (!e) stats.new_constants.add(id);
    if (!ents.has(id)) ents.set(id, {id, canon: e, label: e?.label ?? raw.replace(/_/g, ' '), used: false, example: unitText});
    lineEnts.add(id);
    return {sym: id};
  };

  // Named values: a ground statement Eq(name, number) or Value(name, number) defines the name as that number for the whole document
  // ("the reference date is 2026-03-01"); the name is replaced by the number in every other formula, and the statement itself is the
  // fact of a one-place predicate.
  const named = new Map();
  for (const u of units) for (const line of u.fol) {
    const p = parseFol(line);
    if (!p.ok || p.ast.type !== 'atom' || !['Eq', RESERVED.value].includes(p.ast.pred) || p.ast.args.length !== 2) continue;
    const [a, b] = p.ast.args;
    if (a.const && isNum(b)) named.set(a.const, b.num); else if (b.const && isNum(a)) named.set(b.const, a.num);
  }
  const substitute = n => {
    const t = x => (x.const !== undefined && named.has(x.const) ? {num: named.get(x.const)} : x.fn ? {...x, args: x.args.map(t)} : x);
    if (n.type === 'atom') {
      if (['Eq', RESERVED.value].includes(n.pred) && n.args.length === 2 && n.args.some(x => x.const !== undefined && named.has(x.const)) && n.args.some(isNum)) {
        const c = n.args.find(x => x.const !== undefined), v = n.args.find(isNum);
        return {type: 'atom', pred: RESERVED.value, args: [c, v]};
      }
      return {...n, args: n.args.map(t)};
    }
    return {...n, ...(n.a ? {a: substitute(n.a)} : {}), ...(n.b ? {b: substitute(n.b)} : {})};
  };

  for (const u of units) {
    const fresh = freshVars();
    let k = 0;
    const id = kind => `${prefix}_${u.key}_${kind}${++k}`;
    for (const line of u.fol) {
      stats.formulas++;
      if (/^\?/.test(line.trim())) { stats.questions++; continue; }
      const parsed = parseFol(line);
      if (!parsed.ok) { rejected.push({unit: u.key, fol: line, why: `not parsed: ${parsed.why}`}); continue; }
      stats.parsed++;
      const parts = statementsOf(named.size ? substitute(parsed.ast) : parsed.ast);
      for (const part of parts) try {
        stats.statements++;
        auxName = new Map();
        lineEnts = new Set();
        const ast = liftFunctions(part, fresh);
        const ir = folToIr([{ast, question: false, source: u.unit.text}]);
        if (ir.rejected.length) no(ir.rejected[0].why);
        const out = [];
        const term = (t, p, i) => {
          if (t.var) { p?.kinds[i].add('var'); return `?${slug(t.var) || 'v'}`; }
          if ('num' in t) { p?.kinds[i].add(Number.isInteger(t.num) ? 'int' : 'dec'); return String(t.num); }
          if (t.fn) no('a function term left after lifting');
          const c = constant(t.const, u.unit.text);
          if (c.text !== undefined) { p?.kinds[i].add('text'); return JSON.stringify(c.text); }
          p?.kinds[i].add('entity');
          return c.sym;
        };
        // A logical constant as the last argument (P(x, true), P(x, false)) is the property itself or its negation.
        // (`yes`/`no` too when the structure role typed that position as a boolean.)
        const truth = l => {
          const last = l.args.at(-1)?.const, v = typeof last === 'string' ? last.toLowerCase() : null;
          const kind = look.predicate(l.pred, l.args.length)?.args?.at(-1) ?? '';
          const yes = v === 'true' || (v === 'yes' && /bool/.test(kind)), no_ = v === 'false' || (v === 'no' && /bool/.test(kind));
          return yes || no_ ? {...l, args: l.args.slice(0, -1), negated: no_ ? !l.negated : l.negated} : l;
        };
        const atom = (l, how) => { l = truth(l); const p = usePred(l.pred, l.args, how); return {p, args: l.args.map((t, i) => term(t, p, i)), negated: l.negated}; };
        for (const f of ir.facts) {
          const a = atom(f, 'fact');
          if (a.args.some(x => x.startsWith('?'))) no('a fact with a variable');
          out.push({id: id('f'), type: 'fact', pred: a.p, args: a.args, negated: a.negated});
        }
        for (const v of ir.values) {
          const p = usePred(slug(v.name), [{}], 'fact');
          if ('num' in v.term) { p.kinds[0].add(Number.isInteger(v.term.num) ? 'int' : 'dec'); out.push({id: id('f'), type: 'fact', pred: p, args: [String(v.term.num)], negated: false}); }
          else if (v.term.const) { const c = constant(v.term.const, u.unit.text); p.kinds[0].add(c.text !== undefined ? 'text' : 'entity'); out.push({id: id('f'), type: 'fact', pred: p, args: [c.text !== undefined ? JSON.stringify(c.text) : c.sym], negated: false}); }
          else no('a quantity defined by arithmetic over other quantities');
        }
        const lowerWhen = when => {
          const lines = [];
          let t = 0;
          const tmp = () => `?t${++t}_${k}`;
          for (const c of when) {
            if (c.cmp) {
              if (c.a.fn || c.b.fn) no('a comparison with arithmetic left after lifting');
              lines.push({kind: 'compare', text: `compare ${term(c.a)} ${WORD[c.cmp]} ${term(c.b)}`});
            } else if (c.value) {
              const p = usePred(slug(c.value.const ?? c.value), [{}], 'condition');
              lines.push({kind: 'lit', p, args: [term(c.term, p, 0)], neg: null});
            } else if (String(c.pred).startsWith(FN_PREFIX)) {
              const fn = c.pred.slice(FN_PREFIX.length), args = c.args.map(x => term(x)), outVar = args.pop();
              if (DATE_FUNCTIONS.includes(fn)) for (const l of dateCompute(fn, args, outVar, tmp)) lines.push({kind: 'compute', text: l});
              else if (args.length === 2) lines.push({kind: 'compute', text: `compute ${outVar} ${args[0]} ${ARITH[fn]} ${args[1]}`});
              else if (args.length > 2 && ['add', 'mul', 'min', 'max'].includes(fn)) {
                let acc = args[0];
                args.slice(1).forEach((b, i) => { const v = i === args.length - 2 ? outVar : tmp(); lines.push({kind: 'compute', text: `compute ${v} ${acc} ${ARITH[fn]} ${b}`}); acc = v; });
              } else no(`${fn} needs two arguments`);
            } else {
              const a = atom(c, 'condition');
              lines.push({kind: 'lit', p: a.p, args: a.args, neg: a.negated ? (c.strong || !c.negated ? 'not' : 'naf') : null});
            }
          }
          return lines;
        };
        for (const r of ir.rules) {
          const when = lowerWhen(r.when);
          const h = atom(r.then, 'head');
          out.push({id: id('r'), type: 'rule', when, pred: h.p, args: h.args, negated: h.negated});
        }
        for (const r of ir.valueRules) {
          const p = usePred(slug(r.name), [{}], 'head');
          const when = lowerWhen(r.when);
          let head;
          if ('num' in r.term) { head = String(r.term.num); p.kinds[0].add(Number.isInteger(r.term.num) ? 'int' : 'dec'); }
          else if (r.term.var) { head = `?${slug(r.term.var)}`; p.kinds[0].add('var'); }
          else no('a quantity rule with arithmetic in its conclusion');
          out.push({id: id('r'), type: 'rule', when, pred: p, args: [head], negated: false});
        }
        if (ir.constraints.length) no('a comparison stated without a condition (no knowledge reading)');
        if (ir.queries.length) stats.questions += ir.queries.length;
        for (const idUsed of lineEnts) ents.get(idUsed).used = true;
        for (const w of out) {
          w.pred.used = true;
          for (const l of w.when ?? []) if (l.p) l.p.used = true;
          Object.assign(w, {unit: u.key, passage: u.passage, quote: u.unit.quote, source: `${title}, ${u.unit.section || 'untitled section'}, line ${u.unit.line}`, table: Boolean(u.unit.table), status: u.status ?? null, fol: line});
          wires.push(w);
          if (w.type === 'fact') { w.pred.facts.push(w); stats.facts++; }
          else { (w.negated ? w.pred.negRules : w.pred.rules).push(w); stats.rules++; }
        }
        stats.converted++;
      } catch (error) {
        if (!(error instanceof Reject) && !/unknown date function/.test(error.message)) throw error;
        stats.rejected++;
        rejected.push({unit: u.key, fol: line, ...(parts.length > 1 ? {part: showFol(part)} : {}), why: error.message});
      }
    }
  }
  stats.vocabulary_misses = [...stats.vocabulary_misses];
  stats.new_constants = [...stats.new_constants];
  return {wires, predicates: [...preds.values()].filter(p => p.used), entities: [...ents.values()].filter(e => e.used), rejected, stats};
}

/**
 * Statements made of a group's name: a fact whose first argument is a constant that table rows give as a value to several members
 * (R(a, c), R(b, c) from a table): the sentence may state it of the group's members. Returned as findings for the FOL repair: [{unit, text}].
 */
export function groupStatements(conv) {
  const members = new Map();
  // Membership comes from table rows only (a roster's department column), never from prose relations: "Ganymede is less dense than
  // Europa" and "Callisto is less dense than Europa" do not make Europa a group (measured on eval-ingest-v1, 2026-10-03).
  for (const w of conv.wires) if (w.type === 'fact' && !w.negated && w.table) w.args.slice(1).forEach(a => {
    if (!/^[a-z]/.test(a)) return;
    const k = `${a}\u0000${w.pred.id}`;
    if (!members.has(k)) members.set(k, {value: a, pred: w.pred, firsts: new Set()});
    members.get(k).firsts.add(w.args[0]);
  });
  const groups = new Map();
  for (const m of members.values()) if (m.firsts.size >= 2 && !groups.has(m.value)) groups.set(m.value, m.pred);
  const camelOf = id => id.split('_').filter(Boolean).map(x => x[0].toUpperCase() + x.slice(1)).join('');
  return conv.wires.filter(w => w.type === 'fact' && groups.has(w.args[0]) && groups.get(w.args[0]) !== w.pred).map(w => {
    const r = camelOf(groups.get(w.args[0]).id);
    return {unit: w.unit, text: `${w.fol} states ${camelOf(w.pred.id)} of the group ${w.args[0]}, which the document's facts give to its members (${r}(x, ${w.args[0]})). Unless the sentence is about the group as a whole (a total, a count or a share of the whole, its size, its place, its head: keep those on the group, never copy them onto each member), it states something of every member: write it as a rule over the members, FORALLx (${r}(x, ${w.args[0]}) IMPLIES ${camelOf(w.pred.id)}(x${w.args.length > 1 ? ', ...' : ''})).`};
  });
}

/**
 * Values a rule condition gives a relation that its facts never take, while the facts take other values (HasLevel(x, senior_members)
 * against facts HasLevel(ann, senior)): the condition can never hold. Findings for the FOL repair: [{unit, text}].
 */
export function unmatchedValues(conv) {
  const values = new Map();
  for (const w of conv.wires) if (w.type === 'fact' && !w.negated) w.args.forEach((a, i) => { const k = `${w.pred.id}/${i}`; if (!values.has(k)) values.set(k, new Set()); values.get(k).add(a); });
  const camelOf = id => id.split('_').filter(Boolean).map(x => x[0].toUpperCase() + x.slice(1)).join('');
  const out = [];
  for (const w of conv.wires) if (w.type !== 'fact') for (const l of w.when) {
    if (l.kind !== 'lit') continue;
    l.args.forEach((a, i) => {
      const have = values.get(`${l.p.id}/${i}`);
      if (!have || have.has(a) || a.startsWith('?') || !/^[a-z]/.test(a)) return;
      out.push({unit: w.unit, text: `${w.fol} asks ${camelOf(l.p.id)} for the value ${a}, which no fact of the document has; its facts use ${[...have].slice(0, 10).join(', ')}. Use the value the facts use for the same thing.`});
    });
  }
  return out;
}

/** Least fixpoint: table-only predicates, then predicates defined by strict rules over closed predicates; aux predicates are closed. */
export function closure(predicates, existing = new Map()) {
  const closed = new Set(predicates.filter(p => p.aux || (p.canon?.shared?.closed && p.canon.args.length === p.arity)).map(p => p.id));
  for (const [id, e] of existing) if (e.closed) closed.add(id);
  const own = predicates.filter(p => !p.aux && !existing.has(p.id));
  const deps = p => p.rules.flatMap(r => r.when.filter(l => l.kind === 'lit').map(l => l.p.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of own) {
      if (closed.has(p.id)) continue;
      const facts = p.facts.filter(f => !f.negated);
      if (!facts.length && !p.rules.length) continue;
      if (facts.some(f => !f.table || f.status)) continue;
      if (p.rules.some(r => r.status || r.type !== 'rule')) continue;
      if (deps(p).every(d => closed.has(d) || d === p.id) && (facts.length || p.rules.length)) { closed.add(p.id); changed = true; }
    }
  }
  return closed;
}

const q = s => JSON.stringify(String(s));

/** The type of an argument position from its uses and the vocabulary's kind. */
function argType(p, i) {
  const k = p.kinds[i], vk = p.canon?.args?.[i];
  if (vk === 'date') return 'integer';
  if (k.has('dec')) return 'value';
  if (k.has('int') && !k.has('entity') && !k.has('text')) return 'integer';
  if (k.has('num') && !k.has('entity') && !k.has('text')) return 'value';
  if (vk === 'number' && !k.has('entity') && !k.has('text')) return k.has('dec') ? 'value' : 'integer';
  if (k.has('text') && !k.has('entity') && !k.has('int')) return 'text';
  return 'entity';
}

/**
 * The SOP text of the converted wires: {vocabulary, passages: Map key → text, closed, dropped}. `entityVocab`: the canonical
 * entities (labels, aliases, kinds). Declarations of ids `existing` has are not written again.
 */
export function renderWires(conv, {existing = new Map(), existingIds = new Set(), entityVocab = [], title, docSource}) {
  // A positive conclusion the document also denies by a strict rule: the exception wins, the general rule is a default.
  for (const p of conv.predicates) if (p.negRules.some(r => !r.status)) for (const r of p.rules) r.type = 'default';
  for (const w of conv.wires) if (w.type === 'rule' && w.status) w.type = 'default';
  const closed = closure(conv.predicates, existing);
  // Positions that hold numbers: literal numbers, the vocabulary's date and number kinds, and every position a variable of a
  // `compute` or `compare` line (or of another numeric position) fills in a rule (fixpoint over the rules).
  const numeric = new Set();
  for (const p of conv.predicates) p.kinds.forEach((k, i) => { if (k.has('int') || k.has('dec') || ['date', 'number'].includes(p.canon?.args?.[i])) numeric.add(`${p.id}/${i}`); });
  const ruleWires = conv.wires.filter(w => w.type !== 'fact');
  const slots = w => [...w.when.filter(l => l.kind === 'lit').map(l => ({p: l.p, args: l.args})), {p: w.pred, args: w.args}];
  for (let changed = true; changed;) {
    changed = false;
    for (const w of ruleWires) {
      const vars = new Set(w.when.filter(l => l.kind !== 'lit').flatMap(l => l.text.match(/\?[a-z][a-z0-9_]*/g) ?? []));
      for (const sl of slots(w)) sl.args.forEach((a, i) => { if (a.startsWith('?') && numeric.has(`${sl.p.id}/${i}`)) vars.add(a); });
      for (const sl of slots(w)) sl.args.forEach((a, i) => { const k = `${sl.p.id}/${i}`; if (vars.has(a) && !numeric.has(k)) { numeric.add(k); sl.p.kinds[i].add('num'); changed = true; } });
    }
  }
  const decl = [];
  const declared = new Set();
  for (const p of conv.predicates) {
    if (existing.has(p.id) || declared.has(p.id)) continue;
    declared.add(p.id);
    const used = new Set();
    const args = Array.from({length: p.arity}, (_, i) => {
      const type = argType(p, i);
      let role = p.canon?.args?.[i] === 'date' && !used.has('time') ? 'time' : ROLES.find(r => !used.has(r));
      used.add(role);
      return `${role}:${type}`;
    });
    // A shared relation is declared exactly as its vocabulary file declares it (the same wire, should the memory import that layer).
    if (p.canon?.shared?.declaration && p.canon.args.length === p.arity) { decl.push(p.canon.shared.declaration, ''); continue; }
    const words = p.aux ? `auxiliary condition of ${title}` : p.id.replace(/_/g, ' ');
    decl.push(`@${p.id} predicate`, `  args ${args.join(' ') || 'none'}`, ...(p.aux ? [] : [`  label en ${q(words)}`]),
      `  description ${q(p.aux ? `an auxiliary condition built from the logic of a sentence of ${title}` : `${p.canon?.reading || words} (from ${title})`)}`,
      ...(p.canon?.key && p.arity >= 2 ? [`  key ${p.canon.key}`] : []), ...(closed.has(p.id) ? ['  closed true'] : []), ...(!p.aux && args[0]?.endsWith(':entity') ? ['  reading describe'] : []), '');
  }
  // Entities: every constant used, with its canonical label, aliases and kind (a class entity per kind).
  const byId = new Map(entityVocab.map(e => [e.id, e]));
  const isPred = id => conv.predicates.some(p => p.id === id) || (existing.has(id));
  const kindOf = e => { const v = byId.get(e.id) ?? e.canon; return v?.kind && v.kind !== e.id && !isPred(v.kind) && SYMBOL.test(v.kind) ? v.kind : null; };
  const classes = new Set(conv.entities.map(kindOf).filter(Boolean));
  const entLines = [];
  for (const e of conv.entities) {
    if (existingIds.has(e.id) || declared.has(e.id)) continue;
    if (isPred(e.id)) continue;
    declared.add(e.id);
    const v = byId.get(e.id) ?? e.canon;
    const kind = classes.has(e.id) ? 'class' : kindOf(e);
    entLines.push(`@${e.id} entity`, ...(kind ? [`  kind ${kind}`] : []), `  label en ${q(v?.label ?? e.label)}`, ...(v?.aliases ?? []).slice(0, 8).map(a => `  alias en ${q(a)}`), `  source ${q(docSource)}`, '');
  }
  const classLines = [];
  for (const c of classes) {
    if (existingIds.has(c) || declared.has(c)) continue;
    declared.add(c);
    classLines.push(`@${c} entity`, '  kind class', `  label en ${q(c.replace(/_/g, ' '))}`, `  source ${q(docSource)}`, '');
  }
  const passages = new Map();
  for (const w of conv.wires) {
    const lines = [`@${w.id} ${w.type}`];
    if (w.type === 'fact') {
      lines.push(`  holds ${w.negated ? 'not ' : ''}${[w.pred.id, ...w.args].join(' ')}`);
      if (w.status) lines.push(`  status ${w.status}`);
    } else {
      for (const l of w.when) {
        if (l.kind !== 'lit') { lines.push(`  when ${l.text}`); continue; }
        const neg = l.neg === 'naf' ? (closed.has(l.p.id) ? 'absent ' : 'not ') : l.neg === 'not' ? 'not ' : '';
        lines.push(`  when ${neg}${[l.p.id, ...l.args].join(' ')}`);
      }
      lines.push(`  then ${w.negated ? 'not ' : ''}${[w.pred.id, ...w.args].join(' ')}`);
    }
    lines.push(`  quote ${q(w.quote)}`, `  source ${q(w.source)}`, '');
    passages.set(w.passage, (passages.get(w.passage) ?? '') + lines.join('\n') + '\n');
  }
  return {vocabulary: [...classLines, ...decl, ...entLines].join('\n').trim() + '\n', passages, closed: [...closed].filter(id => !existing.has(id))};
}
