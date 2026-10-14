// VENDORED: copied from vrc03r.zip src/exact-runtime.mjs; only its two imports point at ./vrc/
/** Rational arithmetic DAG. Same polynomial identities as VRC, no float conversion. */
import {Rat, ZERO, ONE} from './vrc/rational.mjs';
import {Poly, parseKey} from './vrc/poly.mjs';

export function exactRelation(op, value) {
  const n = Rat.of(value).n;
  switch (op) {
    case '>=': return n >= 0n;
    case '<=': return n <= 0n;
    case '>': return n > 0n;
    case '<': return n < 0n;
    case '==': return n === 0n;
    default: throw new TypeError(`Unsupported comparator: ${op}`);
  }
}

export function compileExactPolynomials(polynomials) {
  if (!polynomials.length) throw new TypeError('Nonempty polynomial list required');
  const dimension = polynomials[0].n;
  const nodes = [], memo = new Map();
  function put(key, node) {
    if (memo.has(key)) return memo.get(key);
    const id = nodes.length; nodes.push(node); memo.set(key, id); return id;
  }
  const constant = value => put(`c:${value}`, {op: 'const', value: Rat.of(value)});
  const variable = index => put(`v:${index}`, {op: 'var', index});
  function binary(op, a, b) {
    const av = nodes[a].op === 'const' ? nodes[a].value : null;
    const bv = nodes[b].op === 'const' ? nodes[b].value : null;
    if (op === 'add') {
      if (av?.zero) return b;
      if (bv?.zero) return a;
    } else {
      if (av?.zero || bv?.zero) return constant(ZERO);
      if (av?.eq(ONE)) return b;
      if (bv?.eq(ONE)) return a;
    }
    if (a > b) [a, b] = [b, a];
    return put(`${op}:${a}:${b}`, {op, a, b});
  }
  function power(index, k) {
    if (k === 0) return constant(ONE);
    if (k === 1) return variable(index);
    const half = power(index, Math.floor(k / 2));
    const even = binary('mul', half, half);
    return k % 2 ? binary('mul', even, variable(index)) : even;
  }
  function horner(p) {
    const key = `p:${p.key()}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (p.zero) result = constant(ZERO);
    else if (p.constant) result = constant(p.t.values().next().value);
    else {
      let best = p.variables()[0], score = -1;
      for (const index of p.variables()) {
        let s = 0; for (const k of p.t.keys()) s += parseKey(k)[index];
        if (s > score) { best = index; score = s; }
      }
      const groups = new Map();
      for (const [key, c] of p.t) {
        const e = parseKey(key), d = e[best]; e[best] = 0;
        if (!groups.has(d)) groups.set(d, []);
        groups.get(d).push([e, c]);
      }
      const degrees = [...groups.keys()].sort((a, b) => b - a);
      result = horner(new Poly(dimension, groups.get(degrees[0])));
      for (let i = 1; i < degrees.length; i++) {
        result = binary('add', binary('mul', result, power(best, degrees[i-1] - degrees[i])),
          horner(new Poly(dimension, groups.get(degrees[i]))));
      }
      if (degrees.at(-1)) result = binary('mul', result, power(best, degrees.at(-1)));
    }
    memo.set(key, result); return result;
  }
  const outputs = polynomials.map(p => {
    if (p.n !== dimension) throw new TypeError('Polynomial interface mismatch');
    return horner(p);
  });
  return Object.freeze({
    operations: nodes.filter(n => n.op === 'add' || n.op === 'mul').length,
    evaluate(state) {
      if (state.length !== dimension) throw new TypeError('State dimension mismatch');
      const values = new Array(nodes.length);
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        values[i] = n.op === 'const' ? n.value : n.op === 'var' ? Rat.of(state[n.index]) :
          n.op === 'add' ? values[n.a].add(values[n.b]) : values[n.a].mul(values[n.b]);
      }
      return outputs.map(i => values[i]);
    }
  });
}
