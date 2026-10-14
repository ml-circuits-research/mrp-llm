// VENDORED: copied verbatim from sop_reasoner_e10.zip (sop-verified-reasoner 0.3.0) src/terms.mjs
/** Function-free, typed terms. Strings, booleans and safe integers only. */
export const variable = t => typeof t === 'object' && t !== null && typeof t.var === 'string';
export const vars = terms => terms.filter(variable).map(t => t.var);
export const term = token => {
  if (token.startsWith('?')) {
    if (!/^\?[A-Za-z_][\w]*$/.test(token)) throw new SyntaxError(`Invalid variable: ${token}`);
    return {var: token.slice(1)};
  }
  if (token.startsWith('"')) return JSON.parse(token);
  if (token === 'true' || token === 'false') return token === 'true';
  if (/^-?\d+$/.test(token)) {
    const n = Number(token); if (!Number.isSafeInteger(n)) throw new RangeError('Integer outside safe range');
    return n;
  }
  if (!/^[A-Za-z_][\w.:/\-]*$/.test(token)) throw new SyntaxError(`Invalid constant: ${token}`);
  return token;
};
export const showTerm = t => variable(t) ? `?${t.var}` : JSON.stringify(t);
export const key = tuple => JSON.stringify(tuple);
export const same = (a,b) => Object.is(a,b) || a === b;
export function testValues(op,a,b) {
  if(op === '==') return same(a,b);
  if(op === '!=') return !same(a,b);
  if(typeof a !== 'number' || typeof b !== 'number') throw new TypeError('Ordered TEST requires integer operands');
  switch(op) {case '<':return a<b; case '<=':return a<=b; case '>':return a>b; case '>=':return a>=b;}
  throw new SyntaxError(`Unknown comparison ${op}`);
}
