/**
 * Lexical level of the knowledge language: `@id type` headers, exactly two spaces before a field keyword, one keyword per
 * line, `all`/`any`/`match`/`end` blocks, JSON-quoted text, `?variables`, `$id` and `~id` references, atoms of 0 to 6 terms
 * and the condition leaves (`not`, `absent`, `compare`, `compute`, `order`, `start_of`, `end_of`). Structural problems are
 * collected, never thrown.
 */
import {captureCircuit, captureEnabled} from '../../lib/circuit-capture.mjs';
import {expandCompact} from '../compact.mjs';
import {COMPARATORS, COMPUTE, ORDER_WORDS, ROLE_NAMES, LINK_KEYWORDS, MAX_ARITY, STEP_BLOCKS} from './grammar.mjs';

export const ID = /^[A-Za-z][A-Za-z0-9_]*$/;
export const VAR = /^\?[a-z][a-z0-9_]*$/;
export const SYMBOL = /^[a-z][a-z0-9_]*$/;
export const INTEGER = /^-?\d+$/;
/** A number term: an integer or a decimal (`0.11`, `-2.5`); decimals are exact (DS004 "Exact arithmetic"). */
export const NUMBER = /^-?\d+(?:\.\d+)?$/;
export const DECIMAL = /^-?\d+\.\d+$/;
export const REF = /^[$~][A-Za-z][A-Za-z0-9_]*$/;
export const DATE = /^(\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?|beginning|open)$/;

/** Split a field value into tokens, keeping JSON-quoted strings whole. */
export function tokens(text) {
  const out = [];
  const re = /"(?:[^"\\]|\\.)*"|\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

export function termError(t) {
  if (VAR.test(t) || NUMBER.test(t) || SYMBOL.test(t) || REF.test(t)) return null;
  if (t.startsWith('"')) {
    try { JSON.parse(t); return null; } catch { return 'bad JSON string ' + t; }
  }
  return 'bad term ' + JSON.stringify(t);
}

/** Parse the lines of a text into wires; structural problems are collected, not thrown. */
export function parse(text) {
  if (captureEnabled) captureCircuit(text, 'knowledge');
  // The compact surface (`@id type key=value`) is read as the canonical one (sop/compact.mjs, DS024).
  text = expandCompact(text);
  const errors = [];
  const wires = [];
  const seen = new Set();
  const lines = text.split(/\r?\n/);
  let cur = null, field = null, stack = [];
  const err = (code, line, message) => errors.push({code, line, message, wire: cur?.id ?? null});
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], n = i + 1, trimmed = raw.trim();
    if (stack.length) {
      if (!trimmed || trimmed.startsWith('#')) continue;
      field.block.push({text: trimmed, line: n, indent: raw.length - raw.trimStart().length});
      if (trimmed === 'end') stack.pop();
      else if (stack.at(-1) === 'step' && STEP_BLOCKS.includes(trimmed.split(/\s+/)[0])) stack.push('step');
      else if (stack.at(-1) !== 'step' && ['all', 'any', 'match'].includes(trimmed)) stack.push(trimmed);
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (raw.startsWith('@')) {
      const m = /^@(\S+)\s+(\S+)\s*$/.exec(raw);
      if (!m) { err('bad_header', n, 'header must be "@id type": ' + raw); cur = null; continue; }
      if (!ID.test(m[1])) err('bad_id', n, 'bad wire id ' + m[1]);
      if (seen.has(m[1])) err('duplicate_id', n, 'duplicate wire id ' + m[1]);
      seen.add(m[1]);
      cur = {id: m[1], type: m[2], line: n, fields: []};
      wires.push(cur);
      continue;
    }
    if (!cur) { err('field_outside_wire', n, 'field before any wire header'); continue; }
    if (!raw.startsWith('  ') || raw.startsWith('   ')) { err('bad_indent', n, 'a field needs exactly two leading spaces: ' + raw); continue; }
    const m = /^  ([A-Za-z_]+)(?:\s+(.*?))?\s*$/.exec(raw);
    if (!m) { err('bad_field_line', n, 'cannot read field line: ' + raw); continue; }
    field = {key: m[1], value: m[2] ?? '', line: n, block: []};
    cur.fields.push(field);
    const first = tokens(field.value)[0];
    // `quantifier all` names a quantifier, it does not open a condition group
    if (['all', 'any', 'match'].includes(field.value.trim()) && m[1] !== 'quantifier') stack.push(field.value.trim());
    else if (m[1] === 'step' && STEP_BLOCKS.includes(first)) stack.push('step');
  }
  if (stack.length) errors.push({code: 'unclosed_block', line: lines.length, message: 'a block is not closed with end', wire: cur?.id ?? null});
  return {wires, errors};
}

/** Parse one atom (optionally prefixed) from tokens. Returns {neg, p, terms} or {error}. */
export function atomFrom(toks, {allowNeg = false, allowAbsent = false, ground = false} = {}) {
  let neg = 'none', i = 0;
  if (toks[0] === 'not') { if (!allowNeg) return {error: '"not" is not allowed here'}; neg = 'not'; i = 1; }
  else if (toks[0] === 'absent') { if (!allowAbsent) return {error: '"absent" is not allowed here'}; neg = 'absent'; i = 1; }
  const p = toks[i];
  if (!p || !SYMBOL.test(p)) return {error: 'bad predicate ' + JSON.stringify(p)};
  if (['not', 'absent', 'compare', 'compute', 'order', 'start_of', 'end_of', 'all', 'any', 'end', 'match', 'else'].includes(p)) return {error: 'reserved word used as predicate: ' + p};
  const terms = toks.slice(i + 1);
  if (terms.length > MAX_ARITY) return {error: 'arity must be 0..' + MAX_ARITY + ', got ' + terms.length};
  for (const t of terms) {
    const e = termError(t);
    if (e) return {error: e};
    if (ground && (VAR.test(t) || t.startsWith('$'))) return {error: 'ground atom required, found ' + t};
  }
  return {neg, p, terms};
}

export const varsOf = terms => terms.filter(t => VAR.test(t));

/** Parse a condition field (inline leaf or block) into a tree; push problems into `problems`. */
export function parseCondition(field, problems, opts = {}) {
  const allowAbsent = opts.allowAbsent !== false;
  const head = field.value.trim();
  const lines = field.block.map(b => ({...b}));
  const leaf = (text, line) => {
    const toks = tokens(text);
    if (toks[0] === 'compare') {
      if (toks.length !== 4 || !COMPARATORS.includes(toks[2])) { problems.push({code: 'bad_compare', line, message: 'compare A WORD B with WORD in ' + COMPARATORS.join('|')}); return null; }
      for (const t of [toks[1], toks[3]]) { const e = termError(t); if (e) problems.push({code: 'bad_term', line, message: e}); }
      return {kind: 'compare', left: toks[1], word: toks[2], right: toks[3], line};
    }
    if (toks[0] === 'compute') {
      if (toks.length !== 5 || !VAR.test(toks[1]) || !COMPUTE.includes(toks[3])) { problems.push({code: 'bad_compute', line, message: 'compute ?v A WORD B with WORD in ' + COMPUTE.join('|')}); return null; }
      for (const t of [toks[2], toks[4]]) { const e = termError(t); if (e) problems.push({code: 'bad_term', line, message: e}); }
      if (['divided_by', 'whole_divided_by', 'modulo', 'rounded_to', 'rounded_up_to', 'rounded_down_to'].includes(toks[3]) && /^-?0+(?:\.0+)?$/.test(toks[4])) problems.push({code: 'division_by_zero', line, message: 'division by the constant zero'});
      return {kind: 'compute', out: toks[1], left: toks[2], word: toks[3], right: toks[4], line};
    }
    if (toks[0] === 'order') {
      if (toks.length !== 4 || !VAR.test(toks[1]) || !ORDER_WORDS.includes(toks[2]) || !VAR.test(toks[3])) { problems.push({code: 'bad_order', line, message: 'order ?t1 WORD ?t2 with WORD in ' + ORDER_WORDS.join('|')}); return null; }
      return {kind: 'order', left: toks[1], word: toks[2], right: toks[3], line};
    }
    if (toks[0] === 'start_of' || toks[0] === 'end_of') {
      if (!VAR.test(toks[1] ?? '')) { problems.push({code: 'bad_time_leaf', line, message: toks[0] + ' ?t ATOM binds the start or end of the validity of a stored fact'}); return null; }
      const at = atomFrom(toks.slice(2));
      if (at.error) { problems.push({code: 'bad_atom', line, message: at.error + ' in "' + text + '"'}); return null; }
      return {kind: 'timeof', which: toks[0], out: toks[1], ...at, line};
    }
    const a = atomFrom(toks, {allowNeg: true, allowAbsent});
    if (a.error) { problems.push({code: 'bad_atom', line, message: a.error + ' in "' + text + '"'}); return null; }
    return {kind: 'atom', ...a, line};
  };
  const model = (idx) => {
    // model-form match block: lines idx.. until matching end
    const node = {kind: 'match', roles: [], line: lines[idx]?.line ?? field.line};
    let j = idx;
    while (j < lines.length && lines[j].text !== 'end') {
      const t = tokens(lines[j].text);
      if (t[0] === 'relation') node.relation = t[1];
      else if (t[0] === 'role') {
        if (!ROLE_NAMES.includes(t[1])) problems.push({code: 'bad_role', line: lines[j].line, message: 'role must be one of ' + ROLE_NAMES.join(', ')});
        node.roles.push({name: t[1], value: t[2]});
      } else if (t[0] === 'polarity') node.polarity = t[1];
      else if (LINK_KEYWORDS.includes(t[0])) node.link = t[0];
      else problems.push({code: 'bad_match_line', line: lines[j].line, message: 'unknown match line "' + lines[j].text + '"'});
      j++;
    }
    if (!node.polarity) problems.push({code: 'match_needs_polarity', line: node.line, message: 'a match needs a polarity line'});
    return {node, next: j + 1};
  };
  const group = (kind, idx) => {
    const node = {kind, children: [], line: field.line};
    let j = idx;
    while (j < lines.length) {
      const t = lines[j].text;
      if (t === 'end') return {node, next: j + 1};
      if (t === 'all' || t === 'any') { const r = group(t, j + 1); node.children.push(r.node); j = r.next; continue; }
      if (t === 'match') { const r = model(j + 1); node.children.push(r.node); j = r.next; continue; }
      const l = leaf(t, lines[j].line);
      if (l) node.children.push(l);
      j++;
    }
    problems.push({code: 'unclosed_block', line: field.line, message: 'condition group not closed'});
    return {node, next: j};
  };
  if (head === 'all' || head === 'any') return group(head, 0).node;
  if (head === 'match') return model(0).node;
  return leaf(head, field.line);
}

/** Flatten a condition tree to leaves. */
export function leaves(node, out = []) {
  if (!node) return out;
  if (node.children) node.children.forEach(c => leaves(c, out));
  else out.push(node);
  return out;
}
