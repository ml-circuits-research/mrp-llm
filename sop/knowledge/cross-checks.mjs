/**
 * Cross-wire checks of the knowledge validator: constants against declared argument types, completeness-sensitive constructs
 * over open predicates, slice-aware `absent`, ordering operands, time leaves, key lint, governance (supersession, versions,
 * overrides, amendments), procedures (sub-tasks, step arity, strict prohibitions against strict methods) and stratification.
 */
import {STEP_BLOCKS} from './grammar.mjs';
import {VAR, SYMBOL, INTEGER, REF, DATE, tokens, atomFrom, leaves} from './lexical.mjs';

const typeOk = (type, t) => {
  if (VAR.test(t) || REF.test(t)) return true;
  switch (type) {
    case 'entity': return SYMBOL.test(t) || t.startsWith('"');
    case 'integer': return INTEGER.test(t);
    case 'text': return t.startsWith('"');
    case 'time': return DATE.test(t) || INTEGER.test(t);
    default: return true;
  }
};

/** Cross-wire checks of round 2: types, closed-world warnings, time leaves, governance, overrides, procedures. */
export function crossChecks({allWires, ctxs, predicates, problems, headOf, ruleSetComplete}) {
  const byId = new Map(allWires.map(w => [w.id, w]));
  const f1 = (w, k) => w.fields.find(x => x.key === k);
  const derived = new Set();
  for (const w of allWires) if (['rule', 'default', 'aggregate'].includes(w.type)) { const h = headOf(w); if (h) derived.add(h.p); }
  const add = (code, w, line, message, severity) => problems.push({code, file: w.file, line, message, wire: w.id, ...(severity ? {severity} : {})});
  // 1. constants against declared argument types
  for (const {file, wires, ctx} of ctxs) {
    const check = (a, w, line) => {
      const decl = predicates.get(a.p);
      if (!decl?.types) return;
      a.terms.forEach((t, i) => { if (decl.types[i] && !typeOk(decl.types[i], t)) problems.push({code: 'type_mismatch', file: file.name, line, message: `${a.p} argument ${i + 1} is declared ${decl.types[i]} but got ${t}`, wire: w}); });
    };
    for (const a of ctx.atoms) check(a, a.wire, a.line);
    for (const w of wires) for (const c of w.conds ?? []) for (const l of leaves(c.tree)) if (l.kind === 'atom' || l.kind === 'timeof') check(l, w.id, l.line);
  }
  // 2. completeness-sensitive constructs over open predicates (warnings: the host reports a lower bound or an open domain)
  const closedP = p => predicates.get(p)?.closed === true;
  for (const w of allWires) {
    const body = (keys) => (w.conds ?? []).filter(c => keys.includes(c.key)).flatMap(c => leaves(c.tree)).filter(l => l.kind === 'atom' && l.neg !== 'absent');
    if (w.type === 'aggregate') for (const l of body(['over'])) if (!closedP(l.p)) add('aggregate_needs_closed', w, l.line, `aggregate over ${l.p}: declare it closed, otherwise the result is a lower bound (bound at_least)`, 'warning');
    if (w.type === 'query') {
      const mode = f1(w, 'mode')?.value.trim() ?? 'select';
      if (mode === 'count') for (const l of body(['where'])) if (!closedP(l.p)) add('count_needs_closed', w, l.line, `count over ${l.p}: declare it closed, otherwise the count is a lower bound (bound at_least)`, 'warning');
      if (mode === 'every') for (const l of body(['where'])) if (!closedP(l.p)) add('every_needs_closed_scope', w, l.line, `every ranges over ${l.p}: declare it closed, otherwise the universal answer is unknown (open domain)`, 'warning');
    }
  }
  // 2b. slice-aware: absent over a derived predicate needs every rule with that head (and, recursively, with the heads of its
  // body predicates) to be in the slice. `ruleSetComplete` is the retrieval layer's manifest (predicate -> all rules present).
  if (ruleSetComplete) {
    const bodiesOf = new Map();
    for (const w of allWires.filter(x => ['rule', 'default', 'aggregate'].includes(x.type))) {
      const h = headOf(w);
      if (h) (bodiesOf.get(h.p) ?? bodiesOf.set(h.p, new Set()).get(h.p)).add(w);
    }
    const dep = p => { const out = new Set(), q = [p]; while (q.length) { const x = q.pop(); if (out.has(x)) continue; out.add(x); for (const w of bodiesOf.get(x) ?? []) for (const c of w.conds ?? []) for (const l of leaves(c.tree)) if (l.kind === 'atom') q.push(l.p); } return out; };
    for (const w of allWires) for (const c of w.conds ?? []) for (const l of leaves(c.tree)) if (l.kind === 'atom' && l.neg === 'absent') {
      const bad = [...dep(l.p)].find(x => ruleSetComplete[x] === false);
      if (bad) add('absent_over_incomplete_rules', w, l.line, `absent ${l.p} depends on ${bad}, whose rule set is not entirely in the slice: absence cannot be concluded`);
    }
  }
  // 3. ordering comparisons need integer or time operands
  for (const w of allWires) {
    const varType = new Map();
    for (const c of w.conds ?? []) for (const l of leaves(c.tree)) if (l.kind === 'atom' && l.neg !== 'absent') {
      const types = predicates.get(l.p)?.types;
      l.terms.forEach((t, i) => { if (VAR.test(t) && types?.[i]) varType.set(t, types[i]); });
    }
    for (const c of w.conds ?? []) for (const l of leaves(c.tree)) if (l.kind === 'compare' && !['equal', 'not_equal'].includes(l.word)) for (const t of [l.left, l.right]) if (['entity', 'text'].includes(varType.get(t))) add('compare_on_entity', w, l.line, `${l.word} compares numbers or times, but ${t} is declared ${varType.get(t)}`);
  }
  // 4. start_of and end_of read stored validity, so they cannot apply to derived atoms
  for (const w of allWires) for (const c of w.conds ?? []) for (const l of leaves(c.tree)) if (l.kind === 'timeof' && derived.has(l.p)) add('time_leaf_on_derived', w, l.line, `${l.which} ${l.p}: ${l.p} is derived; its validity is the intersection of its body (snapshot semantics), not a stored interval`);
  // 5. key lint: a declared key position determines the rest (advisory, a warning)
  const seenKey = new Map();
  for (const w of allWires.filter(x => x.type === 'fact')) {
    const a = atomFrom(tokens(f1(w, 'holds')?.value ?? ''), {allowNeg: true});
    if (a.error) continue;
    const decl = predicates.get(a.p);
    if (!decl?.key || a.neg === 'not') continue;
    const k = a.p + '|' + a.terms[decl.key - 1], rest = a.terms.filter((_, i) => i !== decl.key - 1).join(' ');
    if (seenKey.has(k) && seenKey.get(k) !== rest && !f1(w, 'valid')) add('key_violation', w, w.line, `${a.p}: key position ${decl.key} is ${a.terms[decl.key - 1]} in two facts with different values (declare valid intervals or fix the data)`, 'warning');
    seenKey.set(k, rest);
  }
  // 6. governance: supersession, versions, overrides, amendments
  for (const w of allWires) {
    const sup = f1(w, 'supersedes')?.value.trim().slice(1);
    if (sup) {
      const t = byId.get(sup);
      if (t) {
        if (t.type !== w.type) add('supersedes_type_mismatch', w, f1(w, 'supersedes').line, `${w.id} (${w.type}) supersedes ${sup} (${t.type})`);
        const v1 = Number(f1(w, 'version')?.value), v0 = Number(f1(t, 'version')?.value);
        if (v1 && v0 && v1 <= v0) add('version_not_increasing', w, f1(w, 'supersedes').line, `version ${v1} does not exceed the superseded version ${v0}`);
        const approvedNew = (f1(w, 'approval')?.value.trim() ?? 'approved') === 'approved';
        const oldState = f1(t, 'approval')?.value.trim() ?? 'approved';
        if (approvedNew && oldState === 'approved') add('superseded_not_marked', w, f1(w, 'supersedes').line, `${sup} is superseded by the approved ${w.id}: mark it approval superseded`);
      }
    }
    if (w.type === 'amendment') {
      for (const m of w.fields.filter(x => x.key === 'members')) for (const id of tokens(m.value)) { const t = byId.get(id.slice(1)); if (t && !['proposed', 'contested'].includes(f1(t, 'approval')?.value.trim() ?? 'approved')) add('amendment_member_not_proposed', w, m.line, `amendment member ${t.id} must have approval proposed (or contested)`); }
      if (!w.fields.some(x => x.key === 'members' || x.key === 'removes')) add('amendment_empty', w, w.line, 'an amendment proposes members or removes something');
    }
  }
  // overrides: same subject, opposite force (norms) or contrary heads (defaults); no cycles
  const edges = [];
  for (const w of allWires.filter(x => ['norm', 'default'].includes(x.type))) for (const o of w.fields.filter(x => x.key === 'overrides')) {
    const t = byId.get(o.value.trim().slice(1));
    if (!t) continue;
    edges.push([w.id, t.id]);
    if (w.type !== t.type) { add('overrides_target_mismatch', w, o.line, `${w.id} (${w.type}) overrides ${t.id} (${t.type})`); continue; }
    if (w.type === 'norm') {
      const subj = x => x.normPat?.action ? '~' + x.normPat.action : x.normPat?.pred;
      const pairs = ['forbid|permit', 'permit|forbid', 'forbid|oblige', 'oblige|forbid'];
      if (subj(w) !== subj(t) || !pairs.includes(w.modality + '|' + t.modality)) add('overrides_target_mismatch', w, o.line, `${w.id} (${w.modality} ${subj(w)}) cannot override ${t.id} (${t.modality} ${subj(t)}): overrides needs the same subject and opposite force`);
    } else {
      const hw = headOf(w), ht = headOf(t);
      if (!hw || !ht || hw.p !== ht.p || hw.neg === ht.neg || hw.terms.length !== ht.terms.length) add('overrides_not_contrary', w, o.line, `${w.id} overrides ${t.id}, but their conclusions are not contrary atoms of one predicate`);
    }
  }
  const adj = new Map();
  for (const [a, b] of edges) (adj.get(a) ?? adj.set(a, []).get(a)).push(b);
  const onCycle = start => { const seen = new Set(), q = [...(adj.get(start) ?? [])]; while (q.length) { const x = q.pop(); if (x === start) return true; if (seen.has(x)) continue; seen.add(x); q.push(...(adj.get(x) ?? [])); } return false; };
  for (const id of new Set(edges.map(e => e[0]))) if (onCycle(id)) { add('overrides_cycle', byId.get(id), byId.get(id).line, `overrides forms a cycle through ${id}`); break; }
  // 7. procedures: sub-tasks have methods, steps match action parameters, strict prohibitions do not contradict strict methods
  const methodHeads = new Set(allWires.filter(w => w.type === 'method').map(w => { const a = atomFrom(tokens(f1(w, 'achieves')?.value ?? '')); return a.error ? null : a.p; }).filter(Boolean));
  const actionParams = new Map(allWires.filter(w => w.type === 'action').map(w => [w.id, tokens(f1(w, 'params')?.value ?? '').length]));
  for (const {file, ctx} of ctxs) {
    for (const t of ctx.tasksCalled ?? []) if (!methodHeads.has(t.p)) problems.push({code: 'subtask_without_method', file: file.name, line: t.line, message: `sub-task ${t.p} has no method that achieves it`, wire: t.wire});
    for (const sc of ctx.stepCalls ?? []) if (actionParams.has(sc.action) && actionParams.get(sc.action) !== sc.n) problems.push({code: 'step_arity_mismatch', file: file.name, line: sc.line, message: `~${sc.action} takes ${actionParams.get(sc.action)} parameter(s), the step gives ${sc.n}`, wire: sc.wire});
  }
  for (const m of allWires.filter(w => w.type === 'method' && (f1(w, 'binding')?.value.trim() ?? 'strict') === 'strict' && (f1(w, 'approval')?.value.trim() ?? 'approved') === 'approved')) {
    const mandatory = new Set();
    let depth = 0;
    for (const f of m.fields.filter(x => x.key === 'step')) {
      const head = tokens(f.value)[0];
      if (STEP_BLOCKS.includes(head)) continue;
      if (head?.startsWith('~')) mandatory.add(head.slice(1));
    }
    void depth;
    for (const n of allWires.filter(w => w.type === 'norm' && w.modality === 'forbid' && (f1(w, 'severity')?.value.trim() ?? 'hard') === 'hard' && (f1(w, 'binding')?.value.trim() ?? 'strict') === 'strict' && !f1(w, 'when') && (f1(w, 'approval')?.value.trim() ?? 'approved') === 'approved')) if (n.normPat?.action && mandatory.has(n.normPat.action)) add('strict_forbid_conflicts_method', n, n.line, `strict hard norm ${n.id} forbids ~${n.normPat.action}, a mandatory step of the strict method ${m.id}`);
  }
}

export function negativeCycle(edges) {
  const adj = new Map();
  for (const e of edges) { if (!adj.has(e.from)) adj.set(e.from, []); adj.get(e.from).push(e); }
  // A negative edge u->v is on a cycle iff v reaches u.
  const reach = (start, goal) => {
    const seen = new Set([start]), q = [start];
    while (q.length) { const x = q.shift(); if (x === goal) return true; for (const e of adj.get(x) ?? []) if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); } }
    return false;
  };
  for (const e of edges) if (e.neg && reach(e.to, e.from)) return {path: [e.from, e.to, '...', e.from], wire: e.wire, file: e.file, line: e.line};
  return null;
}

