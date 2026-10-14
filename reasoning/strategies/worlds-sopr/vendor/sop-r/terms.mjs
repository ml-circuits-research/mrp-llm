// VENDORED: copied verbatim from sop-r.zip src/ terms.mjs
// Term dictionary: every constant (atom, number, quoted string, boolean) gets a dense integer id.
// Equality follows the reference implementation: "x" (quoted) and x (atom) are the same term;
// the display form of a term is the one it was first interned with.
import { Quoted, pyStr } from './lex.mjs';

export class Dict {
  constructor() {
    this.ids = new Map();   // key -> id
    this.vals = [];         // id -> JS value (number | string | boolean)
    this.quoted = [];       // id -> true if first seen as a quoted string
  }
  static key(v) {
    if (v instanceof Quoted) return 's' + v.s;
    switch (typeof v) {
      case 'number': return 'n' + v;
      case 'boolean': return 'n' + (v ? 1 : 0);      // Python: True == 1
      default: return 's' + v;
    }
  }
  intern(v) {
    const k = Dict.key(v);
    let id = this.ids.get(k);
    if (id === undefined) {
      id = this.vals.length;
      this.ids.set(k, id);
      this.vals.push(v instanceof Quoted ? v.s : v);
      this.quoted.push(v instanceof Quoted);
    }
    return id;
  }
  lookup(v) { return this.ids.get(Dict.key(v)); }
  val(id) { return this.vals[id]; }
  // Python str()
  str(id) { return pyStr(this.vals[id]); }
  // Python fmt(): quoted strings with quotes
  fmt(id) { return this.quoted[id] ? `"${this.vals[id]}"` : pyStr(this.vals[id]); }
  // token form (for messages that need Quoted semantics)
  tok(id) { return this.quoted[id] ? new Quoted(this.vals[id]) : this.vals[id]; }
  get size() { return this.vals.length; }
}
