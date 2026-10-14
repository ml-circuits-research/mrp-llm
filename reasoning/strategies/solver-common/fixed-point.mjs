/**
 * Exact decimal arithmetic for the integer engines (sql-sqlite, datalog-souffle, asp-clingo): FIXED POINT, never binary floating point.
 *
 * A program with decimals is rewritten, before lowering, into an equivalent program over integers. Every number n of the program (facts,
 * constants of rules and queries) becomes the integer n * 10^S, where S is chosen once per problem: the largest number of decimal places
 * any value of the program can need (constants, stored values, and what `times`, `power` and `divided_by` by a constant produce). The
 * engines then run plain integer arithmetic; the values they return are divided by 10^S exactly (`fromScaled`), so 0.1 plus 0.2 is 0.3.
 *
 *   plus, minus, compare, sum, min, max   unchanged on the scaled integers (same scale)
 *   times                                 A*B then an exact whole division by 10^S (the analysis guarantees the division is exact)
 *   count                                 the engine multiplies the count by 10^S (`scaleCount` on the aggregate)
 *   divided_by a constant                 (A*10^S) whole_divided_by D; exact when the constant is 2^a*5^b over a power of ten, else not expressible
 *   divided_by a variable                 the same, plus a flag rule `x_fx_inexact` that fires when the quotient has more than S decimals:
 *                                         the engine then reports `not_expressible` (an exact-rational engine answers), never a rounded number
 *   whole_divided_by, modulo              on the integer values (a non-integer operand makes the body false, as in the oracle)
 *   power                                 a constant exponent 0..MAX_POWER, unrolled into exact multiplications
 *   rounded_to, rounded_up_to, rounded_down_to   integer floor/ceiling/half-away-from-zero over multiples of B (B above 0)
 *   minimum_with, maximum_with            two alternatives of the body: a compare of the scaled values, then the kept one
 *
 * Everything is expressed with the four integer words the engines already lower (plus, minus, times, whole_divided_by) and comparisons, so
 * no engine learns a new operation. A scale above MAX_SCALE, an operation without an exact scaled form (a power with a variable exponent,
 * a division by a constant with other prime factors) or a scaled value beyond a safe integer is `not_expressible` for these engines.
 * With no decimal and no word beyond the integer ones the plan is null and the program is untouched.
 */
import {isVarTerm, NotExpressibleError} from '../js-reference/values.mjs';
import {INTEGER_COMPUTE_WORDS} from '../../../sop/enums.mjs';

export const MAX_SCALE = 12;
export const DIVISION_HEADROOM = 2;
export const MAX_POWER = 8;
/** The nullary predicate whose derivation means "some division was not exact at this scale". */
export const INEXACT = 'x_fx_inexact';

const refuse = message => new NotExpressibleError(['exact_arithmetic'], message);

// ------------------------------------------------------------------------------------------------ decimal text

/** The decimal digits of a finite number: {neg, digits (BigInt of all significant digits), exp10} with value = digits * 10^exp10. */
function decompose(n) {
  const text = Math.abs(n).toString();
  const [mantissa, e] = text.split('e');
  const [whole, frac = ''] = mantissa.split('.');
  return {neg: n < 0, digits: BigInt(whole + frac), exp10: Number(e ?? 0) - frac.length};
}

/** Number of decimal places of a finite number (0 for an integer). */
export function decimals(n) {
  if (!Number.isFinite(n)) throw refuse(`the value ${n} is not a finite number`);
  if (Number.isInteger(n)) return 0;
  const {digits, exp10} = decompose(n);
  let d = digits, e = exp10;
  while (e < 0 && d % 10n === 0n) { d /= 10n; e++; }
  return Math.max(0, -e);
}

/** n * 10^scale as a JS integer (the scale must cover the decimals of n); null when it leaves the safe-integer range. */
export function toScaled(n, scale) {
  const {neg, digits, exp10} = decompose(n);
  const shift = exp10 + scale;
  const big = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  const out = Number(neg ? -big : big);
  return Number.isSafeInteger(out) ? out : null;
}

/** The exact decimal of a scaled integer (a JS number or a bigint), as the nearest double of that decimal text. */
export function fromScaled(v, scale) {
  if (scale === 0 || (typeof v !== 'number' && typeof v !== 'bigint')) return typeof v === 'bigint' ? Number(v) : v;
  const text = String(v), neg = text[0] === '-';
  const padded = (neg ? text.slice(1) : text).padStart(scale + 1, '0');
  const frac = padded.slice(-scale).replace(/0+$/, '');
  return Number((neg ? '-' : '') + padded.slice(0, -scale) + (frac ? '.' + frac : ''));
}

// ------------------------------------------------------------------------------------------------ analysis

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

/** The extra decimal places a division by the constant d needs, or throws when the quotient may not terminate. */
function divisorPlaces(d) {
  if (d === 0) throw refuse('divided_by 0 is undefined; it is not lowered to the integer engines');
  const m = decimals(d);
  const n = BigInt(toScaled(Math.abs(d), m));
  let p = n / gcd(n, 10n ** BigInt(m));
  let x = 0, y = 0;
  while (p % 2n === 0n) { p /= 2n; x++; }
  while (p % 5n === 0n) { p /= 5n; y++; }
  if (p !== 1n) throw refuse(`divided_by ${d}: the quotient may not terminate; an exact-rational engine answers`);
  return Math.max(x, y);
}

const constPower = t => {
  if (typeof t !== 'number' || !Number.isInteger(t) || t < 0 || t > MAX_POWER) throw refuse(`power takes a constant whole exponent from 0 to ${MAX_POWER} on the integer engines`);
  return t;
};

/** The leaves of a program: rules, aggregates and the extra lists (query alternatives). */
function* allLeaves(program, extra) {
  for (const r of program.rules) for (const a of r.alts) yield* a.leaves.map(l => ({l, owner: 'rule'}));
  for (const g of program.aggregates) for (const a of g.alts) yield* a.leaves.map(l => ({l, owner: 'aggregate'}));
  for (const alt of extra) yield* alt.leaves.map(l => ({l, owner: 'query'}));
}

/**
 * The fixed-point plan of a (sliced) program and optional query alternatives: null when integer arithmetic is already exact, else
 * {scale, P, flag, maxAbs}. `flag` is true when a division by a variable needs the inexactness flag rule. Throws NotExpressibleError
 * (feature exact_arithmetic) when no fixed-point form exists.
 */
export function planFixedPoint(program, extraAlts = []) {
  let needed = false;
  const pos = new Map();
  let top = 0, flag = false, maxAbs = 0;
  const seeNumber = v => { const d = decimals(v); if (d > 0) needed = true; top = Math.max(top, d); maxAbs = Math.max(maxAbs, Math.abs(v)); return d; };
  const key = (p, i) => `${p}/${i}`;
  const raise = (p, i, s) => { if (s > (pos.get(key(p, i)) ?? 0)) { pos.set(key(p, i), s); return true; } return false; };
  for (const f of program.facts) f.args.forEach((a, i) => { if (typeof a === 'number') raise(f.p, i, seeNumber(a)); });
  for (const { l } of allLeaves(program, extraAlts)) {
    if (l.kind === 'atom') l.args.forEach(a => { if (typeof a === 'number') seeNumber(a); });
    else if (l.kind === 'compare' || l.kind === 'compute') for (const t of [l.left, l.right]) if (typeof t === 'number') seeNumber(t);
    if (l.kind === 'compute' && !INTEGER_COMPUTE_WORDS.includes(l.word)) needed = true;
  }
  for (const r of program.rules) r.head.args.forEach((a, i) => { if (typeof a === 'number') raise(r.head.p, i, seeNumber(a)); });
  for (const g of program.aggregates) g.yields.args.forEach((a, i) => { if (typeof a === 'number') raise(g.yields.p, i, seeNumber(a)); });
  if (!needed) return null;

  // scale of every variable of a body, in the order of the (already ordered) leaves; position scales feed back until stable
  const bodyScales = leaves => {
    const env = new Map();
    const scaleOf = t => (isVarTerm(t) ? env.get(t.var) ?? 0 : typeof t === 'number' ? decimals(t) : 0);
    for (const l of leaves) {
      if (l.kind === 'atom') l.args.forEach((a, i) => { if (isVarTerm(a)) env.set(a.var, Math.max(env.get(a.var) ?? 0, pos.get(key(l.p, i)) ?? 0)); });
      else if (l.kind === 'timeof') env.set(l.out, 0);
      else if (l.kind === 'compute') {
        const a = scaleOf(l.left), b = scaleOf(l.right);
        let s;
        switch (l.word) {
          case 'plus': case 'minus': s = Math.max(a, b); break;
          case 'times': s = a + b; break;
          case 'whole_divided_by': case 'modulo': s = 0; break;
          case 'power': s = a * constPower(l.right); break;
          case 'divided_by': if (isVarTerm(l.right)) { s = a + DIVISION_HEADROOM; flag = true; } else s = a + divisorPlaces(l.right); break;
          case 'rounded_to': case 'rounded_up_to': case 'rounded_down_to': s = b; break;
          case 'minimum_with': case 'maximum_with': s = Math.max(a, b); break;
          default: throw refuse(`compute ${l.word} has no fixed-point form`);
        }
        env.set(l.out, s);
        top = Math.max(top, s, a, b);
      }
    }
    return env;
  };
  for (let round = 0, changed = true; changed; round++) {
    if (round > 64) throw refuse('the decimal scale of the program does not settle');
    changed = false;
    const feed = (head, env) => head.args.forEach((a, i) => { if (isVarTerm(a) && raise(head.p, i, env.get(a.var) ?? 0)) changed = true; });
    for (const r of program.rules) for (const alt of r.alts) feed(r.head, bodyScales(alt.leaves));
    for (const g of program.aggregates) {
      for (const alt of g.alts) {
        const env = bodyScales(alt.leaves);
        env.set(g.out, g.fn === 'count' ? 0 : g.fn === 'collect' ? 0 : env.get(g.field) ?? 0);
        feed(g.yields, env);
      }
    }
    for (const alt of extraAlts) bodyScales(alt.leaves);
    for (const s of pos.values()) top = Math.max(top, s);
  }
  if (top > MAX_SCALE) throw refuse(`the program needs ${top} decimal places; the integer engines carry at most ${MAX_SCALE}`);
  return {scale: top, P: 10 ** top, flag, maxAbs};
}

/** The largest scaled value of a plan, to compare with the integer range of an engine. */
export const maxScaled = plan => plan.maxAbs * plan.P;

// ------------------------------------------------------------------------------------------------ rewriting

const v = name => ({var: name});
const bound = leaves => {
  const out = new Set();
  for (const l of leaves) {
    if (l.kind === 'atom' && l.mode !== 'absent') l.args.forEach(a => { if (isVarTerm(a)) out.add(a.var); });
    else if (l.kind === 'compute' || l.kind === 'timeof') out.add(l.out);
    if (l.kind === 'timeof') l.args.forEach(a => { if (isVarTerm(a)) out.add(a.var); });
  }
  return out;
};

class Rewriter {
  constructor(plan, {narrow = false} = {}) {
    this.plan = plan;
    this.narrow = narrow;
    this.leafId = 0;
    this.flagAlts = [];
  }

  sc(t) {
    if (isVarTerm(t) || typeof t !== 'number') return t;
    const out = toScaled(t, this.plan.scale);
    if (out === null) throw refuse(`the value ${t} scaled by 10^${this.plan.scale} leaves the safe-integer range`);
    return out;
  }

  atomArgs(args) { return args.map(t => this.sc(t)); }

  /** Variants of one original leaf: a list of {leaves, check}; `check` are the leaves that must hold for the quotient to be exact. */
  leaf(l, allowFlag) {
    if (l.kind === 'atom') return [{leaves: [{...l, args: this.atomArgs(l.args)}]}];
    if (l.kind === 'timeof') return [{leaves: [{...l, args: this.atomArgs(l.args)}]}];
    if (l.kind === 'compare') return [{leaves: [{...l, left: this.sc(l.left), right: this.sc(l.right)}]}];
    if (l.kind !== 'compute') return [{leaves: [l]}];
    return this.compute(l, allowFlag);
  }

  compute(l, allowFlag) {
    const { P } = this.plan, S = this.plan.scale;
    const id = ++this.leafId;
    const a = this.sc(l.left), b = this.sc(l.right), out = l.out;
    const make = () => {
      let n = 0;
      const seq = [];
      // `wide` marks an intermediate that may exceed the 2^53 bound of a final value (the 64-bit engine checks only its final results)
      const emit = (word, left, right, to = null, wide = false) => {
        const name = to ?? `?fx${id}_${++n}`;
        seq.push({kind: 'compute', word, out: name, left, right, ...(wide ? {wide: true} : {})});
        return v(name);
      };
      const cmp = (word, left, right) => seq.push({kind: 'compare', word, left, right});
      // x*y/P. A 32-bit engine cannot hold x*y: x = qx*P + rx, so x*y/P = qx*y + (rx*y)/P and no intermediate exceeds the result by more than P*y
      const fxTimes = (x, y, to) => {
        if (!this.narrow) return emit('whole_divided_by', emit('times', x, y, null, true), P, to);
        const qx = emit('whole_divided_by', x, P);
        const rx = emit('minus', x, emit('times', qx, P));
        return emit('plus', emit('times', qx, y), emit('whole_divided_by', emit('times', rx, y), P), to);
      };
      // x*P/y with the exactness check: the pair (value, leaves that hold when the quotient is NOT exact)
      const fxDivide = (x, y, to, check) => {
        if (!this.narrow) {
          const t = emit('times', x, P, null, true);
          const out = emit('whole_divided_by', t, y, to);
          if (check) check.push({kind: 'compute', word: 'times', out: `?fx${id}_back`, left: out, right: y, wide: true}, {kind: 'compare', word: 'not_equal', left: v(`?fx${id}_back`), right: t});
          return out;
        }
        const q = emit('whole_divided_by', x, y);
        const r = emit('minus', x, emit('times', q, y));
        const rp = emit('times', r, P);
        const q2 = emit('whole_divided_by', rp, y);
        const out = emit('plus', emit('times', q, P), q2, to);
        if (check) check.push({kind: 'compute', word: 'times', out: `?fx${id}_back`, left: q2, right: y}, {kind: 'compare', word: 'not_equal', left: v(`?fx${id}_back`), right: rp});
        return out;
      };
      // a scaled integer is a whole number when dividing by P and multiplying back gives it again
      const whole = t => {
        if (S === 0) return;
        if (!isVarTerm(t)) { if (t % P !== 0) throw refuse('a non-integer constant given to a whole-number word'); return; }
        cmp('equal', emit('times', emit('whole_divided_by', t, P), P), t);
      };
      return {seq, emit, cmp, fxTimes, fxDivide, whole};
    };
    const one = build => { const m = make(); const check = build(m); return {leaves: m.seq, ...(check ? {check} : {})}; };
    switch (l.word) {
      case 'plus': case 'minus': return [one(m => { m.emit(l.word, a, b, out); })];
      case 'times': return [one(m => { m.fxTimes(a, b, out); })];
      case 'divided_by': {
        if (!isVarTerm(l.right)) return [one(m => { m.fxDivide(a, b, out, null); })];
        if (!allowFlag) throw refuse('divided_by a variable inside a query is not lowered; an exact-rational engine answers');
        return [one(m => {
          // the helper rule (flag) fires when the quotient is not exact at this scale
          const check = [];
          m.fxDivide(a, b, out, check);
          return check;
        })];
      }
      case 'whole_divided_by': return [one(m => { m.whole(a); m.whole(b); m.emit('times', m.emit('whole_divided_by', a, b), P, out); })];
      case 'modulo': return [one(m => { m.whole(a); m.whole(b); m.emit('minus', a, m.emit('times', m.emit('whole_divided_by', a, b), b), out); })];
      case 'power': {
        const k = constPower(l.right);
        return [one(m => {
          if (k === 0) m.emit('plus', P, 0, out);
          else if (k === 1) m.emit('plus', a, 0, out);
          else { let acc = a; for (let i = 2; i <= k; i++) acc = m.fxTimes(acc, a, i === k ? out : null); }
        })];
      }
      // the smaller (larger) value: two alternatives of the body, one per side of the comparison
      case 'minimum_with': case 'maximum_with': {
        const min = l.word === 'minimum_with';
        return [one(m => { m.cmp(min ? 'at_most' : 'at_least', a, b); m.emit('plus', a, 0, out); }),
          one(m => { m.cmp(min ? 'above' : 'below', a, b); m.emit('plus', b, 0, out); })];
      }
      case 'rounded_down_to': case 'rounded_up_to': return [one(m => {
        m.cmp('above', b, 0);
        const quotient = m.emit('whole_divided_by', a, b);
        const m0 = m.emit('minus', a, m.emit('times', quotient, b));
        const m1 = m.emit('plus', m0, b);
        const mpos = m.emit('minus', m1, m.emit('times', m.emit('whole_divided_by', m1, b), b));
        if (l.word === 'rounded_down_to') m.emit('minus', a, mpos, out);
        else {
          const u = m.emit('minus', b, mpos);
          m.emit('plus', a, m.emit('minus', u, m.emit('times', m.emit('whole_divided_by', u, b), b)), out);
        }
      })];
      case 'rounded_to': {
        // half away from zero: the two signs of A are two alternatives of the body
        const half = positive => one(m => {
          m.cmp('above', b, 0);
          m.cmp(positive ? 'at_least' : 'below', a, 0);
          const twoA = m.emit('times', a, 2);
          const w = positive ? m.emit('plus', twoA, b) : m.emit('minus', b, twoA);
          const twoB = m.emit('times', b, 2);
          const wm = m.emit('minus', w, m.emit('times', m.emit('whole_divided_by', w, twoB), twoB));
          m.emit('whole_divided_by', positive ? m.emit('minus', w, wm) : m.emit('minus', wm, w), 2, out);
        });
        return [half(true), half(false)];
      }
      default: throw refuse(`compute ${l.word} has no fixed-point form`);
    }
  }

  /** The alternatives an original alternative becomes (one per sign split) and, for each division by a variable, a flag alternative. */
  alt(leaves, {flags = null, allowFlag = true} = {}) {
    let variants = [[]];
    for (const l of leaves) {
      const choices = this.leaf(l, allowFlag);
      const next = [];
      for (const prefix of variants) {
        for (const c of choices) {
          const body = [...prefix, ...c.leaves];
          next.push(body);
          if (c.check && flags) flags.push({leaves: [...body, ...c.check]});
        }
      }
      variants = next;
      if (variants.length > 16) throw refuse('too many rounded_to alternatives in one body for the integer engines');
    }
    return variants;
  }
}

/** The scaled integer program: facts and constants times 10^S, compute words expanded, count aggregates marked, the flag rule added. */
export function scaleProgram(program, plan, options = {}) {
  const rw = new Rewriter(plan, options);
  const flags = [];
  const facts = program.facts.map(f => ({...f, args: rw.atomArgs(f.args)}));
  const head = h => ({...h, args: rw.atomArgs(h.args)});
  const ruleMap = new Map();
  const rules = program.rules.map(r => {
    const alts = r.alts.flatMap(alt => rw.alt(alt.leaves, {flags}).map(leaves => ({leaves})));
    const out = {...r, head: head(r.head), alts};
    ruleMap.set(r, out);
    return out;
  });
  const aggMap = new Map();
  const aggregates = program.aggregates.map(g => {
    const alts = g.alts.flatMap(alt => rw.alt(alt.leaves, {flags}).map(leaves => ({leaves})));
    const out = {...g, yields: head(g.yields), alts, rowVars: [...new Set(alts.flatMap(a => [...bound(a.leaves)]))].sort(), ...(g.fn === 'count' && plan.scale > 0 ? {scaleCount: plan.P} : {})};
    aggMap.set(g, out);
    return out;
  });
  const strata = program.strata.map(s => ({...s, rules: s.rules.map(r => ruleMap.get(r) ?? r), aggregates: s.aggregates.map(g => aggMap.get(g) ?? g)}));
  const edges = [...program.edges];
  const slice = new Set(program.slice ?? []);
  const extra = {rules, aggregates, strata, edges, slice};
  if (flags.length) {
    const flagRule = {id: INEXACT, source: {id: INEXACT, version: 1}, head: {neg: false, p: INEXACT, args: []}, alts: flags};
    extra.rules = [...rules, flagRule];
    extra.strata = [...strata, {preds: new Set([INEXACT]), rules: [flagRule], aggregates: [], recursive: false}];
    for (const alt of flags) for (const l of alt.leaves) if (l.kind === 'atom') edges.push({from: l.p, to: INEXACT, strict: false});
    slice.add(INEXACT);
  }
  return {...program, facts, ...extra};
}

/** Facts alone (a view of the program's facts), scaled. */
export function scaleFacts(facts, plan) {
  const rw = new Rewriter(plan);
  return facts.map(f => ({...f, args: rw.atomArgs(f.args)}));
}

/** The query plan with constants scaled and compute words expanded (a division by a variable is refused inside a query). */
export function scaleQuery(qp, plan, options = {}) {
  const rw = new Rewriter(plan, options);
  const alts = list => list.flatMap(alt => rw.alt(alt.leaves, {allowFlag: false}).map(leaves => ({...alt, leaves, bound: new Set([...(alt.bound ?? []), ...bound(leaves)])})));
  return {...qp, alts: alts(qp.alts), scopeAlts: alts(qp.scopeAlts)};
}

/** Decode the value tables an engine read back (Map key -> rows) and report whether the inexactness flag fired. */
export function decodeTables(tables, plan) {
  const out = new Map();
  let inexact = false;
  for (const [key, rows] of tables) {
    if (key === `p|${INEXACT}`) { inexact = rows.length > 0; continue; }
    out.set(key, plan.scale === 0 ? rows : rows.map(r => r.map(x => (typeof x === 'number' ? fromScaled(x, plan.scale) : x))));
  }
  return {tables: out, inexact};
}

export const inexactError = plan => refuse(`a division was not exact at ${plan.scale} decimal places; an exact-rational engine answers`);
