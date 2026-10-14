/**
 * Text emitter for the lowered conformance program: core wires only (`predicate`, `fact`, `rule`), written as the circuits any core
 * strategy reads. Generated predicates and wires carry the reserved prefix `x_c_`; every generated predicate is declared closed (a
 * trace is a closed, finite record, so negation as failure over its relations is sound).
 */
import {isVarTerm, showValue} from '../js-reference/values.mjs';

/** A lowercase symbol made of the characters of an id (predicate names are lowercase symbols). */
export const sym = s => String(s).toLowerCase().replace(/[^a-z0-9_]/g, '_');

/** Text of a term: a variable, an integer, or a symbol or quoted string. */
export const T = t => (typeof t === 'string' && /^\?/.test(t) ? t : isVarTerm(t) ? t.var : showValue(t));
export const Q = s => JSON.stringify(String(s));

/** `[not|absent] p t1 t2` */
export const atom = (p, terms, mode = 'pos') => [mode === 'pos' ? null : mode, p, ...terms.map(T)].filter(x => x !== null).join(' ');

export class Out {
  constructor() { this.parts = []; this.arity = new Map(); this.n = 0; }

  declare(name, arity) {
    const had = this.arity.get(name);
    if (had !== undefined) {
      if (had !== arity) throw new Error(`generated predicate ${name} used with arity ${arity} and ${had}`);
      return name;
    }
    this.arity.set(name, arity);
    this.parts.push(`@${name} predicate\n  args ${arity ? Array(arity).fill('value').join(' ') : 'none'}\n  closed true`);
    return name;
  }

  fact(holds) { this.parts.push(`@x_c_f${++this.n} fact\n  holds ${holds}`); }

  /** `head` is the text after `then`; `body` the leaf lines (each the text after `when`). */
  rule(head, body) { this.parts.push(`@x_c_r${++this.n} rule\n${body.map(b => '  when ' + b).join('\n')}\n  then ${head}`); }

  text() { return this.parts.join('\n\n') + '\n'; }
}
