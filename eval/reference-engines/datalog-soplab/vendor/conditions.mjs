// VENDORED: copied verbatim from soplab-v0.4.0.zip src/conditions.mjs
import { builtin, provider, isVar, substituteTerm } from './model.mjs';

let callNonce = 0;

export function ref(name, ...args) { return { kind: 'ref', ref: String(name).replace(/^\$/, ''), args }; }
export function all(...items) { return { kind: 'logic', op: 'all', items: items.flat() }; }
export function any(...items) { return { kind: 'logic', op: 'any', items: items.flat() }; }
export function none(item) { return { kind: 'logic', op: 'none', item }; }
export function call(name, ...args) { return provider(name, ...args); }

export function condition(id, mode, params = [], items = [], meta = {}) {
  if (!['all', 'any'].includes(mode)) throw new Error(`Condition @${id} must be all or any`);
  return { kind: 'wire', wireType: mode, id: String(id), params: [...params], items: [...items], meta: { ...meta } };
}

export function reduction(id, { params = [], source, groupBy = [], aggregates = [], meta = {} } = {}) {
  return { kind: 'wire', wireType: 'reduce', id: String(id), params: [...params], source, groupBy: [...groupBy], aggregates: aggregates.map((x) => ({ ...x })), meta: { ...meta } };
}

export function isRef(x) { return !!x && typeof x === 'object' && typeof x.ref === 'string' && Array.isArray(x.args); }
export function normalizeCondition(x) { return Array.isArray(x) ? all(...x) : x; }

function collectVarsTerm(term, out) {
  if (isVar(term)) out.add(term);
  else if (Array.isArray(term)) term.forEach((x) => collectVarsTerm(x, out));
  else if (term && typeof term === 'object') Object.values(term).forEach((x) => collectVarsTerm(x, out));
}

export function collectVars(expr, out = new Set()) {
  if (!expr) return out;
  if (Array.isArray(expr)) { expr.forEach((x) => collectVars(x, out)); return out; }
  if (expr.pred || expr.builtin || expr.provider || expr.ref) {
    for (const a of expr.args ?? []) collectVarsTerm(a, out);
    return out;
  }
  if (expr.op === 'none') return collectVars(expr.item, out);
  if (expr.op === 'all' || expr.op === 'any') (expr.items ?? []).forEach((x) => collectVars(x, out));
  return out;
}

function renameTerm(term, mapping) {
  if (isVar(term) && mapping.has(term)) return mapping.get(term);
  if (Array.isArray(term)) return term.map((x) => renameTerm(x, mapping));
  if (term && typeof term === 'object') return Object.fromEntries(Object.entries(term).map(([k, v]) => [k, renameTerm(v, mapping)]));
  return term;
}

export function rewriteExpr(expr, mapping) {
  if (Array.isArray(expr)) return expr.map((x) => rewriteExpr(x, mapping));
  if (!expr || typeof expr !== 'object') return expr;
  if (expr.pred) return { ...expr, args: expr.args.map((x) => renameTerm(x, mapping)) };
  if (expr.builtin) return builtin(expr.builtin, ...expr.args.map((x) => renameTerm(x, mapping)));
  if (expr.provider) return provider(expr.provider, ...expr.args.map((x) => renameTerm(x, mapping)));
  if (expr.ref) return { ...expr, args: expr.args.map((x) => renameTerm(x, mapping)) };
  if (expr.op === 'none') return none(rewriteExpr(expr.item, mapping));
  if (expr.op === 'all' || expr.op === 'any') return { ...expr, items: expr.items.map((x) => rewriteExpr(x, mapping)) };
  return expr;
}

export function instantiateWire(def, args) {
  if (args.length !== def.params.length) throw new Error(`Wire $${def.id} expects ${def.params.length} arguments, got ${args.length}`);
  const nonce = ++callNonce;
  const mapping = new Map();
  def.params.forEach((p, i) => mapping.set(p, args[i]));
  const expressions = def.wireType === 'reduce' ? [def.source] : def.items;
  const vars = collectVars(expressions);
  for (const v of vars) if (!mapping.has(v)) mapping.set(v, `?__${def.id}_${nonce}_${v.slice(1)}`);
  const localPrefix = `?__${def.id}_${nonce}_`;
  if (def.wireType === 'reduce') {
    return {
      localPrefix, mapping,
      source: rewriteExpr(def.source, mapping),
      groupBy: def.groupBy.map((x) => renameTerm(x, mapping)),
      aggregates: def.aggregates.map((a) => ({
        ...a,
        field: a.field == null ? null : renameTerm(a.field, mapping),
        as: renameTerm(a.as, mapping),
      })),
      params: def.params.map((p) => renameTerm(p, mapping)),
    };
  }
  return {
    localPrefix, mapping,
    expr: { kind: 'logic', op: def.wireType, items: def.items.map((x) => rewriteExpr(x, mapping)) },
  };
}

export function stripLocalBindings(bindings, prefix) {
  return Object.fromEntries(Object.entries(bindings)
    .filter(([k]) => !k.startsWith(prefix))
    .map(([k, v]) => [k, substituteTerm(v, bindings)]));
}
