/**
 * Evidence of the js-reference strategy: positive evidence P (`p a` is derivable) and negative evidence N (`not p a` is
 * derivable) are two independent tables (Belnap; Przymusinski). `both` is only a reported status, never a state that stops
 * propagation: a body `p a` is satisfied by P regardless of N, a body `not p a` by N regardless of P.
 *
 * A node records the first derivation found: its kind (`fact`, `rule`, `aggregate`), the claim that produced it, and the premises
 * (nodes, or `{absent}` markers for negation as failure). Derivations are found in rounds, so a node's premises always come from
 * earlier rounds and the premise graph is acyclic.
 */
import {argsKey} from './values.mjs';

export class Evidence {
  constructor() {
    this.pos = new Map();
    this.neg = new Map();
  }

  table(neg, p, create = false) {
    const side = neg ? this.neg : this.pos;
    let t = side.get(p);
    if (!t && create) { t = {byKey: new Map(), list: []}; side.set(p, t); }
    return t;
  }

  get(neg, p, args) { return this.table(neg, p)?.byKey.get(argsKey(args)); }

  list(neg, p) { return this.table(neg, p)?.list ?? []; }

  /** Adds a node unless the same literal is already there; returns whether it was new. */
  add(node) {
    const t = this.table(node.neg, node.p, true);
    node.key = argsKey(node.args);
    if (t.byKey.has(node.key)) return false;
    t.byKey.set(node.key, node);
    t.list.push(node);
    return true;
  }

  /** Status of a ground atom: supported (P), refuted (N), both, unknown. */
  status(p, args) {
    const pos = Boolean(this.get(false, p, args)), neg = Boolean(this.get(true, p, args));
    return pos && neg ? 'both' : pos ? 'supported' : neg ? 'refuted' : 'unknown';
  }
}
