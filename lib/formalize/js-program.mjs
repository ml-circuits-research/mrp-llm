/**
 * The jsEval route of the formalizer (owner decision 2026-10-03; proposal P-6 in experiments/proposal/wire-type-proposals.md). A
 * problem whose goal asks for a value or a choice computed from given data (the routing of ./structure/route.mjs) is formalized as
 * `jsEval` wires: pure expressions of the restricted expression language (sop/expression.mjs) over the problem's registry numbers
 * v1..vn (./registry.mjs), which the runtime gives as values. The model writes only the expressions; the numbers come from the
 * message by structure, and the answer must depend on them.
 *
 * Admission (this route's model surface; DS014 "The jsEval route"): only `jsEval` wires with one `expr`; ids are new names (never vK,
 * never twice); an expression reads only registry values and EARLIER wires (so there is no cycle and no recursion), no `?variables`;
 * a text literal must be copied from the message; at least one answer depends on the registry through the dataflow; and the
 * interpreter evaluates every wire within its budgets on the registry values.
 *
 * Lowering: each admitted program is lowered, where it can be, to the arithmetic subset of the expression path
 * (./expression-program.mjs) and from there to `compute`/`compare` rules that every engine executes. Arrays of fixed shape (literals,
 * `range` of a literal bound, `map`/`filter`/`reduce`/`sum`/`count`/`min`/`max`/`includes` over them, records with fixed fields) are
 * unrolled structurally; what has no fixed shape (a `range` over data, `sort`, text methods, an array answer of data-dependent length)
 * stays `jsEval` and is executed by the oracle (the trusted runtime's interpreter), the engines answering `not_expressible`.
 *
 * Everything here is structure (tokens, references, shapes, arithmetic); nothing interprets the problem's words. The question text is
 * the role prompt config/prompts/js-v1.md (data).
 */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseExpression, evaluateExpression} from '../../sop/expression.mjs';
import {parse} from '../../sop/parser.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {parseTemplate, fill} from '../prompt-template.mjs';
import {registryOf, analyseProgram, lowerProgram} from './expression-program.mjs';

export const PROMPT_FILE = fileURLToPath(new URL('../../config/prompts/js-v1.md', import.meta.url));
let template = null;
export const loadJsTemplate = (file = PROMPT_FILE) => (template && file === PROMPT_FILE ? template : (template = parseTemplate(fs.readFileSync(file, 'utf8'))));

/** The registry value of index k as the program reads it: a percentage is its fraction. */
export const registryValue = v => (v.percent ? v.value / 100 : v.value);

/** The chat messages of the route's question (`problems`: the admission's complaints for the second ask). */
export function jsMessages(message, registry, {problems = null, file = PROMPT_FILE} = {}) {
  const t = loadJsTemplate(file);
  const numbers = registry.map(v => `v${v.index} = ${v.span}${v.percent ? ` (a percentage: $v${v.index} is ${registryValue(v)})` : ''}   [${v.context}]`).join('\n');
  const user = fill(t.user, {problem: message, numbers: numbers || '(none)', last: `v${registry.length}`});
  const out = [{role: 'system', content: t.system}, {role: 'user', content: user}];
  if (problems) out.push({role: 'user', content: fill(t.again, {problems})});
  return out;
}

const strip = text => String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```[a-z]*\n?|```/g, '');

/** The wires of a reply: [{id, type, expr, line}] in order (an `expr` continued on indented lines is joined), or [] for none. */
export function readWires(text) {
  const wires = [];
  for (const raw of strip(text).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const head = /^\s*@([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z]+)\s*$/.exec(line);
    if (head) { wires.push({id: head[1], type: head[2], expr: null, line: wires.length + 1}); continue; }
    const cur = wires.at(-1);
    if (!cur) continue;
    const field = /^\s*expr\s+(.+)$/.exec(line);
    if (field && cur.expr === null) { cur.expr = field[1].trim(); continue; }
    // The wire has one field: an indented line without a keyword right under the header is its expression (`expr` left out).
    if (cur.expr === null && !cur.extra && /^\s+\S/.test(raw) && !/^[a-z][A-Za-z_]*\s+[^\s*+\-/%<>=!&|?:.,)\]]/.test(line.trim())) { cur.expr = line.trim(); continue; }
    // An indented line continues the expression unless it has the shape of a field line (`key value`, the key not followed by an operator).
    const fieldLike = /^[a-z][A-Za-z_]*\s+[^\s*+\-/%<>=!&|?:.,)\]]/.test(line.trim());
    if (cur.expr !== null && /^\s+\S/.test(raw) && !fieldLike) cur.expr += ' ' + line.trim();
    else (cur.extra ??= []).push(line.trim());
  }
  return wires;
}

const RESERVED = new Set(['answer_value', 'Math', 'true', 'false', 'null', 'range', 'sum', 'count', 'min', 'max', 'only', 'String', 'Number']);
const walk = (n, f) => { if (!n || typeof n !== 'object') return; f(n); for (const v of Object.values(n)) if (Array.isArray(v)) v.forEach(x => walk(x, f)); else if (v && typeof v === 'object') walk(v, f); };
const fold = s => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Admission of a read program: {ok, violations: [{code, wire, message}], wires: [{id, expr, ast, refs}], answers: [ids], values}.
 * `values` are the interpreter's values of every wire on the registry numbers (the oracle's execution).
 */
export function admitJsProgram(read, registry, message) {
  const violations = [], wires = [];
  const bad = (code, wire, text) => violations.push({code, wire, message: text});
  const regIds = new Map(registry.map(v => [`v${v.index}`, v]));
  const known = new Set(regIds.keys());
  if (!read.length) bad('js_no_wire', null, 'no `@name jsEval` wire with an `expr` line');
  for (const w of read) {
    if (w.type !== 'jsEval') { bad('js_route_type', w.id, `@${w.id} is a ${w.type} wire; this route admits only jsEval wires`); continue; }
    if (w.expr === null) { bad('js_missing_expr', w.id, `@${w.id} has no expr line`); continue; }
    if (w.extra?.length) { bad('js_extra_field', w.id, `@${w.id} has lines other than expr: ${w.extra[0].slice(0, 60)}`); continue; }
    if (/^v\d+$/i.test(w.id)) { bad('js_redefines_registry', w.id, `@${w.id} assigns a registry number (given; read it as $${w.id})`); continue; }
    if (RESERVED.has(w.id)) { bad('js_reserved_name', w.id, `${w.id} is not a usable wire name`); continue; }
    if (wires.some(x => x.id === w.id)) { bad('js_duplicate_name', w.id, `@${w.id} is written twice`); continue; }
    let ast;
    try { ast = parseExpression(w.expr); } catch (error) { bad('js_parse_error', w.id, `@${w.id} does not parse: ${error.message}`); continue; }
    const refs = new Set();
    let ok = true;
    // Member keys (`x.cost`, `xs.map`) are names, not text; every other text literal is a value.
    const keys = new Set();
    walk(ast, n => { if (n.type === 'member' && n.key.type === 'literal') keys.add(n.key); });
    walk(ast, n => {
      if (keys.has(n)) return;
      if (n.type === 'ref') { if (!known.has(n.value)) { ok = false; bad(regIds.size && /^v\d+$/.test(n.value) ? 'js_unknown_registry_index' : 'js_unknown_reference', w.id, `@${w.id} reads $${n.value}, which is neither a number of the problem nor an earlier wire`); } refs.add(n.value); }
      if (n.type === 'var') { ok = false; bad('js_variable', w.id, `@${w.id} uses ${n.value}; this route reads only $ values`); }
      if (n.type === 'literal' && typeof n.value === 'string' && /\p{L}/u.test(n.value) && !fold(message).includes(fold(n.value))) { ok = false; bad('js_text_not_in_message', w.id, `@${w.id} writes the text "${n.value.slice(0, 40)}", which is not copied from the problem`); }
    });
    if (!ok) continue;
    wires.push({id: w.id, expr: w.expr, ast, refs: [...refs]});
    known.add(w.id);
  }
  const tagged = wires.filter(w => /^answer\d*$/.test(w.id));
  const answers = (tagged.length ? tagged : wires.slice(-1)).map(w => w.id);
  // The data dependency: an answer must reach a registry number through the dataflow (a constant answer is a result the model wrote).
  const byId = new Map(wires.map(w => [w.id, w]));
  const reaches = id => { const seen = new Set(), stack = [id]; while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); if (regIds.has(x)) return true; stack.push(...(byId.get(x)?.refs ?? [])); } return false; };
  if (!violations.length) for (const a of answers) if (!reaches(a)) bad('js_answer_not_from_data', a, `@${a} does not depend on any number of the problem; write the expression that computes it from $v1..`);
  let values = null;
  if (!violations.length) {
    try { values = evaluateJsProgram(wires, registry); }
    catch (error) { bad('js_runtime_error', error.wire ?? null, `${error.wire ? `@${error.wire}: ` : ''}${error.message}`); }
  }
  if (values) for (const a of answers) if (values[a] === null || typeof values[a] === 'object' && !Array.isArray(values[a])) bad('js_answer_shape', a, `@${a} yields ${values[a] === null ? 'null' : 'a record'}; an answer is a number, a text, true/false or a list of them`);
  return {ok: violations.length === 0, violations, wires, answers, values};
}

/** The values of every wire by the bounded interpreter (registry numbers as $vK, percentages as fractions); throws with `wire`. */
export function evaluateJsProgram(wires, registry, {maxOps = 10000} = {}) {
  const refs = Object.create(null);
  for (const v of registry) refs[`v${v.index}`] = registryValue(v);
  const out = {};
  for (const w of wires) {
    try { refs[w.id] = evaluateExpression(w.ast, {refs, maxOps}).value; } catch (error) { throw Object.assign(error, {wire: w.id}); }
    out[w.id] = refs[w.id];
  }
  return out;
}

/** The trusted circuit of an admitted program: the registry numbers as `value` wires, then the model's `jsEval` wires. */
export function jsCircuit(admitted, registry) {
  const lines = registry.map(v => `@v${v.index} value\n  data ${registryValue(v)}\n`);
  for (const w of admitted.wires) lines.push(`@${w.id} jsEval\n  expr ${w.expr}\n`);
  return lines.join('\n');
}

/** The oracle's execution: the trusted runtime runs the circuit; the answers are the values of the answer wires. */
export async function runOracle(admitted, registry) {
  const sop = jsCircuit(admitted, registry);
  parse(sop);
  const r = await new Runtime().run(sop);
  return {sop, answers: admitted.answers.map(id => ({id, value: r.values[id]}))};
}

// ------------------------------------------------------------------------------------------------ lowering

class NotLowerable extends Error {}
const no = why => { throw new NotLowerable(why); };
const MAX_RANGE = 64, MAX_NODES = 800;
const lit = value => ({type: 'literal', value});
const bin = (op, left, right) => ({type: 'binary', op, left, right});
const and = (a, b) => (a && b ? bin('&&', a, b) : a ?? b);
const isBool = n => n.type === 'literal' ? typeof n.value === 'boolean' : n.type === 'unary' ? n.op === '!' : n.type === 'binary' && ['&&', '||', '<', '<=', '>', '>=', '==', '===', '!=', '!=='].includes(n.op);
const scalar = (x, what) => (x.kind === 'scalar' ? x.ast : no(`${what} is not a single value`));
const S = ast => ({kind: 'scalar', ast});

/** test ? a : b over lowered values: yes/no values as && || !, arrays item by item, records field by field. */
function select(test, a, b) {
  if (a.kind === 'scalar' && b.kind === 'scalar') {
    if (isBool(a.ast) || isBool(b.ast)) return S(bin('||', bin('&&', test, a.ast), bin('&&', {type: 'unary', op: '!', arg: test}, b.ast)));
    return S({type: 'conditional', test, yes: a.ast, no: b.ast});
  }
  if (a.kind === 'record' && b.kind === 'record' && a.fields.size === b.fields.size && [...a.fields.keys()].every(k => b.fields.has(k))) return {kind: 'record', fields: new Map([...a.fields].map(([k, v]) => [k, select(test, v, b.fields.get(k))]))};
  if (a.kind === 'array' && b.kind === 'array' && a.items.length === b.items.length && [...a.items, ...b.items].every(x => !x.guard)) return {kind: 'array', items: a.items.map((x, i) => ({guard: null, value: select(test, x.value, b.items[i].value)}))};
  return no('a choice between values of different shapes');
}

function lowerNode(n, env, wires) {
  switch (n.type) {
    case 'literal': return n.value === null ? no('null') : S(n);
    case 'ref': return wires.get(n.value) ?? S(n);
    case 'name': return env.has(n.value) ? env.get(n.value) : no(`the name ${n.value}`);
    case 'unary': return S({type: 'unary', op: n.op, arg: scalar(lowerNode(n.arg, env, wires), 'the operand')});
    case 'binary': {
      if (n.op === '??') return no('??');
      return S(bin(n.op, scalar(lowerNode(n.left, env, wires), 'an operand'), scalar(lowerNode(n.right, env, wires), 'an operand')));
    }
    case 'conditional': return select(scalar(lowerNode(n.test, env, wires), 'a test'), lowerNode(n.yes, env, wires), lowerNode(n.no, env, wires));
    case 'array': return {kind: 'array', items: n.items.map(x => ({guard: null, value: lowerNode(x, env, wires)}))};
    case 'object': return {kind: 'record', fields: new Map(n.entries.map(([k, v]) => [k, lowerNode(v, env, wires)]))};
    case 'member': {
      const o = lowerNode(n.object, env, wires), k = n.key.type === 'literal' ? n.key.value : no('a computed key');
      if (o.kind === 'record') return o.fields.has(k) ? o.fields.get(k) : no(`the missing field ${k}`);
      if (o.kind === 'array') {
        if (k === 'length') return o.items.every(x => !x.guard) ? S(lit(o.items.length)) : S(sumOf(o.items.map(x => ({guard: x.guard, value: S(lit(1))}))));
        if (Number.isSafeInteger(k) && o.items.every(x => !x.guard)) return o.items[k]?.value ?? no('an index outside the array');
      }
      return no('this lookup');
    }
    case 'call': return lowerCall(n, env, wires);
    case 'arrow': return no('a function outside map, filter, reduce or count');
    default: return no(`a ${n.type}`);
  }
}

const sumOf = items => items.reduce((acc, x) => {
  const v = x.guard ? {type: 'conditional', test: x.guard, yes: scalar(x.value, 'an item'), no: lit(0)} : scalar(x.value, 'an item');
  return acc ? bin('+', acc, v) : v;
}, null) ?? lit(0);

function apply(fn, args, env, wires) {
  if (fn?.type !== 'arrow') return no('a function argument that is not an arrow');
  const inner = new Map(env);
  fn.params.forEach((p, k) => { if (args[k] === undefined) no('a parameter without a value'); inner.set(p, args[k]); });
  return lowerNode(fn.body, inner, wires);
}

function lowerCall(n, env, wires) {
  const arr = x => { const v = lowerNode(x, env, wires); return v.kind === 'array' ? v : no('a list of data-dependent length'); };
  if (n.callee.type === 'name') {
    const f = n.callee.value, a = n.args;
    if (f === 'range') {
      const bounds = a.map(x => lowerNode(x, env, wires)).map(x => (x.kind === 'scalar' && x.ast.type === 'literal' && Number.isSafeInteger(x.ast.value) ? x.ast.value : no('a range over data (its length depends on the numbers)')));
      const [lo, hi] = bounds.length === 1 ? [0, bounds[0]] : bounds;
      if (hi - lo > MAX_RANGE) no('a long range');
      return {kind: 'array', items: Array.from({length: Math.max(0, hi - lo)}, (_, k) => ({guard: null, value: S(lit(lo + k))}))};
    }
    if (f === 'sum' && a.length === 1) return S(sumOf(arr(a[0]).items));
    if (f === 'count' && a.length === 1) return lowerNode({type: 'member', object: a[0], key: lit('length')}, env, wires);
    if (f === 'count' && a.length === 2) { const xs = arr(a[0]); if (a[1].params?.length > 1 && xs.items.some(x => x.guard)) no('an index after filter'); return S(sumOf(xs.items.map((x, i) => ({guard: and(x.guard, scalar(apply(a[1], [x.value, S(lit(i))], env, wires), 'a test')), value: S(lit(1))})))); }
    if ((f === 'min' || f === 'max') && a.length === 1) { const xs = arr(a[0]); if (!xs.items.length || xs.items.some(x => x.guard)) no(`${f} over a filtered or empty list`); return S({type: 'call', callee: {type: 'member', object: {type: 'name', value: 'Math'}, key: lit(f)}, args: xs.items.map(x => scalar(x.value, 'an item'))}); }
    if (f === 'only' && a.length === 1) { const xs = arr(a[0]); return xs.items.length === 1 && !xs.items[0].guard ? xs.items[0].value : no('only() of a list that is not one item'); }
    return no(`${f}()`);
  }
  if (n.callee.type !== 'member' || n.callee.key.type !== 'literal') return no('this call');
  const key = n.callee.key.value;
  if (n.callee.object.type === 'name' && n.callee.object.value === 'Math') return S({type: 'call', callee: n.callee, args: n.args.map(x => scalar(lowerNode(x, env, wires), 'a Math argument'))});
  const xs = arr(n.callee.object), [f, init] = n.args;
  const indexed = fn => fn?.params?.length > (key === 'reduce' ? 2 : 1);
  if (['map', 'filter', 'reduce'].includes(key) && indexed(f) && xs.items.some(x => x.guard)) no('an index after filter');
  if (key === 'map') return {kind: 'array', items: xs.items.map((x, i) => ({guard: x.guard, value: apply(f, [x.value, S(lit(i))], env, wires)}))};
  if (key === 'filter') return {kind: 'array', items: xs.items.map((x, i) => ({guard: and(x.guard, scalar(apply(f, [x.value, S(lit(i))], env, wires), 'a test')), value: x.value}))};
  if (key === 'reduce') {
    let items = xs.items, acc, offset = 0;
    if (n.args.length === 2) acc = lowerNode(init, env, wires);
    else { if (!items.length || items[0].guard) no('reduce without a start over a filtered or empty list'); acc = items[0].value; items = items.slice(1); offset = 1; }
    items.forEach((x, i) => { const next = apply(f, [acc, x.value, S(lit(i + offset))], env, wires); acc = x.guard ? select(x.guard, next, acc) : next; });
    return acc;
  }
  if (key === 'includes' && n.args.length === 1) {
    const v = scalar(lowerNode(n.args[0], env, wires), 'the value');
    return S(xs.items.reduce((acc, x) => { const t = and(x.guard, bin('==', scalar(x.value, 'an item'), v)); return acc ? bin('||', acc, t) : t; }, null) ?? lit(false));
  }
  if (key === 'slice' && xs.items.every(x => !x.guard) && n.args.every(x => x.type === 'literal' && Number.isSafeInteger(x.value))) return {kind: 'array', items: xs.items.slice(...n.args.map(x => x.value))};
  return no(`.${key}()`);
}

const size = n => { let k = 0; walk(n, () => k++); return k; };
/** The text of a lowered expression in the expression path's syntax (references as bare names). */
export function unparse(n) {
  switch (n.type) {
    case 'literal': return typeof n.value === 'string' ? JSON.stringify(n.value) : typeof n.value === 'number' && n.value < 0 ? `(0 - ${-n.value})` : String(n.value);
    case 'ref': return n.value;
    case 'unary': return n.op === '-' ? `(0 - ${unparse(n.arg)})` : `!(${unparse(n.arg)})`;
    case 'binary': return `(${unparse(n.left)} ${n.op} ${unparse(n.right)})`;
    case 'conditional': return `(${unparse(n.test)} ? ${unparse(n.yes)} : ${unparse(n.no)})`;
    case 'call': return `Math.${n.callee.key.value}(${n.args.map(unparse).join(', ')})`;
    default: throw new NotLowerable(`a ${n.type}`);
  }
}

/**
 * Lowers an admitted program to the engines' circuit where its shape allows: {lowered: true, sop, queries, lines} or {lowered: false,
 * why}. Array and record wires are unrolled into the wires that read them; each answer that is a fixed list becomes one answer per item.
 */
export function lowerJsProgram(admitted, registry, {lexicon = null} = {}) {
  try {
    const shaped = new Map(), lines = [], answers = [];
    // Only the wires an answer reads are lowered (a dead step, e.g. an unused sort, does not keep the program from the engines).
    const byId = new Map(admitted.wires.map(w => [w.id, w])), live = new Set(), stack = [...admitted.answers];
    while (stack.length) { const id = stack.pop(); if (live.has(id) || !byId.has(id)) continue; live.add(id); stack.push(...byId.get(id).refs); }
    for (const w of admitted.wires.filter(x => live.has(x.id))) {
      const v = lowerNode(w.ast, new Map(), shaped);
      const isAnswer = admitted.answers.includes(w.id);
      if (v.kind === 'scalar') {
        if (size(v.ast) > MAX_NODES) no('an expression too large to unroll');
        lines.push({n: lines.length + 1, name: w.id, text: unparse(v.ast)});
        if (isAnswer) answers.push(w.id);
        continue;
      }
      shaped.set(w.id, v);
      if (!isAnswer) continue;
      if (v.kind !== 'array' || v.items.some(x => x.guard || x.value.kind !== 'scalar')) no('an answer that is a list of data-dependent length or a record');
      v.items.forEach((x, k) => { lines.push({n: lines.length + 1, name: `${w.id}_${k + 1}`, text: unparse(x.value.ast)}); answers.push(`${w.id}_${k + 1}`); });
    }
    const used = new Set(lines.flatMap(l => [...l.text.matchAll(/\bv(\d+)\b/g)].map(m => Number(m[1]))));
    const analysis = analyseProgram({lines, unused: registry.map(v => v.index).filter(k => !used.has(k))}, registry);
    if (!analysis.ok) return {lowered: false, why: `the unrolled program is outside the arithmetic subset: ${analysis.violations.slice(0, 2).map(v => v.message).join('; ')}`};
    analysis.program.answers = answers.filter(a => analysis.program.lines.some(l => l.name === a));
    if (analysis.program.answers.length !== answers.length) return {lowered: false, why: 'an answer is constant after unrolling'};
    const out = lowerProgram(analysis, registry, {lexicon});
    return {lowered: true, sop: out.sop, queries: out.queries, lines};
  } catch (error) {
    if (error instanceof NotLowerable) return {lowered: false, why: error.message};
    return {lowered: false, why: `not lowerable: ${error.message}`};
  }
}

/**
 * The jsEval route for one message: the registry, one question (once more on a violation, with the violations named), admission,
 * the oracle's values and the lowering. `chat(messages, maxTokens)` is a proxy client ({ok, text}). Returns {status, registry,
 * attempts, admitted, lowering} where status is `ok`, `no_numbers`, `unavailable` or `rejected`.
 */
export async function jsFormalize({message, chat, registry = null, lexicon = null, maxTokens = null}) {
  registry ??= registryOf(message);
  if (!registry.length) return {status: 'no_numbers', registry, attempts: []};
  const t = loadJsTemplate(), budget = maxTokens ?? t.options.maxTokens ?? 1200;
  const attempts = [];
  let problems = null, admitted = null, first = null;
  for (let round = 0; round < 2; round++) {
    const messages = jsMessages(message, registry, {problems});
    // The second ask keeps the first answer in the conversation, so the model corrects it instead of starting over.
    if (round && first) messages.splice(2, 0, {role: 'assistant', content: first});
    const reply = await chat(messages, budget);
    attempts.push({answer: reply.ok ? reply.text : null, reason: reply.ok ? null : reply.reason ?? 'no answer'});
    if (!reply.ok) return {status: 'unavailable', registry, attempts};
    first ??= reply.text;
    admitted = admitJsProgram(readWires(reply.text), registry, message);
    attempts.at(-1).violations = admitted.violations;
    if (admitted.ok) return {status: 'ok', registry, attempts, admitted, lowering: lowerJsProgram(admitted, registry, {lexicon})};
    problems = admitted.violations.slice(0, 4).map(v => `- ${v.message}`).join('\n');
  }
  return {status: 'rejected', registry, attempts, admitted};
}
