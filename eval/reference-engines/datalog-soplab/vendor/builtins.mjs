// VENDORED: copied verbatim from soplab-v0.4.0.zip src/builtins.mjs
import { isVar, substituteTerm } from './model.mjs';
import { unifyTerms } from './unify.mjs';

export class BuiltinRegistry {
  constructor({ installDefaults = true } = {}) {
    this.map = new Map();
    if (installDefaults) this.installDefaults();
  }

  register(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('Builtin must be a function');
    this.map.set(String(name), fn);
    return this;
  }

  evaluate(literal, bindings, context = {}) {
    const fn = this.map.get(literal.builtin);
    if (!fn) throw new Error(`Unknown builtin: ${literal.builtin}`);
    context.metrics?.inc('builtinCalls');
    return fn(literal.args, bindings, context);
  }

  installDefaults() {
    const get = (x, b) => substituteTerm(x, b);
    const bound = (x) => !isVar(x);
    const allBound = (xs) => xs.every(bound);

    this.register('eq', (args, b) => {
      const next = unifyTerms(args[0], args[1], b);
      return next ? { pass: true, bindings: next } : { pass: false };
    });
    this.register('neq', (args, b) => {
      const xs = args.map((x) => get(x, b));
      return { pass: allBound(xs) && !Object.is(xs[0], xs[1]) };
    });
    for (const [name, op] of [
      ['lt', (a, c) => a < c], ['lte', (a, c) => a <= c],
      ['gt', (a, c) => a > c], ['gte', (a, c) => a >= c],
    ]) this.register(name, (args, b) => {
      const xs = args.map((x) => get(x, b));
      return { pass: allBound(xs) && op(xs[0], xs[1]) };
    });

    this.register('includes', (args, b) => {
      const xs = args.map((x) => get(x, b));
      return { pass: allBound(xs) && xs[0]?.includes?.(xs[1]) === true };
    });
    this.register('startsWith', (args, b) => {
      const xs = args.map((x) => get(x, b));
      return { pass: allBound(xs) && String(xs[0]).startsWith(String(xs[1])) };
    });
    this.register('matches', (args, b) => {
      const xs = args.map((x) => get(x, b));
      if (!allBound(xs)) return { pass: false };
      return { pass: new RegExp(String(xs[1])).test(String(xs[0])) };
    });
  }
}
