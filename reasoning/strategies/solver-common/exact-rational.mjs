/**
 * Exact rational arithmetic for the engines that ground values in JavaScript (z3-smt-bounded) and for reading Z3's Real answers.
 * A decimal of the circuit is read from its shortest decimal text (0.1 is 1/10, not the binary double), every `compute` word is
 * evaluated on BigInt fractions, and the result is rendered like the other exact engines render it: a terminating decimal as the
 * exact decimal, a quotient that does not terminate (1 divided_by 3) to DECIMAL_DIGITS significant digits (the oracle's rendering).
 * The words are the oracle's (DS004 "Exact arithmetic"): `whole_divided_by` truncates toward zero and `modulo` is its remainder
 * (integers only), `power` takes an integer exponent 0..64, `rounded_to` rounds half away from zero, `rounded_up_to` and
 * `rounded_down_to` take the next or previous multiple of a positive B; a zero divisor, a non-number or an unsafe result is undefined.
 */
export const DECIMAL_DIGITS = 12;

const big = BigInt;
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };

export class Q {
  constructor(n, d = 1n) {
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
  }

  static of(x) {
    if (x instanceof Q) return x;
    if (!Number.isFinite(x)) return null;
    if (Number.isInteger(x)) return new Q(big(x));
    const [mantissa, e] = Math.abs(x).toString().split('e');
    const [whole, frac = ''] = mantissa.split('.');
    let n = big(whole + frac), d = 1n;
    const shift = Number(e ?? 0) - frac.length;
    if (shift >= 0) n *= 10n ** big(shift); else d = 10n ** big(-shift);
    return new Q(x < 0 ? -n : n, d);
  }

  add(o) { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Q(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Q(this.n * o.n, this.d * o.d); }
  div(o) { return new Q(this.n * o.d, this.d * o.n); }
  cmp(o) { const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
  get isInteger() { return this.d === 1n; }
  get sign() { return this.n < 0n ? -1 : this.n > 0n ? 1 : 0; }
  pow(k) { let r = new Q(1n); for (let i = 0; i < k; i++) r = r.mul(this); return r; }

  /** floor, ceiling and truncation as BigInt */
  floor() { return this.n >= 0n ? this.n / this.d : -((-this.n + this.d - 1n) / this.d); }
  ceil() { return -new Q(-this.n, this.d).floor(); }
  trunc() { return this.n / this.d; }
  /** half away from zero */
  round() { const a = new Q(this.n < 0n ? -this.n : this.n, this.d).add(new Q(1n, 2n)).floor(); return this.n < 0n ? -a : a; }

  /** True when the decimal expansion terminates (the reduced denominator has only the prime factors 2 and 5). */
  get terminates() {
    let d = this.d;
    while (d % 2n === 0n) d /= 2n;
    while (d % 5n === 0n) d /= 5n;
    return d === 1n;
  }

  /** The JS number of the value: exact when it terminates, else DECIMAL_DIGITS significant digits (the oracle's rendering). */
  toNumber() {
    if (this.d === 1n) return Number(this.n);
    const neg = this.n < 0n, n = neg ? -this.n : this.n;
    let places = 40;
    if (this.terminates) { places = 0; while ((10n ** big(places)) % this.d !== 0n) places++; }
    const digits = (n * (10n ** big(places)) / this.d).toString().padStart(places + 1, '0');
    const value = Number((neg ? '-' : '') + digits.slice(0, -places) + '.' + digits.slice(-places));
    return this.terminates ? value : Number(value.toPrecision(DECIMAL_DIGITS));
  }
}

const SAFE = 9007199254740991;
const safe = q => (q.n <= big(SAFE) * q.d && -q.n <= big(SAFE) * q.d ? q : null);

/** `compute` on exact fractions; returns a JS number or undefined, with the words and the undefined cases of the oracle. */
export function exactCompute(word, a, b) {
  const x = Q.of(a), y = Q.of(b);
  if (!x || !y) return undefined;
  let r;
  switch (word) {
    case 'plus': r = x.add(y); break;
    case 'minus': r = x.sub(y); break;
    case 'times': r = x.mul(y); break;
    case 'divided_by': if (y.sign === 0) return undefined; r = x.div(y); break;
    case 'whole_divided_by': if (y.sign === 0 || !x.isInteger || !y.isInteger) return undefined; r = new Q(x.div(y).trunc()); break;
    case 'modulo': if (y.sign === 0 || !x.isInteger || !y.isInteger) return undefined; r = new Q(x.n % y.n); break;
    case 'power': if (!y.isInteger || y.sign < 0 || y.n > 64n) return undefined; r = x.pow(Number(y.n)); break;
    case 'rounded_to': case 'rounded_up_to': case 'rounded_down_to': {
      if (y.sign <= 0) return undefined;
      const q = x.div(y);
      r = new Q(word === 'rounded_to' ? q.round() : word === 'rounded_up_to' ? q.ceil() : q.floor()).mul(y);
      break;
    }
    case 'minimum_with': r = x.cmp(y) <= 0 ? x : y; break;
    case 'maximum_with': r = x.cmp(y) >= 0 ? x : y; break;
    default: return undefined;
  }
  return safe(r)?.toNumber();
}

/** A Z3 Real (or Int) value s-expression -> Q: `3`, `0.3`, `(/ 3.0 10.0)`, `(- (/ 1.0 3.0))`, `(- 2.5)`. */
export function realOf(x) {
  if (Array.isArray(x)) {
    if (x[0] === '-' && x.length === 2) { const v = realOf(x[1]); return new Q(-v.n, v.d); }
    if (x[0] === '/') return realOf(x[1]).div(realOf(x[2]));
    throw new Error('unreadable Z3 number');
  }
  const [whole, frac = ''] = String(x).split('.');
  return new Q(big(whole + frac), 10n ** big(frac.length));
}

/** An SMT-LIB Real literal of a JS number: `5.0`, `(/ 1.0 10.0)`, `(- (/ 1.0 10.0))`. */
export function smtReal(n) {
  const q = Q.of(n);
  const body = q.d === 1n ? `${(q.n < 0n ? -q.n : q.n)}.0` : `(/ ${q.n < 0n ? -q.n : q.n}.0 ${q.d}.0)`;
  return q.n < 0n ? `(- ${body})` : body;
}
