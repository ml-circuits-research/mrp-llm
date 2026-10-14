// VENDORED: copied verbatim from soplab-v0.4.0.zip src/providers.mjs
import { substituteTerm, isVar } from './model.mjs';
import { unifyTerms } from './unify.mjs';

export class ProviderRegistry {
  constructor({ installDefaults = true } = {}) {
    this.map = new Map();
    if (installDefaults) this.installDefaults();
  }

  register(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('Provider must be a function or generator function');
    this.map.set(String(name), fn);
    return this;
  }

  *evaluate(node, bindings, context = {}) {
    const fn = this.map.get(node.provider);
    if (!fn) throw new Error(`Unknown binding provider: ${node.provider}`);
    context.metrics?.inc('providerCalls');
    const result = fn(node.args, bindings, context);
    if (!result) return;
    if (typeof result[Symbol.iterator] === 'function') {
      for (const row of result) if (row) yield normalizeProviderRow(row, bindings);
    } else {
      yield normalizeProviderRow(result, bindings);
    }
  }

  installDefaults() {
    this.register('range', function* (args, bindings) {
      if (args.length !== 3) throw new Error('CALL range expects: from to output');
      const from = substituteTerm(args[0], bindings);
      const to = substituteTerm(args[1], bindings);
      if (isVar(from) || isVar(to)) return;
      const step = from <= to ? 1 : -1;
      for (let n = Number(from); step > 0 ? n <= Number(to) : n >= Number(to); n += step) {
        const next = unifyTerms(args[2], n, bindings);
        if (next) yield { bindings: next, evidence: [{ kind: 'provider', provider: 'range', value: n }] };
      }
    });

    this.register('member', function* (args, bindings) {
      if (args.length !== 2) throw new Error('CALL member expects: collection output');
      const collection = substituteTerm(args[0], bindings);
      if (!Array.isArray(collection)) return;
      for (const value of collection) {
        const next = unifyTerms(args[1], value, bindings);
        if (next) yield { bindings: next, evidence: [{ kind: 'provider', provider: 'member', value }] };
      }
    });
  }
}

function normalizeProviderRow(row, fallbackBindings) {
  if (row.bindings) return { bindings: row.bindings, evidence: row.evidence ?? [] };
  return { bindings: row ?? fallbackBindings, evidence: [] };
}
