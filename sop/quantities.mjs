/**
 * Quantities with units in comparisons (DS014 "Question forms", comparison of measures): a compared JSON-quoted operand that is a number
 * followed by the name of a unit the memory knows ("3000 seconds", "1 kilogram", "1.5 km") is a value with a unit, not a leading number
 * and never an entity. A comparison of two such quantities is lowered onto the unit facts of the memory: the predicate it declares with
 * `reading unit_amount` (how many base units one of the unit is) and the one declared with `reading unit_dimension` (what the unit
 * measures).
 *
 *   compare "1 hour" above "3000 seconds"
 *     ->  where unit_amount hour ?a, unit_amount second ?b, unit_dimension hour ?d, unit_dimension second ?d
 *         compare ?a above 3000000            (1 x ?a > 3000 x 1000, written as a bound on the integer ?a)
 *
 * The matches make the answer rest on the memory's own facts (they are cited in its proof) and give no row when the units measure
 * different dimensions (an honest unknown, never a comparison of hours with metres). The right side is the exact rational
 * n2 x amount(u2) / n1 from the same facts, compiled into the lexicon (`Lexicon.unitFacts`); because an amount in base units is an
 * integer, a strict or non-strict bound on it is exact after rounding the rational towards the right side (no floating point).
 *
 * Structure only: the number is read by its digits, the unit through the memory's lexicon (an entity of class `unit`); no unit table, no
 * conversion factor and no predicate id in code. A comparison whose operands are not both such quantities is left as written.
 */
import {COMPARATOR_WORDS} from './enums.mjs';

/** The unit class of core-min: a unit entity is of this class (kind or `is_a`). */
export const UNIT_CLASS = 'unit';

const QUANTITY = /^\s*(\d+(?:\.\d+)?)\s+(\S(?:.*\S)?)\s*$/u;
const OPERAND = String.raw`("(?:\\.|[^"\\])*"|\S+)`;
const LINE = new RegExp(String.raw`^\s*${OPERAND}\s+(\S+)\s+${OPERAND}\s*$`, 'u');

/** The single predicate the memory declares with the reading, or null when it declares none or several. */
export function predicateWithReading(lexicon, reading) {
  const found = Object.values(lexicon?.predicates ?? {}).filter(p => p.readings?.includes(reading) && p.arity === 2);
  return found.length === 1 ? found[0].id : null;
}

/** A quoted operand read as a quantity: {amount (the digits as written), unit (entity id), surface, unitSurface, match}, or null. */
export function readQuantity(quoted, lexicon) {
  if (typeof quoted !== 'string' || !quoted.startsWith('"')) return null;
  let surface;
  try { surface = JSON.parse(quoted); } catch { return null; }
  const m = QUANTITY.exec(surface);
  if (!m || !lexicon?.matching) return null;
  const {found, match} = lexicon.matching(m[2], {language: 'auto', kind: 'entity', type: UNIT_CLASS});
  return found.length === 1 ? {amount: m[1], unit: found[0].id, surface, unitSurface: m[2], match} : null;
}

/** A non-negative decimal string as an exact fraction of BigInts. */
const fraction = text => { const [whole, part = ''] = String(text).split('.'); return {n: BigInt(whole + part), d: 10n ** BigInt(part.length)}; };
const floorDiv = (a, b) => (a >= 0n ? a / b : -((-a + b - 1n) / b));
const ceilDiv = (a, b) => -floorDiv(-a, b);

/**
 * The bound on the integer amount of the left unit that decides `n1 x left OP n2 x right`, given right's amount in base units: the
 * comparison word and operand of the lowered `compare` line (an integer, or a non-integer decimal string that no integer equals).
 */
export function quantityBound(op, leftAmount, rightAmount, rightBase) {
  const l = fraction(leftAmount), r = fraction(rightAmount), base = BigInt(rightBase);
  if (l.n === 0n) return null;
  // ?a OP (r.n / r.d) x base / (l.n / l.d)  =  ?a OP num / den
  const num = r.n * base * l.d, den = r.d * l.n;
  const exact = num % den === 0n, floor = floorDiv(num, den), ceil = ceilDiv(num, den);
  switch (op) {
    case 'above': return {op, value: String(floor)};
    case 'at_most': return {op, value: String(floor)};
    case 'below': return {op, value: String(ceil)};
    case 'at_least': return {op, value: String(ceil)};
    case 'equal': case 'not_equal': return {op, value: exact ? String(floor) : JSON.stringify(`${floor}.5`)};
    default: return null;
  }
}

/**
 * Lowers the comparisons of one query whose two operands are quantities. `lines` are the query's `compare` values as written; `fresh()`
 * names a new variable. Returns {compare, where, quantities}: the compare lines with each lowered comparison rewritten, the extra
 * `where` conditions (amounts and dimensions), and a report entry per quantity.
 */
export function lowerQuantities(lines, lexicon, {fresh}) {
  const amountOf = predicateWithReading(lexicon, 'unit_amount'), dimensionOf = predicateWithReading(lexicon, 'unit_dimension');
  const out = {compare: [...lines], where: [], quantities: []};
  if (!amountOf || !dimensionOf) return out;
  const amounts = lexicon.unitFacts?.unit_amount ?? {};
  out.compare = lines.map(line => {
    const m = LINE.exec(line);
    if (!m || !Object.hasOwn(COMPARATOR_WORDS, m[2])) return line;
    const left = readQuantity(m[1], lexicon), right = readQuantity(m[3], lexicon);
    if (!left || !right || !/^\d+$/.test(amounts[right.unit] ?? '')) return line;
    const bound = quantityBound(m[2], left.amount, right.amount, amounts[right.unit]);
    if (!bound) return line;
    const a = fresh(), b = fresh(), dimension = fresh();
    out.where.push(`${amountOf} ${left.unit} ${a}`, `${amountOf} ${right.unit} ${b}`, `${dimensionOf} ${left.unit} ${dimension}`, `${dimensionOf} ${right.unit} ${dimension}`);
    for (const q of [left, right]) out.quantities.push({surface: q.surface, amount: q.amount, unit: q.unit, unit_surface: q.unitSurface, match: q.match});
    return `${a} ${bound.op} ${bound.value}`;
  });
  return out;
}
