// VENDORED: copied verbatim from soplab-v0.4.0.zip src/store.mjs
import {
  atomKey, normalizeAtom, relationKey, stableStringify, stableTerm, isGroundTerm,
} from './model.mjs';

function proofKey(p) { return stableStringify(p); }

export class ClaimStore {
  constructor() {
    this.claims = new Map();
    this.relationIndex = new Map();
    this.argumentIndex = new Map();
  }

  add(atom, provenance = { kind: 'asserted' }) {
    const a = normalizeAtom(atom);
    const key = atomKey(a);
    let record = this.claims.get(key);
    const isNew = !record;
    if (!record) {
      record = { key, atom: a, proofs: [] };
      this.claims.set(key, record);
      const rk = relationKey(a);
      if (!this.relationIndex.has(rk)) this.relationIndex.set(rk, new Set());
      this.relationIndex.get(rk).add(key);
      a.args.forEach((arg, i) => {
        if (!isGroundTerm(arg)) return;
        const ik = `${rk}|${i}|${stableTerm(arg)}`;
        if (!this.argumentIndex.has(ik)) this.argumentIndex.set(ik, new Set());
        this.argumentIndex.get(ik).add(key);
      });
    }
    const pk = proofKey(provenance);
    if (!record.proofs.some((p) => proofKey(p) === pk)) record.proofs.push(provenance);
    return { isNew, record };
  }

  candidateKeys(pattern) {
    const p = normalizeAtom(pattern);
    const rk = relationKey(p);
    const base = this.relationIndex.get(rk);
    if (!base) return new Set();
    let best = base;
    p.args.forEach((arg, i) => {
      if (!isGroundTerm(arg)) return;
      const set = this.argumentIndex.get(`${rk}|${i}|${stableTerm(arg)}`) ?? new Set();
      if (set.size < best.size) best = set;
    });
    return best;
  }

  recordsForPattern(pattern, { metrics = null, allowedKeys = null } = {}) {
    metrics?.inc('relationLookups');
    const keys = this.candidateKeys(pattern);
    const out = [];
    for (const key of keys) {
      if (allowedKeys && !allowedKeys.has(key)) continue;
      const rec = this.claims.get(key);
      if (rec) out.push(rec);
    }
    metrics?.inc('candidateRows', out.length);
    return out;
  }

  has(atom) { return this.claims.has(atomKey(normalizeAtom(atom))); }
  get(atom) { return this.claims.get(atomKey(normalizeAtom(atom))) ?? null; }

  status(atom) {
    const requested = normalizeAtom(atom);
    const pos = this.claims.get(atomKey({ ...requested, sign: 1 }));
    const neg = this.claims.get(atomKey({ ...requested, sign: -1 }));
    const support = requested.sign === -1 ? neg : pos;
    const opposition = requested.sign === -1 ? pos : neg;
    let status = 'unknown';
    if (pos && neg) status = 'conflicting';
    else if (support) status = 'supported';
    else if (opposition) status = 'refuted';
    return { status, support: support ?? null, opposition: opposition ?? null, positive: pos ?? null, negative: neg ?? null };
  }

  values() { return [...this.claims.values()]; }
  size() { return this.claims.size; }

  assertedValues() {
    return this.values().filter((r) => r.proofs.some((p) => ['asserted', 'source', 'assumption'].includes(p.kind)));
  }

  clearDerived() {
    const keep = [];
    for (const rec of this.values()) {
      const proofs = rec.proofs.filter((p) => ['asserted', 'source', 'assumption'].includes(p.kind));
      if (proofs.length) keep.push({ atom: rec.atom, proofs });
    }
    this.claims.clear(); this.relationIndex.clear(); this.argumentIndex.clear();
    for (const row of keep) for (const p of row.proofs) this.add(row.atom, p);
  }

  toJSON({ includeDerived = true } = {}) {
    const rows = includeDerived ? this.values() : this.assertedValues();
    return rows.map((x) => ({ atom: x.atom, proofs: x.proofs }));
  }

  static fromJSON(data) {
    const s = new ClaimStore();
    for (const row of data ?? []) for (const p of row.proofs ?? [{ kind: 'asserted' }]) s.add(row.atom, p);
    return s;
  }
}
