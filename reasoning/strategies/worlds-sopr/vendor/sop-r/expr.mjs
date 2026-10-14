// VENDORED: copied verbatim from sop-r.zip src/ expr.mjs
// Expressions for let / test / require-test, with the semantics of the reference implementation
// (Python): + - * / ( ), chained comparisons = != < <= > >=, and / or returning operands,
// type errors and division by zero make the whole expression "no value" (undefined).
import { Quoted, isVar, norm } from './lex.mjs';

export const OPS = new Set(['+', '-', '*', '/', '(', ')', '<', '<=', '>', '>=', '=', '!=', 'and', 'or']);
const CMP = new Set(['<', '<=', '>', '>=', '=', '!=']);

class Fail extends Error {}
const fail = () => { throw new Fail(); };

// tokens -> AST, or null when the expression is syntactically invalid
export function parseExpr(toks) {
  let i = 0;
  const peek = () => toks[i];
  const isOp = (t, op) => typeof t === 'string' && t === op && OPS.has(t);
  const operand = () => {
    const t = toks[i];
    if (t === undefined) fail();
    if (isOp(t, '(')) { i++; const e = orE(); if (!isOp(toks[i], ')')) fail(); i++; return e; }
    if (typeof t === 'string' && OPS.has(t)) fail();
    i++;
    if (isVar(t)) return { v: t };
    return { c: t instanceof Quoted ? t.s : t };
  };
  const factor = () => {
    const t = peek();
    if (isOp(t, '-') || isOp(t, '+')) { i++; return { u: t, a: factor() }; }
    return operand();
  };
  const term = () => { let a = factor(); while (isOp(peek(), '*') || isOp(peek(), '/')) { const op = toks[i++]; a = { op, a, b: factor() }; } return a; };
  const arith = () => { let a = term(); while (isOp(peek(), '+') || isOp(peek(), '-')) { const op = toks[i++]; a = { op, a, b: term() }; } return a; };
  const cmp = () => {
    const first = arith();
    const ops = [], args = [first];
    while (typeof peek() === 'string' && CMP.has(peek())) { ops.push(toks[i++]); args.push(arith()); }
    return ops.length ? { cmp: ops, args } : first;
  };
  const andE = () => { let a = cmp(); while (isOp(peek(), 'and')) { i++; a = { and: [a, cmp()] }; } return a; };
  const orE = () => { let a = andE(); while (isOp(peek(), 'or')) { i++; a = { or: [a, andE()] }; } return a; };
  try {
    if (!toks.length) return null;
    const e = orE();
    if (i !== toks.length) return null;
    return e;
  } catch (e) { if (e instanceof Fail) return null; throw e; }
}

export function exprVars(toks) { return toks.filter(isVar); }

const truthy = (v) => !(v === false || v === 0 || v === '' || v === null || v === undefined);
const num = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
const isNum = (v) => typeof v === 'number' || typeof v === 'boolean';

function eq(a, b) {
  if (isNum(a) && isNum(b)) return num(a) === num(b);
  return a === b;
}
function compare(op, a, b) {
  if (op === '=') return eq(a, b);
  if (op === '!=') return !eq(a, b);
  let x, y;
  if (isNum(a) && isNum(b)) { x = num(a); y = num(b); }
  else if (typeof a === 'string' && typeof b === 'string') { x = a; y = b; }
  else fail();
  switch (op) { case '<': return x < y; case '<=': return x <= y; case '>': return x > y; default: return x >= y; }
}
function arith(op, a, b) {
  if (op === '+') {
    if (isNum(a) && isNum(b)) return num(a) + num(b);
    if (typeof a === 'string' && typeof b === 'string') return a + b;
    fail();
  }
  if (op === '*') {
    if (isNum(a) && isNum(b)) return num(a) * num(b);
    if (typeof a === 'string' && Number.isInteger(num(b))) return a.repeat(Math.max(0, num(b)));
    if (typeof b === 'string' && Number.isInteger(num(a))) return b.repeat(Math.max(0, num(a)));
    fail();
  }
  if (!isNum(a) || !isNum(b)) fail();
  if (op === '-') return num(a) - num(b);
  if (num(b) === 0) fail();
  return num(a) / num(b);
}

function ev(e, get) {
  if ('c' in e) return e.c;
  if ('v' in e) return get(e.v);
  if ('u' in e) { const a = ev(e.a, get); if (!isNum(a)) fail(); return e.u === '-' ? -num(a) : num(a); }
  if ('op' in e) return arith(e.op, ev(e.a, get), ev(e.b, get));
  if ('and' in e) { const a = ev(e.and[0], get); return truthy(a) ? ev(e.and[1], get) : a; }
  if ('or' in e) { const a = ev(e.or[0], get); return truthy(a) ? a : ev(e.or[1], get); }
  // chained comparison
  let left = ev(e.args[0], get);
  for (let k = 0; k < e.cmp.length; k++) {
    const right = ev(e.args[k + 1], get);
    if (!compare(e.cmp[k], left, right)) return false;
    left = right;
  }
  return true;
}

// get(varName) returns the JS value of a bound variable or undefined when unbound.
// Any unbound variable, type error or division by zero -> undefined.
export function evalExpr(ast, vars, get) {
  for (const v of vars) if (get(v) === undefined) return undefined;
  if (ast === null) return undefined;
  try {
    const r = ev(ast, get);
    if (typeof r === 'number' && !Number.isFinite(r)) return undefined;
    return norm(r);
  } catch (e) { if (e instanceof Fail) return undefined; throw e; }
}
