/**
 * Extension E2 of the knowledge surface (reasoning wires proposal, section 4.3): the NUMERIC `action`.
 *
 * A STRIPS action may also carry exact-rational arithmetic, as in the VRC planner (`vrc03r`, profile `vrc.search.v1`):
 *
 *   @a0 action
 *     requires normal                  # relational part as before (zero-arity flags are fine); optional when `next` is present
 *     adds service
 *     removes normal
 *     guard ?q below 1000000000        # EXPR WORD EXPR, WORD in above below at_least at_most equal; every guard must hold
 *     next q ?q + ?x0^2 + ?y0^2        # one `next VAR EXPR` per state variable (identity must be explicit, as in VRC)
 *     next x0 ?y0
 *
 * The numeric state is held by ground facts of the reserved relation `state` (entity, variable, value), exactly VRC's
 * `VALUE state entity variable value`:  `holds state demo q 0`  (declare it `args subject:entity topic:entity object:rational`).
 * A plan query adds the numeric goal and the horizon:
 *
 *   @q query
 *     mode plan
 *     observe demo ?q at_least 4808    # ENTITY EXPR WORD NUMBER (the planner finds a shortest plan that reaches it)
 *     horizon 28                       # a search bound: a cut is `budget_exhausted` (reason horizon), never `no_plan`
 *
 * An EXPR is a polynomial in the state variables `?v` with exact rational constants: `+ - * ^` (non-negative integer power),
 * parentheses, and division by a nonzero constant. It is data for the planner, never JavaScript (it is parsed here, never
 * evaluated as code). A `rational` term is an integer, a decimal or `n/d`.
 *
 * This module is syntax only (plain data in, plain data and problem lists out). `sop/knowledge/grammar.mjs` imports the
 * tables; the strategy `reasoning/strategies/vrc-compressed-planning/` compiles the ASTs with exact arithmetic.
 */

const one = (kind, extra = {}) => ({card: 'one', kind, ...extra});
const many = (kind, extra = {}) => ({card: 'many', kind, ...extra});

export const NUMERIC_FEATURE = 'numeric_action';
export const NUMERIC_ARG_TYPE = 'rational';
export const NUMERIC_STATE_RELATION = 'state';
export const NUMERIC_WORDS = ['above', 'below', 'at_least', 'at_most', 'equal'];
export const MAX_STATE_VARIABLES = 32;
export const RATIONAL = /^[+-]?(?:\d+(?:\.\d+)?)(?:\/\d+)?$/;

/** Fields the numeric extension adds, per wire type, in the shape of the grammar table (`card`, `kind`). */
export const NUMERIC_FIELDS = {
  action: {next: many('numnext'), guard: many('numguard')},
  query: {observe: one('numobserve'), horizon: one('posint')}
};

// ------------------------------------------------------------------------------------------------ exact rationals

const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };

/** `3`, `-2`, `0.25`, `1/3` -> {n, d} (BigInt, reduced, d > 0), or null. */
export function parseRational(text) {
  if (!RATIONAL.test(text)) return null;
  const [num, den = '1'] = text.split('/');
  const neg = num.startsWith('-');
  const [i, f = ''] = num.replace(/^[+-]/, '').split('.');
  let n = BigInt(i + f), d = 10n ** BigInt(f.length) * BigInt(den);
  if (d === 0n) return null;
  if (neg) n = -n;
  const g = gcd(n, d) || 1n;
  return {n: n / g, d: d / g};
}

export const isRationalToken = t => RATIONAL.test(t);

// ------------------------------------------------------------------------------------------------ the expression grammar

const TOKEN = /^(?:\?[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[()+\-*\/^])/;

/**
 * Parse a polynomial expression into an AST: {t:'num', text} | {t:'var', name} | {t:'neg', a} | {t:'add'|'sub'|'mul'|'div'|'pow', a, b}.
 * Returns {ast, vars} or {error}. `^` takes a non-negative integer, `/` a nonzero constant (checked in `constantValue`).
 */
export function parseExpression(text) {
  if (typeof text !== 'string' || !text.trim()) return {error: 'empty expression'};
  if (text.length > 20000) return {error: 'expression too long'};
  const toks = [];
  for (let rest = text.trim(); rest;) {
    const m = TOKEN.exec(rest);
    if (!m) return {error: `unexpected text "${rest.slice(0, 12)}"`};
    toks.push(m[0]);
    rest = rest.slice(m[0].length).trimStart();
  }
  let i = 0, depth = 0;
  const vars = new Set();
  const fail = msg => { throw new SyntaxError(msg); };
  const atom = () => {
    if (++depth > 64) fail('expression nested too deeply');
    const t = toks[i++];
    let a;
    if (t === '(') { a = expr(); if (toks[i++] !== ')') fail('missing )'); }
    else if (t?.startsWith('?')) { vars.add(t.slice(1)); a = {t: 'var', name: t.slice(1)}; }
    else if (t && /^\d/.test(t)) a = {t: 'num', text: t};
    else fail(`expected a variable or a number, got ${t ?? 'the end'}`);
    depth--;
    return a;
  };
  const power = () => {
    let a = atom();
    if (toks[i] === '^') { i++; const k = toks[i++]; if (!/^\d+$/.test(k ?? '')) fail('a power is a non-negative integer'); a = {t: 'pow', a, b: {t: 'num', text: k}}; }
    return a;
  };
  const unary = () => (toks[i] === '-' ? (i++, {t: 'neg', a: unary()}) : toks[i] === '+' ? (i++, unary()) : power());
  const term = () => { let a = unary(); while (toks[i] === '*' || toks[i] === '/') { const op = toks[i++]; a = {t: op === '*' ? 'mul' : 'div', a, b: unary()}; } return a; };
  const expr = () => { let a = term(); while (toks[i] === '+' || toks[i] === '-') { const op = toks[i++]; a = {t: op === '+' ? 'add' : 'sub', a, b: term()}; } return a; };
  try {
    const ast = expr();
    if (i !== toks.length) fail(`unexpected ${toks[i]}`);
    checkDivisions(ast);
    return {ast, vars: [...vars]};
  } catch (e) {
    if (e instanceof SyntaxError) return {error: e.message};
    throw e;
  }
}

/** The exact value of a constant AST ({n, d}) or null when it holds a variable. */
export function constantValue(a) {
  switch (a.t) {
    case 'num': return parseRational(a.text);
    case 'var': return null;
    case 'neg': { const v = constantValue(a.a); return v && {n: -v.n, d: v.d}; }
    case 'pow': { const v = constantValue(a.a); return v && {n: v.n ** BigInt(a.b.text), d: v.d ** BigInt(a.b.text)}; }
    default: {
      const x = constantValue(a.a), y = constantValue(a.b);
      if (!x || !y) return null;
      const norm = (n, d) => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d) || 1n; return {n: n / g, d: d / g}; };
      if (a.t === 'add') return norm(x.n * y.d + y.n * x.d, x.d * y.d);
      if (a.t === 'sub') return norm(x.n * y.d - y.n * x.d, x.d * y.d);
      if (a.t === 'mul') return norm(x.n * y.n, x.d * y.d);
      return y.n === 0n ? null : norm(x.n * y.d, x.d * y.n);
    }
  }
}

function checkDivisions(a) {
  if (!a || a.t === 'num' || a.t === 'var') return;
  if (a.t === 'div') {
    const v = constantValue(a.b);
    if (!v) throw new SyntaxError('division is only by a nonzero constant');
    if (v.n === 0n) throw new SyntaxError('division by zero');
  }
  checkDivisions(a.a);
  if (a.b) checkDivisions(a.b);
}

// ------------------------------------------------------------------------------------------------ field parsers

const words = text => text.trim().split(/\s+/).filter(Boolean);

/** `next VAR EXPR` -> {variable, ast, vars} or {error}. */
export function parseNext(value) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/s.exec(value.trim());
  if (!m) return {error: 'next needs "VARIABLE EXPRESSION"'};
  const e = parseExpression(m[2]);
  return e.error ? e : {variable: m[1], ...e};
}

/** `guard EXPR WORD EXPR`. */
export function parseGuard(value) {
  const t = words(value);
  const at = t.findIndex(w => NUMERIC_WORDS.includes(w));
  if (at < 1 || at === t.length - 1) return {error: `a guard is "EXPR ${NUMERIC_WORDS.join('|')} EXPR"`};
  const left = parseExpression(t.slice(0, at).join(' ')), right = parseExpression(t.slice(at + 1).join(' '));
  if (left.error || right.error) return {error: left.error ?? right.error};
  return {word: NUMERIC_WORDS[NUMERIC_WORDS.indexOf(t[at])], left: left.ast, right: right.ast, vars: [...new Set([...left.vars, ...right.vars])]};
}

/** `observe ENTITY EXPR WORD NUMBER`. */
export function parseObserve(value) {
  const t = words(value);
  const at = t.findIndex((w, k) => k >= 2 && NUMERIC_WORDS.includes(w));
  if (t.length < 4 || at < 0 || at !== t.length - 2) return {error: `observe is "ENTITY EXPR ${NUMERIC_WORDS.join('|')} NUMBER"`};
  const e = parseExpression(t.slice(1, at).join(' '));
  const threshold = parseRational(t[at + 1]);
  if (e.error) return e;
  if (!threshold) return {error: 'the threshold must be a rational number'};
  return {entity: t[0], word: t[at], ast: e.ast, vars: e.vars, threshold};
}

// ------------------------------------------------------------------------------------------------ checks

/** The numeric fields of a wire as plain data: [{key, value, line}]. */
const f1 = (w, k) => w.fields.find(f => f.key === k);
const fAll = (w, k) => w.fields.filter(f => f.key === k);

/** Is this action a numeric action? (it carries `next` or `guard`.) */
export const isNumericAction = w => w.type === 'action' && w.fields.some(f => f.key === 'next' || f.key === 'guard');

/** Field-level check of one numeric field kind; returns [{code, message}]. */
export function checkNumericValue(kind, f) {
  const bad = (code, message) => [{code, message}];
  if (kind === 'numnext') { const r = parseNext(f.value); return r.error ? bad('bad_next', r.error) : []; }
  if (kind === 'numguard') { const r = parseGuard(f.value); return r.error ? bad('bad_guard', r.error) : []; }
  if (kind === 'numobserve') { const r = parseObserve(f.value); return r.error ? bad('bad_observe', r.error) : []; }
  return [];
}

/**
 * Wire-level checks of a numeric action: every `next` names a distinct variable and, when an action has any `next`, every state
 * variable of the program has one (identity must be explicit); expression variables are state variables of the same action.
 * `stateVars` is the union of the variables named by the `next` lines of all numeric actions, supplied by the caller.
 * Also reports the two relaxations the numeric extension needs: such an action may omit `requires`, and its effect may be numeric only.
 */
export function checkNumericAction(w, stateVars) {
  const out = [];
  const nexts = fAll(w, 'next').map(f => ({f, r: parseNext(f.value)}));
  const names = nexts.filter(n => !n.r.error).map(n => n.r.variable);
  if (new Set(names).size !== names.length) out.push({code: 'duplicate_next', message: 'each state variable has one next line'});
  if (nexts.length) for (const v of stateVars) if (!names.includes(v)) out.push({code: 'missing_next', message: `state variable ${v} needs a next line (identity must be explicit)`});
  if (stateVars.length > MAX_STATE_VARIABLES) out.push({code: 'too_many_state_variables', message: `at most ${MAX_STATE_VARIABLES} state variables`});
  const known = new Set(stateVars);
  for (const n of nexts) for (const v of n.r.vars ?? []) if (!known.has(v)) out.push({code: 'unknown_state_variable', message: `?${v} is not a state variable`});
  for (const g of fAll(w, 'guard')) for (const v of parseGuard(g.value).vars ?? []) if (!known.has(v)) out.push({code: 'unknown_state_variable', message: `?${v} in a guard is not a state variable`});
  return out;
}

/** The state variables of a set of wires: the union of the `next` variables of every numeric action, in first-seen order. */
export function stateVariables(wires) {
  const out = [];
  for (const w of wires) if (w.type === 'action') for (const f of fAll(w, 'next')) { const r = parseNext(f.value); if (!r.error && !out.includes(r.variable)) out.push(r.variable); }
  return out;
}

// ------------------------------------------------------------------------------------------------ parsed form for strategies

/** The numeric part of an action wire: {nexts: [{variable, ast}], guards: [{word, left, right}]}; throws on a malformed field. */
export function parseNumericAction(w) {
  const nexts = fAll(w, 'next').map(f => { const r = parseNext(f.value); if (r.error) throw new SyntaxError(`${w.id}: ${r.error}`); return {variable: r.variable, ast: r.ast}; });
  const guards = fAll(w, 'guard').map(f => { const r = parseGuard(f.value); if (r.error) throw new SyntaxError(`${w.id}: ${r.error}`); return {word: r.word, left: r.left, right: r.right}; });
  return {nexts, guards};
}

/** The numeric goal and horizon of a plan query wire, or null when it has no `observe`. */
export function parseNumericGoal(w) {
  const o = f1(w, 'observe');
  if (!o) return null;
  const r = parseObserve(o.value);
  if (r.error) throw new SyntaxError(`${w.id}: ${r.error}`);
  const h = f1(w, 'horizon');
  return {entity: r.entity, word: r.word, ast: r.ast, threshold: r.threshold, horizon: h ? Number(h.value.trim()) : null};
}
