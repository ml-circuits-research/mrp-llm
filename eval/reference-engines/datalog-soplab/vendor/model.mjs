// VENDORED: copied verbatim from soplab-v0.4.0.zip src/model.mjs
export const isVar = (x) => typeof x === 'string' && x.startsWith('?');

export function atom(pred, ...args) {
  return { kind: 'atom', pred: String(pred), args, sign: 1 };
}

export function not(pred, ...args) {
  return { kind: 'atom', pred: String(pred), args, sign: -1 };
}

export function neg(a) {
  const n = normalizeAtom(a);
  return { ...n, sign: n.sign * -1 };
}

export function builtin(name, ...args) {
  return { kind: 'builtin', builtin: String(name), args };
}

export function provider(name, ...args) {
  return { kind: 'provider', provider: String(name), args };
}

export function rule(id, head, body = [], meta = {}) {
  return { kind: 'rule', id: String(id), head: normalizeAtom(head), body, meta: { ...meta } };
}

export function transition(id, { when = [], add = [], remove = [], cost = 1, meta = {} } = {}) {
  return {
    kind: 'transition',
    id: String(id),
    when,
    add: add.map(normalizeAtom),
    remove: remove.map(normalizeAtom),
    cost,
    meta: { ...meta },
  };
}

export function assumption(id, value, { cost = 1, meta = {} } = {}) {
  return { kind: 'assumption', id: String(id), atom: normalizeAtom(value), cost: Number(cost), meta: { ...meta } };
}

export function normalizeAtom(a) {
  if (!a || typeof a !== 'object' || !a.pred || !Array.isArray(a.args)) {
    throw new TypeError(`Invalid atom: ${JSON.stringify(a)}`);
  }
  return { kind: 'atom', pred: String(a.pred), args: a.args, sign: a.sign === -1 ? -1 : 1 };
}

export function cloneBindings(bindings = {}) {
  return Object.assign(Object.create(null), bindings);
}

export function substituteTerm(term, bindings) {
  if (isVar(term)) {
    let value = term;
    const seen = new Set();
    while (isVar(value) && Object.prototype.hasOwnProperty.call(bindings, value)) {
      if (seen.has(value)) break;
      seen.add(value);
      value = bindings[value];
    }
    return value;
  }
  if (Array.isArray(term)) return term.map((x) => substituteTerm(x, bindings));
  if (term && typeof term === 'object') {
    return Object.fromEntries(Object.entries(term).map(([k, v]) => [k, substituteTerm(v, bindings)]));
  }
  return term;
}

export function substituteAtom(a, bindings) {
  const n = normalizeAtom(a);
  return { ...n, args: n.args.map((x) => substituteTerm(x, bindings)) };
}

export function isGroundTerm(term) {
  if (isVar(term)) return false;
  if (Array.isArray(term)) return term.every(isGroundTerm);
  if (term && typeof term === 'object') return Object.values(term).every(isGroundTerm);
  return true;
}

export function isGroundAtom(a) {
  return normalizeAtom(a).args.every(isGroundTerm);
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function stableTerm(term) {
  if (typeof term === 'string') return `s:${JSON.stringify(term)}`;
  if (typeof term === 'number') return `n:${term}`;
  if (typeof term === 'boolean') return `b:${term}`;
  if (term === null) return 'null';
  return `j:${stableStringify(term)}`;
}

export function atomKey(a) {
  const n = normalizeAtom(a);
  const sign = n.sign === -1 ? '-' : '+';
  return `${sign}${n.pred}/${n.args.length}(${n.args.map(stableTerm).join(',')})`;
}

export function unsignedAtomKey(a) {
  const n = normalizeAtom(a);
  return `${n.pred}/${n.args.length}(${n.args.map(stableTerm).join(',')})`;
}

export function relationKey(a) {
  const n = normalizeAtom(a);
  return `${n.sign}:${n.pred}/${n.args.length}`;
}

export function formatTerm(x) {
  if (typeof x === 'string') {
    if (isVar(x)) return x;
    if (/^[A-Za-z_][\w./:+-]*$/.test(x)) return x;
    return JSON.stringify(x);
  }
  return stableStringify(x);
}

export function formatAtomCNL(a) {
  const n = normalizeAtom(a);
  const args = n.args.map(formatTerm).join(' ');
  const p = args ? `${n.pred} ${args}` : n.pred;
  return n.sign === -1 ? `NOT ${p}` : p;
}

export function bindingSignature(bindings = {}) {
  return stableStringify(Object.fromEntries(Object.keys(bindings).sort().map((k) => [k, substituteTerm(bindings[k], bindings)])));
}
