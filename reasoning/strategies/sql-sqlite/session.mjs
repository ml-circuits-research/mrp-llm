/**
 * One SQLite connection (the built-in node:sqlite) with the three SQL functions the compiled statements call:
 *
 *   tick(...)       counts a joined tuple against the budget and checks the wall clock; when a ceiling is hit it throws the budget stop
 *                   out of the running statement (node:sqlite has no progress handler, so this is the statement timeout). SQLite
 *                   rolls the whole statement back, so a cut closure only ever holds complete statements;
 *   cmp(word, a, b) `compare A WORD B` with the oracle's own rules (an ordering needs integers or times, two instants are equal
 *                   when they are the same moment), for the cases the compiler cannot prove to be plain integer or plain symbol;
 *   ord(x)          the position of an integer or a time on the number line, NULL otherwise (`order ?t1 before ?t2`).
 *
 * Statements are cached by text, so the rounds of a fixpoint loop prepare each statement once.
 */
import {DatabaseSync} from 'node:sqlite';
import {compareValues, ordinal} from '../js-reference/values.mjs';

export class Session {
  /** `path` ':memory:' for the strategy's own database; a file with `readOnly` for the bank mode (temp tables only). */
  constructor({budget, codec, path = ':memory:', readOnly = false}) {
    this.budget = budget;
    this.codec = codec;
    this.readOnly = readOnly;
    this.db = new DatabaseSync(path, readOnly ? {readOnly: true} : {});
    if (!readOnly) this.db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA locking_mode=EXCLUSIVE; PRAGMA cache_size=-262144;');
    this.db.exec('PRAGMA temp_store=MEMORY;');
    this.cache = new Map();
    this.db.function('tick', {varargs: true, deterministic: false}, () => { this.budget.tick(); return 1; });
    this.db.function('cmp', {deterministic: true}, (word, a, b) => (compareValues(word, a, b) ? 1 : 0));
    this.db.function('ord', {deterministic: true}, x => ordinal(x));
  }

  prepare(sql) {
    let s = this.cache.get(sql);
    if (!s) { s = this.db.prepare(sql); this.cache.set(sql, s); }
    return s;
  }

  /** Run a statement; a budget stop raised inside it (by tick) is rethrown as the stop itself. */
  guard(fn) {
    try { return fn(); } catch (e) {
      if (this.budget.stop) throw this.budget.stop;
      throw e;
    }
  }

  run(sql, ...params) { return this.guard(() => this.prepare(sql).run(...params)); }
  all(sql, ...params) { return this.guard(() => this.prepare(sql).all(...params)); }
  get(sql, ...params) { return this.guard(() => this.prepare(sql).get(...params)); }

  /** Stream join bindings into the oracle form pass without allocating a second result array. */
  *iterate(sql, ...params) {
    const iterator = this.guard(() => this.prepare(sql).iterate(...params));
    try {
      for (;;) {
        const item = this.guard(() => iterator.next());
        if (item.done) return;
        yield item.value;
      }
    } finally {
      iterator.return?.();
    }
  }
  exec(sql) { return this.guard(() => this.db.exec(sql)); }

  close() {
    this.cache.clear();
    this.db.close();
  }
}
