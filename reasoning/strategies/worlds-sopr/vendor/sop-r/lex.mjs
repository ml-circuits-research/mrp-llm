// VENDORED: copied verbatim from sop-r.zip src/ lex.mjs
// Lexer and token helpers for SOP-R.
//
// Token values:  number | string (atom, lower-cased; "?var", "$ref", "@name" are atoms too) | Quoted
// A Quoted is a "quoted string literal": never lower-cased, never a variable.

export class Quoted {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

export const NUM = /^-?\d+(\.\d+)?$/;
const LEX = /"([^"]*)"|(\S+)/g;

export class SopError extends Error {}

// Python-compatible number normalisation: round to 6 decimals, integral floats become ints.
export function norm(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return v;
    if (!Number.isInteger(v)) {
      const r = Math.round(v * 1e6) / 1e6;
      return Object.is(r, -0) ? 0 : r;
    }
  }
  return v;
}

export function lex(line) {
  const out = [];
  LEX.lastIndex = 0;
  let m;
  while ((m = LEX.exec(line)) !== null) {
    if (m[1] !== undefined) { out.push(new Quoted(m[1])); continue; }
    const t = m[2];
    if (t.startsWith('#')) break;
    if (NUM.test(t)) out.push(t.includes('.') ? norm(parseFloat(t)) : parseInt(t, 10));
    else out.push(t.toLowerCase());
  }
  return out;
}

export const isAtom = (t) => typeof t === 'string';
export const isVar = (t) => typeof t === 'string' && t.startsWith('?');
export const isRef = (t) => typeof t === 'string' && t.startsWith('$');
export const isQuoted = (t) => t instanceof Quoted;

// Python str() of a value
export function pyStr(v) {
  if (v instanceof Quoted) return v.s;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return pyNum(v);
  return String(v);
}

export function pyNum(v) {
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return String(v);
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : v < 0 ? '-inf' : 'nan';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e16)) {
    const [mant, exp] = v.toExponential().split('e');
    const n = parseInt(exp, 10);
    return mant + 'e' + (n < 0 ? '-' : '+') + String(Math.abs(n)).padStart(2, '0');
  }
  return String(v);
}

// Python fmt(): quoted strings keep their quotes
export const fmtTok = (v) => (v instanceof Quoted ? `"${v.s}"` : pyStr(v));
export const fmtToks = (ts) => ts.map(fmtTok).join(' ');

// value used for equality (Python: Q("x") == "x")
export const tokVal = (t) => (t instanceof Quoted ? t.s : t);
export const tokEq = (a, b) => tokVal(a) === tokVal(b);
export const tokKey = (t) => {
  const v = tokVal(t);
  return typeof v === 'number' ? 'n' + v : typeof v === 'boolean' ? 'b' + v : 's' + v;
};

// compare two strings by code point (Python ordering)
export function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
