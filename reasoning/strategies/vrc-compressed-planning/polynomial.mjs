/**
 * From the AST of `sop/knowledge/numeric-action.mjs` to the exact polynomials of the vendored VRC kernel.
 * Nothing here evaluates JavaScript: a polynomial is data (rational coefficients, BigInt).
 */
import {Poly} from './vendor/vrc/poly.mjs';
import {Rat} from './vendor/vrc/rational.mjs';
import {constantValue} from '../../../sop/knowledge/numeric-action.mjs';

/** The VRC comparator of a numeric word; a guard or goal reads `poly OP 0` with poly = left - right. */
export const OPERATOR = {above: '>', below: '<', at_least: '>=', at_most: '<=', equal: '=='};

export function astToPoly(ast, names) {
  const n = names.length;
  const go = a => {
    switch (a.t) {
      case 'num': return Poly.constant(n, a.text);
      case 'var': {
        const i = names.indexOf(a.name);
        if (i < 0) throw new RangeError(`unknown state variable ?${a.name}`);
        return Poly.variable(n, i);
      }
      case 'neg': return go(a.a).scale(-1);
      case 'add': return go(a.a).add(go(a.b));
      case 'sub': return go(a.a).sub(go(a.b));
      case 'mul': return go(a.a).mul(go(a.b));
      case 'pow': return go(a.a).pow(Number(a.b.text));
      case 'div': { const c = constantValue(a.b); return go(a.a).scale(new Rat(c.d, c.n)); }
      default: throw new TypeError(`unknown expression node ${a.t}`);
    }
  };
  return go(ast);
}

export const guardPoly = (g, names) => ({op: OPERATOR[g.word], poly: astToPoly(g.left, names).sub(astToPoly(g.right, names))});
