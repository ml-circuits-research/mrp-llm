/**
 * The expression path of dual formalization (owner, 2026-10-02): besides the step-by-step question tree, a model answers ONE closed
 * question, "write the computation as numbered lines `name = expression` over v1..vn", in the restricted expression language of
 * sop/expression.mjs. The answer is foreign code, so it is never run as JavaScript: it is parsed by the existing parser, analysed
 * statically (every reference is a registry value or an earlier name, types and units agree, every registry number is used or listed as
 * unused, no construct outside the arithmetic subset), and lowered to SOP Lang (`stated` values, one session rule per line with
 * `compute`/`compare` conditions, a conditional as one rule per branch, a yes/no line as a check with its explicit `not` rule), which
 * the engines execute with a proof. The interpreter of sop/expression.mjs evaluates the same program on perturbed numbers for the
 * cross-check (lib/formalize/dual-check.mjs).
 *
 * The intermediate names of a program are the model's own decomposition: the dataflow graph of its lines is reported per problem
 * (`analysis.graph`), which is how the problem types a model maps to are observed without asking it to name them.
 *
 * Everything here is structure (tokens, references, types, arithmetic); nothing interprets the problem's words. The question text is a
 * step-by-step template, which may stay in code for now (AGENTS.md "No hardcoded understanding").
 */
import {parseExpression, evaluateExpression} from '../../sop/expression.mjs';
import {registry as makeRegistry} from './registry.mjs';
import {loadExemplarIndex, retrieve} from './exemplars.mjs';

/** The numbers of a message: the registry (N0) of lib/formalize/registry.mjs, shared with the decomposition protocol. */
export const registryOf = message => normalizeRegistry(makeRegistry(message));

/** [{index, value, span, context, unit?, label?, percent?}] from a registry module's result (an array, or {values|numbers|registry}). */
export function normalizeRegistry(r) {
  const list = Array.isArray(r) ? r : r?.values ?? r?.numbers ?? r?.registry ?? [];
  return list.map((v, i) => ({index: Number(v.index ?? i + 1), value: Number(v.value), span: String(v.span ?? v.text ?? v.value).trim(), context: String(v.context ?? v.window ?? ''),
    ...(v.unit ? {unit: String(v.unit)} : {}), ...(v.label ? {label: String(v.label)} : {}), ...(v.percent ? {percent: true} : {})}))
    .filter(v => Number.isFinite(v.value) && Number.isInteger(v.index) && v.index > 0);
}

/** The version of the question text; a recording made with another version is stale (its questions are no longer asked). */
export const PROMPT_VERSION = 1;
export const EXPRESSION_SYSTEM = 'You write short computations. Reply with the lines only, no explanation.';
const EXAMPLE = ['1. total_minutes = v1 * v2', '2. hours = total_minutes / 60', '3. answer = hours <= v3', 'unused: v4'].join('\n');
// The second prompt variant of the N-way formalization (an independent sample by prompt, not by temperature, so a replay stays
// deterministic): the numbers in reverse order and another example.
const EXAMPLE_B = ['1. per_box = v2 / v3', '2. boxes = Math.ceil(v1 / per_box)', '3. answer = boxes * v4'].join('\n');
export const PROMPT_VARIANTS = Object.freeze(['a', 'b']);

/**
 * The one closed question of the expression path (a step-by-step template; `again` adds the static analysis's complaint). `variant`
 * 'b' lists the numbers last to first with another example; `exemplars` ([{numbers, program}], verified programs of other problems,
 * lib/formalize/exemplars.mjs) are shown as their numbers and program only, never their text.
 */
export function expressionQuestion(message, registry, {again = null, variant = 'a', exemplars = []} = {}) {
  const ordered = variant === 'b' ? [...registry].reverse() : registry;
  const numbers = ordered.map(v => `v${v.index} = ${v.span}${v.percent ? ` (a percentage: in the lines v${v.index} already means ${v.value / 100}; do not divide it by 100)` : ''}${v.label ? ` (${v.label})` : ''}   [${v.context}]`).join('\n');
  return [`Problem:\n${message}`, `Numbers of the problem:\n${numbers || '(none)'}`,
    `Write the computation of what the question asks as numbered lines \`name = expression\`, using only v1..v${registry.length} and earlier names; the last line is the answer. If several values are asked, name them answer1, answer2, ... in the order asked. v1..v${registry.length} are given: never assign them, and write no results, only expressions.`,
    'Allowed: numbers, + - * / and % (remainder), parentheses, < <= > >= == !=, && || !, test ? a : b, "text" for a named choice, Math.min, Math.max, Math.floor, Math.ceil, Math.round, Math.abs. Nothing else.',
    `List the numbers you do not need on a last line \`unused: vK, vK\`.\nExample of the format (another problem):\n${variant === 'b' ? EXAMPLE_B : EXAMPLE}`,
    ...(exemplars.length ? [`Verified programs of similar problems (their numbers, then their lines):\n${exemplars.map(x => `${x.numbers}\n${x.program}`).join('\n\n')}`] : []),
    ...(again ? [`Your previous answer had a problem: ${again}. Write the lines again.`] : [])].join('\n\n');
}

const strip = text => String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```[a-z]*\n?|```/g, '');
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['Math', 'true', 'false', 'null', 'unused', 'not', 'absent', 'compare', 'compute', 'order', 'all', 'any', 'end', 'match']);

/** The lines of an answer → {lines: [{n, name, text}], unused: [indices]} or null (nothing in the format). Structure only. */
export function readProgram(text) {
  const lines = [], unused = new Set();
  for (let raw of strip(text).split('\n')) {
    raw = raw.replace(/\/\/.*$|\s#\s.*$/, '').replace(/;\s*$/, '').trim().replace(/^(?:[-*•]\s*|\d+\s*[.):]\s*)/, '').replace(/^(?:const|let|var)\s+/, '').trim();
    if (!raw) continue;
    const u = /^unused\s*[:=]\s*(.*)$/i.exec(raw);
    if (u) { for (const m of u[1].matchAll(/\bv(\d+)\b/gi)) unused.add(Number(m[1])); continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.+)$/.exec(raw);
    if (!m) continue;
    // Shown work (`x = a * b = 3 * 4 = 12`): the expression is the first part; a bare min/max/floor/ceil/round/abs is the Math one.
    const expr = m[2].split(/(?<![=!<>])=(?!=)/)[0].trim().replace(/(?<![.\w])(min|max|floor|ceil|round|abs)\s*\(/g, 'Math.$1(');
    lines.push({n: lines.length + 1, name: m[1], text: expr});
  }
  return lines.length ? {lines, unused: [...unused]} : null;
}

const MATH = new Set(['min', 'max', 'floor', 'ceil', 'round', 'abs', 'pow']);
const COMPARE = new Set(['<', '<=', '>', '>=', '==', '===', '!=', '!==']);
const ARITH = new Set(['+', '-', '*', '/', '%']);
const normUnit = u => String(u ?? '').toLowerCase().replace(/\s+/g, ' ').trim() || null;

/**
 * Static analysis of a read program against the registry. Returns {ok, violations: [{code, line, message}], warnings, program}:
 * `program.lines[k].ast` (registry and earlier names as references), `type`, `unit`, `refs`; `answers` (names), `graph` (the dataflow
 * of intermediate names), `used`/`unused` registry indices. A literal equal to exactly one unused-by-reference registry number is mapped
 * back to its index (the proposal's "a number copied verbatim is mapped to its index"), so perturbing the registry perturbs it too.
 */
export function analyseProgram(read, registry, {external = new Map()} = {}) {
  const violations = [], warnings = [];
  const bad = (code, line, message) => violations.push({code, line, message});
  const reg = new Map(registry.map(v => [`v${v.index}`, v]));
  const known = new Map(); // name → {type, unit}
  for (const [k, v] of reg) known.set(k, {type: 'number', unit: normUnit(v.unit), registry: true});
  // Names the caller defines outside the program (by its own rules, e.g. a value under conditions): numbers the lines may read.
  for (const name of external.keys()) known.set(name, {type: 'number', unit: null, external: true});
  const lines = [];
  for (const line of read?.lines ?? []) {
    if (reg.has(line.name) || /^v\d+$/i.test(line.name)) {
      // A line that restates a registry number as written (`v1 = 800`, `v2 = 0.1` for 10%) says nothing new and is skipped.
      const r = reg.get(line.name), n = Number(line.text.replace(/%$/, ''));
      if (r && Number.isFinite(n) && (n === r.value || r.percent && n === r.value / 100)) { warnings.push({code: 'restated_registry', line: line.n, message: `${line.name} restated`}); continue; }
      bad('redefines_registry', line.n, `line ${line.n} assigns ${line.name}, a registry number (given; use it, never assign it)`); continue;
    }
    if (RESERVED.has(line.name) || !NAME.test(line.name)) { bad('reserved_name', line.n, `${line.name} is not a usable name`); continue; }
    if (known.has(line.name)) { bad('duplicate_name', line.n, `${line.name} is assigned twice`); continue; }
    let ast;
    try { ast = parseExpression(line.text); } catch (error) { bad('parse_error', line.n, `line ${line.n} does not parse: ${error.message}`); continue; }
    const refs = new Set(), literals = [];
    const walk = n => {
      switch (n.type) {
        case 'literal': if (typeof n.value === 'number') literals.push(n); if (n.value === null) bad('forbidden_construct', line.n, 'null is not allowed'); return;
        case 'name':
          if (!known.has(n.value)) { bad(/^v\d+$/i.test(n.value) ? 'unknown_registry_index' : 'unknown_name', line.n, `${n.value} is neither a registry number nor an earlier name`); return; }
          refs.add(n.value); n.type = 'ref'; return;
        case 'unary': case 'binary': case 'conditional': for (const k of ['arg', 'left', 'right', 'test', 'yes', 'no']) if (n[k]) walk(n[k]); return;
        case 'call':
          if (n.callee.type === 'member' && n.callee.object.type === 'name' && n.callee.object.value === 'Math' && n.callee.key.type === 'literal' && MATH.has(n.callee.key.value)
            && n.args.length >= 1 && (['min', 'max'].includes(n.callee.key.value) || (n.callee.key.value === 'pow' ? n.args.length === 2 : n.args.length === 1))) { n.args.forEach(walk); return; }
          bad('forbidden_construct', line.n, `only Math.min/max (several arguments), Math.pow (two) and Math.floor/ceil/round/abs (one argument) may be called`); return;
        default: bad('forbidden_construct', line.n, `${n.type === 'ref' || n.type === 'var' ? 'a $ or ? reference' : `a ${n.type}`} is not allowed`);
      }
    };
    walk(ast);
    lines.push({...line, ast, refs: [...refs], literals});
    known.set(line.name, {type: null, unit: null});
  }
  // Literals that copy a registry number the program never references are that number (by index), when the value is unique.
  const referenced = new Set(lines.flatMap(l => l.refs).filter(r => reg.has(r)));
  for (const l of lines) for (const lit of l.literals) {
    const same = registry.filter(v => v.value === lit.value || v.percent && v.value / 100 === lit.value);
    if (same.length === 1 && !referenced.has(`v${same[0].index}`) && !(read.unused ?? []).includes(same[0].index)) {
      const value = lit.value;
      Object.assign(lit, {type: 'ref', value: `v${same[0].index}`}); l.refs.push(`v${same[0].index}`); lit.copied = value;
      warnings.push({code: 'literal_mapped_to_registry', line: l.n, message: `the number ${lit.value} is v${same[0].index}`});
    }
  }
  // A yes/no answer written as text ("yes", "no", "true", "false": the closed menu of a yes/no answer, read like any menu answer) is
  // the yes/no value; `test ? true : false` is the test itself and `test ? false : true` its negation.
  const YESNO = {yes: true, no: false, true: true, false: false};
  const yesNo = n => {
    if (!n || typeof n !== 'object') return n;
    for (const k of ['arg', 'left', 'right', 'test', 'yes', 'no']) if (n[k]) n[k] = yesNo(n[k]);
    if (n.args) n.args = n.args.map(yesNo);
    if (n.type === 'literal' && typeof n.value === 'string' && Object.hasOwn(YESNO, n.value.trim().toLowerCase())) return {type: 'literal', value: YESNO[n.value.trim().toLowerCase()]};
    if (n.type === 'conditional' && n.yes.type === 'literal' && n.no.type === 'literal' && typeof n.yes.value === 'boolean' && typeof n.no.value === 'boolean')
      return n.yes.value === n.no.value ? n.yes : n.yes.value ? n.test : {type: 'unary', op: '!', arg: n.test};
    return n;
  };
  for (const l of lines) l.ast = yesNo(l.ast);
  // Types (number, boolean, string) and units, line by line in order.
  for (const l of lines) {
    const t = typeOf(l.ast, known, (code, message) => bad(code, l.n, `line ${l.n}: ${message}`));
    known.set(l.name, t);
    Object.assign(l, {type: t.type, unit: t.unit});
  }
  // A line of constant text or a constant yes/no (a result the model wrote, not a computation) is dropped, with a warning.
  const constant = x => (x.type === 'string' || x.type === 'boolean') && !x.refs.length;
  for (const l of lines.filter(constant)) {
    warnings.push({code: 'constant_text_dropped', line: l.n, message: `${l.name} is constant text, not a computation`});
    if (lines.some(x => x.refs.includes(l.name))) bad('constant_text', l.n, `${l.name} is constant text used by another line`);
  }
  lines.splice(0, lines.length, ...lines.filter(x => !constant(x)));
  if (!lines.length && read?.lines?.length && !violations.length) bad('no_computed_answer', null, 'no line computes from the numbers');
  const used = new Set(lines.flatMap(l => l.refs).filter(r => reg.has(r)).map(r => Number(r.slice(1))));
  const listed = new Set(read?.unused ?? []);
  // Coverage is checked only when every line parsed (an unparsable line's references are unknown).
  if (!violations.some(v => v.code === 'parse_error')) for (const v of registry) if (!used.has(v.index) && !listed.has(v.index)) bad('unused_number', null, `v${v.index} (${v.span}) is neither used nor listed as unused`);
  for (const k of listed) if (used.has(k)) warnings.push({code: 'unused_but_used', line: null, message: `v${k} is listed as unused but used`});
  const tagged = lines.filter(l => /^answer\d*$/.test(l.name));
  const answers = (tagged.length ? tagged : lines.slice(-1)).map(l => l.name);
  // Dataflow: which names each line reads; lines that reach no answer are dead (a sub-problem the answer does not need).
  const byName = new Map(lines.map(l => [l.name, l]));
  const live = new Set(), stack = [...answers];
  while (stack.length) { const n = stack.pop(); if (live.has(n) || !byName.has(n)) continue; live.add(n); stack.push(...byName.get(n).refs); }
  for (const l of lines) if (!live.has(l.name)) warnings.push({code: 'dead_line', line: l.n, message: `${l.name} is not used by the answer`});
  const depth = new Map();
  for (const l of lines) depth.set(l.name, 1 + Math.max(0, ...l.refs.filter(r => depth.has(r)).map(r => depth.get(r))));
  const intermediates = lines.filter(l => !answers.includes(l.name) && live.has(l.name)).map(l => l.name);
  const graph = {nodes: lines.map(l => ({name: l.name, type: l.type, inputs: l.refs, depth: depth.get(l.name), answer: answers.includes(l.name), live: live.has(l.name)})),
    intermediates: intermediates.length, depth: Math.max(0, ...[...depth.values()]),
    // Independent sub-problems: connected components of the live lines that do not pass through another line (by registry inputs only).
    roots: lines.filter(l => live.has(l.name) && l.refs.every(r => reg.has(r))).length};
  if (!lines.length && !violations.length) bad('empty', null, 'no `name = expression` line');
  return {ok: violations.length === 0, violations, warnings, program: {lines, answers, unused: [...listed], used: [...used].sort((a, b) => a - b), graph,
    percent: registry.filter(v => v.percent).map(v => v.index)}};
}

/** The type and unit of an expression; `fail(code, message)` on a violation. Units only where the registry knows them. */
function typeOf(n, known, fail) {
  const num = (x, what) => { if (x.type && x.type !== 'number') fail('type_error', `${what} needs a number, got a ${x.type}`); };
  const sameUnit = (a, b, op) => { if (a.unit && b.unit && a.unit !== b.unit) fail('unit_mismatch', `${op} of ${a.unit} and ${b.unit}`); return a.unit ?? b.unit ?? null; };
  switch (n.type) {
    case 'literal': return {type: typeof n.value === 'boolean' ? 'boolean' : typeof n.value === 'string' ? 'string' : 'number', unit: null};
    case 'ref': return known.get(n.value) ?? {type: null, unit: null};
    case 'unary': { const a = typeOf(n.arg, known, fail); if (n.op === '!') { if (a.type && a.type !== 'boolean') fail('type_error', '! needs a yes/no value'); return {type: 'boolean', unit: null}; } num(a, 'unary minus'); return {type: 'number', unit: a.unit}; }
    case 'binary': {
      const a = typeOf(n.left, known, fail), b = typeOf(n.right, known, fail);
      if (n.op === '&&' || n.op === '||') { if (a.type !== 'boolean' || b.type !== 'boolean') fail('type_error', `${n.op} needs yes/no values`); return {type: 'boolean', unit: null}; }
      if (n.op === '??') { fail('forbidden_construct', '?? is not allowed'); return {type: a.type, unit: a.unit}; }
      if (COMPARE.has(n.op)) {
        if (!['==', '===', '!=', '!=='].includes(n.op)) { num(a, n.op); num(b, n.op); }
        else if (a.type && b.type && a.type !== b.type) fail('type_error', `${n.op} compares a ${a.type} with a ${b.type}`);
        if (a.type === 'boolean' || b.type === 'boolean') fail('forbidden_construct', 'comparing yes/no values is not supported; use && || !');
        sameUnit(a, b, n.op); return {type: 'boolean', unit: null};
      }
      num(a, n.op); num(b, n.op);
      if (n.op === '+' || n.op === '-' || n.op === '%') return {type: 'number', unit: sameUnit(a, b, n.op)};
      const unit = !a.unit && !b.unit ? null : n.op === '*' ? [a.unit, b.unit].filter(Boolean).join('*') : a.unit && b.unit ? (a.unit === b.unit ? null : `${a.unit}/${b.unit}`) : a.unit ?? `1/${b.unit}`;
      return {type: 'number', unit};
    }
    case 'conditional': {
      const t = typeOf(n.test, known, fail), a = typeOf(n.yes, known, fail), b = typeOf(n.no, known, fail);
      if (t.type !== 'boolean') fail('type_error', 'the test of ?: must be a comparison or a yes/no value');
      if (a.type && b.type && a.type !== b.type) fail('type_error', `the branches of ?: differ (${a.type}, ${b.type})`);
      if (a.type === 'boolean') fail('forbidden_construct', 'a ?: that yields yes/no; write it with && || !');
      return {type: a.type ?? b.type, unit: sameUnit(a, b, '?:')};
    }
    case 'call': {
      if (n.callee.type !== 'member' || n.callee.key?.type !== 'literal') return {type: null, unit: null};
      const args = n.args.map(x => typeOf(x, known, fail));
      args.forEach(x => num(x, `Math.${n.callee.key.value}`));
      const unit = args.reduce((u, x) => (u && x.unit && u !== x.unit ? (fail('unit_mismatch', `Math.${n.callee.key.value} of ${u} and ${x.unit}`), u) : u ?? x.unit), null);
      return {type: 'number', unit};
    }
    default: return {type: null, unit: null};
  }
}

/** The values of every line for registry `values` (Map or object index → number) by the bounded interpreter; throws on an error. */
export function evaluateProgram(program, values) {
  const refs = Object.create(null);
  // A percentage is written as in the message (10) and is the fraction (0.1) in the program.
  for (const [k, v] of values instanceof Map ? values : Object.entries(values)) refs[`v${k}`] = program.percent?.includes(Number(k)) ? v / 100 : v;
  const out = {};
  for (const l of program.lines) { refs[l.name] = evaluateExpression(l.ast, {refs, maxOps: 2000}).value; out[l.name] = refs[l.name]; }
  return out;
}

const OPS = {'+': 'plus', '-': 'minus', '*': 'times', '/': 'divided_by', '%': 'modulo'};
const CMP = {'<': ['below', 'at_least'], '<=': ['at_most', 'above'], '>': ['above', 'at_most'], '>=': ['at_least', 'below'], '==': ['equal', 'not_equal'], '===': ['equal', 'not_equal'], '!=': ['not_equal', 'equal'], '!==': ['not_equal', 'equal']};
const ROUND = {floor: 'rounded_down_to', ceil: 'rounded_up_to', round: 'rounded_to'};
const MAX_ALTERNATIVES = 32;
const term = v => typeof v === 'number' ? String(v) : typeof v === 'string' && !v.startsWith('?') ? JSON.stringify(v) : v;

/**
 * Lowers an analysed program to a SOP circuit: one session predicate per used registry number and per line, `stated` values, one rule
 * per line and branch, the answers as queries. Returns {sop, predicates: Map name → predicate id, queries: [{name, id, type}]}.
 * `lexicon` avoids collisions with the memory's vocabulary.
 */
export function lowerProgram(analysis, registry, {lexicon = null, external = new Map()} = {}) {
  const {program} = analysis;
  if (!analysis.ok) throw new Error(`a program with violations is not lowered (${analysis.violations.map(v => v.code).join(', ')})`);
  const taken = new Set(), pid = new Map();
  const idOf = name => {
    let id = /^[a-z]/.test(name) ? name.toLowerCase() : `p_${name.toLowerCase()}`;
    if (RESERVED.has(id) || lexicon?.predicates?.[id] || lexicon?.entities?.[id]) id = `${id}_value`;
    while (taken.has(id)) id = `${id}_x`;
    taken.add(id); return id;
  };
  const types = new Map(program.lines.map(l => [l.name, l.type]));
  // External names keep the caller's predicate ids and are declared and defined by the caller.
  for (const [name, id] of external) { pid.set(name, id); taken.add(id); }
  for (const k of program.used) pid.set(`v${k}`, idOf(`v${k}`));
  for (const l of program.lines) pid.set(l.name, idOf(l.name));
  const out = [];
  // A percentage is stated as written under its own predicate and divided by 100 by one rule.
  const percent = new Map(program.used.filter(k => program.percent?.includes(k)).map(k => [k, idOf(`v${k}_percent`)]));
  for (const id of [...[...pid].filter(([name]) => !external.has(name)).map(([, id]) => id), ...percent.values()]) out.push(`@${id} predicate\n  args object:value\n`);
  program.used.forEach((k, i) => {
    const v = registry.find(r => r.index === k);
    out.push(`@s${i + 1} stated\n  certainty asserted\n  relation "${percent.get(k) ?? pid.get(`v${k}`)}"\n  role object ${v.value}\n  polarity affirmed\n`);
  });
  for (const [k, id] of percent) out.push(`@${pid.get(`v${k}`)}_rule rule\n  when ${id} ?p\n  when compute ?f ?p divided_by 100\n  then ${pid.get(`v${k}`)} ?f\n`);
  let rule = 0;
  for (const l of program.lines) {
    let counter = 0;
    const fresh = () => `?t${++counter}`;
    const ctx = {fresh, pid, types};
    if (l.type === 'boolean') {
      // A check: its yes when a branch of the condition holds, its explicit no when a branch of the opposite holds.
      for (const alt of truth(l.ast, true, ctx)) out.push(ruleText(`r${++rule}`, alt, `${pid.get(l.name)} 1`));
      for (const alt of truth(l.ast, false, ctx)) out.push(ruleText(`r${++rule}`, alt, `not ${pid.get(l.name)} 1`));
    } else for (const alt of value(l.ast, ctx)) out.push(ruleText(`r${++rule}`, alt.conds, `${pid.get(l.name)} ${term(alt.term)}`, alt.term));
  }
  const queries = program.answers.map((name, k) => ({name, id: `q${k ? k + 1 : ''}`, type: types.get(name), predicate: pid.get(name)}));
  for (const q of queries) out.push(q.type === 'boolean'
    ? `@${q.id} query\n  where match\n    relation "${q.predicate}"\n    role object 1\n    polarity affirmed\n  end\n`
    : `@${q.id} query\n  select ?x\n  where match\n    relation "${q.predicate}"\n    role object ?x\n    polarity affirmed\n  end\n`);
  return {sop: out.join('\n'), predicates: pid, queries};
}

function ruleText(id, conds, head, result = null) {
  const lines = [...new Set(conds)];
  // A line that is a constant or a bare reference still binds its result through one compute line.
  if (typeof result === 'number' && !lines.length) lines.push(`compute ?k ${result} plus 0`), head = head.replace(/\S+$/, '?k');
  return `@${id} rule\n${lines.map(c => `  when ${c}`).join('\n')}${lines.length ? '\n' : ''}  then ${head}\n`;
}

const cross = (a, b, join) => { const out = []; for (const x of a) for (const y of b) { out.push(join(x, y)); if (out.length > MAX_ALTERNATIVES) throw new Error('the program branches into too many cases'); } return out; };

/** A numeric or text expression → [{conds: [condition lines], term}] (one alternative per branch of its conditionals). */
function value(n, ctx) {
  switch (n.type) {
    case 'literal': return [{conds: [], term: n.value}];
    case 'ref': { const v = `?r_${n.value.toLowerCase()}`; return [{conds: [`${ctx.pid.get(n.value)} ${v}`], term: v}]; }
    case 'unary': return value(n.arg, ctx).map(a => { if (typeof a.term === 'number') return {conds: a.conds, term: -a.term}; const t = ctx.fresh(); return {conds: [...a.conds, `compute ${t} 0 minus ${a.term}`], term: t}; });
    case 'binary': return cross(value(n.left, ctx), value(n.right, ctx), (a, b) => { const t = ctx.fresh(); return {conds: [...a.conds, ...b.conds, `compute ${t} ${term(a.term)} ${OPS[n.op]} ${term(b.term)}`], term: t}; });
    case 'conditional': return [...cross(truth(n.test, true, ctx), value(n.yes, ctx), (c, a) => ({conds: [...c, ...a.conds], term: a.term})),
      ...cross(truth(n.test, false, ctx), value(n.no, ctx), (c, a) => ({conds: [...c, ...a.conds], term: a.term}))];
    case 'call': {
      const f = n.callee.key.value, args = n.args.map(x => value(x, ctx));
      if (f === 'min' || f === 'max') return args.slice(1).reduce((acc, next) => cross(acc, next, (a, b) => { const t = ctx.fresh(); return {conds: [...a.conds, ...b.conds, `compute ${t} ${term(a.term)} ${f === 'min' ? 'minimum_with' : 'maximum_with'} ${term(b.term)}`], term: t}; }), args[0]);
      if (f === 'pow') return cross(args[0], args[1], (a, b) => { const t = ctx.fresh(); return {conds: [...a.conds, ...b.conds, `compute ${t} ${term(a.term)} power ${term(b.term)}`], term: t}; });
      if (f === 'abs') return args[0].map(a => { const neg = ctx.fresh(), t = ctx.fresh(); return {conds: [...a.conds, `compute ${neg} 0 minus ${term(a.term)}`, `compute ${t} ${term(a.term)} maximum_with ${neg}`], term: t}; });
      return args[0].map(a => { const t = ctx.fresh(); return {conds: [...a.conds, `compute ${t} ${term(a.term)} ${ROUND[f]} 1`], term: t}; });
    }
    default: throw new Error(`cannot lower a ${n.type}`);
  }
}

/** A yes/no expression → the alternatives (each a list of condition lines) under which it is `want` (true or false): its DNF. */
function truth(n, want, ctx) {
  if (n.type === 'literal') return n.value === want ? [[]] : [];
  if (n.type === 'ref') return [[`${want ? '' : 'not '}${ctx.pid.get(n.value)} 1`]];
  if (n.type === 'unary' && n.op === '!') return truth(n.arg, !want, ctx);
  if (n.type === 'binary' && (n.op === '&&' || n.op === '||')) {
    const conj = (n.op === '&&') === want;
    const a = truth(n.left, want, ctx), b = truth(n.right, want, ctx);
    if (conj) return cross(a, b, (x, y) => [...x, ...y]);
    const out = [...a, ...b]; if (out.length > MAX_ALTERNATIVES) throw new Error('the program branches into too many cases'); return out;
  }
  if (n.type === 'binary' && CMP[n.op]) return cross(value(n.left, ctx), value(n.right, ctx), (a, b) => [...a.conds, ...b.conds, `compare ${term(a.term)} ${CMP[n.op][want ? 0 : 1]} ${term(b.term)}`]);
  throw new Error(`cannot lower a ${n.type} as a yes/no condition`);
}

/**
 * The expression path for one message: the registry, one question (once more on a violation, with the violation named), the static
 * analysis and the lowering. `chat(messages, maxTokens)` is a proxy client ({ok, text}). Returns {status, registry, attempts, analysis,
 * lowered} where status is `ok`, `no_numbers`, `unavailable` (the model did not answer) or `rejected` (violations after the second ask).
 */
export async function expressionFormalize({message, chat, lexicon = null, registry = null, maxTokens = 700, variant = 'a', exemplars = null, exemplarIndex = null, exemplarExclude = () => false, hint = null}) {
  registry ??= registryOf(message);
  if (!registry.length) return {status: 'no_numbers', registry, attempts: [], exemplars: []};
  // F1 by default (coordinator decision 2026-10-02): two verified programs of problems with the nearest registry shape, from the local
  // exemplar index; `exemplarExclude` is the caller's leave-one-out (an evaluation excludes the problem's own section).
  exemplars ??= retrieve(exemplarIndex ?? loadExemplarIndex(), registry, {k: 2, exclude: exemplarExclude});
  const attempts = [];
  let again = hint, analysis = null;
  for (let round = 0; round < 2; round++) {
    const question = expressionQuestion(message, registry, {again, variant, exemplars});
    const reply = await chat([{role: 'system', content: EXPRESSION_SYSTEM}, {role: 'user', content: question}], maxTokens);
    attempts.push({question, answer: reply.ok ? reply.text : null, reason: reply.ok ? null : reply.reason ?? 'no answer'});
    if (!reply.ok) return {status: 'unavailable', registry, attempts, exemplars};
    const read = readProgram(reply.text);
    analysis = analyseProgram(read, registry);
    attempts.at(-1).violations = analysis.violations;
    if (analysis.ok) {
      try { return {status: 'ok', registry, attempts, analysis, exemplars, lowered: lowerProgram(analysis, registry, {lexicon})}; }
      catch (error) { analysis = {...analysis, ok: false, violations: [{code: 'not_lowerable', line: null, message: error.message}]}; attempts.at(-1).violations = analysis.violations; }
    }
    again = analysis.violations.slice(0, 3).map(v => v.message).join('; ');
  }
  return {status: 'rejected', registry, attempts, analysis, exemplars};
}
