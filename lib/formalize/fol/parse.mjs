/**
 * A reader of first-order logic as the LFM writes it (fvossel/t5-base-nl-to-fol and the extension of
 * experiments/proposal/structure-and-formalizer-models.md §5), into an AST. Structure only: tokens, precedence, scopes.
 *
 * Syntax accepted
 *   quantifiers   FORALLx / EXISTSx (also glued: FORALLxFORALLy, NOTEXISTSy), ∀x / ∃x, a spaced keyword in any case (FORALL x,
 *                 Exists k), and several variables after one quantifier (FORALLx,y,z; FORALLx, FORALLy; ∀x y); a quantifier's scope
 *                 is the parenthesised formula right after it, else the formula that follows it (as far right as it goes)
 *   connectives   NOT (also glued to the next capitalised word: NOTPenguin; also !), AND, OR, XOR, IMPLIES, IFF / EQUIV, and
 *                 ¬ ∧ ∨ ⊕ → ↔ -> => <-> <=>; precedence NOT > AND > OR > XOR > IMPLIES (right-associative) > IFF; the prefix form
 *                 AND(a, b, ...), OR(a, b, ...), NOT(a), IMPLIES(a, b), IFF(a, b), XOR(a, b) is the same connective
 *   atoms         Name(t1, ..., tn) or a bare Name (0-ary); an infix comparison of two terms, t1 = t2 (also ==), != (≠), <, <= (≤),
 *                 >, >= (≥), is the atom Eq / NOT Eq / Lt / Le / Gt / Ge of the agreed extension
 *   terms         names, numbers, "quoted text", function terms f(t1, ...), and infix arithmetic + - * / with the usual precedence
 *                 and parentheses (read as add / sub / mul / div)
 * A name is a variable when an enclosing quantifier binds it; otherwise a constant. A lowercase one-letter name that no quantifier
 * binds is a free variable (read as universally quantified, the convention of the training data), reported, and its quantifier is
 * marked `implicit` (the converter may read it as a quantity name in a numeric statement).
 *
 * AST: {type: 'atom', pred, args} | {type: 'not', a} | {type: 'and'|'or'|'xor'|'implies'|'iff', a, b} |
 *      {type: 'forall'|'exists', v, a, implicit?};  terms: {var} | {const} | {num} | {fn, args}.
 * `parseFol(text)` → {ok: true, ast, free: [vars], repaired} or {ok: false, why}.
 */
const KEYWORDS = new Map([['AND', 'and'], ['OR', 'or'], ['XOR', 'xor'], ['IMPLIES', 'implies'], ['IFF', 'iff'], ['EQUIV', 'iff'], ['NOT', 'not']]);
const SYMBOLS = new Map([['¬', 'not'], ['∧', 'and'], ['∨', 'or'], ['⊕', 'xor'], ['→', 'implies'], ['↔', 'iff'], ['⇒', 'implies'], ['⇔', 'iff'], ['&', 'and'], ['|', 'or']]);
const COMPARE = new Map([['==', 'Eq'], ['=', 'Eq'], ['!=', 'Ne'], ['≠', 'Ne'], ['<=', 'Le'], ['≤', 'Le'], ['>=', 'Ge'], ['≥', 'Ge'], ['<', 'Lt'], ['>', 'Gt']]);
const ARITH = new Map([['+', 'add'], ['-', 'sub'], ['*', 'mul'], ['/', 'div']]);
const VARIABLE = /^[a-z][a-z0-9_]*$/;
const QUANTIFIER_WORD = /^(forall|exists)$/i;
// Multi-character operators first: the longest match wins.
const LONG_OPS = [['<->', {t: 'op', v: 'iff'}], ['<=>', {t: 'op', v: 'iff'}], ['->', {t: 'op', v: 'implies'}], ['=>', {t: 'op', v: 'implies'}],
  ['==', {t: 'cmp', v: '=='}], ['!=', {t: 'cmp', v: '!='}], ['<=', {t: 'cmp', v: '<='}], ['>=', {t: 'cmp', v: '>='}]];

/** Tokens: {t: 'lp'|'rp'|'comma'|'op'|'q'|'name'|'num'|'cmp'|'arith', v}. */
export function tokenize(text) {
  const s = String(text ?? '').trim().replace(/\.$/, ''), out = [];
  let i = 0;
  const word = /[A-Za-z0-9_][A-Za-z0-9_.'-]*/y;
  // A term ends here: a following `-` is a subtraction, otherwise it starts a negative number.
  const afterTerm = () => ['name', 'num', 'rp'].includes(out.at(-1)?.t);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { out.push({t: 'lp'}); i++; continue; }
    if (c === ')') { out.push({t: 'rp'}); i++; continue; }
    if (c === ',') { out.push({t: 'comma'}); i++; continue; }
    const long = LONG_OPS.find(([k]) => s.startsWith(k, i));
    if (long) { out.push({...long[1]}); i += long[0].length; continue; }
    if (c === '"' || c === '“' || (c === "'" && !afterTerm())) {
      const close = c === '“' ? '”' : c, j = s.indexOf(close, i + 1);
      if (j < 0) throw new Error('unclosed quoted text');
      out.push({t: 'name', v: s.slice(i + 1, j), quoted: true}); i = j + 1; continue;
    }
    if (COMPARE.has(c)) { out.push({t: 'cmp', v: c}); i++; continue; }
    if (c === '!') { out.push({t: 'op', v: 'not'}); i++; continue; }
    if (c === '-' && /\d/.test(s[i + 1] ?? '') && !afterTerm()) {
      const m = /^-\d+(?:\.\d+)?/.exec(s.slice(i));
      out.push({t: 'num', v: Number(m[0])}); i += m[0].length; continue;
    }
    if (ARITH.has(c)) { out.push({t: 'arith', v: c}); i++; continue; }
    if (SYMBOLS.has(c)) { out.push({t: 'op', v: SYMBOLS.get(c)}); i++; continue; }
    if (c === '∀' || c === '∃') {
      const m = /^[a-z][a-z0-9_]*/.exec(s.slice(i + 1).trimStart());
      if (!m) throw new Error(`quantifier ${c} without a variable`);
      out.push({t: 'q', v: c === '∀' ? 'forall' : 'exists', x: m[0]});
      i = s.indexOf(m[0], i + 1) + m[0].length; continue;
    }
    word.lastIndex = i;
    const m = word.exec(s);
    if (!m) throw new Error(`unexpected character "${c}"`);
    i += m[0].length;
    out.push(...splitWord(m[0].replace(/[.]+$/, '')));
  }
  return out;
}

/** One word → tokens: quantifiers and NOT glued to what follows are split off. */
function splitWord(w) {
  const out = [];
  while (w) {
    let m;
    if ((m = /^(FORALL|EXISTS)([a-z][a-z0-9_]*)/.exec(w))) { out.push({t: 'q', v: m[1] === 'FORALL' ? 'forall' : 'exists', x: m[2]}); w = w.slice(m[0].length); continue; }
    if (KEYWORDS.has(w)) { out.push({t: 'op', v: KEYWORDS.get(w)}); break; }
    if ((m = /^NOT(?=[A-Z])/.exec(w)) && w.length > 3) { out.push({t: 'op', v: 'not'}); w = w.slice(3); continue; }
    if (/^-?\d+(?:\.\d+)?$/.test(w)) { out.push({t: 'num', v: Number(w)}); break; }
    out.push({t: 'name', v: w}); break;
  }
  return out;
}

/** A spaced quantifier keyword (`FORALL x`, `Exists k`) becomes a quantifier token when a variable follows it. */
function joinQuantifiers(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], n = tokens[i + 1];
    if (t.t === 'name' && !t.quoted && QUANTIFIER_WORD.test(t.v) && n?.t === 'name' && !n.quoted && VARIABLE.test(n.v)) { out.push({t: 'q', v: t.v.toLowerCase(), x: n.v}); i++; continue; }
    out.push(t);
  }
  return out;
}

const fold = (type, items) => items.reduce((a, b) => ({type, a, b}));

class Parser {
  constructor(tokens) { this.k = tokens; this.i = 0; }
  peek(d = 0) { return this.k[this.i + d]; }
  next() { return this.k[this.i++]; }
  op(v) { const p = this.peek(); if (p?.t === 'op' && p.v === v) { this.i++; return true; } return false; }
  expect(t) { const p = this.next(); if (p?.t !== t) throw new Error(`expected ${t === 'rp' ? ')' : t === 'lp' ? '(' : t} at token ${this.i}`); return p; }
  iff() { let a = this.imp(); while (this.op('iff')) a = {type: 'iff', a, b: this.imp()}; return a; }
  imp() { const a = this.xor(); return this.op('implies') ? {type: 'implies', a, b: this.imp()} : a; }
  xor() { let a = this.or(); while (this.op('xor')) a = {type: 'xor', a, b: this.or()}; return a; }
  or() { let a = this.and(); while (this.op('or')) a = {type: 'or', a, b: this.and()}; return a; }
  and() { let a = this.unary(); while (this.op('and')) a = {type: 'and', a, b: this.unary()}; return a; }
  unary() {
    const p = this.peek();
    if (!p) throw new Error('formula ends too early');
    // The prefix form of a connective: AND(a, b, ...), OR(...), IMPLIES(a, b), NOT(a).
    if (p.t === 'op' && p.v !== 'not' && this.peek(1)?.t === 'lp') {
      this.i += 2;
      const items = [this.iff()];
      while (this.peek()?.t === 'comma') { this.i++; items.push(this.iff()); }
      this.expect('rp');
      if (items.length < 2) throw new Error(`${p.v.toUpperCase()}(...) needs two formulas`);
      if (['and', 'or'].includes(p.v)) return fold(p.v, items);
      if (items.length !== 2) throw new Error(`${p.v.toUpperCase()}(...) takes two formulas`);
      return {type: p.v, a: items[0], b: items[1]};
    }
    if (this.op('not')) return {type: 'not', a: this.unary()};
    if (p.t === 'q') {
      // Several variables after one quantifier: FORALLx,y,z / FORALLx, FORALLy / ∀x y.
      const vars = [p.x];
      this.i++;
      for (;;) {
        const n = this.peek(), m = this.peek(1);
        if (n?.t === 'comma' && m?.t === 'name' && !m.quoted && VARIABLE.test(m.v) && (m.v.length <= 2 || this.peek(2)?.t !== 'lp')) { vars.push(m.v); this.i += 2; continue; }
        if (n?.t === 'comma' && m?.t === 'q' && m.v === p.v) { vars.push(m.x); this.i += 2; continue; }
        if (n?.t === 'name' && !n.quoted && VARIABLE.test(n.v) && n.v.length <= 2 && ['lp', 'q', 'name', 'comma'].includes(m?.t)) { vars.push(n.v); this.i++; continue; }
        break;
      }
      // FORALLx (φ) ...: the scope is the parenthesised formula right after the quantifier (as LLM-written FOL means it:
      // FORALLz (A IMPLIES B) IMPLIES C is (∀z (A → B)) → C); without parentheses it reaches as far right as it goes.
      const body = this.peek()?.t === 'lp' ? this.unary() : this.iff();
      return vars.reduceRight((a, v) => ({type: p.v, v, a}), body);
    }
    if (p.t === 'lp') {
      // A parenthesised formula, or the parenthesised left side of a comparison: (a + b) = c.
      const save = this.i;
      try {
        this.i++;
        const a = this.iff();
        this.expect('rp');
        if (!['cmp', 'arith'].includes(this.peek()?.t)) return a;
      } catch (error) { if (this.k.slice(save).every(t => t.t !== 'cmp')) throw error; }
      this.i = save;
      return this.comparison(this.sum());
    }
    if (p.t === 'name' || p.t === 'num' || (p.t === 'arith' && p.v === '-')) {
      const t = this.sum();
      if (this.peek()?.t === 'cmp') return this.comparison(t);
      if (t.fn) return {type: 'atom', pred: t.fn, args: t.args};
      if ('name' in t && !t.quoted) return {type: 'atom', pred: t.name, args: []};
      throw new Error(`a term without a comparison at token ${this.i}`);
    }
    throw new Error(`unexpected ${p.t === 'op' ? p.v.toUpperCase() : p.t === 'num' ? p.v : p.t === 'cmp' || p.t === 'arith' ? p.v : p.t} at token ${this.i}`);
  }
  comparison(left) {
    const c = this.next();
    if (c?.t !== 'cmp') throw new Error(`expected a comparison at token ${this.i}`);
    const right = this.sum(), pred = COMPARE.get(c.v);
    return pred === 'Ne' ? {type: 'not', a: {type: 'atom', pred: 'Eq', args: [left, right]}} : {type: 'atom', pred, args: [left, right]};
  }
  // Terms with infix arithmetic: sum := product (+|- product)*, product := factor (*|/ factor)*.
  sum() {
    let a = this.product();
    while (this.peek()?.t === 'arith' && ['+', '-'].includes(this.peek().v)) { const o = this.next().v; a = {fn: ARITH.get(o), args: [a, this.product()]}; }
    return a;
  }
  product() {
    let a = this.factor();
    while (this.peek()?.t === 'arith' && ['*', '/'].includes(this.peek().v)) { const o = this.next().v; a = {fn: ARITH.get(o), args: [a, this.factor()]}; }
    return a;
  }
  factor() {
    const p = this.next();
    if (p?.t === 'num') return {num: p.v};
    if (p?.t === 'arith' && p.v === '-') { const f = this.factor(); return 'num' in f ? {num: -f.num} : {fn: 'sub', args: [{num: 0}, f]}; }
    if (p?.t === 'lp') { const a = this.sum(); this.expect('rp'); return a; }
    if (p?.t !== 'name') throw new Error(`expected a term at token ${this.i}`);
    if (!p.quoted && this.peek()?.t === 'lp') { this.i++; const args = this.peek()?.t === 'rp' ? [] : this.terms(); this.expect('rp'); return {fn: p.v, args}; }
    return p.quoted ? {name: p.v, quoted: true} : {name: p.v};
  }
  terms() { const out = [this.sum()]; while (this.peek()?.t === 'comma') { this.i++; out.push(this.sum()); } return out; }
}

/** Names bound by quantifiers become {var}; the others {const}; free one-letter lowercase names become {var} and are reported. */
function bind(node, bound, free) {
  const term = t => {
    if (t.fn) return {fn: t.fn, args: t.args.map(term)};
    if ('num' in t) return t;
    if (t.quoted) return {const: t.name};
    if (bound.has(t.name)) return {var: t.name};
    if (/^[a-z]$/.test(t.name)) { free.add(t.name); return {var: t.name}; }
    return {const: t.name};
  };
  switch (node.type) {
    case 'atom': return {...node, args: node.args.map(term)};
    case 'not': return {type: 'not', a: bind(node.a, bound, free)};
    case 'forall': case 'exists': return {type: node.type, v: node.v, a: bind(node.a, new Set([...bound, node.v]), free)};
    default: return {type: node.type, a: bind(node.a, bound, free), b: bind(node.b, bound, free)};
  }
}

/**
 * The line forms of fol-v3 (reserved, exact, structural; the converter gives them their meaning, ./to-ir.mjs):
 *   SUPPOSE id: φ      an option of an argument question (a speaker's claim, an answer choice, a rival story, a rule the text
 *                      does not contain): never in force by itself; `id` is the option's label (letters, digits, underscores)
 *   ASSUME φ           something the formalizer adds that the text does not state (a reading, a background fact or rule)
 *   Effect(φ)  Explain(φ)  Missing(φ)  Why(φ)  Change(φ)   a question about the support of the ground claim φ
 *   Assumed            a question about the formalizer's own assumptions
 * AST: {type: 'suppose', id, a} | {type: 'assume', a} | {type: 'meta', kind: 'effect'|'explain'|'missing'|'why'|'change'|'assumed', a}.
 */
export const META = Object.freeze({Effect: 'effect', Explain: 'explain', Missing: 'missing', Why: 'why', Change: 'change'});

/** The parenthesis that opens at `i` closes at the end of `s`. */
function enclosesRest(s, i) {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '(') d++;
    if (s[j] === ')' && --d === 0) return j === s.length - 1;
  }
  return false;
}

export function parseFol(text) {
  const s = String(text ?? '').trim().replace(/\.$/, '').trim();
  let m;
  if ((m = /^SUPPOSE\s+\(?([A-Za-z0-9_]+)\)?\s*:\s*([\s\S]+)$/.exec(s))) {
    const p = parseFol(m[2]);
    if (p.ok && ['suppose', 'assume', 'meta'].includes(p.ast.type)) return {ok: false, why: 'SUPPOSE takes a formula, not another line form'};
    return p.ok ? {...p, ast: {type: 'suppose', id: m[1], a: p.ast}} : p;
  }
  if ((m = /^ASSUME\s+([\s\S]+)$/.exec(s))) {
    const p = parseFol(m[1]);
    if (p.ok && ['suppose', 'assume', 'meta'].includes(p.ast.type)) return {ok: false, why: 'ASSUME takes a formula, not another line form'};
    return p.ok ? {...p, ast: {type: 'assume', a: p.ast}} : p;
  }
  if (/^Assumed\s*(?:\(\s*\))?$/.test(s)) return {ok: true, ast: {type: 'meta', kind: 'assumed', a: null}, free: [], repaired: false};
  // Effect(φ) is a question form only when φ is a formula whose predicates are CamelCase names; otherwise (Effect(drug, sleep),
  // Why(x)) it is an ordinary atom of that name.
  if ((m = /^(Effect|Explain|Missing|Why|Change)\s*\(/.exec(s)) && enclosesRest(s, m[0].length - 1)) {
    const p = parsePlain(s.slice(m[0].length, -1));
    if (p.ok && predicatesOf(p.ast).every(x => /^[A-Z]/.test(x))) return {...p, ast: {type: 'meta', kind: META[m[1]], a: p.ast}};
  }
  return parsePlain(s);
}

const predicatesOf = n => (n.type === 'atom' ? [n.pred] : [n.a, n.b].filter(Boolean).flatMap(predicatesOf));

function parsePlain(text) {
  let tokens;
  try { tokens = joinQuantifiers(tokenize(text)); } catch (error) { return {ok: false, why: error.message}; }
  if (!tokens.length) return {ok: false, why: 'empty'};
  // One repair, structural only: unmatched closing parentheses at the end are dropped, missing ones at the end are added.
  let depth = 0, repaired = false;
  const kept = [];
  for (const t of tokens) { if (t.t === 'lp') depth++; if (t.t === 'rp') { if (depth === 0) { repaired = true; continue; } depth--; } kept.push(t); }
  while (depth-- > 0) { kept.push({t: 'rp'}); repaired = true; }
  const p = new Parser(kept);
  try {
    const raw = p.iff();
    if (p.i < kept.length) return {ok: false, why: `unexpected text after the formula at token ${p.i}`};
    const free = new Set();
    let ast = bind(raw, new Set(), free);
    for (const v of [...free].reverse()) ast = {type: 'forall', v, a: ast, implicit: true};
    return {ok: true, ast, free: [...free], repaired};
  } catch (error) { return {ok: false, why: error.message}; }
}

/** The AST back as text (for reports and tests). */
export function showFol(n) {
  const t = x => (x.fn ? `${x.fn}(${x.args.map(t).join(', ')})` : 'num' in x ? String(x.num) : x.var ?? x.const);
  switch (n.type) {
    case 'atom': return n.args.length ? `${n.pred}(${n.args.map(t).join(', ')})` : n.pred;
    case 'not': return `NOT ${showFol(n.a)}`;
    case 'forall': case 'exists': return `${n.type.toUpperCase()}${n.v} (${showFol(n.a)})`;
    case 'suppose': return `SUPPOSE ${n.id}: ${showFol(n.a)}`;
    case 'assume': return `ASSUME ${showFol(n.a)}`;
    case 'meta': return n.kind === 'assumed' ? 'Assumed' : `${Object.keys(META).find(k => META[k] === n.kind)}(${showFol(n.a)})`;
    default: return `(${showFol(n.a)} ${n.type.toUpperCase()} ${showFol(n.b)})`;
  }
}
