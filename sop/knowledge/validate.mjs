/**
 * The knowledge validator (DS004): per-wire checks (`validateWires`: fields, cardinality, references, safety of variables,
 * modes of work) and whole-program checks (`validateProgram`: unique ids, arity, closed-world discipline, stratification,
 * then `crossChecks`). `authoring: true` is the mode of a wire author: the governance fields the host writes at ingestion are
 * ignored with a warning and `approval_incomplete` is left to ingestion.
 */
import {GRAMMAR, STEP_BLOCKS, HOST_WRITTEN} from './grammar.mjs';
import {ORDER_SAMPLING, ORDER_SAMPLING_MODES, CANDIDATE_MODES, MAX_CANDIDATES} from '../enums.mjs';
import {VAR, tokens, atomFrom, varsOf, parse, leaves} from './lexical.mjs';
import {checkValue} from './validate-fields.mjs';
import {isNumericAction, checkNumericAction, stateVariables} from './numeric-action.mjs';
import {crossChecks, negativeCycle} from './cross-checks.mjs';
import {lexiconChecks, roleArgSpecs} from './lexicon-checks.mjs';

/** Validate parsed wires; returns problems. `programs` is used for cross-wire checks (refs, arity, safety, stratification). */
export function validateWires(wires, {role = 'knowledge', parseErrors = [], authoring = false, allowSealed = false} = {}) {
  const problems = [...parseErrors];
  const ctx = {problems, refs: [], atoms: [], tasksCalled: []};
  const byId = new Map(wires.map(w => [w.id, w]));
  let stateVars;
  for (const w of wires) {
    const g = GRAMMAR[w.type];
    if (!g) { problems.push({code: 'unknown_wire_type', line: w.line, message: 'unknown wire type "' + w.type + '"', wire: w.id}); continue; }
    if (role === 'knowledge' && g.side === 'query' && w.type !== 'constraint') problems.push({code: 'wrong_file_role', line: w.line, message: w.type + ' belongs in the query circuit', wire: w.id});
    const supposition = w.type === 'fact' && ['supposed', 'hedged'].includes(w.fields.find(x => x.key === 'status')?.value.trim());
    if (role === 'query' && g.side === 'knowledge' && !supposition) problems.push({code: 'wrong_file_role', line: w.line, message: w.type + ' belongs in the knowledge circuits', wire: w.id});
    const seen = new Map();
    for (const f of w.fields) {
      const spec = g.fields[f.key];
      if (!spec) { problems.push({code: 'unknown_field', line: f.line, message: w.type + ' has no field "' + f.key + '"', wire: w.id}); continue; }
      seen.set(f.key, (seen.get(f.key) ?? 0) + 1);
      if (spec.card === 'one' && seen.get(f.key) > 1) problems.push({code: 'repeated_field', line: f.line, message: f.key + ' may appear once', wire: w.id});
      checkValue(spec, f, w, ctx);
    }
    for (const [k, spec] of Object.entries(g.fields)) if (spec.required && !seen.has(k)) problems.push({code: 'missing_field', line: w.line, message: w.type + ' needs ' + k, wire: w.id});
    typeChecks(w, problems, {authoring, allowSealed});
    if (isNumericAction(w)) for (const p of checkNumericAction(w, stateVars ??= stateVariables(wires))) problems.push({...p, line: w.line, wire: w.id});
  }
  for (const r of ctx.refs) {
    const target = byId.get(r.id);
    if (!target) problems.push({code: 'unknown_ref', line: r.line, message: 'reference to unknown wire ' + r.id, wire: r.wire});
  }
  return {problems, ctx};
}

function typeChecks(w, problems, {authoring = false, allowSealed = false} = {}) {
  const push = (code, message, line = w.line) => problems.push({code, line, message, wire: w.id});
  const f = key => w.fields.find(x => x.key === key);
  const positiveVars = new Set();
  for (const c of w.conds ?? []) if (!['except', 'never_neg'].includes(c.key)) for (const l of leaves(c.tree)) if (l.kind === 'atom' && l.neg !== 'absent') varsOf(l.terms).forEach(v => positiveVars.add(v));
  for (const c of w.conds ?? []) for (const l of leaves(c.tree)) if (l.kind === 'compute') positiveVars.add(l.out);
  const boundBy = (conds) => {
    const b = new Set();
    for (const c of conds) for (const l of leaves(c.tree)) { if (l.kind === 'atom' && l.neg !== 'absent') varsOf(l.terms).forEach(v => b.add(v)); if (l.kind === 'timeof') { b.add(l.out); varsOf(l.terms).forEach(v => b.add(v)); } if (l.kind === 'compute') b.add(l.out); if (l.kind === 'match') l.roles.forEach(r => { if (VAR.test(r.value)) b.add(r.value); }); }
    return b;
  };
  const bodyKeys = {rule: ['when'], default: ['when'], integrity: ['never'], aggregate: ['over'], method: ['when'], norm: ['when'], goal: ['where'], query: ['where']};
  const bodyConds = (w.conds ?? []).filter(c => (bodyKeys[w.type] ?? []).includes(c.key));
  const bound = boundBy(bodyConds);
  // a method's own parameters (the achieves atom) and a norm's pattern variables are bound by the action parameters
  if (w.type === 'method' && f('achieves')) { const a = atomFrom(tokens(f('achieves').value)); if (!a.error) varsOf(a.terms).forEach(v => bound.add(v)); }
  if (w.type === 'norm' && w.normPat) varsOf(w.normPat.terms).forEach(v => bound.add(v));
  // Safety: every variable used under absent, compare, compute inputs, the head and select must be bound positively.
  for (const c of w.conds ?? []) for (const l of leaves(c.tree)) {
    if (l.kind === 'atom' && l.neg === 'absent') for (const v of varsOf(l.terms)) if (!bound.has(v) && c.key !== 'except') push('unsafe_negation', 'variable ' + v + ' under absent is not bound by a positive atom', l.line);
    if (l.kind === 'compare') for (const v of varsOf([l.left, l.right])) if (!bound.has(v)) push('unsafe_variable', 'variable ' + v + ' in compare is not bound by a positive atom', l.line);
    if (l.kind === 'compute') for (const v of varsOf([l.left, l.right])) if (!bound.has(v)) push('unsafe_variable', 'variable ' + v + ' in compute is not bound', l.line);
    if (l.kind === 'order') for (const v of [l.left, l.right]) if (!bound.has(v)) push('unsafe_variable', 'time variable ' + v + ' in order is not bound by start_of or end_of', l.line);
  }
  if (w.type === 'rule' || w.type === 'default') {
    const then = f('then') && atomFrom(tokens(f('then').value), {allowNeg: true});
    if (then && !then.error) for (const v of varsOf(then.terms)) if (!bound.has(v)) push('unsafe_head', 'head variable ' + v + ' does not occur in a positive body atom', f('then').line);
    if (w.type === 'default') for (const c of (w.conds ?? []).filter(c => c.key === 'except')) for (const l of leaves(c.tree)) if (l.kind === 'atom') for (const v of varsOf(l.terms)) if (!bound.has(v)) push('unsafe_exception', 'exception variable ' + v + ' is not bound by the body', l.line);
  }
  if (w.type === 'aggregate') {
    const aggs = w.aggs ?? [];
    if (aggs.length !== 1) push('aggregate_one_function', 'an aggregate needs exactly one of count|sum|min|max|collect');
    const group = f('group') ? tokens(f('group').value) : [];
    for (const a of aggs) {
      if (a.fn !== 'count' && !a.field) push('aggregate_field', a.fn + ' needs a field');
      if (a.field && !bound.has(a.field)) push('unsafe_variable', 'aggregated field ' + a.field + ' is not bound in over');
      for (const g of group) if (!bound.has(g)) push('unsafe_variable', 'group variable ' + g + ' is not bound in over');
      const y = f('yields') && atomFrom(tokens(f('yields').value));
      if (y && !y.error) for (const v of varsOf(y.terms)) if (!group.includes(v) && v !== a.out) push('unsafe_head', 'yields variable ' + v + ' is neither grouped nor the output');
    }
  }
  if (w.type === 'action') {
    const params = f('params') ? tokens(f('params').value) : [];
    const req = new Set();
    for (const x of w.fields.filter(x => x.key === 'requires')) { const a = atomFrom(tokens(x.value), {allowNeg: true}); if (!a.error) varsOf(a.terms).forEach(v => req.add(v)); }
    for (const p of params) if (!req.has(p)) push('unsafe_action', 'parameter ' + p + ' does not occur in requires');
    for (const x of w.fields.filter(x => ['adds', 'removes'].includes(x.key))) { const a = atomFrom(tokens(x.value), {allowNeg: true}); if (!a.error) for (const v of varsOf(a.terms)) if (!req.has(v)) push('unsafe_action', 'effect variable ' + v + ' is not bound by requires', x.line); }
    if (!w.fields.some(x => ['adds', 'removes', 'next', 'guard'].includes(x.key))) push('action_needs_effect', 'an action needs adds, removes, next or guard');
  }
  if (w.type === 'hypothesis' && !f('holds') && !w.fields.some(x => x.key === 'assume' || x.key === 'waive')) push('missing_field', 'hypothesis needs holds, assume or waive');
  if (w.type === 'constraint') {
    const task = f('task')?.value.trim() ?? 'prove';
    if (task === 'optimize' && !(f('objective') && f('direction'))) push('missing_field', 'optimize needs objective and direction');
    if (task !== 'optimize' && !f('claim') && task === 'prove') push('missing_field', 'prove needs claim');
    const declared = new Set(w.vars ?? []);
    for (const v of w.exprVars ?? []) if (!declared.has(v)) push('undeclared_variable', 'variable ' + v + ' is not declared with var');
  }
  if (w.type === 'query') {
    const mode = f('mode')?.value.trim() ?? 'select';
    if (!f('where') && mode !== 'conform' && !(mode === 'plan' && f('observe'))) push('missing_field', 'query needs where');
    if (mode === 'conform' && !f('trace')) push('missing_field', 'mode conform needs trace');
    if (mode !== 'conform' && f('trace')) push('bad_field_for_mode', 'trace is only for mode conform');
    if (f('via') && !['plan', 'why_not', 'abduce'].includes(mode)) push('bad_field_for_mode', 'via is only for plan, why_not and abduce');
    const temporal = ['at', 'during', 'overlaps'].filter(k => f(k));
    if (temporal.length > 1) push('temporal_conflict', 'use one of at (instant), during (throughout an interval), overlaps (some instant of an interval)');
    if (mode === 'every' && !f('scope')) push('missing_field', 'mode every needs scope');
    if (mode !== 'every' && f('scope')) push('bad_field_for_mode', 'scope is only for mode every');
    // `order random` (DS004 "Sampling"): the answers of mode select in a seeded random order, a random sample with limit.
    const sampling = w.fields.filter(x => x.key === 'order' && ORDER_SAMPLING.includes(x.value.trim()));
    if (sampling.length > 1) push('order_random_repeated', 'a query takes at most one order random line');
    if (sampling.length && !ORDER_SAMPLING_MODES.includes(mode)) push('order_random_mode', 'order random samples the answers of mode ' + ORDER_SAMPLING_MODES.join('|') + ', not mode ' + mode);
    const select = f('select') ? tokens(f('select').value) : [];
    for (const s of select) if (!bound.has(s)) push('select_unbound', 'selected variable ' + s + ' does not occur in where');
    // Candidates (Q-LANG-10): wires in force only in the runs of this query; their targets are checked across files (validateProgram).
    const candidates = w.fields.filter(x => x.key === 'candidate').map(x => x.value.trim());
    if (candidates.length && !CANDIDATE_MODES.includes(mode)) push('candidate_needs_mode', 'candidate lines belong to mode ' + CANDIDATE_MODES.join(' or ') + ', not mode ' + mode);
    if (candidates.length > MAX_CANDIDATES) push('candidate_limit', candidates.length + ' candidates; at most ' + MAX_CANDIDATES + ' per query');
    const supposed = new Set(w.fields.filter(x => x.key === 'if').map(x => x.value.trim()));
    for (const c of candidates) if (supposed.has(c)) push('candidate_also_if', c + ' is both a candidate and supposed with if; a candidate is tried, a condition is assumed');
    if (mode === 'effect') {
      const groundClaim = !select.length && !f('scope') && w.conds?.some(c => c.key === 'where') && (w.conds ?? []).filter(c => c.key === 'where').every(c => leaves(c.tree).every(l => !(l.terms ?? []).some(t => VAR.test(t))));
      if (!candidates.length) push('effect_needs_ground_claim', 'mode effect classifies candidates against a claim; name at least one with candidate $id');
      if (!groundClaim) push('effect_needs_ground_claim', 'mode effect needs a ground claim: where without variables, no select');
    }
  }
  const arityOf = () => (f('args') ? (f('args').value.trim() === 'none' ? 0 : tokens(f('args').value).length) : w.fields.filter(x => x.key === 'role').length);
  if (w.type === 'predicate' && !f('args') && !f('role')) push('missing_field', 'predicate needs args or role lines');
  if (w.type === 'predicate' && f('transitive')?.value.trim() === 'true' && arityOf() !== 2) push('bad_transitive', 'transitive needs a predicate of arity 2');
  if (w.type === 'predicate' && f('key')) {
    const n = arityOf();
    const k = Number(f('key').value);
    if (!(k >= 1 && k <= n)) push('bad_key', 'key must be an argument position 1..' + n);
  }
  // Authoring mode (an author running the validator on the wires it is about to submit): the governance fields the host writes at
  // ingestion are ignored with a warning, and approval_incomplete is an ingestion check only.
  if (authoring) {
    for (const k of HOST_WRITTEN) if (f(k) && GRAMMAR[w.type]?.fields[k]) problems.push({code: 'governance_ignored', severity: 'warning', line: f(k).line, message: k + ' is written by the host at ingestion; remove it from the wires you submit', wire: w.id});
  } else if (GRAMMAR[w.type]?.fields.approval && f('approval')?.value.trim() === 'approved' && w.type !== 'amendment' && !(f('approved_by') && f('approved_at'))) push('approval_incomplete', 'an explicit approval approved needs approved_by and approved_at (the host sets them)');
  if (w.type === 'argument' && Boolean(f('for')) === Boolean(f('against'))) push('argument_needs_for_or_against', 'an argument has exactly one of for and against');
  if (w.type === 'norm') {
    const modal = ['forbid', 'oblige', 'permit'].filter(k => f(k));
    if (modal.length !== 1) push('norm_one_modality', 'a norm has exactly one of forbid, oblige, permit');
    const quals = ['within', 'before', 'after', 'always', 'sometime', 'at_most_once'].filter(k => f(k));
    if (quals.length > 1) push('norm_qualifier_conflict', 'a norm has at most one temporal qualifier, got ' + quals.join(', '));
    const allowed = {forbid: ['always', 'before', 'after', 'at_most_once'], oblige: ['within', 'before', 'after', 'always', 'sometime'], permit: []}[modal[0]] ?? [];
    for (const q of quals) if (!allowed.includes(q)) push('norm_qualifier_invalid', modal[0] + ' does not take the qualifier ' + q);
    if (f('cost') && (f('severity')?.value.trim() ?? 'hard') !== 'soft') push('cost_needs_soft', 'cost is the price of violating a soft norm');
    if ((f('severity')?.value.trim() ?? 'hard') === 'soft' && f('binding')) problems.push({code: 'binding_on_soft_norm', severity: 'warning', line: w.line, message: 'binding says whether the engine may relax a norm that blocks; a soft norm never blocks, so binding is vacuous here', wire: w.id});
    if (f('standing') && modal[0] !== 'oblige') push('standing_needs_oblige', 'standing marks an oblige norm that applies to every binding of its when; it has no meaning on ' + (modal[0] ?? 'this norm'));
    if (modal[0] === 'oblige' && f('oblige')) {
      // An obligation is scoped when a positive atom of `when` binds each of its variables (the trigger); at run time the instances are
      // limited to bindings that come from the goal's arguments or from an executed action. A variable no `when` atom binds is unsafe.
      // The marker `standing` says the author wants the obligation applied to every binding of the `when`, whatever the goal: the host
      // then reports the note obligation_unscoped, and the validator warns so that the author confirms the intent.
      const vars = s => (s.match(/\?[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
      const pv = new Set(vars(f('oblige').value));
      const bound = new Set(w.fields.filter(x => x.key === 'when').flatMap(x => vars(x.value)));
      if ([...pv].some(v => !bound.has(v))) push('unsafe_variable', 'the obligation has a variable that no when atom binds; tie it to the thing it concerns with a when atom (or write a ground obligation)');
      else if (f('standing') && pv.size) problems.push({code: 'obligation_unscoped', severity: 'warning', line: f('standing').line, message: 'a standing obligation applies to every binding of its when, whatever the goal; the host reports obligation_unscoped for it. Keep standing only when the source says the duty is general', wire: w.id});
    }
    if (modal[0] === 'permit' && !f('overrides')) problems.push({code: 'permit_without_target', severity: 'warning', line: w.line, message: 'a permit without overrides changes nothing: it should override the forbid it excepts', wire: w.id});
  }
  if (w.type === 'test' || w.type === 'code') {
    // programming wires (P0): host or turn wires; the executable texts are JSON strings, and a sealed test never leaves eval/suites/
    for (const key of w.type === 'test' ? ['call', 'expect'] : ['body']) if (f(key) && !f(key).value.trim().startsWith('"')) push('bad_value', key + ' must be a JSON-quoted string');
    if (w.type === 'test' && f('kind')?.value.trim() === 'sealed' && !allowSealed) push('sealed_test_in_knowledge', 'a test of kind sealed belongs to eval/suites/ only: it is refused in knowledge, task and candidate files');
    if (w.type === 'code' && f('entry') && f('body')?.value.trim().startsWith('"')) {
      try { if (!new RegExp('(function\\s+|const\\s+|let\\s+|var\\s+)' + f('entry').value.trim().replace(/[$]/g, '\\$') + '\\b').test(JSON.parse(f('body').value.trim()))) push('code_entry_not_defined', 'the body does not define the entry ' + f('entry').value.trim()); } catch { /* a bad JSON string is reported by the field check */ }
    }
  }
  if (/^x_/.test(w.id)) push('reserved_prefix', 'ids starting with x_ are reserved for generated wires');
  if (w.type === 'fact' && (f('speaker') || f('status')) ) {
    const st = f('status')?.value.trim();
    if (f('speaker') && st !== 'reported') push('speaker_needs_reported', 'speaker is only meaningful with status reported');
  }
}

/**
 * Validate a program made of several files (knowledge circuits and a query circuit) together:
 * unique ids, reference resolution, arity consistency, closed-world discipline, stratification.
 * `files` is [{name, text, role}].
 */
export function validateProgram(files, opts = {}) {
  const problems = [];
  const allWires = [];
  const arities = new Map();
  const ctxs = [];
  for (const file of files) {
    const {wires, errors} = parse(file.text);
    const {problems: p, ctx} = validateWires(wires, {role: file.role, parseErrors: errors, authoring: Boolean(opts.authoring), allowSealed: Boolean(opts.allowSealed)});
    for (const x of p) problems.push({...x, file: file.name});
    ctxs.push({file, wires, ctx});
    for (const w of wires) allWires.push({...w, file: file.name});
  }
  const ids = new Map();
  for (const w of allWires) {
    if (ids.has(w.id)) problems.push({code: 'duplicate_id', file: w.file, line: w.line, message: 'wire id ' + w.id + ' also defined in ' + ids.get(w.id), wire: w.id});
    else ids.set(w.id, w.file);
  }
  // Cross-file references are resolved against all files.
  const known = new Set(allWires.map(w => w.id));
  for (let i = problems.length - 1; i >= 0; i--) if (problems[i].code === 'unknown_ref') { const m = /unknown wire (\S+)/.exec(problems[i].message); if (m && known.has(m[1])) problems.splice(i, 1); }
  // A candidate names a supposed fact or a rule/default (Q-LANG-10); an unknown id is already unknown_ref.
  const byWireId = new Map(allWires.map(w => [w.id, w]));
  for (const q of allWires.filter(w => w.type === 'query')) for (const c of q.fields.filter(x => x.key === 'candidate')) {
    const target = byWireId.get(c.value.trim().slice(1));
    if (!target) continue;
    const supposedFact = target.type === 'fact' && ['supposed', 'hedged'].includes(target.fields.find(x => x.key === 'status')?.value.trim());
    if (!supposedFact && !['rule', 'default'].includes(target.type)) problems.push({code: 'candidate_target', file: q.file, line: c.line, message: 'candidate ' + c.value.trim() + ' names a ' + target.type + '; a candidate is a fact with status supposed or a rule or default', wire: q.id});
  }
  const declared = new Map();
  for (const w of allWires) if (w.type === 'predicate') {
    const name = w.fields.find(f => f.key === 'predicate');
    void name;
  }
  // Predicates: each `predicate` wire id is the relation name; its args give the arity.
  const predicates = new Map();
  for (const w of allWires.filter(w => w.type === 'predicate')) {
    const args = tokens(w.fields.find(f => f.key === 'args')?.value ?? '');
    const specs = ctxs.map(c => c.ctx.argSpecs?.[w.id]).find(Boolean) ?? roleArgSpecs(ctxs.map(c => c.ctx.roleSpecs?.[w.id]).find(Boolean));
    predicates.set(w.id, {arity: specs ? specs.length : args.length, closed: w.fields.find(f => f.key === 'closed')?.value.trim() === 'true', types: specs?.map(x => x.type) ?? null, key: Number(w.fields.find(f => f.key === 'key')?.value ?? 0) || null, line: w.line, file: w.file});
  }
  const noteArity = (p, n, file, line, wire) => {
    if (predicates.has(p) && predicates.get(p).arity !== n) problems.push({code: 'arity_mismatch', file, line, message: p + ' is declared with arity ' + predicates.get(p).arity + ' but used with ' + n, wire});
    if (arities.has(p) && arities.get(p) !== n) problems.push({code: 'arity_mismatch', file, line, message: p + ' used with arity ' + n + ' and ' + arities.get(p), wire});
    else arities.set(p, n);
  };
  // Dependency graph for stratification: head -> body predicates, negative edges for absent, except, aggregate sources.
  const edges = [];
  const headOf = w => {
    const t = w.fields.find(f => f.key === 'then' || f.key === 'yields');
    if (!t) return null;
    const a = atomFrom(tokens(t.value), {allowNeg: true});
    return a.error ? null : a;
  };
  for (const {file, wires, ctx} of ctxs) {
    for (const a of ctx.atoms) noteArity(a.p, a.terms.length, file.name, a.line, a.wire);
    for (const w of wires) {
      for (const c of w.conds ?? []) for (const l of leaves(c.tree)) {
        if (l.kind === 'atom') {
          noteArity(l.p, l.terms.length, file.name, l.line, w.id);
          if (l.neg === 'absent') {
            const decl = predicates.get(l.p);
            if (!decl?.closed) problems.push({code: 'absent_needs_closed', file: file.name, line: l.line, message: 'absent ' + l.p + ': declare "predicate ' + l.p + '" with closed true (absence is only meaningful for a complete relation)', wire: w.id});
          }
        }
      }
      const h = headOf(w);
      if (h && ['rule', 'default', 'aggregate'].includes(w.type)) {
        const isAgg = w.type === 'aggregate';
        for (const c of w.conds ?? []) for (const l of leaves(c.tree)) if (l.kind === 'atom') edges.push({from: h.p, to: l.p, neg: l.neg === 'absent' || c.key === 'except' || isAgg, wire: w.id, file: file.name, line: l.line});
        if (w.type === 'default') edges.push({from: h.p, to: h.p, neg: false, skip: true});
      }
      if (h && w.type === 'default' && h.neg === 'none') {
        // the default blocks on an explicit contrary conclusion: depends negatively on the contrary head
      }
    }
  }
  for (const e of edges) if (e.skip) edges.splice(edges.indexOf(e), 1);
  crossChecks({allWires, ctxs, predicates, problems, headOf, ruleSetComplete: opts.ruleSetComplete ?? null});
  lexiconChecks({files, allWires, ctxs, problems, linking: Boolean(opts.linking)});

  const cycle = negativeCycle(edges);
  if (cycle) problems.push({code: 'not_stratifiable', file: cycle.file, line: cycle.line, message: 'negation, exception or aggregation through recursion: ' + cycle.path.join(' -> '), wire: cycle.wire});
  return {problems, wires: allWires, ok: !problems.some(p => p.severity !== 'warning')};
}

