// VENDORED: copied verbatim from sop-r.zip src/ store.mjs
// Fact storage.
//
// A Store maps relation id -> Rel. A Rel holds the (subject, object) pairs of one relation with two
// hash indexes (subject -> objects, object -> subjects): "vertical partitioning" by relation, the
// standard layout of triple stores. Terms are integer ids from the Dict.
//
// Copy-on-write: Store.fork() is O(#relations). The first write to a shared relation creates an
// overlay Rel (local additions + deletions over a frozen parent), so hypothetical worlds and plan
// steps never copy whole relations. Overlay chains are flattened past MAX_DEPTH.

const MAX_DEPTH = 6;
// nested-map pair sets / pair maps (no numeric pair keys: ids may exceed 2^26)
const pHas = (m, s, o) => { const x = m.get(s); return x !== undefined && x.has(o); };
const pAdd = (m, s, o) => { let x = m.get(s); if (x === undefined) { x = new Set(); m.set(s, x); } x.add(o); };
const pDel = (m, s, o) => { const x = m.get(s); if (x !== undefined) { x.delete(o); if (!x.size) m.delete(s); } };
const mGet = (m, s, o) => { const x = m.get(s); return x === undefined ? undefined : x.get(o); };
const mSet = (m, s, o, v) => { let x = m.get(s); if (x === undefined) { x = new Map(); m.set(s, x); } x.set(o, v); };

export class Rel {
  constructor(id, parent = null) {
    this.id = id;
    this.parent = parent;
    this.so = new Map();
    this.os = new Map();
    this.del = null;
    this.size = parent ? parent.size : 0;
    this.nS = parent ? parent.nS : 0;
    this.nO = parent ? parent.nO : 0;
    this.why = null;
    this.depth = parent ? parent.depth + 1 : 0;
  }
  _hasLocal(s, o) { const x = this.so.get(s); return x !== undefined && x.has(o); }
  _hasParent(s, o) { return this.parent !== null && !(this.del !== null && pHas(this.del, s, o)) && this.parent.has(s, o); }
  has(s, o) { return this._hasLocal(s, o) || this._hasParent(s, o); }
  add(s, o) {
    if (this.parent !== null && this.del !== null && pHas(this.del, s, o)) { pDel(this.del, s, o); this.size++; return true; }
    if (this.has(s, o)) return false;
    let x = this.so.get(s);
    if (x === undefined) { x = new Set(); this.so.set(s, x); this.nS++; }
    x.add(o);
    let y = this.os.get(o);
    if (y === undefined) { y = new Set(); this.os.set(o, y); this.nO++; }
    y.add(s);
    this.size++;
    return true;
  }
  delete(s, o) {
    if (this._hasLocal(s, o)) {
      const x = this.so.get(s); x.delete(o); if (!x.size) { this.so.delete(s); }
      const y = this.os.get(o); y.delete(s); if (!y.size) { this.os.delete(o); }
      this.size--; return true;
    }
    if (this._hasParent(s, o)) {
      if (this.del === null) this.del = new Map();
      pAdd(this.del, s, o); this.size--; return true;
    }
    return false;
  }
  // iteration: the callback may return true to stop early; the methods then return true
  forS(s, cb) {
    if (this.parent !== null) {
      if (this.del === null) { if (this.parent.forS(s, cb)) return true; }
      else {
        const d = this.del.get(s);
        if (d === undefined) { if (this.parent.forS(s, cb)) return true; }
        else if (this.parent.forS(s, (o) => (d.has(o) ? undefined : cb(o)))) return true;
      }
    }
    const x = this.so.get(s);
    if (x !== undefined) for (const o of x) if (cb(o) === true) return true;
    return false;
  }
  forO(o, cb) {
    if (this.parent !== null) {
      if (this.del === null) { if (this.parent.forO(o, cb)) return true; }
      else if (this.parent.forO(o, (s) => (pHas(this.del, s, o) ? undefined : cb(s)))) return true;
    }
    const y = this.os.get(o);
    if (y !== undefined) for (const s of y) if (cb(s) === true) return true;
    return false;
  }
  forAll(cb) {
    if (this.parent !== null) {
      if (this.del === null) { if (this.parent.forAll(cb)) return true; }
      else if (this.parent.forAll((s, o) => (pHas(this.del, s, o) ? undefined : cb(s, o)))) return true;
    }
    for (const [s, x] of this.so) for (const o of x) if (cb(s, o) === true) return true;
    return false;
  }
  countS(s) { const x = this.so.get(s); return (x ? x.size : 0) + (this.parent ? this.parent.countS(s) : 0); }
  countO(o) { const y = this.os.get(o); return (y ? y.size : 0) + (this.parent ? this.parent.countO(o) : 0); }
  subjects(cb) { // distinct subjects (may repeat for overlays; callers dedupe if needed)
    if (this.parent !== null) this.parent.subjects(cb);
    for (const s of this.so.keys()) cb(s);
  }
  getWhy(s, o) {
    if (this.why !== null && this._hasLocal(s, o)) { const w = mGet(this.why, s, o); if (w !== undefined) return w; }
    if (this._hasParent(s, o)) return this.parent.getWhy(s, o);
    return undefined;
  }
  setWhy(s, o, w) { if (this.why === null) this.why = new Map(); mSet(this.why, s, o, w); }
  flat() { // materialise into a single-level Rel (keeps provenance)
    const r = new Rel(this.id);
    this.forAll((s, o) => { r.add(s, o); const w = this.getWhy(s, o); if (w !== undefined) r.setWhy(s, o, w); });
    return r;
  }
}

export class Store {
  constructor(parent = null) {
    this.tables = parent ? new Map(parent.tables) : new Map();
    this.owned = new Set();
  }
  get(r) { return this.tables.get(r); }
  w(r) {
    let t = this.tables.get(r);
    if (t === undefined) { t = new Rel(r); this.tables.set(r, t); this.owned.add(r); }
    else if (!this.owned.has(r)) {
      t = t.depth >= MAX_DEPTH ? t.flat() : new Rel(r, t);
      this.tables.set(r, t); this.owned.add(r);
    }
    return t;
  }
  share(r, t) { this.tables.set(r, t); this.owned.delete(r); }
  fork() { const c = new Store(this); this.owned = new Set(); return c; }
  has(s, r, o) { const t = this.tables.get(r); return t !== undefined && t.has(s, o); }
  add(s, r, o) { return this.w(r).add(s, o); }
  delete(s, r, o) { const t = this.tables.get(r); if (t === undefined || !t.has(s, o)) return false; return this.w(r).delete(s, o); }
  get size() { let n = 0; for (const t of this.tables.values()) n += t.size; return n; }
  rels() { return this.tables.keys(); }
}
