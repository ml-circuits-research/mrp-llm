/**
 * SOP-IR (./to-ir.mjs) → SOP Lang circuits, one per query (several asked unknowns share one), deterministically.
 *   logic      facts become `stated` wires, rules become session `rule` wires, every predicate a session predicate (prefix `f_`, roles
 *              subject, object, topic, recipient by position; a position that holds a number is typed `value`) declared
 *              `closed true`: the problem is its own closed world (DS014 "Problems that state their own data"), so an underivable
 *              ground literal is refuted; an open predicate (a disjunct of a disjunctive conclusion, the dropped part of an
 *              existential one) is not closed. A negated condition is `absent`, an explicitly negated one (a disjunction's other
 *              disjuncts) `not`; comparisons are `compare` (and `compute` for arithmetic), over the problem's quantities when they
 *              name one. Before/After get transitivity and After(a, b) ≡ Before(b, a). The auxiliary predicates of universal and
 *              negated conditions (`fx_aux…`) and the problem's domain (`fx_thing`, every thing it names) are declared like the rest.
 *   yes/no     the literal (or a conjunction of ground literals) is queried; supported → true, refuted → false, anything else → no
 *              answer
 *   which      a session rule `fq_answer ?v` per alternative of the question's condition, queried with `select`; the answer is the
 *              list of things (an empty list when none exists: FOL's ∃x φ asked as a question is both "is there" and "which");
 *              `none` (¬∃x φ) answers yes when the list is empty
 *   every      `mode every` with `quantifier all` over the known members of the restriction (no member: unknown)
 *   value and compare   (the answer must reach a registry number through the dataflow: a written final number is refused)
 *              the Value definitions become numbered lines `name = expression` over the registry v1..vn (a number equal to a
 *              registry number is that number's index, so a perturbation moves it) and go through the expression program's static
 *              analysis and lowering (lib/formalize/expression-program.mjs); a quantity defined by value rules (a Value concluded
 *              under conditions) is defined by session rules of its own and read by the program as an external name
 *   support    (fol-v3) Effect, Explain, Missing, Why and Change: `mode effect` with the options as `candidate` wires (`opt_<label>`:
 *              a fact as `stated certainty supposed`, a rule as a session rule), `mode abduce` over them, `mode why_not`, `mode explain`,
 *              and for Change one `mode effect` circuit per premise with that premise as the only candidate (see `metaCircuits`);
 *              the formalizer's assumptions: facts as `assumed` wires (reported by the runtime, never facts), rules as session rules
 *              each question rests on supposes with `if` (its answer is then conditional on them); Assumed lists them
 *   unknowns   a value or comparison that depends on a quantity no Value defines but the problem's comparisons constrain is a
 *              constraint search: one model `constraint` wire (integer variables, bounds derived soundly from the comparisons by
 *              interval propagation, requirements in words, `task possible` / `prove` / `optimize`), solved by the constraint
 *              engine; a value is given only when every solution agrees on it
 * Soundness (owner, 2026-10-03: a wrong circuit is worse than an honest unknown): a negative answer (refuted, an empty list, a failed
 * universal) rests on the closed world, so it is withheld (no answer) when the query's predicates depend on a predicate the closed
 * world cannot vouch for (an open one, or one a rejected statement mentions), or when the asked predicate is defined nowhere in the
 * problem (no fact or rule concludes it: the "no" would be a guess); a refutation with a proof (an explicit negation) is kept. A quantity given two different values, or a value rule
 * that gives two different values, has no answer.
 * `compileIr(ir, {registry, names})` → {circuits: [{kind, query, sop, literals, decode(packet)}], rejected: [{why}]}.
 * `names`: Map slug → display text (the PSM's entity spans), so a constant `cedar` is shown and answered as "Cedar".
 */
import {analyseProgram, lowerProgram} from '../expression-program.mjs';
import {ARITH, MATH, RESERVED, DOMAIN, varsOf} from './to-ir.mjs';

const ROLES = ['subject', 'object', 'topic', 'recipient'];
export const slug = s => String(s).normalize('NFKD').replace(/\p{M}/gu, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const quote = s => JSON.stringify(String(s));
const WORD = {Lt: 'below', Le: 'at_most', Gt: 'above', Ge: 'at_least', Eq: 'equal', Ne: 'not_equal'};
const JS = {Lt: '<', Le: '<=', Gt: '>', Ge: '>=', Eq: '==', Ne: '!='};
const COMPUTE = {add: 'plus', sub: 'minus', mul: 'times', div: 'divided_by', mod: 'modulo', pow: 'power', min: 'minimum_with', max: 'maximum_with'};
const ROUND = {ceil: 'rounded_up_to', floor: 'rounded_down_to', round: 'rounded_to'};
const MAX_ASSIGNMENTS = 100000;
const isAux = p => /^__aux\d+$/.test(p);

class Fail extends Error {}
const fail = why => { throw new Fail(why); };

/** Predicate ids, arities and numeric positions of the logic part. */
function vocabulary(literals) {
  const uses = new Map();
  for (const l of literals) {
    if (!uses.has(l.pred)) uses.set(l.pred, new Set());
    uses.get(l.pred).add(l.args.length);
  }
  const ids = new Map(), taken = new Set();
  for (const [pred, arities] of uses) for (const n of arities) {
    let id = pred === DOMAIN ? 'fx_thing' : isAux(pred) ? `fx_${pred.slice(2)}` : `f_${slug(pred).slice(0, 40) || 'p'}${arities.size > 1 ? `_${n}` : ''}`;
    while (taken.has(id)) id += '_x';
    taken.add(id); ids.set(`${pred}/${n}`, id);
  }
  return ids;
}

const firstValues = p => (p?.answers ?? []).map(a => Object.values(a.binding ?? a)[0]).filter(v => v !== undefined);
// A constant is shown as the problem names it (the PSM's span), else as words (case_d → "case d").
const back = (names, v) => { const s = slug(String(v).replace(/^local_/, '')); for (const [k, shown] of names) if (k === s || slug(shown) === s) return shown; return String(v).replace(/^local_/, '').replace(/_/g, ' '); };
const termConsts = t => (t.const ? [t.const] : t.fn ? t.args.flatMap(termConsts) : []);
const termNums = t => ('num' in t ? [t.num] : t.fn ? t.args.flatMap(termNums) : []);
const itemTerms = c => (c.cmp ? [c.a, c.b] : c.value ? [c.value, c.term] : []);

/** The problem's quantities, named choices, unknowns and conflicts, from the IR. */
function classify(ir) {
  const byName = new Map();
  for (const v of ir.values) { const k = slug(v.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(v); }
  const conditional = new Map();
  for (const r of ir.valueRules) { const k = slug(r.name); if (!conditional.has(k)) conditional.set(k, []); conditional.get(k).push(r); }
  const constrained = new Set([...ir.constraints.flatMap(c => [c.a, c.b]), ...ir.objectives.map(o => o.term)].flatMap(termConsts).map(slug).concat(ir.integer.map(slug)));
  const isQuantity = c => byName.has(slug(c)) || conditional.has(slug(c)) || constrained.has(slug(c));
  // A Value whose term is a constant that is no quantity is a named choice: the fact Value(q, c) of the logic part.
  const choices = [], defs = new Map(), conflicts = new Set();
  // Does a term read the quantity `target`, through the definitions of the quantities it reads?
  const reads = (t, target, seen = new Set()) => termConsts(t).map(slug).some(c => c === target || (!seen.has(c) && (seen.add(c), (byName.get(c) ?? []).some(v => reads(v.term, target, seen)))));
  for (const [k, list] of byName) {
    let numeric = list.filter(v => !(v.term.const && !isQuantity(v.term.const)));
    // q = r next to a definition of q, where r is itself defined through q (an IFF between two names): the alias says nothing new.
    const plain = numeric.filter(v => !(v.term.const && reads(v.term, k)));
    if (new Set(numeric.map(v => JSON.stringify(v.term))).size > 1 && plain.length) numeric = plain;
    for (const v of list.filter(x => !numeric.includes(x))) choices.push({pred: RESERVED.value, args: [{const: v.name}, v.term], negated: false});
    if (!numeric.length) continue;
    if (new Set(numeric.map(v => JSON.stringify(v.term))).size > 1 || conditional.has(k)) conflicts.add(k);
    defs.set(k, numeric[0]);
  }
  const unknowns = new Set([...constrained].filter(k => !defs.has(k) && !conditional.has(k)));
  return {defs, conditional, conflicts, unknowns, choices, isQuantity: c => defs.has(slug(c)) || conditional.has(slug(c)) || unknowns.has(slug(c))};
}

/** A Value condition item on a named choice is the logic literal Value(q, c); on a quantity it stays a numeric item. */
function itemOf(c, k) {
  if (c.value && c.value.const && !k.isQuantity(c.value.const) && (c.term.var || (c.term.const && !k.isQuantity(c.term.const)))) return {pred: RESERVED.value, args: [c.value, c.term], negated: false};
  return c;
}

/** The quantities a term or an item reads. */
const quantitiesOf = (terms, k) => [...new Set(terms.flatMap(termConsts).filter(c => k.isQuantity(c)).map(slug))];

export function compileIr(ir, {registry = [], names = new Map()} = {}) {
  const k = classify(ir);
  const circuits = [], rejected = [];
  const rules = ir.rules.map(r => ({...r, when: r.when.map(c => itemOf(c, k))}));
  const valueRules = ir.valueRules.map(r => ({...r, when: r.when.map(c => itemOf(c, k))}));
  for (const [name, list] of k.conditional) k.conditional.set(name, list.map(r => ({...r, when: r.when.map(c => itemOf(c, k))})));
  const facts = [...ir.facts, ...k.choices];
  // fol-v3: the options of an argument question and the formalizer's own assumptions (facts: `assumed` wires, reported; rules: session
  // rules every question supposes with `if`). An assumption equal to a stated fact says nothing new and is left out.
  const mapRule = r => ({...r, when: r.when.map(c => itemOf(c, k))});
  const stated = new Set(facts.map(factKey));
  const options = (ir.options ?? []).map((o, i) => ({...o, wid: `opt_${slug(o.id) || i + 1}${o.part ? `_${o.part}` : ''}`, ...(o.rule ? {rule: mapRule(o.rule)} : {})}));
  const assumedFacts = (ir.assumed ?? []).filter(a => a.kind === 'fact' && !stated.has(factKey(a.fact))).map(a => a.fact);
  const assumedRules = (ir.assumed ?? []).filter(a => a.kind === 'rule').map(a => mapRule(a.rule));
  // Options are only the candidates of Effect and Explain: never in force in another question.
  const hypo = {options, assumedFacts, assumedRules, assumedSources: (ir.assumed ?? []).map(a => a.source)};

  // Predicates the closed world cannot vouch for (open ones, those a rejected statement mentions, the heads of dropped rules) and
  // everything derived from them.
  const affected = new Set([...ir.open, ...ir.rejected.filter(x => !x.question).flatMap(x => x.preds ?? [])]);
  const open = new Set(ir.open);
  const drop = (r, why) => { rejected.push({why}); affected.add(r.then.pred); return false; };
  // `absent` on an open predicate has no meaning (the predicate is not closed); a rule that reads a quantity without a definition
  // cannot run: such rules are dropped.
  let kept = rules.filter(r => {
    const bad = r.when.find(c => c.pred && c.negated && !c.strong && open.has(c.pred));
    if (bad) return drop(r, `a rule negates the open predicate ${bad.pred} by absence`);
    const qs = ruleQuantities([r], k);
    if (qs.length) try { quantityProgram(qs, null, {k, registry}); } catch (error) { return drop(r, error.message); }
    return true;
  });
  let shared;
  try { shared = ruleQuantities(kept, k); quantityPart(shared, k, registry); } catch (error) {
    kept = kept.filter(r => !ruleQuantities([r], k).length || drop(r, error.message));
    shared = [];
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rules) if (!affected.has(r.then.pred) && r.when.some(c => c.pred && affected.has(c.pred))) { affected.add(r.then.pred); changed = true; }
  }
  const trusted = preds => preds.every(p => !affected.has(p));

  for (const q of ir.queries) {
    try {
      if (q.kind === 'value' || q.kind === 'compare') {
        const terms = q.kind === 'value' ? [{const: q.name}] : testTerms(q.test);
        if (dependsOnUnknown(terms, k)) continue; // gathered below, one constraint circuit per problem
        circuits.push(valueCircuit(q, {k, facts, rules: kept, valueRules, registry, names, open}));
        continue;
      }
      if (META_KINDS.includes(q.kind)) { circuits.push(...metaCircuits(q, {k, facts, rules: kept, valueRules, registry, names, trusted, open, ...hypo})); continue; }
      circuits.push(logicCircuit(q, {k, facts, rules: kept, valueRules, registry, names, trusted, open, ...hypo}));
    } catch (error) {
      rejected.push({source: q.source, why: error.message});
    }
  }
  const search = ir.queries.filter(q => (q.kind === 'value' || q.kind === 'compare') && dependsOnUnknown(q.kind === 'value' ? [{const: q.name}] : testTerms(q.test), k));
  if (search.length) {
    try { circuits.push(...constraintCircuits(search, ir, k, registry)); } catch (error) { rejected.push({source: search[0].source, why: error.message}); }
  }
  return {circuits, rejected};
}

const testTerms = t => (t.cmp ? [t.a, t.b] : [...testTerms(t.a), ...testTerms(t.b)]);

/** A term reads an unknown, directly or through the definitions of the quantities it reads. */
function dependsOnUnknown(terms, k, seen = new Set()) {
  for (const c of terms.flatMap(termConsts).map(slug)) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (k.unknowns.has(c)) return true;
    if (k.defs.has(c) && dependsOnUnknown([k.defs.get(c).term], k, seen)) return true;
    if (k.conditional.has(c) && dependsOnUnknown(k.conditional.get(c).flatMap(r => [r.term, ...r.when.flatMap(itemTerms)]), k, seen)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- the quantity part (expression program + value rules)

/**
 * The program of the quantities `wanted` (names) plus an optional answer line: unconditional quantities are program lines over the
 * registry; quantities defined by value rules are external names with rules of their own. Returns {lines, external: Map name →
 * predicate id, conditionalNames}.
 */
function quantityProgram(wanted, answer, {k, registry}) {
  const lines = [], done = new Set(), visiting = new Set(), external = new Map(), conditionalNames = [];
  // A registry percentage means its fraction in a program (15% is 0.15): a written 0.15 is that number, a written 15 is 100 times it.
  const ref = x => {
    const frac = registry.find(v => v.percent && Math.abs(v.value / 100 - x) < 1e-12), plain = registry.find(v => !v.percent && v.value === x), pct = registry.find(v => v.percent && v.value === x);
    return plain ? `v${plain.index}` : frac ? `v${frac.index}` : pct ? `(v${pct.index} * 100)` : String(x);
  };
  const expr = t => {
    if ('num' in t) return ref(t.num);
    if (t.const) { const s = slug(t.const); emit(s); return `q_${s}`; }
    if (t.fn && ARITH[t.fn] && t.args.length >= 2) {
      if ((t.fn === 'sub' || t.fn === 'div' || t.fn === 'mod') && t.args.length !== 2) fail(`${t.fn} takes two terms`);
      return t.args.map(expr).reduce((a, b) => `(${a} ${ARITH[t.fn]} ${b})`);
    }
    if (t.fn && MATH.includes(t.fn) && t.args.length >= 1) return `Math.${t.fn}(${t.args.map(expr).join(', ')})`;
    return fail(`the term ${t.fn ?? t.var ?? '?'} is not arithmetic`);
  };
  const emit = name => {
    if (done.has(name)) return;
    if (visiting.has(name)) fail(`${name} is defined by itself`);
    if (k.conflicts.has(name)) fail(`the quantity ${name} is given two different values`);
    if (k.conditional.has(name)) {
      visiting.add(name);
      external.set(`q_${name}`, `qc_${name}`);
      conditionalNames.push(name);
      for (const r of k.conditional.get(name)) for (const c of quantitiesOf([r.term, ...r.when.flatMap(itemTerms)], k)) emit(c);
      visiting.delete(name); done.add(name);
      return;
    }
    const d = k.defs.get(name);
    if (!d) fail(`the quantity ${name} is used but never given a Value`);
    visiting.add(name);
    const text = expr(d.term);
    visiting.delete(name); done.add(name);
    lines.push({name: `q_${name}`, text});
  };
  for (const w of wanted) emit(w);
  if (answer) lines.push({name: 'answer1', text: answer(expr)});
  return {lines, external, conditionalNames};
}

/** Analyses and lowers a quantity program; returns {sop (queries kept), pid}. */
function lowered(lines, external, registry) {
  const used = new Set(lines.flatMap(l => [...l.text.matchAll(/\bv(\d+)\b/g)].map(m => Number(m[1]))));
  const read = {lines: lines.map((l, i) => ({n: i + 1, name: l.name, text: l.text})), unused: registry.map(v => v.index).filter(i => !used.has(i))};
  const analysis = analyseProgram(read, registry, {external});
  if (!analysis.ok) fail(analysis.violations.map(v => v.message).slice(0, 2).join('; '));
  const low = lowerProgram(analysis, registry, {external});
  return {sop: low.sop, pid: low.predicates};
}

/** SOP condition lines of a term: [lines, text]; quantities read through their predicates, arithmetic through `compute`. */
function termLines(t, ctx) {
  if ('num' in t) return [[], String(t.num)];
  if (t.var) return [[], `?${slug(t.var) || 'v'}`];
  if (t.const) {
    const s = slug(t.const);
    if (ctx.k.isQuantity(t.const)) {
      const id = ctx.pid?.get(`q_${s}`);
      if (!id) fail(`the quantity ${s} is used but never given a Value`);
      return [[`${id} ?qv_${s}`], `?qv_${s}`];
    }
    const shown = ctx.names.get(s) ?? t.const;
    ctx.literals.add(shown);
    return [[], quote(shown)];
  }
  if (t.fn && (COMPUTE[t.fn] || ROUND[t.fn] || t.fn === 'abs')) {
    const parts = t.args.map(a => termLines(a, ctx)), lines = parts.flatMap(p => p[0]);
    if (ROUND[t.fn] || t.fn === 'abs') {
      if (parts.length !== 1) fail(`${t.fn} takes one term`);
      const v = `?t${++ctx.counter}`;
      if (t.fn === 'abs') { const n = `?t${++ctx.counter}`; return [[...lines, `compute ${n} 0 minus ${parts[0][1]}`, `compute ${v} ${parts[0][1]} maximum_with ${n}`], v]; }
      return [[...lines, `compute ${v} ${parts[0][1]} ${ROUND[t.fn]} 1`], v];
    }
    if (parts.length < 2 || (!['add', 'mul', 'min', 'max'].includes(t.fn) && parts.length !== 2)) fail(`${t.fn} takes two terms`);
    let acc = parts[0][1];
    for (const p of parts.slice(1)) { const v = `?t${++ctx.counter}`; lines.push(`compute ${v} ${acc} ${COMPUTE[t.fn]} ${p[1]}`); acc = v; }
    return [lines, acc];
  }
  return fail(`the term ${t.fn ?? '?'} is not arithmetic`);
}

/** SOP condition lines of one rule item. */
function itemLines(c, ctx) {
  if (c.pred) return [`${c.negated ? (c.strong ? 'not ' : 'absent ') : ''}${atomText(c, ctx)}`];
  if (c.cmp) {
    const [la, a] = termLines(c.a, ctx), [lb, b] = termLines(c.b, ctx);
    return [...la, ...lb, `compare ${a} ${WORD[c.cmp]} ${b}`];
  }
  if (c.value) {
    if (!c.value.const) fail('a Value of a quantity named by a variable');
    const [lq, q] = termLines(c.value, ctx);
    if (c.term.var) return [lq[0].replace(/\?qv_\S+$/, `?${slug(c.term.var)}`)];
    const [lt, t] = termLines(c.term, ctx);
    return [...lq, ...lt, `compare ${q} equal ${t}`];
  }
  return fail('an unknown condition');
}

function atomText(l, ctx) {
  const id = ctx.ids.get(`${l.pred}/${l.args.length}`);
  if (!l.args.length) { ctx.literals.add('problem'); return `${id} ${quote('problem')}`; }
  return `${id} ${l.args.map(t => {
    if (t.fn) fail('a function term in a logic literal');
    if (t.var) return `?${slug(t.var) || 'v'}`;
    if ('num' in t) { ctx.literals.add(String(t.num)); return String(t.num); }
    const shown = ctx.names.get(slug(t.const)) ?? t.const;
    ctx.literals.add(shown);
    return quote(shown);
  }).join(' ')}`;
}

/**
 * The logic part as SOP text (predicates, stated facts, rules, the domain) plus the value rules of the conditional quantities.
 * fol-v3 adds: `options` (SUPPOSE: a fact as `stated certainty supposed`, a rule as a session rule; ids `opt_<label>`), `assumed`
 * facts (ASSUME: `assumed` wires, ids `fa<n>`), `assumedRules` (ASSUME: session rules `fa_r<n>`), and `supposedKey` (the one fact of
 * the problem written `certainty supposed`, so a question can try the answer without it). Returns the wire ids as well: `factIds`
 * (fact key → id) and `ruleIds` (rule index → id).
 */
function logicText({facts, rules, extra = [], open, names, k, pid, valueRules = [], conditionalNames = [], typing = [], options = [], assumed = [], assumedRules = [], supposedKey = null}) {
  const literals = new Set(), out = [];
  // Each fact once (SOP refuses a repeated statement).
  facts = [...new Map(facts.map(f => [factKey(f), f])).values()];
  const optionRules = options.filter(o => o.kind === 'rule').map(o => o.rule), optionFacts = options.filter(o => o.kind === 'fact').map(o => o.fact);
  const ruleLits = rs => rs.flatMap(r => [...r.when.filter(c => c.pred), r.then]);
  const lits = [...facts, ...ruleLits(rules), ...extra, ...valueRules.flatMap(r => r.when.filter(c => c.pred)), ...optionFacts, ...ruleLits(optionRules), ...assumed, ...ruleLits(assumedRules)];
  // A thing named only by a rule or the question is introduced by the domain fact (the problem names it), so it can be linked.
  const inFacts = new Set(facts.flatMap(f => f.args).filter(t => t.const).map(t => slug(t.const)));
  const strangers = lits.flatMap(l => l.args).filter(t => t.const && !inFacts.has(slug(t.const)));
  if (strangers.length) lits.push({pred: DOMAIN, args: [{var: 'x'}], negated: false});
  const ids = vocabulary(lits);
  const ctx = {ids, names, literals, k, pid, counter: 0};
  const numeric = new Map();
  for (const l of lits) l.args.forEach((t, i) => { if ('num' in t) numeric.set(`${l.pred}/${l.args.length}/${i}`, true); });
  // A variable that a condition orders or computes with holds a number: its positions are typed value.
  for (const items of [...[...rules, ...optionRules, ...assumedRules].map(r => [...r.when, r.then]), ...valueRules.map(r => r.when), ...typing]) {
    const nv = new Set(items.filter(c => c.cmp && (!['Eq', 'Ne'].includes(c.cmp) || [c.a, c.b].some(t => 'num' in t || t.fn))).flatMap(c => [c.a, c.b]).flatMap(function walk(t) { return t.var ? [t.var] : t.fn ? t.args.flatMap(walk) : []; }));
    for (const l of items.filter(c => c.pred)) l.args.forEach((t, i) => { if (t.var && nv.has(t.var)) numeric.set(`${l.pred}/${l.args.length}/${i}`, true); });
  }
  for (const [key, id] of ids) {
    const [pred, n] = [key.slice(0, key.lastIndexOf('/')), Number(key.slice(key.lastIndexOf('/') + 1))];
    if (n > ROLES.length) fail(`${pred} has ${n} arguments (at most ${ROLES.length})`);
    const args = n === 0 ? 'subject:entity' : ROLES.slice(0, n).map((r, i) => `${r}:${numeric.get(`${pred}/${n}/${i}`) ? 'value' : 'entity'}`).join(' ');
    // A display label (the predicate's name in words), so an answer that names a fact or a rule reads "wet", not "f wet".
    const words = /^f_/.test(id) ? slug(pred).replace(/_/g, ' ') : '';
    out.push(`@${id} predicate\n  args ${args}\n${words ? `  label en ${quote(words)}\n` : ''}${open?.has(pred) ? '' : '  closed true\n'}`);
  }
  const proposition = (f, type, certainty) => {
    const args = f.args.length ? f.args.map(t => termOf(t, ctx)) : [quote('problem')];
    if (!f.args.length) literals.add('problem');
    return `${type}\n${certainty ? `  certainty ${certainty}\n` : ''}  relation "${ids.get(`${f.pred}/${f.args.length}`)}"\n${args.map((a, j) => `  role ${ROLES[j]} ${a}`).join('\n')}\n  polarity ${f.negated ? 'negated' : 'affirmed'}\n`;
  };
  const ruleText = (id, r) => { ctx.counter = 0; return `@${id} rule\n${r.when.flatMap(c => itemLines(c, ctx)).map(l => `  when ${l}`).join('\n')}\n  then ${r.then.negated ? 'not ' : ''}${atomText(r.then, ctx)}\n`; };
  const factIds = new Map();
  facts.forEach((f, i) => { factIds.set(factKey(f), `fs${i + 1}`); out.push(`@fs${i + 1} ${proposition(f, 'stated', factKey(f) === supposedKey ? 'supposed' : 'asserted')}`); });
  const ruleIds = rules.map((r, i) => { out.push(ruleText(`fr${i + 1}`, r)); return `fr${i + 1}`; });
  for (const o of options) out.push(o.kind === 'fact' ? `@${o.wid} ${proposition(o.fact, 'stated', 'supposed')}` : ruleText(o.wid, o.rule));
  assumed.forEach((f, i) => out.push(`@fa${i + 1} ${proposition(f, 'assumed', null)}`));
  const assumedRuleIds = assumedRules.map((r, i) => { out.push(ruleText(`fa_r${i + 1}`, r)); return `fa_r${i + 1}`; });
  // The domain: every thing the problem names (entities only).
  if (ids.has(`${DOMAIN}/1`)) {
    const all = lits.some(l => l.pred === DOMAIN && l.args[0]?.var !== 'x') || [...rules, ...optionRules, ...assumedRules].some(r => r.when.some(c => c.pred === DOMAIN));
    const things = new Set(lits.filter(l => l.pred !== DOMAIN).flatMap(l => l.args).filter(t => t.const && (all || !inFacts.has(slug(t.const)))).map(t => names.get(slug(t.const)) ?? t.const));
    [...things].forEach((t, i) => { literals.add(t); out.push(`@fd${i + 1} stated\n  certainty asserted\n  relation "fx_thing"\n  role subject ${quote(t)}\n  polarity affirmed\n`); });
  }
  // The agreed time construct: Before is transitive, After is its inverse.
  const b = ids.get(`${RESERVED.before}/2`), a = ids.get(`${RESERVED.after}/2`);
  if (b) out.push(`@r_before_trans rule\n  when ${b} ?x ?y\n  when ${b} ?y ?z\n  then ${b} ?x ?z\n`);
  if (a && b) out.push(`@r_after_before rule\n  when ${a} ?x ?y\n  then ${b} ?y ?x\n`, `@r_before_after rule\n  when ${b} ?x ?y\n  then ${a} ?y ?x\n`);
  // Value rules: a quantity defined under conditions; two rules that give it different values leave it without an answer (decode).
  for (const name of conditionalNames) {
    out.push(`@qc_${name} predicate\n  args object:value\n`);
    k.conditional.get(name).forEach((r, i) => {
      ctx.counter = 0;
      const conds = r.when.flatMap(c => itemLines(c, ctx)), [lt, t] = termLines(r.term, ctx);
      const body = [...conds, ...lt];
      if (!/^\?/.test(t)) body.push(`compute ?k ${t} plus 0`);
      out.push(`@qr_${name}_${i + 1} rule\n${body.map(l => `  when ${l}`).join('\n')}\n  then qc_${name} ${/^\?/.test(t) ? t : '?k'}\n`);
    });
  }
  return {text: out, ids, literals, ctx, factIds, ruleIds, assumedRuleIds};
}

const factKey = f => JSON.stringify([f.pred, f.args, f.negated]);

/** Quantities read by numeric items of rules (so the logic part can compare them). */
const ruleQuantities = (rules, k) => quantitiesOf(rules.flatMap(r => r.when.flatMap(itemTerms)), k);

function quantityPart(wanted, k, registry) {
  if (!wanted.length) return {sop: '', pid: new Map(), conditionalNames: []};
  const p = quantityProgram(wanted, null, {k, registry});
  if (!p.lines.length) return {sop: '', pid: new Map([...p.external]), conditionalNames: p.conditionalNames};
  const low = lowered(p.lines, p.external, registry);
  // The program's own queries are not wanted here: only its predicates and rules.
  return {sop: low.sop.split(/\n(?=@)/).filter(b => !/^@\S+ query\b/.test(b.trim())).join('\n'), pid: low.pid, conditionalNames: p.conditionalNames};
}

/**
 * The rules a question rests on: backwards from the predicates it asks (and the conditions of the value rules), over the problem's
 * rules, the assumed rules and the option rules; forwards from what the options state (a candidate that contradicts an admitted fact
 * must be seen). `deps`: the predicates the asked ones are derived from (for the closed world's trust).
 */
function support(asked, {allRules, assumedRules = [], options = [], valueRules = []}) {
  const optionRules = options.filter(o => o.kind === 'rule').map(o => o.rule);
  const pool = [...allRules, ...assumedRules, ...optionRules];
  const reach = new Set(options.map(o => (o.fact ?? o.rule.then).pred));
  for (let changed = true; changed;) { changed = false; for (const r of pool) if (!reach.has(r.then.pred) && r.when.some(c => c.pred && reach.has(c.pred))) { reach.add(r.then.pred); changed = true; } }
  const back = seeds => {
    const out = new Set(seeds);
    for (let changed = true; changed;) { changed = false; for (const r of pool) if (out.has(r.then.pred)) for (const c of r.when) if (c.pred && !out.has(c.pred)) { out.add(c.pred); changed = true; } }
    return out;
  };
  const need = back([...asked, ...reach, ...optionRules.flatMap(r => r.when.filter(c => c.pred).map(c => c.pred)), ...valueRules.flatMap(r => r.when.filter(c => c.pred).map(c => c.pred))]);
  return {rules: allRules.filter(r => need.has(r.then.pred)), assumedRules: assumedRules.filter(r => need.has(r.then.pred)), optionRules, deps: back(asked)};
}

/** At most this many `assumed` wires per circuit (the runtime's default `policy.maxModelAssumptions`). */
const MAX_ASSUMED = 8;
/** The `if` lines that suppose the assumed rules a question rests on; a query carries at most 3 link lines (DS014 `link_too_many`). */
const MAX_IF = 3;
function ifLines(ids) {
  if (ids.length > MAX_IF) fail(`the question rests on ${ids.length} assumed rules (at most ${MAX_IF} can be supposed)`);
  return ids.map(id => `  if $${id}`);
}

function logicCircuit(q, {k, facts, rules: allRules, valueRules, registry, names, trusted, open, assumedFacts = [], assumedRules = []}) {
  const queryLits = q.kind === 'yesno' ? [q.lit, ...(q.also ?? [])] : q.kind === 'every' ? [...q.where, ...q.scope] : q.alts.flat().filter(c => c.pred);
  // Only the rules the question rests on (a rule elsewhere, even one that does not stratify, cannot change its answer).
  const S = support(queryLits.map(l => l.pred), {allRules, assumedRules, valueRules});
  const rules = S.rules;
  const wanted = [...new Set([...ruleQuantities(rules, k), ...quantitiesOf(q.kind === 'which' || q.kind === 'none' ? q.alts.flat().flatMap(itemTerms) : [], k)])];
  const part = quantityPart(wanted, k, registry);
  const usedValueRules = valueRules.filter(r => part.conditionalNames.includes(slug(r.name)));
  const L = logicText({facts, rules, extra: queryLits, open, names, k, pid: part.pid, valueRules: usedValueRules, conditionalNames: part.conditionalNames, typing: q.alts ?? [],
    assumed: assumedFacts.slice(0, MAX_ASSUMED), assumedRules: S.assumedRules});
  const body = [...L.text, ...(part.sop ? [part.sop] : [])];
  const ifs = ifLines(L.assumedRuleIds).map(l => `${l}\n`).join('');
  // Predicates the query rests on: its own and everything they are derived from.
  const deps = S.deps;
  // The closed world vouches for a negative answer only about what the problem defines (a fact or a rule concludes it); a predicate
  // that only the question names says nothing either way (a "no" there would be a guess).
  const defined = new Set([...facts.map(f => f.pred), ...rules.map(r => r.then.pred), ...S.assumedRules.map(r => r.then.pred)]);
  const asked = q.kind === 'yesno' ? [q.lit, ...(q.also ?? [])] : q.kind === 'every' ? q.scope : q.alts.flat().filter(c => c.pred && !c.negated);
  const closedOk = trusted([...deps]) && asked.every(l => defined.has(l.pred));
  // A closed-world negation (`absent`) of a predicate the closed world cannot vouch for makes every answer a guess, a yes as well.
  const naf = [...rules, ...S.assumedRules].flatMap(r => r.when).concat((q.alts ?? []).flat(), q.kind === 'yesno' ? [q.lit, ...(q.also ?? [])] : []).filter(c => c.pred && c.negated && !c.strong && !/^__/.test(c.pred)).map(c => c.pred);
  const nafOk = trusted(naf) && naf.every(p => defined.has(p));
  if (part.sop) for (const v of registry) L.literals.add(String(v.value));
  const field = (name, ls) => whereField(name, ls, L);
  if (q.kind === 'yesno') {
    body.push(`@q query\n${ifs}${field('where', [q.lit, ...(q.also ?? [])])}\n`);
    // A refutation with a proof is an explicit negation (sound without the closed world); one without rests on the closed world.
    return {kind: 'yesno', query: q, sop: body.join('\n'), literals: [...L.literals], decode: p => (!nafOk ? null : p.status === 'supported' ? true : p.status === 'refuted' && (closedOk || p.proof?.length) ? false : null)};
  }
  if (q.kind === 'every') {
    body.push(`@q query\n  mode every\n  quantifier all\n${ifs}${field('where', q.where)}\n${field('scope', q.scope)}\n`);
    return {kind: 'every', query: q, sop: body.join('\n'), literals: [...L.literals], decode: p => (!nafOk ? null : p.status === 'supported' ? true : p.status === 'refuted' && closedOk ? false : null)};
  }
  // which / none: one rule per alternative.
  const v = `?${slug(q.v) || 'v'}`;
  body.push(`@fq_answer predicate\n  args subject:entity\n`);
  q.alts.forEach((alt, i) => { L.ctx.counter = 0; body.push(`@rq${i + 1} rule\n${alt.flatMap(c => itemLines(c, L.ctx)).map(l => `  when ${l}`).join('\n')}\n  then fq_answer ${v}\n`); });
  body.push(`@q query\n  select ?x\n${ifs}  where match\n    relation "fq_answer"\n    role subject ?x\n    polarity affirmed\n  end\n`);
  const found = p => (['supported', 'refuted'].includes(p.status) || firstValues(p).length ? firstValues(p).map(x => back(names, x)) : null);
  return {kind: q.kind, query: q, sop: body.join('\n'), literals: [...L.literals],
    decode: p => { const xs = found(p); if (xs === null || !nafOk || (!xs.length && !closedOk)) return null; return q.kind === 'none' ? xs.length === 0 : xs; }};
}

/** A condition field of match blocks over a logicText's vocabulary: one block, or an `all` group of several. */
function whereField(name, ls, L) {
  const block = (l, pad) => {
    if (!l.args.length) L.literals.add('problem');
    const roles = (l.args.length ? l.args.map(t => termOf(t, L.ctx)) : [quote('problem')]).map((a, i) => `${pad}  role ${ROLES[i]} ${a}`);
    return [`match`, `${pad}  relation "${L.ids.get(`${l.pred}/${l.args.length}`)}"`, ...roles, `${pad}  polarity ${l.negated ? 'negated' : 'affirmed'}`, `${pad}end`].join('\n');
  };
  return ls.length === 1 ? `  ${name} ${block(ls[0], '  ')}` : `  ${name} all\n${ls.map(l => `    ${block(l, '    ')}`).join('\n')}\n  end`;
}

// ---------------------------------------------------------------- questions about support and assumptions (fol-v3)

/** The question kinds of fol-v3 about the support of a claim and about the formalizer's own assumptions. */
export const META_KINDS = Object.freeze(['effect', 'explain', 'missing', 'why', 'change', 'assumed']);
/** The query mode each kind is asked in (Effect and Explain without options ask what is missing). */
const META_MODE = Object.freeze({effect: 'effect', explain: 'abduce', missing: 'why_not', why: 'explain', change: 'effect'});
/** At most this many premises are tried one at a time by Change (each is a circuit of its own). */
const MAX_PREMISES = 8;
const MAX_OPTIONS = 8;
const litText = (l, names) => `${l.negated ? 'NOT ' : ''}${l.pred}(${l.args.map(t => ('num' in t ? t.num : t.var ? `?${t.var}` : names.get(slug(t.const)) ?? t.const)).join(', ')})`;
const ruleShown = (r, names) => `${r.when.map(c => (c.pred ? litText(c, names) : c.cmp ? c.cmp : 'Value')).join(' AND ')} IMPLIES ${litText(r.then, names)}`;

/**
 * Circuits of a question about support (DS014 "Candidates: effect and abduce"; DS004 "Query modes"):
 *   effect   Effect(claim): `mode effect` with every option as a `candidate`: the claim without the options (the baseline) and what each
 *            option does to it (establishes, blocks, contradicts, no_effect, inconsistent)
 *   explain  Explain(claim): `mode abduce` over the options as candidates: the minimal consistent sets of options that make the claim
 *            follow, and `necessary`
 *   missing  Missing(claim) (and Effect or Explain without options): `mode why_not`: the base facts whose addition would make it follow
 *   why      Why(claim): `mode explain`: the proof, naming the rules it used
 *   change   Change(claim): for each premise the claim rests on (a stated fact or a rule; at most 8), a circuit of its own with that premise
 *            as the only candidate of a `mode effect` query (the fact written `certainty supposed`): the baseline is the answer without
 *            that premise, so an effect other than no_effect names a premise the answer depends on
 *   assumed  Assumed: the formalizer's assumptions as `assumed` wires (reported by the runtime) and session rules, no question
 * The answer (decode) of effect and change is whether the claim follows from the premises (`supported` → true; anything else → false,
 * "does not follow" only from a finished derivation, withheld when a statement the claim rests on was not understood); of missing (and
 * explain without options) true when the claim follows after all, otherwise no verdict (the question asks what is missing, not whether it follows: the missing facts are in `detail`); of why the
 * claim's status as a yes/no question; of explain the labels of the options in some explanation; of assumed the assumptions as written.
 * `detail(packet)` gives the rest (effects, missing, explanations, rules used).
 */
function metaCircuits(q, {k, facts: problemFacts, rules: allRules, registry, names, trusted, open, options = [], assumedFacts = [], assumedRules = [], assumedSources = []}) {
  // A rule asked as the claim: its condition is given of an arbitrary instance (to-ir.mjs `meta`), so it joins the facts here.
  const given = q.given ?? [];
  const facts = [...problemFacts, ...given.map(g => ({pred: g.pred, args: g.args, negated: g.negated}))];
  if (q.kind === 'assumed') {
    const L = logicText({facts, rules: [], open, names, k, assumed: assumedFacts.slice(0, MAX_ASSUMED), assumedRules});
    return [{kind: 'assumed', query: q, sop: L.text.join('\n'), literals: [...L.literals], decode: () => [...assumedSources],
      detail: p => ({model_assumptions: (p.model_assumptions ?? []).map(a => a.statement)})}];
  }
  const cands = ['effect', 'explain'].includes(q.kind) ? options : [];
  if (cands.length > MAX_OPTIONS) fail(`more than ${MAX_OPTIONS} options (a question takes at most ${MAX_OPTIONS} candidates)`);
  const mode = cands.length || !['effect', 'explain'].includes(q.kind) ? META_MODE[q.kind] : 'why_not';
  const S = support(q.claim.map(l => l.pred), {allRules, assumedRules, options: cands});
  const part = quantityPart(ruleQuantities(S.rules, k), k, registry);
  const defined = new Set([...facts.map(f => f.pred), ...S.rules.map(r => r.then.pred), ...S.assumedRules.map(r => r.then.pred)]);
  const naf = [...S.rules, ...S.assumedRules, ...S.optionRules].flatMap(r => r.when).concat(q.claim).filter(c => c.pred && c.negated && !c.strong && !/^__/.test(c.pred)).map(c => c.pred);
  // An arbitrary instance has only what is given of it: an absence a rule reads would hold of it by construction, so none may be read.
  const nafOk = trusted(naf) && naf.every(p => defined.has(p)) && !(given.length && naf.length);
  const depsOk = trusted([...S.deps]);
  const closedOk = depsOk && q.claim.every(l => defined.has(l.pred));
  const label = new Map(cands.map(o => [o.wid, o.id]));
  const build = ({supposedKey = null, candidates = cands.map(o => o.wid)} = {}) => {
    const L = logicText({facts, rules: S.rules, extra: q.claim, open, names, k, pid: part.pid, conditionalNames: part.conditionalNames, options: cands,
      assumed: assumedFacts.slice(0, MAX_ASSUMED), assumedRules: S.assumedRules, supposedKey});
    if (part.sop) for (const v of registry) L.literals.add(String(v.value));
    const lines = [`@q query`, `  mode ${mode}`, ...(typeof candidates === 'function' ? candidates(L) : candidates).map(id => `  candidate $${id}`), ...ifLines(L.assumedRuleIds), whereField('where', q.claim, L)];
    return {sop: [...L.text, ...(part.sop ? [part.sop] : []), lines.join('\n') + '\n'].join('\n'), literals: [...L.literals], L};
  };
  // Whether the claim follows from the premises: a "no" rests on what the problem's statements say, so it is withheld when a statement
  // the claim depends on was not understood.
  // Only a finished derivation decides: `clarify`, `error`, `not_computable` and the like are no answer.
  const follows = status => (!nafOk ? null : status === 'supported' ? true : depsOk && ['refuted', 'unknown'].includes(status) ? false : null);
  if (q.kind === 'change') {
    const givenKeys = new Set(given.map(g => factKey({pred: g.pred, args: g.args, negated: g.negated})));
    const premises = [...new Map(facts.filter(f => S.deps.has(f.pred) && !givenKeys.has(factKey(f))).map(f => [factKey(f), f])).values()].map(f => ({kind: 'fact', fact: f}))
      .concat(S.rules.map((r, i) => ({kind: 'rule', rule: r, index: i}))).slice(0, MAX_PREMISES);
    if (!premises.length) fail('the claim rests on no premise of the problem');
    return premises.map(pr => {
      const c = build(pr.kind === 'fact' ? {supposedKey: factKey(pr.fact), candidates: L => [L.factIds.get(factKey(pr.fact))]} : {candidates: L => [L.ruleIds[pr.index]]});
      const shown = pr.kind === 'fact' ? litText(pr.fact, names) : ruleShown(pr.rule, names);
      return {kind: 'change', query: q, sop: c.sop, literals: c.literals, premise: shown,
        decode: p => follows(p.effects?.[0]?.with), detail: p => ({premise: shown, effect: p.effects?.[0]?.effect ?? null, without: p.status})};
    });
  }
  const c = build();
  const optionsOf = ids => [...new Set(ids.map(id => label.get(id) ?? id))];
  const decode = mode === 'abduce'
    ? p => (!nafOk ? null : p.status === 'hypotheses' ? optionsOf((p.explanations ?? []).flatMap(e => e.hypotheses ?? [])) : depsOk ? [] : null)
    : mode === 'explain' ? p => (!nafOk ? null : p.status === 'supported' ? true : p.status === 'refuted' && closedOk ? false : null)
      // Missing asks why the claim does not follow, not whether it does: its answer is the missing facts (detail), and a verdict only
      // when the claim does follow after all. Explain without options asks what must be assumed (the same).
      // Effect (also without options) asks whether the premises prove it.
      : q.kind === 'missing' || q.kind === 'explain' ? p => (nafOk && p.status === 'supported' ? true : null)
        : p => follows(p.status);
  const detail = p => (mode === 'effect' ? {effects: (p.effects ?? []).map(e => ({option: label.get(e.candidate) ?? e.candidate, effect: e.effect}))}
    : mode === 'abduce' ? {explanations: (p.explanations ?? []).map(e => optionsOf(e.hypotheses ?? [])), necessary: optionsOf(p.necessary ?? []), inconsistent: (p.inconsistent ?? []).map(e => optionsOf(e.hypotheses ?? []))}
      : mode === 'why_not' ? {missing: p.missing ?? []} : {rules_used: (p.rules_used ?? []).map(r => r.id ?? r)});
  return [{kind: mode === 'why_not' ? 'why_not' : mode === 'abduce' ? 'abduce' : q.kind === 'why' ? 'explain' : 'effect', query: q, sop: c.sop, literals: c.literals, decode, detail}];
}

function termOf(t, ctx) {
  if (t.var) return `?${slug(t.var) || 'v'}`;
  if ('num' in t) { ctx.literals.add(String(t.num)); return String(t.num); }
  if (t.fn) fail('a function term in a logic literal');
  const shown = ctx.names.get(slug(t.const)) ?? t.const;
  ctx.literals.add(shown);
  return quote(shown);
}

function valueCircuit(q, {k, facts, rules, valueRules, registry, names, open}) {
  const answer = expr => (q.kind === 'value' ? expr({const: q.name}) : boolText(q.test, expr));
  const p = quantityProgram([], answer, {k, registry});
  // Static check (owner decision 2026-10-03, instead of perturbation): the answer must depend on the problem's data through the
  // dataflow; a circuit that only writes its final number computes nothing from the problem and is refused.
  const byName = new Map(p.lines.map(l => [l.name, l.text]));
  const conditionalReaches = (name, seen) => k.conditional.get(name).some(r => [r.term, ...r.when.flatMap(itemTerms)].some(t => termNums(t).some(n => registry.some(v => v.value === n || (v.percent && Math.abs(v.value / 100 - n) < 1e-12)))
    || termConsts(t).some(c => reaches(`q_${slug(c)}`, seen))));
  const reaches = (name, seen = new Set()) => {
    if (seen.has(name)) return false;
    seen.add(name);
    if (p.external.has(name)) return conditionalReaches(name.slice(2), seen);
    const text = byName.get(name) ?? '';
    return /\bv\d+\b/.test(text) || [...text.matchAll(/\bq_\w+/g)].some(m => reaches(m[0], seen));
  };
  if (!reaches('answer1')) fail('the answer computes nothing from the problem\'s numbers (a written value, not a computation)');
  const low = lowered(p.lines, p.external, registry);
  let sop = low.sop, literals = registry.map(v => String(v.value));
  if (p.conditionalNames.length) {
    // The value rules need the logic part (their conditions) and the quantities they read.
    const usable = rules.filter(r => ruleQuantities([r], k).every(x => low.pid.has(`q_${x}`)));
    const L = logicText({facts, rules: usable, open, names, k, pid: low.pid, valueRules: valueRules.filter(r => p.conditionalNames.includes(slug(r.name))), conditionalNames: p.conditionalNames});
    sop = [...L.text, sop].join('\n');
    literals = [...new Set([...literals, ...L.literals])];
  }
  return {kind: q.kind, query: q, sop, literals, program: p.lines,
    decode: pk => {
      if (q.kind === 'compare') return pk.status === 'supported' ? true : pk.status === 'refuted' ? false : null;
      // Two different values (two value rules that both apply) are no answer.
      const xs = [...new Set(firstValues(pk).map(Number))];
      return xs.length === 1 ? xs[0] : null;
    }};
}

const boolText = (t, expr) => (t.cmp ? `${expr(t.a)} ${JS[t.cmp]} ${expr(t.b)}` : `(${boolText(t.a, expr)}) ${t.op === 'and' ? '&&' : '||'} (${boolText(t.b, expr)})`);

// ---------------------------------------------------------------- constraint search over unknowns

/**
 * A term as a fraction of linear forms {num, den}: a form is [{sign, factors: [numbers], v: variable name | null}], `den` has no
 * variable. Exact and symbolic: numbers are kept as the problem writes them (the solver multiplies them); throws when the term is
 * not linear (a product of two unknowns, a division by an unknown, a function).
 */
const ONE = [{sign: 1, factors: [1], v: null}];
function mulForms(A, B) {
  const out = [];
  for (const x of A) for (const y of B) {
    if (x.v && y.v) fail('a product of two unknowns is non-linear');
    out.push({sign: x.sign * y.sign, factors: [...x.factors, ...y.factors].filter((f, i, all) => f !== 1 || all.length === 1), v: x.v ?? y.v});
  }
  return out;
}
const neg = A => A.map(x => ({...x, sign: -x.sign}));
const formValue = A => A.reduce((s, x) => s + coef(x), 0);

function fraction(t, ctx, seen = new Set()) {
  if ('num' in t) return {num: [{sign: t.num < 0 ? -1 : 1, factors: [Math.abs(t.num)], v: null}], den: ONE};
  if (t.const) {
    const s = slug(t.const);
    if (ctx.k.unknowns.has(s)) return {num: [{sign: 1, factors: [], v: s}], den: ONE};
    if (ctx.k.conflicts.has(s)) fail(`the quantity ${s} is given two different values`);
    if (ctx.k.conditional.has(s)) fail(`the quantity ${s} is defined by conditions, which a constraint cannot read`);
    const d = ctx.k.defs.get(s);
    if (!d) fail(`the quantity ${s} is used but never given a Value`);
    if (seen.has(s)) fail(`${s} is defined by itself`);
    return fraction(d.term, ctx, new Set([...seen, s]));
  }
  const parts = (t.args ?? []).map(a => fraction(a, ctx, seen));
  if ((t.fn === 'add' || t.fn === 'sub') && parts.length >= 2) {
    if (t.fn === 'sub' && parts.length !== 2) fail('sub takes two terms');
    return parts.reduce((A, B) => ({num: [...mulForms(A.num, B.den), ...(t.fn === 'sub' ? neg : x => x)(mulForms(B.num, A.den))], den: mulForms(A.den, B.den)}));
  }
  if (t.fn === 'mul' && parts.length >= 2) return parts.reduce((A, B) => ({num: mulForms(A.num, B.num), den: mulForms(A.den, B.den)}));
  if (t.fn === 'div' && parts.length === 2) {
    if (parts[1].num.some(x => x.v)) fail('a division by an unknown is non-linear');
    return {num: mulForms(parts[0].num, parts[1].den), den: mulForms(parts[0].den, parts[1].num)};
  }
  return fail(`the term ${t.fn ?? t.var ?? '?'} cannot be part of a constraint`);
}

const decimals = f => (String(f).split('.')[1] ?? '').length;
/** Forms with whole numbers only: every term multiplied by the same power of ten (the decimals of the most precise term). */
function wholeNumbers(forms) {
  const places = forms.flat().map(x => x.factors.reduce((s, f) => s + decimals(f), 0));
  const K = Math.max(0, ...places);
  if (K > 12) fail('a constraint with more than 12 decimal places');
  return forms.map(F => F.map(x => {
    const d = x.factors.reduce((s, f) => s + decimals(f), 0);
    const factors = x.factors.map(f => Math.round(f * 10 ** decimals(f)));
    return {...x, factors: K - d ? [...factors, 10 ** (K - d)] : factors};
  }));
}
const FLIP = {Lt: 'Gt', Le: 'Ge', Gt: 'Lt', Ge: 'Le', Eq: 'Eq', Ne: 'Ne'};
/** A comparison of two fractions as a comparison of whole-number linear forms (cross-multiplied; the denominator's sign decides the direction). */
function comparison(cmp, A, B) {
  const D = formValue(mulForms(A.den, B.den));
  if (Math.abs(D) < 1e-12) fail('a division by zero in a constraint');
  const [left, right] = wholeNumbers([mulForms(A.num, B.den), mulForms(B.num, A.den)]);
  return {cmp: D < 0 ? FLIP[cmp] : cmp, left, right};
}

const coef = x => x.sign * x.factors.reduce((a, b) => a * b, 1);
// The variable first (`?x times 2 times 3`): every product then has a constant operand, as the portable profile requires.
const wordsOf = (terms, varName) => terms.map((x, i) => {
  const parts = [...(x.v ? [varName(x.v)] : []), ...x.factors.map(String)];
  const body = parts.length ? parts.join(' times ') : '1';
  return i === 0 ? (x.sign < 0 ? `0 minus ${body}` : body) : `${x.sign < 0 ? 'minus' : 'plus'} ${body}`;
}).join(' ');

function constraintCircuits(queries, ir, k, registry) {
  const ctx = {k}, varName = v => `?u_${v}`;
  const conditions = [];
  const unknownIn = c => [...c.left, ...c.right].some(x => x.v);
  // The problem's conditions that involve an unknown; Eq(mod(t, c), r) is t = c·k + r with a fresh whole number k.
  let aux = 0;
  const integral = new Set(ir.integer.map(slug));
  for (const c of ir.constraints) {
    const modSide = [c.a, c.b].findIndex(x => x.fn === 'mod');
    if (modSide >= 0) {
      if (c.cmp !== 'Eq') fail('a remainder is only compared for equality');
      const m = [c.a, c.b][modSide], other = [c.a, c.b][1 - modSide];
      const t = fraction(m.args[0], ctx), d = fraction(m.args[1], ctx), r = fraction(other, ctx);
      if (!t.num.some(x => x.v)) continue;
      if (d.num.some(x => x.v) || r.num.some(x => x.v)) fail('a remainder by an unknown');
      const kv = `k${++aux}`;
      k.unknowns.add(kv); integral.add(kv);
      // t = d·k + r, with d and r fractions: t·(d.den·r.den) over t.den compared with (d.num·k·r.den + r.num·d.den).
      const rhs = {num: [...mulForms(mulForms(d.num, [{sign: 1, factors: [], v: kv}]), r.den), ...mulForms(r.num, d.den)], den: mulForms(d.den, r.den)};
      conditions.push(comparison('Eq', t, rhs));
      continue;
    }
    const cond = comparison(c.cmp, fraction(c.a, ctx), fraction(c.b, ctx));
    if (unknownIn(cond)) conditions.push(cond);
  }
  const objectives = ir.objectives.map(o => {
    const f = fraction(o.term, ctx), D = formValue(f.den);
    if (Math.abs(D) < 1e-12) fail('a division by zero in an objective');
    return {direction: D < 0 ? (o.direction === 'min' ? 'max' : 'min') : o.direction, terms: wholeNumbers([f.num])[0]};
  });
  const distinct = [...new Map(objectives.map(o => [JSON.stringify(o), o])).values()];
  if (distinct.length > 1) fail('more than one objective');
  objectives.splice(0, objectives.length, ...distinct);
  // Asked values: an unknown is selected; a defined quantity that reads unknowns gets a variable tied to its definition.
  const selects = [], derived = [];
  const valueQueries = queries.filter(q => q.kind === 'value'), compareQueries = queries.filter(q => q.kind === 'compare');
  for (const q of valueQueries) {
    const s = slug(q.name);
    if (k.unknowns.has(s)) { selects.push({name: s, v: s}); continue; }
    const v = `d_${s}`;
    const eq = comparison('Eq', {num: [{sign: 1, factors: [], v}], den: ONE}, fraction({const: q.name}, ctx));
    derived.push({v, eq});
    selects.push({name: s, v});
  }
  const ties = derived.map(d => d.eq);
  const vars = new Set([...conditions, ...ties].flatMap(c => [...c.left, ...c.right]).concat(objectives.flatMap(o => o.terms)).filter(x => x.v).map(x => x.v));
  for (const sel of selects) vars.add(sel.v);
  if (!vars.size) fail('the asked value reads no unknown');
  // Whole numbers: declared Integer, or tied by an equality with integer coefficients to whole numbers.
  const isInt = x => Number.isInteger(coef(x));
  const all = [...conditions, ...ties];
  const eqs = all.filter(c => c.cmp === 'Eq').map(c => [...c.left, ...neg(c.right)]);
  for (let changed = true; changed;) {
    changed = false;
    for (const e of eqs) {
      const open = e.filter(x => x.v && !integral.has(x.v));
      if (open.length === 1 && Math.abs(coef(open[0])) === 1 && e.every(isInt)) { integral.add(open[0].v); changed = true; }
    }
  }
  // An unknown fixed by an equation once the others are fixed has one real value: the integer search finds it or finds nothing, so it
  // needs no declaration; an unknown only bounded by inequalities must be declared a whole number.
  const fixed = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const e of eqs) {
      const free = [...new Set(e.filter(x => x.v && !fixed.has(x.v)).map(x => x.v))];
      if (free.length === 1 && e.filter(x => x.v === free[0]).reduce((a, x) => a + coef(x), 0) !== 0) { fixed.add(free[0]); changed = true; }
    }
  }
  const notWhole = [...vars].find(v => !integral.has(v) && !fixed.has(v));
  if (notWhole) fail(`the unknown ${notWhole} is not declared a whole number (Integer)`);
  // Bounds by interval propagation over the conditions (sound: a solution lies inside them).
  const lo = new Map(), hi = new Map();
  const forms = all.map(c => ({cmp: c.cmp, terms: [...c.left, ...neg(c.right)]}));
  const range = x => { const c = coef(x); if (!x.v) return [c, c]; const a = lo.get(x.v) ?? -Infinity, b = hi.get(x.v) ?? Infinity; return c >= 0 ? [c * a, c * b] : [c * b, c * a]; };
  const tighten = (v, l, h) => {
    let changed = false;
    if (Number.isFinite(l) && Math.ceil(l - 1e-9) > (lo.get(v) ?? -Infinity)) { lo.set(v, Math.ceil(l - 1e-9)); changed = true; }
    if (Number.isFinite(h) && Math.floor(h + 1e-9) < (hi.get(v) ?? Infinity)) { hi.set(v, Math.floor(h + 1e-9)); changed = true; }
    return changed;
  };
  for (let round = 0, changed = true; changed && round < 20; round++) {
    changed = false;
    for (const f of forms) {
      if (f.cmp === 'Ne') continue;
      for (const v of new Set(f.terms.filter(x => x.v).map(x => x.v))) {
        const c = f.terms.filter(x => x.v === v).reduce((s, x) => s + coef(x), 0);
        if (!c) continue;
        // c·v + rest  (cmp)  0, with rest in [rl, rh]
        let rl = 0, rh = 0;
        for (const x of f.terms.filter(y => y.v !== v)) { const [a, b] = range(x); rl += a; rh += b; }
        const upper = -rl / c, lower = -rh / c; // c·v ≤ -rl  /  c·v ≥ -rh
        const le = ['Lt', 'Le', 'Eq'].includes(f.cmp), ge = ['Gt', 'Ge', 'Eq'].includes(f.cmp);
        if (le && Number.isFinite(rl)) changed = (c > 0 ? tighten(v, -Infinity, upper) : tighten(v, upper, Infinity)) || changed;
        if (ge && Number.isFinite(rh)) changed = (c > 0 ? tighten(v, lower, Infinity) : tighten(v, -Infinity, lower)) || changed;
      }
    }
  }
  // An unknown bounded on one side only, under an objective that never gains from moving it further, where every condition stays
  // true when it moves further: an optimum exists with the unknown at the least value its conditions need (sound bound).
  const o0 = objectives[0];
  if (o0) for (const v of vars) for (const side of ['hi', 'lo']) {
    const have = side === 'hi' ? hi : lo, other = side === 'hi' ? lo : hi;
    if (Number.isFinite(have.get(v)) || !Number.isFinite(other.get(v))) continue;
    const oc = o0.terms.filter(x => x.v === v).reduce((a, x) => a + coef(x), 0);
    const up = side === 'hi'; // the unknown is unbounded upwards (else downwards)
    if (!(o0.direction === 'min' ? (up ? oc >= 0 : oc <= 0) : (up ? oc <= 0 : oc >= 0))) continue;
    let bound = other.get(v), ok = true;
    for (const f of forms.filter(f => f.terms.some(x => x.v === v))) {
      const c = f.terms.filter(x => x.v === v).reduce((a, x) => a + coef(x), 0);
      // c·v + rest ≥ 0 stays true as v grows when c > 0 (≤ 0: when c < 0); mirrored for v falling.
      const grows = ['Gt', 'Ge'].includes(f.cmp) ? c > 0 : ['Lt', 'Le'].includes(f.cmp) ? c < 0 : false;
      const falls = ['Gt', 'Ge'].includes(f.cmp) ? c < 0 : ['Lt', 'Le'].includes(f.cmp) ? c > 0 : false;
      if (!(up ? grows : falls)) { ok = false; break; }
      let rl = 0, rh = 0;
      for (const x of f.terms.filter(y => y.v !== v)) { const [a, b] = range(x); rl += a; rh += b; }
      const need = ['Gt', 'Ge'].includes(f.cmp) ? -rl / c : -rh / c; // the value of v that satisfies the condition for every rest
      if (!Number.isFinite(need)) { ok = false; break; }
      bound = up ? Math.max(bound, Math.ceil(need + 1e-9)) : Math.min(bound, Math.floor(need - 1e-9));
    }
    if (ok) have.set(v, bound);
  }
  let size = 1;
  for (const v of vars) {
    if (!Number.isFinite(lo.get(v)) || !Number.isFinite(hi.get(v))) fail(`the unknown ${v} has no bound`);
    if (hi.get(v) < lo.get(v)) fail(`the conditions on ${v} contradict each other`);
    size *= hi.get(v) - lo.get(v) + 1;
  }
  if (size > MAX_ASSIGNMENTS) fail(`the search is too large (${size} assignments)`);
  // Static check: the conditions must reach the problem's numbers.
  // (numbers may be scaled by a power of ten to whole numbers)
  const nums = all.flatMap(c => [...c.left, ...c.right]).flatMap(x => x.factors);
  const scaled = (n, r) => r !== 0 && [...Array(13).keys()].some(j => Math.abs(n - r * 10 ** j) < 1e-6);
  if (!nums.some(n => registry.some(r => scaled(n, r.value) || (r.percent && scaled(n, r.value / 100))))) fail('the constraint reaches none of the problem\'s numbers');
  const W = terms => wordsOf(terms, varName);
  const head = [`@c constraint`, ...[...vars].map(v => `  var ${varName(v)} int ${lo.get(v)} ${hi.get(v)}`),
    ...all.map(c => `  require ${W(c.left)} ${WORD[c.cmp]} ${W(c.right)}`)];
  const out = [];
  if (valueQueries.length) {
    const o = objectives[0];
    const sop = [...head, ...(o ? ['  task optimize', `  objective ${W(o.terms)}`, `  direction ${o.direction}`] : ['  task possible']), `  select ${selects.map(s => varName(s.v)).join(' ')}`].join('\n') + '\n';
    out.push({kind: 'value', query: valueQueries, sop, literals: registry.map(v => String(v.value)), program: null,
      decode: p => {
        if (!['possible', 'optimal'].includes(p.status) || p.complete === false) return null;
        const xs = selects.map(s => p.outputProjection?.[varName(s.v)]).filter(x => x?.status === 'bound').map(x => Number(x.value));
        return xs.length ? (xs.length === 1 ? xs[0] : xs) : null;
      }});
  }
  for (const q of compareQueries) {
    if (!q.test.cmp) fail('a compound comparison over unknowns');
    const c = comparison(q.test.cmp, fraction(q.test.a, ctx), fraction(q.test.b, ctx));
    const sop = [...head, `  claim ${W(c.left)} ${WORD[c.cmp]} ${W(c.right)}`, '  task prove'].join('\n') + '\n';
    out.push({kind: 'compare', query: q, sop, literals: registry.map(v => String(v.value)), program: null,
      decode: p => (p.complete === false ? null : p.status === 'entailed' ? true : p.status === 'refuted' ? false : null)});
  }
  return out;
}
