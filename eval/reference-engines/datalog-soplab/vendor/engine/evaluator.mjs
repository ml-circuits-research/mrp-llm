// VENDORED: copied verbatim from soplab-v0.4.0.zip src/engine/evaluator.mjs
import { bindingSignature, cloneBindings, substituteAtom } from '../model.mjs';
import { unifyAtoms } from '../unify.mjs';
import { all, isRef, normalizeCondition } from '../conditions.mjs';

export function* solveCondition(reasoner, expr, seed = {}, evidence = [], context = {}) {
  const node = normalizeCondition(expr);
  if (!node) return;
  const metrics = context.metrics;

  if (node.pred) {
    metrics?.inc('atomEvaluations');
    const pattern = substituteAtom(node, seed);
    const allowedKeys = context.deltaNode === node ? context.deltaKeys : null;
    for (const rec of reasoner.store.recordsForPattern(pattern, { metrics, allowedKeys })) {
      metrics?.inc('unifications');
      const next = unifyAtoms(pattern, rec.atom, seed);
      if (next) {
        metrics?.inc('matchedRows');
        yield { bindings: next, evidence: [...evidence, rec.key] };
      }
    }
    return;
  }

  if (node.builtin) {
    const result = reasoner.builtins.evaluate(node, seed, context);
    if (result?.pass) yield { bindings: result.bindings ?? seed, evidence };
    return;
  }

  if (node.provider) {
    for (const row of reasoner.providers.evaluate(node, seed, context)) {
      yield { bindings: row.bindings, evidence: [...evidence, ...(row.evidence ?? [])] };
    }
    return;
  }

  if (isRef(node)) {
    metrics?.inc('wireCalls');
    const def = reasoner.wires.get(node.ref);
    if (!def) throw new Error(`Unknown wire: $${node.ref}`);
    const callStack = context.callStack ?? [];
    if (callStack.includes(def.id)) throw new Error(`Recursive view wire detected: ${[...callStack, def.id].join(' -> ')}`);
    const handler = reasoner.wireTypes.get(def.wireType);
    if (!handler) throw new Error(`No evaluator registered for wire type: ${def.wireType}`);
    const nextContext = { ...context, callStack: [...callStack, def.id] };
    const solve = (subExpr, subSeed = seed, subEvidence = evidence, subContext = nextContext) =>
      solveCondition(reasoner, subExpr, subSeed, subEvidence, subContext);
    yield* handler({ reasoner, def, args: node.args, seed, evidence, context: nextContext, solve });
    return;
  }

  if (node.op === 'none') {
    metrics?.inc('noneChecks');
    const first = solveCondition(reasoner, node.item, cloneBindings(seed), evidence, context).next();
    if (first.done) yield { bindings: cloneBindings(seed), evidence };
    return;
  }

  if (node.op === 'any') {
    const seen = new Set();
    for (const item of node.items ?? []) {
      metrics?.inc('orBranches');
      for (const sol of solveCondition(reasoner, item, cloneBindings(seed), evidence, context)) {
        const sig = `${bindingSignature(sol.bindings)}|${JSON.stringify(sol.evidence)}`;
        if (!seen.has(sig)) { seen.add(sig); yield sol; }
      }
    }
    return;
  }

  if (node.op === 'all') {
    const items = node.items ?? [];
    const walk = function* (i, bindings, ev) {
      if (i >= items.length) { yield { bindings, evidence: ev }; return; }
      for (const sol of solveCondition(reasoner, items[i], bindings, ev, context)) {
        yield* walk(i + 1, sol.bindings, sol.evidence);
      }
    };
    yield* walk(0, cloneBindings(seed), evidence);
    return;
  }

  throw new Error(`Unknown condition node: ${JSON.stringify(node)}`);
}

export function* solveBody(reasoner, body, seed = {}, evidence = [], context = {}) {
  yield* solveCondition(reasoner, Array.isArray(body) ? all(...body) : body, seed, evidence, context);
}
