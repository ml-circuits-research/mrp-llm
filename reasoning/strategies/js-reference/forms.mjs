/**
 * Query forms of the oracle: the value-level fields of a `query` wire that act on the rows a join produced.
 *
 *   compare   one `LEFT WORD RIGHT` line, or an `all`/`any` block of such lines (WORD: equal not_equal above below at_least at_most);
 *             an ordering needs numbers, `equal`/`not_equal` compare numbers as numbers and anything else as written;
 *   except    `?v VALUE`: the rows whose ?v differs from VALUE (a quoted string, an integer or a symbol);
 *   filter    a typed expression of the host language (`sop/expression.mjs`), trusted circuits only; true keeps the row;
 *   rank      `highest ?v` or `lowest ?v`: only the rows with the best value stay (ties stay);
 *   quantifier `all none not_all most half at_least N`: the universal question `mode every` over the KNOWN members of its restriction;
 *   limit     the number of answers returned (the count of `mode count` is never cut).
 *
 * Number reading (DS014 Q-LANG-2): a value is a number when it is a finite number or a string that starts with one ("2380 lei",
 * "80"). An ordering over a value that is not a number is `not_computable` (reason `value_not_numeric`), never false.
 * These forms are an oracle capability of the host question language, ported from the retired `reference` reasoner; the strict
 * closed-domain `every` of the proposal is the same mode WITHOUT a `quantifier` line.
 */
import {tokens, VAR, NUMBER, COMPARATORS} from './wires.mjs';
import {ProgramError} from './values.mjs';
import {evaluateExpression} from '../../../sop/expression.mjs';
import {parseBooleanCondition} from '../../../sop/conditions.mjs';

export const QUANTIFIERS = ['all', 'none', 'not_all', 'most', 'half', 'at_least'];
const COMPARE = {above: (a, b) => a > b, below: (a, b) => a < b, at_least: (a, b) => a >= b, at_most: (a, b) => a <= b};

/** A value read as a number: a number, or a string that starts with one ("2380 lei", "80"); null otherwise. */
export function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const m = typeof value === 'string' ? value.trim().match(/^(-?\d+(?:\.\d+)?)(?:\s|$)/) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Status of a universal question under a quantifier, from the statuses of the members (supported, refuted or unknown).
 * `all`: refuted by any refuted member, supported when every member is supported. `none`: supported when every member is
 * refuted. `not_all`: supported by any refuted member. `most`: more than half supported. `half`: exactly half supported (every
 * member decided). `at_least N`: N or more supported. A result the unknown members could still change is unknown; no member at all
 * is unknown.
 */
export function quantifiedStatus(quantifier, members) {
  const n = members.length, s = members.filter(m => m.status === 'supported').length, r = members.filter(m => m.status === 'refuted').length, u = n - s - r;
  if (!n) return 'unknown';
  const decide = (yes, no) => (yes ? 'supported' : no ? 'refuted' : 'unknown');
  switch (quantifier?.word ?? 'all') {
    case 'all': return decide(u === 0 && r === 0, r > 0);
    case 'none': return decide(u === 0 && s === 0, s > 0);
    case 'not_all': return decide(r > 0, u === 0 && r === 0);
    case 'most': return decide(2 * s > n, 2 * (s + u) <= n);
    case 'half': return decide(u === 0 && 2 * s === n, 2 * s > n || 2 * r > n || (u === 0 && 2 * s !== n));
    case 'at_least': return decide(s >= quantifier.count, s + u < quantifier.count);
    default: throw new ProgramError('bad_quantifier', 'unknown quantifier ' + quantifier.word);
  }
}

const term = t => (VAR.test(t) ? t : NUMBER.test(t) ? Number(t) : t.startsWith('"') ? JSON.parse(t) : t);

/** One compare condition (inline text, or a field with an `all`/`any` block) as a tree of {kind, children} and {left, op, right}. */
function readCompare(field) {
  const leaf = text => {
    const t = tokens(text);
    if (t.length !== 3 || !COMPARATORS.includes(t[1]) || !VAR.test(t[0])) throw new ProgramError('bad_compare', `compare takes ?VARIABLE WORD TERM with WORD in ${COMPARATORS.join(', ')}: ${text}`);
    return {left: t[0], op: t[1], right: term(t[2])};
  };
  const head = field.value.trim();
  if (head !== 'all' && head !== 'any') return leaf(head);
  const lines = (field.block ?? []).map(b => b.text);
  let i = 0;
  const group = kind => {
    const children = [];
    while (i < lines.length) {
      const text = lines[i++];
      if (text === 'end') return {kind, children};
      children.push(text === 'all' || text === 'any' ? group(text) : leaf(text));
    }
    throw new ProgramError('unclosed_block', 'compare group not closed');
  };
  return group(head);
}

/** The forms of a query wire (`wire.fields`) as one object; `null` when it has none. */
export function readForms(wire) {
  const all = k => wire.fields.filter(f => f.key === k);
  const one = k => all(k)[0]?.value.trim() ?? null;
  const forms = {compares: all('compare').map(readCompare), filters: [], rank: null, quantifier: null, limit: Infinity};
  for (const f of all('filter')) forms.filters.push(parseBooleanCondition([f.value, ...(f.block ?? []).map(b => b.text)].join('\n')));
  for (const f of all('except')) {
    const [name, value] = tokens(f.value);
    if (!VAR.test(name ?? '') || value === undefined) throw new ProgramError('bad_except', `except takes ?VARIABLE VALUE: ${f.value}`);
    forms.filters.push({type: 'binary', op: '!=', left: {type: 'var', value: name}, right: {type: 'literal', value: term(value)}});
  }
  if (one('rank')) {
    const [direction, variable, cut, n] = tokens(one('rank'));
    if (!['highest', 'lowest'].includes(direction) || !VAR.test(variable ?? '')) throw new ProgramError('bad_rank', 'rank takes highest or lowest and a ?variable');
    if (cut !== undefined && (!['position', 'top'].includes(cut) || !/^[1-9]\d{0,2}$/.test(n ?? ''))) throw new ProgramError('bad_rank', 'rank may end with position N or top N');
    forms.rank = {direction, variable, ...(cut ? {cut, n: Number(n)} : {})};
  }
  if (one('quantifier')) {
    const [word, count] = tokens(one('quantifier'));
    if (!QUANTIFIERS.includes(word)) throw new ProgramError('bad_quantifier', `quantifier must be one of ${QUANTIFIERS.join(', ')}`);
    if ((word === 'at_least') !== (count !== undefined)) throw new ProgramError('bad_quantifier', 'only at_least takes a number');
    forms.quantifier = {word, ...(count !== undefined ? {count: Number(count)} : {})};
  }
  if (one('limit')) forms.limit = Number(one('limit'));
  return forms;
}

export const hasRowForms = forms => Boolean(forms && (forms.compares.length || forms.filters.length || forms.rank));

/** Variables a form reads (the host checks they are bound by the where part). */
export function formVariables(forms) {
  const out = new Set();
  const walk = n => { if (n.kind) n.children.forEach(walk); else { out.add(n.left); if (typeof n.right === 'string' && VAR.test(n.right)) out.add(n.right); } };
  forms.compares.forEach(walk);
  if (forms.rank) out.add(forms.rank.variable);
  return out;
}

function testCompare(node, env, state) {
  if (node.kind === 'all') return node.children.every(c => testCompare(c, env, state));
  if (node.kind === 'any') return node.children.some(c => testCompare(c, env, state));
  const a = env[node.left], b = VAR.test(String(node.right)) ? env[node.right] : node.right;
  if (node.op === 'equal' || node.op === 'not_equal') {
    const x = numericValue(a), y = numericValue(b), same = x !== null && y !== null ? x === y : a === b;
    return node.op === 'equal' ? same : !same;
  }
  const x = numericValue(a), y = numericValue(b);
  if (x === null || y === null) { state.notComputable = true; return false; }
  return COMPARE[node.op](x, y);
}

/**
 * Apply the row forms to join candidates `[{env, ...}]` in the order filter, compare, rank. `state` records what the decision
 * needs: `filtered` (rows left after the filters), `notComputable` (an ordering met a non-number) and `compared` (compares exist).
 */
export function applyRowForms(candidates, forms, state) {
  state.filtered = candidates.length;
  if (!hasRowForms(forms)) return candidates;
  let rows = candidates.filter(c => forms.filters.every(ast => evaluateExpression(ast, {variables: c.env}).value === true));
  state.filtered = rows.length;
  state.afterFilters = rows;
  state.compared = forms.compares.length > 0;
  if (forms.compares.length) rows = rows.filter(c => forms.compares.every(node => testCompare(node, c.env, state)));
  if (forms.rank && rows.length) {
    const valued = rows.map(c => ({c, value: numericValue(c.env[forms.rank.variable])})).filter(x => x.value !== null);
    if (!valued.length) { state.notComputable = true; return []; }
    // The distinct values from the best to the worse; `position N` keeps the rows of the N-th value, `top N` those of the first N values (ties are never split).
    const distinct = [...new Set(valued.map(x => x.value))].sort((a, b) => (forms.rank.direction === 'highest' ? b - a : a - b));
    const n = forms.rank.n ?? 1;
    const keep = forms.rank.cut === 'top' ? new Set(distinct.slice(0, n)) : new Set(distinct.slice(n - 1, n));
    if (!keep.size) return [];
    rows = valued.filter(x => keep.has(x.value)).map(x => x.c);
  }
  return rows;
}

/** Substitute the bound variables of a condition-leaf list (used by the quantified question for the scope of one member). */
export const substituteArgs = (args, env) => args.map(a => (typeof a === 'object' && a !== null && 'var' in a && a.var in env ? env[a.var] : a));
