// VENDORED: copied verbatim from sop-r.zip src/ engine.mjs
// SOP-R engine: compile + lint + stratify + evaluate.
//
// Semantics are those of the reference implementation (sopr.py, v0.1). The evaluation strategy is
// new and built for large knowledge bases:
//   * terms are dictionary-encoded ints, facts are stored per relation with subject/object indexes
//   * semi-naive fixpoint per stratum, driven by a trigger index (relation, constant) -> rule atoms
//   * greedy join ordering by estimated cardinality
//   * demand-driven ("cone") evaluation: a query saturates only the relations it depends on
//   * hypothetical worlds are copy-on-write; after a change only the forward-affected cone is
//     recomputed, and pure additions on monotone paths are propagated incrementally
// Each optimisation can be switched off (opts) to reproduce the naive algorithm for comparison.
import { lex, isVar, isRef, Quoted, SopError, NUM, pyStr, fmtTok, fmtToks, tokEq, tokKey, cmpStr } from './lex.mjs';
import { parse } from './parse.mjs';
import { Dict } from './terms.mjs';
import { Store } from './store.mjs';
import { OPS, parseExpr, evalExpr } from './expr.mjs';
import { liftWires } from './lift.mjs';

const POS = ['when', 'match'];
const NEG = ['unless', 'not'];
const META = ['source', 'note'];
const AGGS = ['count', 'sum', 'min', 'max', 'avg'];
export const KEYWORDS = {
  fact: null,
  rule: [...POS, ...NEG, 'let', 'test', 'from', 'then', 'overrides', 'supersedes', ...META],
  constraint: [...POS, ...NEG, 'let', 'test', 'from', 'message', 'supersedes', ...META],
  method: [...POS, ...NEG, 'task', 'let', 'test', 'require', 'forbid', 'require-test', 'step', 'do',
    'forall', 'add', 'remove', 'set', 'supersedes', ...META],
  find: [...POS, ...NEG, 'in', 'from', 'let', 'test', 'return', ...META],
  group: [...POS, ...NEG, 'in', 'from', 'let', 'test', 'by', ...AGGS, ...META],
  assume: ['in', 'add', 'remove', 'set', ...META],
  plan: ['in', 'task', ...META],
  check: ['in', ...META],
  answer: ['from', 'show', 'text', ...META],
};
const QUERY_TYPES = ['find', 'group', 'assume', 'plan', 'check', 'answer'];

export const PRELUDE = `
@prelude-isa rule
  when ?x is-a ?c
  when ?c subclass-of ?d
  then ?x is-a ?d
@prelude-sub rule
  when ?a subclass-of ?b
  when ?b subclass-of ?c
  then ?a subclass-of ?c
`;

export const DEFAULTS = {
  seminaive: true,   // semi-naive rounds with trigger index (false: naive rounds, every rule every round)
  lazy: true,        // demand-driven: saturate only the dependency cone of what is asked
  incremental: true, // worlds reuse the parent's saturation outside the affected cone
  joinOrder: true,   // greedy join ordering (false: conditions in written order)
  provenance: true,  // keep one derivation per derived fact (needed for "why")
  lift: false,       // rewrite families of same-shape rules into template + parameter facts
  liftMin: 3,
};

const ALL = 'all';

class Scope {
  constructor() { this.map = new Map(); this.names = []; }
  slot(n) { let s = this.map.get(n); if (s === undefined) { s = this.names.length; this.map.set(n, s); this.names.push(n); } return s; }
  has(n) { return this.map.has(n); }
  get size() { return this.names.length; }
}

function cmpKeyLists(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmpStr(a[i][0], b[i][0]) || cmpStr(a[i][1], b[i][1]);
    if (c) return c;
  }
  return a.length - b.length;
}

export class World {
  constructor(eng, base, assumed) {
    this.eng = eng; this.base = base; this.assumed = assumed;
    this.sat = null; this.prevSat = null; this.dirty = new Set(); this.added = []; this.removed = false;
    this.version = 0; this.parentWorld = null; this.parentVersion = -1;
  }
  store(need = ALL) {
    if (this.sat === null) {
      // a world forked from an unsaturated parent: saturate the parent's cone first (shared by all
      // sibling worlds) and continue from it, as long as the parent has not changed since the fork
      const o = this.eng.opts;
      if (this.prevSat === null && this.parentWorld !== null && this.parentWorld.version === this.parentVersion && o.incremental && o.lazy) {
        this.prevSat = this.parentWorld.store(need);
      }
      this.sat = this.eng._newSat(this);
      this.prevSat = null; this.dirty = new Set(); this.added = []; this.removed = false;
    }
    this.eng._ensure(this.sat, need);
    return this.sat;
  }
  _touch(r) { if (this.sat !== null) { this.prevSat = this.sat; this.sat = null; } this.dirty.add(r); this.version++; }
  copy() {
    const w = new World(this.eng, this.base.fork(), new Set(this.assumed));
    if (this.sat !== null) w.prevSat = this.sat;
    else if (this.prevSat !== null) { w.prevSat = this.prevSat; w.dirty = new Set(this.dirty); w.added = this.added.slice(); w.removed = this.removed; }
    else { w.parentWorld = this; w.parentVersion = this.version; }
    return w;
  }
  add(t) {
    this.assumed.add(t.join(','));
    if (this.base.add(t[0], t[1], t[2])) { this._touch(t[1]); this.added.push(t); }
  }
  remove(pat) { // pat: [s|null, r|null, o|null]
    const rm = [];
    const rels = pat[1] === null ? [...this.base.rels()] : [pat[1]];
    for (const r of rels) {
      const t = this.base.get(r);
      if (!t) continue;
      const [s, , o] = pat;
      if (s !== null && o !== null) { if (t.has(s, o)) rm.push([s, r, o]); }
      else if (s !== null) t.forS(s, (oo) => { rm.push([s, r, oo]); });
      else if (o !== null) t.forO(o, (ss) => { rm.push([ss, r, o]); });
      else t.forAll((ss, oo) => { rm.push([ss, r, oo]); });
    }
    for (const x of rm) { this.base.delete(x[0], x[1], x[2]); this._touch(x[1]); this.removed = true; }
    return rm;
  }
  take(o) {
    this.base = o.base; this.assumed = o.assumed; this.sat = o.sat; this.prevSat = o.prevSat;
    this.dirty = o.dirty; this.added = o.added; this.removed = o.removed;
    this.parentWorld = o.parentWorld; this.parentVersion = o.parentVersion; this.version++;
  }
}

export class Engine {
  constructor(sources, opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.dict = new Dict();
    this.errors = []; this.warnings = [];
    this.wires = new Map(); this.order = [];
    this.stats = { ruleEvals: 0, deltaRounds: 0, derived: 0, strataRuns: 0 };
    for (const [origin, text] of [['prelude', PRELUDE], ...sources]) this._addWires(parse(text, origin));
    if (this.opts.lift) {
      const res = liftWires(this.order, this.opts);
      this.liftReport = res.report;
      this.order = res.wires;
      this.wires = new Map(this.order.map((w) => [w.name, w]));
    }
    this.inactive = new Set();
    this.rawBody = new Map(); this.rawHeads = new Map(); this.meth = new Map();
    this.results = new Map();
    this.cb = new Map(); // compiled bodies (lazy)
    this._compile();
  }

  _addWires(ws) {
    for (const w of ws) {
      if (this.wires.has(w.name)) {
        this.errors.push(`${w.where()}: wire name already assigned at ${this.wires.get(w.name).where()} (single assignment!)`);
        continue;
      }
      this.wires.set(w.name, w);
      this.order.push(w);
    }
  }

  // ------------------------------------------------------------------ compile
  err(w, msg, line = null) { this.errors.push(`${w.where()}${line ? ` line ${line.n}` : ''}: ${msg}`); }
  warn(w, msg, line = null) { this.warnings.push(`${w.where()}${line ? ` line ${line.n}` : ''}: ${msg}`); }

  ref(w, line, types = null) {
    if (line.args.length !== 1 || !isRef(line.args[0])) { this.err(w, `"${line.kw}" expects one $wire reference`, line); return null; }
    const name = line.args[0].slice(1);
    if (!this.wires.has(name)) { this.err(w, `unknown wire $${name}`, line); return null; }
    if (types && !types.includes(this.wires.get(name).type)) {
      this.err(w, `$${name} is a ${this.wires.get(name).type}, expected ${types.join('/')}`, line); return null;
    }
    return name;
  }

  pat(w, line, args = null) {
    const a = args === null ? line.args : args;
    if (a.length !== 3) {
      this.err(w, `"${line.kw}" expects a statement of exactly 3 terms: subject relation object (quote multi-word values)`, line);
      return null;
    }
    if (a.some(isRef)) { this.err(w, '$wire reference not allowed inside a statement', line); return null; }
    return a.slice();
  }

  expr(w, line) {
    const toks = lex(line.raw.replaceAll('(', ' ( ').replaceAll(')', ' ) '));
    if (!toks.length) this.err(w, 'empty expression', line);
    return toks;
  }

  _checkKeywords(ws, queryOnly) {
    for (const w of ws) {
      if (!(w.type in KEYWORDS)) { this.err(w, `unknown wire type "${w.type}"`); continue; }
      const allowed = KEYWORDS[w.type];
      if (w.origin === 'query' && ['fact', 'rule', 'constraint', 'method'].includes(w.type)) {
        this.err(w, `a query file may only contain query wires (find, group, assume, plan, check, answer), not "${w.type}"`);
      }
      for (const l of w.lines) {
        if (allowed !== null && !allowed.includes(l.kw)) this.err(w, `keyword "${l.kw}" is not valid in a ${w.type} wire (valid: ${allowed.join(', ')})`, l);
        if (isVar(l.kw) || isRef(l.kw)) this.err(w, 'a line must start with a keyword', l);
      }
      if (!queryOnly) for (const l of w.get('supersedes')) { const r = this.ref(w, l); if (r) this.inactive.add(r); }
    }
  }

  _compileWire(w) {
    if (w.type === 'fact') this._fact(w);
    else if (['rule', 'constraint', 'find', 'group'].includes(w.type)) {
      this.rawBody.set(w.name, this._body(w));
      if (w.type === 'rule') {
        const heads = w.get('then').map((l) => this.pat(w, l)).filter(Boolean);
        this.rawHeads.set(w.name, heads);
        if (!heads.length) this.err(w, 'rule has no "then" line');
        for (const p of heads) if (isVar(p[1])) this.err(w, 'the relation of a "then" statement cannot be a variable');
        this.rules.push(w);
      } else if (w.type === 'constraint') this.constraints.push(w);
    } else if (w.type === 'method') this._method(w);
    if (w.type === 'fact' || w.type === 'rule') {
      for (const l of w.get('overrides')) {
        const r = this.ref(w, l, ['rule']);
        if (r) { if (!this.overriders.has(r)) this.overriders.set(r, []); this.overriders.get(r).push(w.name); }
      }
    }
  }

  _compile() {
    this._checkKeywords(this.order, false);
    this.active = this.order.filter((w) => !this.inactive.has(w.name) && w.type in KEYWORDS);
    this.baseKeys = new Set(); this.baseTriples = [];
    this.factSrc = new Map(); this.factTriples = new Map();
    this.overriders = new Map();
    this.rules = []; this.constraints = []; this.methods = new Map();
    for (const w of this.active) this._compileWire(w);
    this._lint(this.active);
    this.strata = [];
    if (!this.errors.length) { this._stratify(); if (!this.errors.length) this._prepare(); }
  }

  _fact(w) {
    let subj = null;
    for (const l of w.lines) {
      if (META.includes(l.kw) || l.kw === 'overrides' || l.kw === 'supersedes') continue;
      if (l.kw === 'about') {
        if (l.args.length !== 1) this.err(w, '"about" expects one subject term', l);
        else subj = l.args[0];
        continue;
      }
      let t;
      if (l.kw === 'say') t = this.pat(w, l);
      else {
        if (subj === null) { this.err(w, 'relation line before "about <subject>" (or use "say S R O")', l); continue; }
        if (l.args.length !== 1) { this.err(w, 'a fact line is "relation value" with ONE value term; quote multi-word values or use several lines', l); continue; }
        t = [subj, l.kw, l.args[0]];
      }
      if (t) {
        if (t.some(isVar)) { this.err(w, 'variables are not allowed in facts (use a rule)', l); continue; }
        const ids = t.map((x) => this.dict.intern(x));
        const key = ids.join(',');
        if (!this.baseKeys.has(key)) { this.baseKeys.add(key); this.baseTriples.push(ids); }
        if (!this.factSrc.has(key)) this.factSrc.set(key, w.name);
        if (!this.factTriples.has(w.name)) this.factTriples.set(w.name, []);
        this.factTriples.get(w.name).push(ids);
      }
    }
  }

  _body(w) {
    const body = [];
    for (const l of w.lines) {
      if (POS.includes(l.kw) || NEG.includes(l.kw)) {
        const p = this.pat(w, l);
        if (p) body.push({ k: POS.includes(l.kw) ? 'pos' : 'neg', p });
      } else if (l.kw === 'from') {
        const r = this.ref(w, l, ['find', 'group', 'plan', 'check']);
        if (r) body.push({ k: 'from', ref: r });
      } else if (l.kw === 'let') {
        const toks = this.expr(w, l);
        if (toks.length < 3 || !isVar(toks[0]) || !tokEq(toks[1], '=')) this.err(w, 'let syntax: let ?var = expression', l);
        else body.push({ k: 'let', v: toks[0], toks: toks.slice(2) });
      } else if (l.kw === 'test') body.push({ k: 'test', toks: this.expr(w, l) });
    }
    return body;
  }

  _method(w) {
    const t = w.one('task');
    if (!t || !t.args.length || isVar(t.args[0])) { this.err(w, 'method needs "task <name> ?params..."'); return; }
    const seq = [];
    for (const l of w.lines) {
      const k = l.kw;
      if (k === 'require' || k === 'forbid') {
        const msg = l.args.length === 4 && l.args[3] instanceof Quoted ? l.args[3] : null;
        const p = this.pat(w, l, msg !== null ? l.args.slice(0, 3) : null);
        if (p) seq.push({ k, p, msg });
      } else if (k === 'require-test') {
        const toks = this.expr(w, l);
        const msg = toks.length && toks[toks.length - 1] instanceof Quoted ? toks.pop() : null;
        seq.push({ k, toks, msg });
      } else if (k === 'step') seq.push({ k, args: l.args });
      else if (k === 'do') {
        if (!l.args.length) this.err(w, 'do <task> args...', l);
        else seq.push({ k, task: l.args[0], args: l.args.slice(1) });
      } else if (k === 'forall') {
        if (l.args.length < 5 || !tokEq(l.args[3], 'do')) this.err(w, 'forall syntax: forall S R O do <task> args...', l);
        else seq.push({ k, p: l.args.slice(0, 3), task: l.args[4], args: l.args.slice(5) });
      } else if (k === 'add' || k === 'remove' || k === 'set') {
        const p = this.pat(w, l);
        if (p) seq.push({ k, p });
      }
    }
    const task = t.args[0];
    this.meth.set(w.name, { task, params: t.args.slice(1), seq, wire: w, app: this._body(w) });
    const tk = tokKey(task);
    if (!this.methods.has(tk)) this.methods.set(tk, []);
    this.methods.get(tk).push(w.name);
  }
  _taskNames() { return [...this.methods.values()].map((ns) => pyStr(this.meth.get(ns[0]).task)); }
  _hasTask(t) { return this.methods.has(tokKey(t)); }

  // ------------------------------------------------------------------ lint
  _bodyVars(body) {
    const bound = new Set();
    for (const it of body) {
      if (it.k === 'pos') for (const x of it.p) { if (isVar(x)) bound.add(x); }
      else if (it.k === 'from') for (const x of this._outVars(it.ref)) bound.add(x);
      else if (it.k === 'let') bound.add(it.v);
    }
    return bound;
  }

  _outVars(name, seen = new Set()) {
    const w = this.wires.get(name);
    if (seen.has(name)) return new Set();
    seen = new Set([...seen, name]);
    if (w.type === 'find') {
      const r = w.one('return');
      if (r) return new Set(r.args.filter(isVar));
      return this._bodyVarsSeen(this.rawBody.get(name) || [], seen);
    }
    if (w.type === 'group') {
      const vs = new Set();
      for (const l of w.get('by')) for (const x of l.args) if (isVar(x)) vs.add(x);
      for (const l of w.get(...AGGS)) if (l.args.length && isVar(l.args[l.args.length - 1])) vs.add(l.args[l.args.length - 1]);
      return vs;
    }
    if (w.type === 'plan') return new Set(['?n', '?step', '?status', '?reason']);
    const vs = new Set(['?constraint', '?message']);
    for (const c of this.constraints) for (const v of this._bodyVarsSeen(this.rawBody.get(c.name), seen)) vs.add(v);
    return vs;
  }
  _bodyVarsSeen(body, seen) {
    const bound = new Set();
    for (const it of body) {
      if (it.k === 'pos') for (const x of it.p) { if (isVar(x)) bound.add(x); }
      else if (it.k === 'from') for (const x of this._outVars(it.ref, seen)) bound.add(x);
      else if (it.k === 'let') bound.add(it.v);
    }
    return bound;
  }

  _lint(ws) {
    const rels = this.knownRels || new Set(), atoms = this.knownAtoms || new Set();
    const learn = (t) => {
      if (!isVar(t[1])) rels.add(tokKey(t[1]));
      for (const x of [t[0], t[2]]) if (typeof x === 'string' && !isVar(x)) atoms.add(x);
    };
    if (!this.knownRels) {
      for (const ids of this.baseTriples) learn(ids.map((id) => this.dict.tok(id)));
      for (const w of this.rules) for (const h of this.rawHeads.get(w.name) || []) learn(h);
      for (const m of this.meth.values()) for (const it of m.seq) if (it.k === 'add' || it.k === 'set') learn(it.p);
    }
    for (const w of ws) if (w.type === 'assume') for (const l of w.get('add', 'set')) if (l.args.length === 3) learn(l.args);
    this.knownRels = rels; this.knownAtoms = atoms;

    const checkPat = (w, p, what) => {
      if (!isVar(p[1]) && !rels.has(tokKey(p[1]))) this.warn(w, `relation "${pyStr(p[1])}" (${what}) is never asserted or derived anywhere - typo or vocabulary drift?`);
      for (const x of [p[0], p[2]]) if (typeof x === 'string' && !isVar(x) && !atoms.has(x)) this.warn(w, `constant "${x}" (${what}) never appears in any fact or rule conclusion`);
    };

    for (const w of ws) {
      let body = this.rawBody.get(w.name);
      if (w.type === 'method' && this.meth.has(w.name)) {
        const m = this.meth.get(w.name);
        body = m.app;
        const bound = this._bodyVars(body);
        for (const x of m.params) if (isVar(x)) bound.add(x);
        for (const it of m.seq) {
          if (it.k === 'require' || it.k === 'forbid') {
            checkPat(w, it.p, it.k);
            if (it.k === 'require') for (const x of it.p) if (isVar(x)) bound.add(x);
          } else if (it.k === 'do') { if (!this._hasTask(it.task)) this.warn(w, `task "${pyStr(it.task)}" has no method; it will be emitted as a primitive step`); }
          else if (it.k === 'forall') {
            checkPat(w, it.p, 'forall');
            if (!this._hasTask(it.task)) this.warn(w, `task "${pyStr(it.task)}" has no method; it will be emitted as a primitive step`);
          } else if (it.k === 'add' || it.k === 'set') {
            for (const x of it.p) if (isVar(x) && !bound.has(x)) this.err(w, `variable ${x} in "${it.k}" is not bound`);
          } else if (it.k === 'step') {
            for (const x of it.args) if (isVar(x) && !bound.has(x)) this.err(w, `variable ${x} in "step" is not bound by task params/when/require`);
          }
        }
      }
      if (body === undefined) continue;
      const bound = this._bodyVars(body);
      if (w.type === 'method') for (const x of this.meth.get(w.name).params) if (isVar(x)) bound.add(x);
      for (const it of body) {
        if (it.k === 'pos' || it.k === 'neg') {
          checkPat(w, it.p, 'condition');
          if ((w.type === 'rule' || w.type === 'constraint') && isVar(it.p[1])) this.err(w, 'a variable in relation position is only allowed in query wires');
        } else if (it.k === 'let' || it.k === 'test') {
          for (const x of it.toks) {
            if (isVar(x) && !bound.has(x)) this.err(w, `variable ${x} used in ${it.k} is not bound by a positive condition`);
            if (typeof x === 'string' && !isVar(x) && !OPS.has(x) && !atoms.has(x) && !NUM.test(x)) {
              this.warn(w, `token "${x}" in expression is not a known constant - operators must be separated by spaces`);
            }
          }
        }
      }
      if (w.type === 'rule') for (const h of this.rawHeads.get(w.name) || []) for (const x of h) if (isVar(x) && !bound.has(x)) this.err(w, `variable ${x} in "then" is not bound by a positive condition`);
      if ((w.type === 'find' || w.type === 'group') && w.origin !== 'query' && w.one('in')) this.err(w, 'a view stored in the knowledge base cannot have an "in" line');
      if (w.type === 'find') {
        const r = w.one('return');
        if (r) for (const x of r.args) if (!isVar(x) || !bound.has(x)) this.err(w, `return: ${fmtTok(x)} is not a bound variable`, r);
      }
      if (w.type === 'group') {
        for (const l of w.get(...AGGS)) {
          const a = l.args;
          if (!(a.length === 3 && isVar(a[0]) && tokEq(a[1], 'as') && isVar(a[2]))) this.err(w, `aggregate syntax: ${l.kw} ?var as ?result`, l);
          else if (!bound.has(a[0])) this.err(w, `aggregate variable ${a[0]} is not bound`, l);
        }
        for (const l of w.get('by')) for (const x of l.args) if (!(typeof x === 'string' && bound.has(x))) this.err(w, `by: ${fmtTok(x)} is not a bound variable`, l);
      }
    }
    for (const w of ws) {
      if (['assume', 'plan', 'check', 'find', 'group'].includes(w.type)) for (const l of w.get('in')) this.ref(w, l, ['assume', 'plan']);
      if (w.type === 'assume') for (const l of w.get('add', 'remove', 'set')) if (l.args.length !== 3) this.err(w, `"${l.kw}" expects a statement of exactly 3 terms`, l);
      if (w.type === 'plan') {
        const t = w.one('task');
        if (!t || !t.args.length) this.err(w, 'plan needs "task <name> args..."');
        else if (!this._hasTask(t.args[0])) this.warn(w, `no method defines task "${pyStr(t.args[0])}" (known tasks: ${this._taskNames().sort(cmpStr).join(', ') || 'none'})`);
      }
      if (w.type === 'answer') {
        const f = w.one('from');
        if (!f) this.err(w, 'answer needs "from $wire"');
        else this.ref(w, f, ['find', 'group', 'plan', 'check']);
      }
    }
  }

  // ------------------------------------------------------------------ stratification
  _viewRels(name, seen = new Set()) {
    const rels = new Set();
    if (seen.has(name)) return rels;
    seen.add(name);
    for (const it of this.rawBody.get(name) || []) {
      if (it.k === 'pos' || it.k === 'neg') rels.add(tokKey(it.p[1]));
      else if (it.k === 'from') for (const r of this._viewRels(it.ref, seen)) rels.add(r);
    }
    return rels;
  }
  _deps(name, seen = new Set()) {
    const pos = new Set(), neg = new Set();
    if (seen.has(name)) return [pos, neg];
    seen.add(name);
    for (const it of this.rawBody.get(name)) {
      if (it.k === 'pos') pos.add(tokKey(it.p[1]));
      else if (it.k === 'neg') neg.add(tokKey(it.p[1]));
      else if (it.k === 'from') for (const r of this._viewRels(it.ref)) neg.add(r);
    }
    for (const o of this.overriders.get(name) || []) {
      if (this.wires.get(o).type === 'rule' && !this.inactive.has(o)) {
        const [p2, n2] = this._deps(o, seen);
        for (const r of p2) neg.add(r);
        for (const r of n2) neg.add(r);
      }
    }
    return [pos, neg];
  }
  _stratify() {
    const strat = new Map();
    const g = (r) => strat.get(r) || 0;
    const deps = new Map(this.rules.map((w) => [w.name, this._deps(w.name)]));
    const limit = this.knownRels.size + this.rules.length + 5;
    let converged = false;
    for (let it = 0; it < limit; it++) {
      let changed = false;
      for (const w of this.rules) {
        const [pos, neg] = deps.get(w.name);
        const hs = this.rawHeads.get(w.name).map((h) => tokKey(h[1]));
        let m = 0;
        for (const p of pos) m = Math.max(m, g(p));
        for (const n of neg) m = Math.max(m, g(n) + 1);
        for (const h of hs) m = Math.max(m, g(h));
        for (const h of hs) if (g(h) !== m) { strat.set(h, m); changed = true; }
      }
      if (!changed) { converged = true; break; }
    }
    if (!converged) {
      this.errors.push('rules are not stratifiable: some relation depends on its own negation / aggregation / override (check "unless", "from", "overrides" cycles)');
      return;
    }
    const by = new Map();
    for (const w of this.rules) {
      const k = Math.max(0, ...this.rawHeads.get(w.name).map((h) => g(tokKey(h[1]))));
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(w.name);
    }
    this.strata = [...by.keys()].sort((a, b) => a - b).map((k) => by.get(k));
  }

  // ------------------------------------------------------------------ evaluation structures
  term(tok, scope) { return isVar(tok) ? { v: scope.slot(tok) } : { c: this.dict.intern(tok) }; }

  _scopeFor(w) {
    const scope = new Scope();
    const addToks = (xs) => { for (const x of xs) if (isVar(x)) scope.slot(x); };
    for (const l of w.lines) {
      addToks(l.args);
      if (['let', 'test', 'require-test'].includes(l.kw)) addToks(lex(l.raw.replaceAll('(', ' ( ').replaceAll(')', ' ) ')));
      if (l.kw === 'from' && l.args.length === 1 && isRef(l.args[0]) && this.wires.has(l.args[0].slice(1))) {
        for (const v of this._outVars(l.args[0].slice(1))) scope.slot(v);
      }
    }
    return scope;
  }

  _compileExpr(toks, scope) {
    const ast = parseExpr(toks);
    const walk = (e) => {
      if (e === null) return null;
      if ('v' in e) return { v: scope.slot(e.v) };
      if ('c' in e) return e;
      if ('u' in e) return { u: e.u, a: walk(e.a) };
      if ('op' in e) return { op: e.op, a: walk(e.a), b: walk(e.b) };
      if ('and' in e) return { and: e.and.map(walk) };
      if ('or' in e) return { or: e.or.map(walk) };
      return { cmp: e.cmp, args: e.args.map(walk) };
    };
    return { ast: walk(ast), vars: toks.filter(isVar).map((v) => scope.slot(v)), toks };
  }

  _compileBody(raw, scope) {
    return raw.map((it) => {
      if (it.k === 'pos' || it.k === 'neg') {
        const pat = it.p.map((x) => this.term(x, scope));
        return { k: it.k, pat, raw: it.p };
      }
      if (it.k === 'from') return { k: 'from', ref: it.ref, scope, outSlots: [...this._outVars(it.ref)].map((v) => scope.slot(v)) };
      if (it.k === 'let') return { k: 'let', slot: scope.slot(it.v), ...this._compileExpr(it.toks, scope) };
      return { k: 'test', ...this._compileExpr(it.toks, scope) };
    });
  }

  // compiled body of a find/group/constraint/rule wire (cached)
  cbody(name) {
    let c = this.cb.get(name);
    if (c === undefined) {
      const w = this.wires.get(name);
      const scope = this._scopeFor(w);
      c = { scope, items: this._compileBody(this.rawBody.get(name) || [], scope), wire: w };
      this.cb.set(name, c);
    }
    return c;
  }

  _prepare() {
    const rid = (tok) => this.dict.intern(tok);
    this.ruleInfo = new Map();
    this.derivers = new Map(); // rel id -> [rule info]
    this.stratumOf = new Map();
    this.strata.forEach((names, k) => names.forEach((n) => this.stratumOf.set(n, k)));
    let idx = 0;
    for (const w of this.rules) {
      const c = this.cbody(w.name);
      const heads = this.rawHeads.get(w.name).map((h) => h.map((x) => this.term(x, c.scope)));
      const info = { name: w.name, idx: idx++, body: c, heads, headRels: [...new Set(heads.map((h) => h[1].c))], stratum: this.stratumOf.get(w.name) };
      this.ruleInfo.set(w.name, info);
      for (const r of info.headRels) { if (!this.derivers.has(r)) this.derivers.set(r, []); this.derivers.get(r).push(info); }
    }
    // dependencies (relation ids; ALL when a view uses a variable relation)
    const viewDeps = (name, seen = new Set()) => {
      const out = new Set();
      if (seen.has(name)) return out;
      seen.add(name);
      for (const it of this.rawBody.get(name) || []) {
        if (it.k === 'pos' || it.k === 'neg') out.add(isVar(it.p[1]) ? ALL : rid(it.p[1]));
        else if (it.k === 'from') for (const r of viewDeps(it.ref, seen)) out.add(r);
      }
      return out;
    };
    this._viewDeps = viewDeps;
    for (const info of this.ruleInfo.values()) {
      const all = new Set(), nonmono = new Set();
      const collect = (name, seen, isOverrider) => {
        if (seen.has(name)) return;
        seen.add(name);
        for (const it of this.rawBody.get(name)) {
          if (it.k === 'pos') { const r = rid(it.p[1]); all.add(r); if (isOverrider) nonmono.add(r); }
          else if (it.k === 'neg') { const r = rid(it.p[1]); all.add(r); nonmono.add(r); }
          else if (it.k === 'from') for (const r of viewDeps(it.ref)) { all.add(r); nonmono.add(r); }
        }
        for (const o of this.overriders.get(name) || []) {
          if (this.inactive.has(o)) continue;
          if (this.wires.get(o).type === 'rule') collect(o, seen, true);
          else for (const t of this.factTriples.get(o) || []) { all.add(t[1]); nonmono.add(t[1]); }
        }
      };
      collect(info.name, new Set(), false);
      info.deps = all; info.nonmono = nonmono;
      info.posRels = info.body.items.filter((it) => it.k === 'pos').map((it) => it.pat[1].c);
    }
    this.allRels = new Set(this.baseTriples.map((t) => t[1]));
    for (const info of this.ruleInfo.values()) { for (const r of info.deps) if (r !== ALL) this.allRels.add(r); for (const h of info.headRels) this.allRels.add(h); }
    // forward graph: rel -> heads of rules depending on it
    this.dependents = new Map();
    this.anyDependents = new Set();
    for (const info of this.ruleInfo.values()) {
      for (const r of info.deps) {
        if (r === ALL) { for (const h of info.headRels) this.anyDependents.add(h); continue; }
        if (!this.dependents.has(r)) this.dependents.set(r, new Set());
        for (const h of info.headRels) this.dependents.get(r).add(h);
      }
    }
    // trigger index: rel -> { any: [[info, j]], byS: Map c -> [[info, j, oc]], byO: Map c -> [[info, j]] }
    this.triggers = new Map();
    for (const info of this.ruleInfo.values()) {
      info.body.items.forEach((it, j) => {
        if (it.k !== 'pos') return;
        const r = it.pat[1].c;
        let tr = this.triggers.get(r);
        if (!tr) { tr = { any: [], byS: new Map(), byO: new Map() }; this.triggers.set(r, tr); }
        const [S, , O] = it.pat;
        if (S.c !== undefined) { if (!tr.byS.has(S.c)) tr.byS.set(S.c, []); tr.byS.get(S.c).push([info, j, O.c]); }
        else if (O.c !== undefined) { if (!tr.byO.has(O.c)) tr.byO.set(O.c, []); tr.byO.get(O.c).push([info, j]); }
        else tr.any.push([info, j]);
      });
    }
    this.baseStore = new Store();
    for (const t of this.baseTriples) this.baseStore.add(t[0], t[1], t[2]);
    this.baseWorld = new World(this, this.baseStore, new Set());
  }

  // ------------------------------------------------------------------ matching and joins
  _res(T, env) { return T.c !== undefined ? T.c : env[T.v]; }

  // cb(triple, env) for every fact matching pat under env
  _match(store, pat, env, cb) {
    const R = pat[1];
    const r = this._res(R, env);
    if (r === undefined) {
      for (const [rr, t] of store.tables) {
        if (!t.size) continue;
        const e = env.slice(); e[R.v] = rr;
        this._matchRel(t, rr, pat, e, cb);
      }
      return;
    }
    const t = store.get(r);
    if (t !== undefined) this._matchRel(t, r, pat, env, cb);
  }
  _matchRel(t, r, pat, env, cb) {
    const S = pat[0], O = pat[2];
    const s = this._res(S, env), o = this._res(O, env);
    if (s !== undefined && o !== undefined) { if (t.has(s, o)) cb([s, r, o], env); }
    else if (s !== undefined) t.forS(s, (oo) => { const e = env.slice(); e[O.v] = oo; return cb([s, r, oo], e); });
    else if (o !== undefined) t.forO(o, (ss) => { const e = env.slice(); e[S.v] = ss; return cb([ss, r, o], e); });
    else if (S.v === O.v) t.forAll((ss, oo) => { if (ss === oo) { const e = env.slice(); e[S.v] = ss; return cb([ss, r, oo], e); } return undefined; });
    else t.forAll((ss, oo) => { const e = env.slice(); e[S.v] = ss; e[O.v] = oo; return cb([ss, r, oo], e); });
  }
  _exists(store, pat, env) {
    let found = false;
    const R = pat[1];
    const r = this._res(R, env);
    const test = (t, rr, e) => { this._matchRel(t, rr, pat, e, () => { found = true; return true; }); };
    if (r === undefined) {
      for (const [rr, t] of store.tables) { if (!t.size) continue; const e = env.slice(); e[R.v] = rr; test(t, rr, e); if (found) break; }
    } else { const t = store.get(r); if (t !== undefined) test(t, r, env); }
    return found;
  }
  _unify(pat, t, env) {
    let e = env;
    for (let i = 0; i < 3; i++) {
      const T = pat[i];
      if (T.c !== undefined) { if (T.c !== t[i]) return null; continue; }
      const cur = e[T.v];
      if (cur === undefined) { if (e === env) e = env.slice(); e[T.v] = t[i]; }
      else if (cur !== t[i]) return null;
    }
    return e;
  }

  _estimate(store, it, bound) {
    if (it.k === 'from') return it._rows.length;
    const [S, R, O] = it.pat;
    if (R.c === undefined && !bound.has(R.v)) return store.size + 1;
    if (R.c === undefined) return store.size / Math.max(1, store.tables.size);
    const t = store.get(R.c);
    if (t === undefined) return 0;
    const sb = S.c !== undefined || bound.has(S.v), ob = O.c !== undefined || bound.has(O.v);
    if (sb && ob) return S.c !== undefined && O.c !== undefined ? (t.has(S.c, O.c) ? 1 : 0) : 1;
    if (S.c !== undefined) return t.countS(S.c);
    if (O.c !== undefined) return t.countO(O.c);
    if (sb) return t.size / Math.max(1, t.nS);
    if (ob) return t.size / Math.max(1, t.nO);
    return t.size;
  }

  // Evaluate a compiled body. Returns [[env, support], ...] (deduplicated by env).
  // delta: { j, facts } restricts item j to the given facts (semi-naive variant).
  solve(cb, store, env0 = null, { sup = false, delta = null, sort = false } = {}) {
    const n = cb.scope.size;
    const start = env0 ? env0 : new Array(n);
    if (start.length < n) start.length = n;
    const joins = [];
    let npos = 0;
    cb.items.forEach((it, j) => {
      if (it.k === 'pos') joins.push({ ...it, j, pi: npos++ });
      else if (it.k === 'from') joins.push({ ...it, j, _rows: this._rowsFor(it.ref, store) });
    });
    let order;
    if (delta) {
      const d = joins.find((x) => x.j === delta.j);
      order = [d, ...this._order(store, joins.filter((x) => x !== d), start, d)];
    } else order = this._order(store, joins, start, null);
    const out = [];
    const seen = new Set();
    const post = cb.items.filter((it) => it.k === 'let' || it.k === 'test' || it.k === 'neg');
    const finish = (env, s) => {
      for (const it of post) {
        if (it.k === 'neg') { if (this._exists(store, it.pat, env)) return; }
        else if (it.k === 'test') { if (this._eval(it, env) !== true) return; }
        else {
          const v = this._eval(it, env);
          if (v === undefined) return;
          const id = this.dict.intern(v);
          if (env[it.slot] !== undefined) { if (env[it.slot] !== id) return; }
          else { env = env.slice(); env[it.slot] = id; }
        }
      }
      const key = env.join(',');
      if (seen.has(key)) return;
      seen.add(key);
      out.push([env, s]);
    };
    const rec = (i, env, s) => {
      if (i === order.length) { finish(env, s); return; }
      const it = order[i];
      if (it.k === 'pos') {
        if (delta && i === 0) {
          for (const t of delta.facts) {
            const e = this._unify(it.pat, t, env);
            if (e !== null) { let s2 = null; if (sup) { s2 = s.slice(); s2[it.pi] = t; } rec(1, e, s2); }
          }
          return;
        }
        this._match(store, it.pat, env, (t, e) => { let s2 = null; if (sup) { s2 = s.slice(); s2[it.pi] = t; } rec(i + 1, e, s2); });
      } else {
        for (const row of it._rows) {
          let e = env, ok = true;
          for (const k in row) {
            const slot = it.scope.map.get(k);
            if (slot === undefined) continue;
            const v = row[k];
            if (e[slot] === undefined) { if (e === env) e = env.slice(); e[slot] = v; }
            else if (e[slot] !== v) { ok = false; break; }
          }
          if (ok) rec(i + 1, e, s);
        }
      }
    };
    if (!order.some((it) => it.k === 'pos' && it.pat[1].c !== undefined && !store.get(it.pat[1].c) && !(delta && it.j === delta.j))) {
      rec(0, start, sup ? new Array(npos) : null);
    }
    if (sort) this._sortEnvs(out, cb.scope);
    return out;
  }

  _order(store, items, env0, first) {
    if (!this.opts.joinOrder) return items;
    const bound = new Set();
    env0.forEach((v, i) => { if (v !== undefined) bound.add(i); });
    const bind = (it) => {
      if (it.k === 'pos') { for (const T of it.pat) if (T.v !== undefined) bound.add(T.v); }
      else for (const sl of it.outSlots) bound.add(sl);
    };
    if (first) bind(first);
    const rest = items.slice(), out = [];
    while (rest.length) {
      let bi = 0, best = Infinity;
      for (let i = 0; i < rest.length; i++) {
        const e = this._estimate(store, rest[i], bound);
        if (e < best) { best = e; bi = i; }
      }
      const it = rest.splice(bi, 1)[0];
      out.push(it); bind(it);
    }
    return out;
  }

  _eval(it, env) {
    return evalExpr(it.ast, it.vars, (slot) => { const id = env[slot]; return id === undefined ? undefined : this.dict.val(id); });
  }

  _sortEnvs(envs, scope) {
    const keyOf = (env) => {
      const k = [];
      env.forEach((id, slot) => { if (id !== undefined) k.push([scope.names[slot], this.dict.str(id)]); });
      return k.sort((a, b) => cmpStr(a[0], b[0]) || cmpStr(a[1], b[1]));
    };
    const keyed = envs.map((x) => [keyOf(x[0]), x]);
    keyed.sort((a, b) => cmpKeyLists(a[0], b[0]));
    for (let i = 0; i < envs.length; i++) envs[i] = keyed[i][1];
  }

  envToRow(env, scope) {
    const row = {};
    env.forEach((id, slot) => { if (id !== undefined) row[scope.names[slot]] = id; });
    return row;
  }

  // ------------------------------------------------------------------ saturation
  _newSat(world) {
    const sat = new Store();
    sat.done = new Set(); sat.views = new Map(); sat.world = world;
    const base = world.base;
    base.owned = new Set(); // freeze: later writes to the world's base go to overlays
    const prev = world.prevSat;
    if (prev === null || !this.opts.incremental || !this.opts.lazy) {
      for (const [r, t] of base.tables) sat.share(r, t);
      return sat;
    }
    prev.owned = new Set();
    const A = this._affected(world.dirty);
    for (const [r, t] of base.tables) sat.share(r, t);
    // RS: affected relations that must be recomputed from scratch (lazily, when next needed).
    // Everything else in the affected cone is continued incrementally from the parent's state.
    // Removals, and relations reached through negation / aggregation / overrides, go to RS
    // together with everything downstream of them.
    let RS;
    if (A === ALL || world.removed || !this.opts.seminaive) RS = A;
    else {
      const NM = new Set();
      for (const r of A) {
        if (!prev.done.has(r)) continue;
        for (const info of this.derivers.get(r) || []) {
          let bad = false;
          for (const x of info.nonmono) if (x === ALL || A.has(x)) { bad = true; break; }
          if (bad) { for (const h of info.headRels) NM.add(h); }
        }
      }
      RS = NM.size ? this._affected(NM) : NM;
    }
    const allReset = RS === ALL;
    for (const r of prev.done) {
      if (allReset || RS.has(r)) continue;
      const t = prev.get(r);
      if (t !== undefined) sat.share(r, t); else sat.tables.delete(r); // never the current base table
      sat.done.add(r);
    }
    if (!allReset && RS !== A) {
      const delta = new Map();
      for (const t of world.added) {
        if (!sat.done.has(t[1])) continue;
        if (sat.add(t[0], t[1], t[2])) { if (!delta.has(t[1])) delta.set(t[1], []); delta.get(t[1]).push(t); }
      }
      this.stats.incremental = (this.stats.incremental || 0) + 1;
      if (delta.size) this._continue(sat, delta);
    }
    return sat;
  }

  _affected(dirty) {
    const A = new Set(dirty);
    const q = [...dirty];
    if (this.anyDependents.size) for (const h of this.anyDependents) if (!A.has(h)) { A.add(h); q.push(h); }
    while (q.length) {
      const r = q.pop();
      for (const h of this.dependents.get(r) || []) if (!A.has(h)) { A.add(h); q.push(h); }
    }
    return A;
  }

  // relations needed to answer something that reads `rels` (backward dependency closure)
  _closure(rels) {
    if (rels === ALL || rels.has(ALL)) return ALL;
    const D = new Set(rels), q = [...rels];
    while (q.length) {
      const r = q.pop();
      for (const info of this.derivers.get(r) || []) {
        for (const d of info.deps) {
          if (d === ALL) return ALL;
          if (!D.has(d)) { D.add(d); q.push(d); }
        }
        for (const h of info.headRels) if (!D.has(h)) { D.add(h); q.push(h); }
      }
    }
    return D;
  }

  _ensure(sat, need) {
    if (sat.complete) return;
    let target = this.opts.lazy ? this._closure(need) : ALL;
    if (target === ALL) target = null;
    const runAll = target === null;
    const todo = [];
    for (const names of this.strata) {
      const infos = [];
      for (const n of names) {
        const info = this.ruleInfo.get(n);
        const pending = info.headRels.some((h) => !sat.done.has(h) && (runAll || target.has(h)));
        if (pending) infos.push(info);
      }
      todo.push(infos);
    }
    if (target) for (const r of target) if (!this.derivers.has(r)) sat.done.add(r);
    todo.forEach((infos, k) => {
      if (!infos.length) return;
      this._runStratum(sat, k, infos, null);
      for (const info of infos) for (const h of info.headRels) sat.done.add(h);
    });
    if (runAll) {
      // every relation is final now, including base-only ones (needed by incremental children)
      for (const r of this.allRels) sat.done.add(r);
      for (const r of sat.tables.keys()) sat.done.add(r);
      sat.complete = true;
    }
  }

  _blocked(info, sat, cache, depth = 0) {
    if (depth > 20) throw new SopError(`override chain too deep / cyclic at @${info.name}`);
    let b = cache.get(info.name);
    if (b !== undefined) return b;
    b = new Set();
    for (const o of this.overriders.get(info.name) || []) {
      if (this.inactive.has(o)) continue;
      if (this.wires.get(o).type === 'fact') {
        for (const t of this.factTriples.get(o) || []) if (sat.has(t[0], t[1], t[2])) b.add(t[0] + ',' + t[1]);
      } else {
        const oi = this.ruleInfo.get(o);
        for (const [t] of this._derive(oi, sat, cache, depth + 1, null, false)) b.add(t[0] + ',' + t[1]);
      }
    }
    cache.set(info.name, b);
    return b;
  }

  // head triples of a rule (after suppression by its overriders)
  _derive(info, sat, cache, depth = 0, delta = null, sup = this.opts.provenance) {
    this.stats.ruleEvals++;
    const blocked = this.overriders.has(info.name) ? this._blocked(info, sat, cache, depth) : null;
    const out = [];
    for (const [env, s] of this.solve(info.body, sat, null, { sup, delta })) {
      for (const h of info.heads) {
        const t = [this._res(h[0], env), h[1].c, this._res(h[2], env)];
        if (t[0] === undefined || t[2] === undefined) continue;
        if (blocked !== null && blocked.has(t[0] + ',' + t[1])) continue;
        out.push([t, s]);
      }
    }
    return out;
  }

  _fire(info, results, sat, delta) {
    for (const [t, s] of results) {
      if (sat.add(t[0], t[1], t[2])) {
        this.stats.derived++;
        if (this.opts.provenance) sat.get(t[1]).setWhy(t[0], t[2], ['rule @' + info.name, s || []]);
        if (delta) { let d = delta.get(t[1]); if (!d) { d = []; delta.set(t[1], d); } d.push(t); }
      }
    }
  }

  _runStratum(sat, k, infos, seed) {
    this.stats.strataRuns++;
    const cache = new Map();
    if (!this.opts.seminaive) {
      let changed = true, rounds = 0;
      while (changed) {
        changed = false;
        if (++rounds > 10000) throw new SopError('fixpoint did not converge (unbounded arithmetic recursion?)');
        for (const info of infos) {
          const before = this.stats.derived;
          this._fire(info, this._derive(info, sat, new Map()), sat, null);
          if (this.stats.derived !== before) changed = true;
        }
      }
      return;
    }
    const inSet = new Set(infos.map((i) => i.idx));
    let delta = new Map();
    if (seed === null) for (const info of infos) this._fire(info, this._derive(info, sat, cache), sat, delta);
    else delta = seed;
    let rounds = 0;
    while (delta.size) {
      if (++rounds > 10000) throw new SopError('fixpoint did not converge (unbounded arithmetic recursion?)');
      this.stats.deltaRounds++;
      const next = new Map();
      for (const [info, j, facts] of this._triggered(delta, inSet)) {
        this._fire(info, this._derive(info, sat, cache, 0, { j, facts }), sat, next);
      }
      delta = next;
    }
  }

  // group delta facts by the rule atoms they can match
  _triggered(delta, inSet) {
    const groups = new Map();
    const push = (info, j, facts) => {
      if (!inSet.has(info.idx)) return;
      const key = info.idx * 1024 + j;
      let g = groups.get(key);
      if (!g) { g = [info, j, []]; groups.set(key, g); }
      for (const f of facts) g[2].push(f);
    };
    for (const [r, facts] of delta) {
      const tr = this.triggers.get(r);
      if (!tr) continue;
      for (const [info, j] of tr.any) push(info, j, facts);
      if (tr.byS.size) for (const f of facts) { const l = tr.byS.get(f[0]); if (l) for (const [info, j, oc] of l) if (oc === undefined || oc === f[2]) push(info, j, [f]); }
      if (tr.byO.size) for (const f of facts) { const l = tr.byO.get(f[2]); if (l) for (const [info, j] of l) push(info, j, [f]); }
    }
    return groups.values();
  }

  // propagate pure additions through monotone rules, stratum by stratum
  _continue(sat, delta) {
    const all = new Map();
    const addAll = (d) => { for (const [r, fs] of d) { if (!all.has(r)) all.set(r, []); all.get(r).push(...fs); } };
    addAll(delta);
    this.strata.forEach((names, k) => {
      const infos = names.map((n) => this.ruleInfo.get(n)).filter((i) => i.headRels.every((h) => sat.done.has(h)));
      if (!infos.length || !all.size) return;
      const inSet = new Set(infos.map((i) => i.idx));
      const cache = new Map();
      let d = new Map();
      for (const [info, j, facts] of this._triggered(all, inSet)) this._fire(info, this._derive(info, sat, cache, 0, { j, facts }), sat, d);
      addAll(d);
      let rounds = 0;
      while (d.size) {
        if (++rounds > 10000) throw new SopError('fixpoint did not converge (unbounded arithmetic recursion?)');
        const next = new Map();
        for (const [info, j, facts] of this._triggered(d, inSet)) this._fire(info, this._derive(info, sat, cache, 0, { j, facts }), sat, next);
        addAll(next);
        d = next;
      }
    });
  }

  // ------------------------------------------------------------------ relational wires
  _need(name) {
    const w = this.wires.get(name);
    if (w.type === 'find' || w.type === 'group') {
      const d = this._viewDeps ? this._viewDeps(name) : new Set([ALL]);
      return d.has(ALL) ? ALL : d;
    }
    if (w.type === 'check') {
      const s = new Set();
      for (const c of this.constraints) for (const r of this._viewDeps(c.name)) s.add(r);
      return s.has(ALL) ? ALL : s;
    }
    return ALL;
  }

  worldOf(w) {
    const l = w.one('in');
    if (!l) return this.baseWorld;
    return this.result(l.args[0].slice(1)).world;
  }

  // rows of a find/group/plan/check wire, evaluated on `store` (a saturated store)
  _rowsFor(name, store) {
    const w = this.wires.get(name);
    if (w.type === 'plan' || w.type === 'check') return this.result(name).rows;
    if (w.one('in')) store = this.worldOf(w).store(this._need(name));
    const cache = store.views; // keyed by wire object: query wires are replaced between queries
    if (cache && cache.has(w)) return cache.get(w);
    const cb = this.cbody(name);
    const envs = this.solve(cb, store).map((x) => x[0]);
    let rows;
    if (w.type === 'find') {
      const r = w.one('return');
      if (r) {
        const seen = new Set(); rows = [];
        const slots = r.args.map((v) => [v, cb.scope.map.get(v)]);
        for (const e of envs) {
          const row = {};
          for (const [v, sl] of slots) if (sl !== undefined && e[sl] !== undefined) row[v] = e[sl];
          const k = JSON.stringify(Object.entries(row).sort());
          if (!seen.has(k)) { seen.add(k); rows.push(row); }
        }
      } else rows = envs.map((e) => this.envToRow(e, cb.scope));
    } else rows = this._group(w, envs, cb.scope);
    if (cache) cache.set(w, rows);
    return rows;
  }

  _group(w, envs, scope) {
    const by = w.get('by').flatMap((l) => l.args);
    const bySlots = by.map((v) => scope.map.get(v));
    const groups = new Map();
    for (const e of envs) {
      const key = bySlots.map((sl) => (sl === undefined ? '' : e[sl])).join(',');
      let g = groups.get(key);
      if (!g) { g = { vals: bySlots.map((sl) => (sl === undefined ? undefined : e[sl])), es: [] }; groups.set(key, g); }
      g.es.push(e);
    }
    if (!by.length && !envs.length) groups.set('', { vals: [], es: [] });
    const out = [];
    for (const g of groups.values()) {
      const row = {};
      by.forEach((v, i) => { if (g.vals[i] !== undefined) row[v] = g.vals[i]; });
      for (const l of w.get(...AGGS)) {
        const sl = scope.map.get(l.args[0]);
        const vals = g.es.map((e) => e[sl]).filter((x) => x !== undefined);
        const nums = vals.map((id) => this.dict.val(id)).filter((v) => typeof v === 'number' || typeof v === 'boolean').map(Number);
        let v;
        if (l.kw === 'count') v = new Set(vals).size;
        else if (l.kw === 'sum') v = nums.reduce((a, b) => a + b, 0);
        else if (!nums.length) continue;
        else if (l.kw === 'min') v = Math.min(...nums);
        else if (l.kw === 'max') v = Math.max(...nums);
        else v = nums.reduce((a, b) => a + b, 0) / nums.length;
        row[l.args[2]] = this.dict.intern(Number.isInteger(v) ? v : Math.round(v * 1e6) / 1e6);
      }
      out.push(row);
    }
    return out;
  }

  // ------------------------------------------------------------------ worlds, plans, checks
  result(name) {
    if (this.results.has(name)) return this.results.get(name);
    const w = this.wires.get(name);
    let res;
    if (w.type === 'assume') {
      const world = this.worldOf(w).copy();
      for (const l of w.lines) if (['add', 'remove', 'set'].includes(l.kw)) this._apply(world, l.kw, l.args, (x) => x);
      res = { kind: 'assume', world, rows: [] };
    } else if (w.type === 'plan') {
      const world = this.worldOf(w).copy();
      const t = w.one('task');
      const [ok, steps, reason] = this.execTask(t.args[0], t.args.slice(1), world, 0);
      const title = t.args.map(fmtTok).join(' ');
      const rows = ok
        ? steps.map((s, i) => ({ '?n': this.dict.intern(i + 1), '?step': this.dict.intern(new Quoted(s)) }))
        : [{ '?status': this.dict.intern('blocked'), '?reason': this.dict.intern(new Quoted(reason)) }];
      res = { kind: 'plan', world, rows, ok, reason, title };
    } else if (w.type === 'check') {
      const world = this.worldOf(w);
      const st = world.store(this._need(name));
      const rows = [];
      for (const c of this.constraints) {
        const m = c.one('message');
        const cb = this.cbody(c.name);
        for (const [env] of this.solve(cb, st)) {
          const row = this.envToRow(env, cb.scope);
          row['?constraint'] = this.dict.intern(c.name);
          if (m && m.args.length) {
            const txt = m.args.map((a) => {
              if (isVar(a)) { const sl = cb.scope.map.get(a); return sl !== undefined && env[sl] !== undefined ? this.dict.str(env[sl]) : a; }
              return pyStr(a);
            }).join(' ');
            row['?message'] = this.dict.intern(new Quoted(txt));
          }
          rows.push(row);
        }
      }
      res = { kind: 'check', world, rows };
    } else if (w.type === 'find' || w.type === 'group') {
      const world = this.worldOf(w);
      res = { kind: w.type, world, rows: this._rowsFor(name, world.store(this._need(name))) };
    } else throw new SopError(`@${name} (${w.type}) cannot be evaluated as a query wire`);
    this.results.set(name, res);
    return res;
  }

  // sub(tok) -> token value (or the variable name when unbound)
  _apply(world, kind, pat, sub) {
    const t = pat.map(sub);
    if (kind === 'remove') {
      world.remove(t.map((x) => (isVar(x) ? null : this.dict.intern(x))));
      return;
    }
    if (t.some(isVar)) throw new SopError(`"${kind} ${fmtToks(t)}": unbound variable`);
    const ids = t.map((x) => this.dict.intern(x));
    if (kind === 'set') world.remove([ids[0], ids[1], null]);
    world.add(ids);
  }

  _methodC(name) {
    const m = this.meth.get(name);
    if (!m.c) {
      const scope = this._scopeFor(m.wire);
      m.c = {
        scope,
        params: m.params.map((p) => (isVar(p) ? { v: scope.slot(p) } : { tok: p })),
        app: { scope, items: this._compileBody(m.app, scope) },
        seq: m.seq.map((it) => {
          const x = { ...it };
          if (it.p) x.pat = it.p.map((t) => this.term(t, scope));
          if (it.k === 'require-test') Object.assign(x, this._compileExpr(it.toks, scope));
          return x;
        }),
      };
    }
    return m;
  }

  execTask(task, args, world, depth) {
    if (depth > 40) return [false, [], `recursion limit reached in task "${pyStr(task)}"`];
    const names = this.methods.get(tokKey(task));
    if (!names) return [true, [[task, ...args].map(pyStr).join(' ')], null];
    const hard = [], soft = [];
    const call = `${pyStr(task)} ${args.map(pyStr).join(' ')}`;
    for (const name of names) {
      const m = this._methodC(name);
      if (m.params.length !== args.length) continue;
      const env = new Array(m.c.scope.size);
      let ok = true;
      m.c.params.forEach((p, i) => {
        const aid = this.dict.intern(args[i]);
        if (p.v !== undefined) { if (env[p.v] !== undefined && env[p.v] !== aid) ok = false; env[p.v] = aid; }
        else if (!tokEq(p.tok, args[i])) ok = false;
      });
      if (!ok) continue;
      const envs = this.solve(m.c.app, world.store(ALL), env, { sort: true });
      if (!envs.length) { soft.push(`@${name}: its when/unless conditions do not hold for "${call}"`); continue; }
      for (const [e] of envs) {
        const w2 = world.copy();
        const steps = [];
        const reason = this._runSeq(m, name, e.slice(), w2, steps, depth);
        if (reason === null) { world.take(w2); return [true, steps, null]; }
        hard.push(reason);
      }
    }
    if (hard.length) return [false, [], hard[0]];
    if (soft.length) return [false, [], `no applicable method for "${call}" (${soft.join('; ')})`];
    return [false, [], `no method for "${pyStr(task)}" with ${args.length} argument(s)`];
  }

  _runSeq(m, name, env, world, steps, depth) {
    const scope = m.c.scope;
    const val = (x) => { if (!isVar(x)) return x; const sl = scope.map.get(x); return sl !== undefined && env[sl] !== undefined ? this.dict.tok(env[sl]) : x; };
    const sub = (xs) => xs.map(val);
    const fmtT = (t) => t.map((id) => this.dict.fmt(id)).join(' ');
    const hitsOf = (pat) => {
      const hits = [];
      this._match(world.store(ALL), pat, env, (t, e) => { hits.push([t, e]); });
      return hits.map((h) => [fmtT(h[0]), h]).sort((a, b) => cmpStr(a[0], b[0])).map((x) => x[1]);
    };
    for (const it of m.c.seq) {
      const k = it.k;
      if (k === 'require' || k === 'forbid') {
        const hit = hitsOf(it.pat)[0];
        if (k === 'require') {
          if (hit === undefined) return it.msg ? it.msg.s : `requirement not met: ${fmtToks(sub(it.p))} (@${name})`;
          env = hit[1];
        } else if (hit !== undefined) return it.msg ? it.msg.s : `forbidden condition holds: ${fmtT(hit[0])} (@${name})`;
      } else if (k === 'require-test') {
        if (this._eval(it, env) !== true) return it.msg ? it.msg.s : `test failed: ${sub(it.toks).map(pyStr).join(' ')} (@${name})`;
      } else if (k === 'step') steps.push(sub(it.args).map(pyStr).join(' '));
      else if (k === 'do') {
        const [ok, st, reason] = this.execTask(it.task, sub(it.args), world, depth + 1);
        if (!ok) return reason;
        steps.push(...st);
      } else if (k === 'forall') {
        for (const [, e2] of hitsOf(it.pat)) {
          const a = it.args.map((x) => { if (!isVar(x)) return x; const sl = scope.map.get(x); return sl !== undefined && e2[sl] !== undefined ? this.dict.tok(e2[sl]) : x; });
          const [ok, st, reason] = this.execTask(it.task, a, world, depth + 1);
          if (!ok) return reason;
          steps.push(...st);
        }
      } else this._apply(world, k, it.p, val);
    }
    return null;
  }

  // ------------------------------------------------------------------ output
  render(name) {
    const w = this.wires.get(name);
    const out = [];
    const src = w.type === 'answer' ? w.one('from').args[0].slice(1) : name;
    const res = this.result(src);
    const label = w.type === 'answer' ? w.one('text') : null;
    out.push(`== ${name}${label ? ' : ' + label.args.map(pyStr).join(' ') : ''} ==`);
    if (res.kind === 'plan') {
      if (res.ok) {
        out.push(`PLAN ${res.title}: OK (${res.rows.length} steps)`);
        res.rows.forEach((r) => out.push(`  ${this.dict.str(r['?n'])}. ${this.dict.str(r['?step'])}`));
      } else out.push(`PLAN ${res.title}: BLOCKED - ${res.reason}`);
      return out.join('\n');
    }
    let rows = res.rows;
    const show = w.type === 'answer' ? w.one('show') : null;
    if (show) {
      const seen = new Set(), proj = [];
      for (const r of rows) {
        const row = {};
        for (const v of show.args) if (typeof v === 'string' && v in r) row[v] = r[v];
        const k = JSON.stringify(Object.entries(row).sort());
        if (!seen.has(k)) { seen.add(k); proj.push(row); }
      }
      rows = proj;
    }
    const lines = rows.map((r) => Object.keys(r).sort(cmpStr).map((k) => `${k}=${this.dict.fmt(r[k])}`).join(' | ')).sort(cmpStr);
    for (const l of lines) out.push('  ' + l);
    out.push(`(${rows.length} row${rows.length === 1 ? '' : 's'})`);
    return out.join('\n');
  }

  explain(sat, t, depth = 0, seen = new Set(), out = []) {
    const world = sat.world;
    const key = t.join(',');
    const table = sat.get(t[1]);
    let why;
    if (table !== undefined && table.has(t[0], t[2])) {
      why = table.getWhy(t[0], t[2]);
      if (why === undefined) {
        const label = world && world.assumed.has(key) && !this.factSrc.has(key) ? 'assumed'
          : this.factSrc.has(key) || this.opts.provenance ? `fact @${this.factSrc.get(key) || '?'}` : 'derived (provenance off)';
        why = [label, []];
      }
    }
    out.push(`${'  '.repeat(depth)}${t.map((id) => this.dict.fmt(id)).join(' ')}   [${why ? why[0] : 'NOT DERIVED'}]`);
    if (why && !seen.has(key)) {
      seen.add(key);
      for (const s of why[1]) this.explain(sat, s, depth + 1, seen, out);
    }
    return out;
  }

  why(text) {
    const toks = lex(text);
    const st = this.baseWorld.store(ALL);
    const ids = toks.map((x) => this.dict.lookup(x));
    if (toks.length !== 3 || ids.some((x) => x === undefined)) return [`${fmtToks(toks)}   [NOT DERIVED]`];
    return this.explain(st, ids);
  }

  vocab() {
    const st = this.baseWorld.store(ALL);
    const out = ['# relations (base facts / total incl. derived)'];
    const baseN = new Map();
    for (const t of this.baseTriples) baseN.set(t[1], (baseN.get(t[1]) || 0) + 1);
    const derivedBy = new Map();
    for (const info of this.ruleInfo.values()) for (const r of info.headRels) { if (!derivedBy.has(r)) derivedBy.set(r, new Set()); derivedBy.get(r).add(info.name); }
    const rels = new Set([...derivedBy.keys()]);
    for (const [r, t] of st.tables) if (t.size) rels.add(r);
    const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
    const lpad = (s, n) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
    for (const r of [...rels].sort((a, b) => cmpStr(this.dict.str(a), this.dict.str(b)))) {
      const t = st.get(r);
      const objs = new Set();
      if (t) t.forAll((s, o) => { objs.add(this.dict.fmt(o)); });
      const sorted = [...objs].sort(cmpStr);
      const sample = sorted.slice(0, 8).join(', ') + (sorted.length > 8 ? ' ...' : '');
      const d = derivedBy.has(r) ? ' derived-by ' + [...derivedBy.get(r)].sort(cmpStr).map((x) => '@' + x).join(',') : '';
      out.push(`  ${pad(this.dict.str(r), 28)} ${lpad(String(baseN.get(r) || 0), 3)} / ${lpad(String(t ? t.size : 0), 3)}${d}   values: ${sample}`);
    }
    out.push('# tasks (methods)');
    const tasks = [...this.methods.values()].map((ns) => [pyStr(this.meth.get(ns[0]).task), ns]).sort((a, b) => cmpStr(a[0], b[0]));
    for (const [task, ns] of tasks) for (const n of ns) out.push(`  ${task} ${this.meth.get(n).params.map(pyStr).join(' ')}   (@${n})`);
    out.push('# constraints');
    for (const c of this.constraints) out.push(`  @${c.name}`);
    return out.join('\n');
  }

  lintSummary() {
    const st = this.baseWorld.store(ALL);
    return `OK: ${this.active.length - 2} wires, ${this.baseKeys.size} base facts, ${st.size} facts after inference, ` +
      `${this.rules.length - 2} rules in ${this.strata.length} strata, ${this.meth.size} methods, ` +
      `${this.constraints.length} constraints, ${this.warnings.length} warning(s)`;
  }

  // ------------------------------------------------------------------ query sessions
  // Replace the current query wires with new ones (the KB, its saturation and caches are kept).
  query(text) {
    for (const w of this.order.filter((x) => x.origin === 'query')) { this.wires.delete(w.name); this.cb.delete(w.name); this.rawBody.delete(w.name); }
    this.order = this.order.filter((x) => x.origin !== 'query');
    this.active = this.active.filter((x) => x.origin !== 'query');
    this.results = new Map();
    this.errors = []; this.warnings = [];
    const ws = parse(text, 'query');
    this._addWires(ws);
    const added = ws.filter((w) => this.wires.get(w.name) === w);
    this._checkKeywords(added, true);
    for (const w of added) if (w.type in KEYWORDS) { this.active.push(w); this._compileWire(w); }
    const kr = new Set(this.knownRels), ka = new Set(this.knownAtoms);
    this._lint(added.filter((w) => w.type in KEYWORDS));
    this.knownRels = kr; this.knownAtoms = ka;
    return this;
  }

  answers() {
    const names = this.order.filter((w) => w.origin === 'query' && w.type === 'answer').map((w) => w.name);
    if (names.length) return names;
    const qs = this.order.filter((w) => w.origin === 'query').map((w) => w.name);
    return qs.slice(-1);
  }
}

export { SopError, ALL, QUERY_TYPES };
