/**
 * The asked-parts scorer (coordinator, 2026-10-03): the answers of a pipeline are compared with the parts of the book answer the
 * question asks, not with the whole stored value list. Eval code reading the gold; never product code. Structural rules only:
 *   inputs       a gold number that is one of the problem's own numbers (its registry) is an input or a restated check value, not an
 *                asked part, when the gold also holds numbers the problem does not state
 *   clock        a time or duration written h:mm or "H h M min" in the answer text, stored as the pair [h, m], is one value h + m/60
 *   defects      (as the six-paths scorer) a gold value absent from the gold's own answer text; a gold of two or more numbers that are
 *                all inputs of the problem (the asked part is not a number: the numbers are the reasons quoted in a text answer); a
 *                reviewed defect (REVIEWED_DEFECTS)
 *   numbers      correct when every asked number is among the answered numbers (relative tolerance 0.5%, a percentage and its
 *                fraction are the same number; extra answered values are allowed, they are the parts the gold does not store);
 *                partial when some are and nothing else was answered; wrong when none is, when an asked part is missing and another
 *                number (no value of the stored gold list) was answered in its place, or when no number was answered
 *   yes/no       the first yes/no answer decides (a `which` list answers "is there" by being non-empty)
 *   names        the folded names; correct when every gold name is answered, partial when some are
 * Verdicts: correct, partial, wrong, no_answer, gold_defect.
 */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {registryOf} from '../../../../lib/formalize/expression-program.mjs';

/**
 * Gold defects found by reviewing a problem (local, gitignored: they name book problems): one JSON line {id, why} per problem whose
 * stored answer value is not what its question asks (as the six-paths scorer's reviewed defects).
 */
export const REVIEWED_DEFECTS = fileURLToPath(new URL('../../../../datasets_sources/books/eval/gold-defects.jsonl', import.meta.url));
let reviewed = null;
const reviewedDefects = () => (reviewed ??= new Map(fs.existsSync(REVIEWED_DEFECTS) ? fs.readFileSync(REVIEWED_DEFECTS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(r => [r.id, r.why]) : []));

const near = (a, b) => Math.abs(a - b) <= Math.max(1e-9, 0.005 * Math.abs(b));
const same = (a, b) => near(a, b) || near(a * 100, b) || near(a / 100, b);
const fold = s => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/^(?:the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
// The numbers of a text, with a written fraction a/b also as its value.
const numbersOf = text => {
  const s = String(text ?? '').replace(/(\d),(\d{3})/g, '$1$2');
  return [...s.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0])).concat([...s.matchAll(/(\d+)\s*\/\s*(\d+)/g)].map(m => Number(m[1]) / Number(m[2])));
};

/** The gold's (h, m) pairs written as a clock time or an hours-and-minutes duration. */
function clockPairs(text) {
  const s = String(text ?? '');
  return [...s.matchAll(/\b(\d{1,2}):(\d{2})\b/g), ...s.matchAll(/\b(\d+)\s*h(?:ours?)?\s*(\d{1,2})\s*min/g)].map(m => [Number(m[1]), Number(m[2])]);
}

/** The asked parts of a gold: {kind, values, why} or {kind: 'defect', why}. */
export function askedGold(item, gold) {
  if (!gold) return null;
  if (reviewedDefects().has(item.id)) return {kind: 'defect', why: `reviewed: ${reviewedDefects().get(item.id)}`};
  if (gold.kind !== 'number') return gold;
  let values = [...gold.values];
  // Clock times and durations: the stored pair is one value.
  for (const [h, m] of clockPairs(item.answer)) {
    const i = values.findIndex((v, k) => v === h && values[k + 1] === m);
    if (i >= 0) values.splice(i, 2, h + m / 60);
  }
  const inText = numbersOf(item.answer).concat(clockPairs(item.answer).map(([h, m]) => h + m / 60));
  if (item.answer && values.some(v => !inText.some(t => same(t, v)))) return {kind: 'defect', why: `gold value ${values.join(', ')} is not in its answer text`};
  const inputs = registryOf(item.question).flatMap(r => (r.percent ? [r.value, r.value / 100] : [r.value]));
  const isInput = v => inputs.some(x => Math.abs(x - v) < 1e-9);
  const asked = values.filter(v => !isInput(v));
  if (!asked.length && values.length > 1) return {kind: 'defect', why: 'every gold number is an input of the problem (the asked part is not a number)'};
  return {kind: 'number', values: asked.length ? [...new Set(asked)] : values, all: values, inputs};
}

/** The verdict of one problem's answers ([{kind, value}], unanswered ones null) against the asked parts of its gold. */
export function askedVerdict(item, gold, answers) {
  const g = askedGold(item, gold);
  if (!g) return {verdict: 'unscorable'};
  if (g.kind === 'defect') return {verdict: 'gold_defect', why: g.why};
  const got = answers.filter(a => a.value !== null && a.value !== undefined);
  if (!got.length) return {verdict: 'no_answer'};
  if (g.kind === 'yes_no') {
    const b = got.find(a => typeof a.value === 'boolean' || (['which', 'none'].includes(a.kind) && Array.isArray(a.value)));
    if (!b) return {verdict: 'wrong', why: 'no yes/no answer'};
    const yes = typeof b.value === 'boolean' ? b.value : b.value.length > 0;
    return {verdict: yes === g.values[0] ? 'correct' : 'wrong'};
  }
  if (g.kind === 'number') {
    const nums = got.flatMap(a => [].concat(a.value)).filter(v => typeof v === 'number');
    if (!nums.length) return {verdict: 'wrong', why: 'no number answered'};
    const found = g.values.filter(v => nums.some(n => same(n, v)));
    // An answered number that is no value of the stored gold list is a claim of its own: with an asked part missing, it
    // is taken as the (wrong) answer to that part, so the problem is wrong, not partial.
    const extra = nums.filter(n => !g.all.some(v => same(n, v)));
    const verdict = found.length === g.values.length ? 'correct' : found.length && !extra.length ? 'partial' : 'wrong';
    return {verdict, asked: g.values, found, extra};
  }
  const names = got.flatMap(a => [].concat(a.value)).filter(v => typeof v === 'string').map(fold);
  if (!names.length) return {verdict: 'wrong', why: 'no name answered'};
  const found = g.values.map(fold).filter(v => names.includes(v));
  return {verdict: found.length === g.values.length ? 'correct' : found.length ? 'partial' : 'wrong', asked: g.values, found};
}
