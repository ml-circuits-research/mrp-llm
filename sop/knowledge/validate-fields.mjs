/**
 * Field-level checks of the knowledge validator: the value of one field against its grammar kind (`checkValue`), the step
 * grammar of a method (`checkSteps`) and the integer expressions of a constraint.
 */
import {checkNumericValue} from './numeric-action.mjs';
import {COMPARATORS, ARITHMETIC, ROLE_NAMES, MAX_ARITY, STEP_BLOCKS, ARG_TYPES, LANGUAGE_CODE, REPLY_SLOT} from './grammar.mjs';

/** The one language of the knowledge: labels, aliases and lexemes of any other language are rejected (owner decision 2026-10-01). */
const CORE_LANGUAGE = 'en';
import {VAR, SYMBOL, INTEGER, NUMBER, REF, DATE, tokens, termError, atomFrom, varsOf, parseCondition} from './lexical.mjs';

export function checkValue(spec, f, wire, ctx) {
  const {problems} = ctx;
  const push = (code, message) => problems.push({code, line: f.line, message, wire: wire.id});
  const v = f.value.trim();
  let toks = tokens(v);
  switch (spec.kind) {
    case 'bool': if (!['true', 'false'].includes(v)) push('bad_value', f.key + ' must be true or false'); break;
    case 'int': if (!INTEGER.test(v)) push('bad_value', f.key + ' must be an integer'); break;
    case 'posint': if (!/^[1-9]\d*$/.test(v)) push('bad_value', f.key + ' must be a positive integer'); break;
    case 'text': if (!v) push('bad_value', f.key + ' needs text'); else if (v.startsWith('"')) { try { JSON.parse(v); } catch { push('bad_value', f.key + ' has a bad JSON string'); } } break;
    case 'enum': if (!spec.values.includes(v)) push('bad_enum', f.key + ' must be one of ' + spec.values.join('|') + ', got "' + v + '"'); break;
    // `quantifier WORD`, and `at_least N` with a positive count (the oracle's form, sop/enums.mjs QUANTIFIER_WORDS; capability battery 2026-10-02)
    case 'quantifier': if (!spec.values.includes(toks[0]) || (toks[0] === 'at_least' ? !(toks.length === 2 && /^[1-9]\d*$/.test(toks[1])) : toks.length !== 1)) push('bad_enum', f.key + ' must be one of ' + spec.values.join('|') + ' (at_least takes a positive count), got "' + v + '"'); break;
    case 'time': if (!(v === 'timeless' || (toks.length === 2 && toks.every(t => DATE.test(t))))) push('bad_time', 'valid must be "timeless" or "START END"'); break;
    case 'vars': if (!toks.length || !toks.every(t => VAR.test(t))) push('bad_vars', f.key + ' needs ?variables'); break;
    case 'ref': if (!REF.test(v)) push('bad_ref', f.key + ' needs $id or ~id'); else ctx.refs.push({id: v.slice(1), line: f.line, wire: wire.id, sigil: v[0]}); break;
    case 'argtypes': {
      if (v === 'none') { (ctx.argSpecs ??= {})[wire.id] = []; break; }
      const specs = toks.map(t => { const [a, b] = t.includes(':') ? t.split(':') : [null, t]; return {role: a, type: b}; });
      if (!toks.length || toks.length > MAX_ARITY || !specs.every(x => ARG_TYPES.includes(x.type) && (x.role === null || ROLE_NAMES.includes(x.role)))) { push('bad_args', 'args needs none (arity 0) or 1..' + MAX_ARITY + ' entries "role:type" or "type" with type in ' + ARG_TYPES.join('|') + ' and role in ' + ROLE_NAMES.join('|')); break; }
      const withRole = specs.filter(x => x.role !== null);
      if (withRole.length && withRole.length !== specs.length) push('args_mixed_roles', 'give a role to every argument or to none');
      else if (!withRole.length) problems.push({code: 'args_without_roles', severity: 'warning', line: f.line, message: 'predicate ' + wire.id + ' has no roles; the host lexicon needs role:type to place SymbolicLM roles', wire: wire.id});
      if (new Set(withRole.map(x => x.role)).size !== withRole.length) push('duplicate_role', 'a role may name one argument position only');
      (ctx.argSpecs ??= {})[wire.id] = specs;
      break;
    }
    case 'langcode':
      if (!LANGUAGE_CODE.test(v)) push('bad_language', f.key + ' needs a language code of two or three lowercase letters, got "' + v + '"');
      else if (v !== CORE_LANGUAGE) push('non_english_knowledge', f.key + ' ' + v + ': the knowledge is English only (a message in another language is translated at the edges, DS014 "English-only core")');
      break;
    case 'replytext': {
      let text = null;
      try { text = v.startsWith('"') ? JSON.parse(v) : null; } catch { text = null; }
      if (typeof text !== 'string' || !text.trim()) push('bad_value', f.key + ' needs one JSON-quoted nonempty text');
      else if (text.replace(REPLY_SLOT, '').includes('{{') || text.replace(REPLY_SLOT, '').includes('}}')) push('bad_reply_slot', f.key + ' has a malformed placeholder; write {{name}} with a lowercase name');
      break;
    }
    case 'phrase': {
      let text = null;
      try { text = v.startsWith('"') ? JSON.parse(v) : null; } catch { text = null; }
      if (typeof text !== 'string' || !text.trim() || /[\r\n]/.test(text)) push('bad_value', f.key + ' needs one JSON-quoted nonempty phrase without a line break');
      break;
    }
    case 'langtext': {
      const [lang, ...rest] = toks;
      let text = null;
      try { text = rest.length === 1 && rest[0].startsWith('"') ? JSON.parse(rest[0]) : null; } catch { text = null; }
      if (!LANGUAGE_CODE.test(lang ?? '') || typeof text !== 'string' || !text.trim() || /[\r\n]/.test(text)) push('bad_value', f.key + ' needs LANGUAGE "surface" (a two or three letter language code and one JSON-quoted nonempty surface)');
      else if (lang !== CORE_LANGUAGE) push('non_english_knowledge', f.key + ' ' + lang + ': the knowledge is English only (a message in another language is translated at the edges, DS014 "English-only core")');
      else (ctx.surfaces ??= []).push({wire: wire.id, key: f.key, language: lang, surface: text, line: f.line});
      break;
    }
    case 'roletype': {
      if (toks.length !== 2 || !ROLE_NAMES.includes(toks[0]) || !/^[a-z][a-z0-9_]*$/.test(toks[1])) { push('bad_role', 'role NAME TYPE with NAME in ' + ROLE_NAMES.join('|') + ' and TYPE a value type (' + ARG_TYPES.join('|') + ') or a class symbol'); break; }
      ((ctx.roleSpecs ??= {})[wire.id] ??= []).push({role: toks[0], type: toks[1], line: f.line});
      break;
    }
    case 'rolelist': {
      if (!toks.length || toks.length > MAX_ARITY || !toks.every(t => ROLE_NAMES.includes(t)) || new Set(toks).size !== toks.length) push('bad_frame', f.key + ' needs one to ' + MAX_ARITY + ' distinct role names from ' + ROLE_NAMES.join('|') + ' in realization order');
      break;
    }
    case 'restrict': {
      if (toks.length !== 2 || !ROLE_NAMES.includes(toks[0]) || !/^[a-z][a-z0-9_]*$/.test(toks[1])) push('bad_restrict', 'restrict ROLE CLASS with ROLE in ' + ROLE_NAMES.join('|') + ' and CLASS a class symbol');
      break;
    }
    case 'reflist': if (!toks.length || !toks.every(t => /^\$[A-Za-z][A-Za-z0-9_]*$/.test(t))) push('bad_ref', f.key + ' needs one or more $id'); else for (const t of toks) ctx.refs.push({id: t.slice(1), line: f.line, wire: wire.id, sigil: '$'}); break;
    case 'date': if (!(toks.length === 1 && DATE.test(toks[0]))) push('bad_time', f.key + ' needs one ISO date or timestamp'); break;
    case 'instant': if (!(toks.length === 1 && DATE.test(toks[0]))) push('bad_time', f.key + ' needs one ISO date or timestamp'); break;
    case 'interval': if (!(toks.length === 2 && toks.every(t => DATE.test(t)))) push('bad_time', f.key + ' needs "START END" (start inclusive, end exclusive; beginning and open allowed)'); break;
    case 'ident': if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(v)) push('bad_value', f.key + ' needs a JavaScript identifier'); break;
    case 'sym': if (!SYMBOL.test(v)) push('bad_value', f.key + ' needs a lowercase symbol'); break;
    case 'flag': if (v) push('bad_value', f.key + ' takes no value'); break;
    case 'stepref': if (!/^~[A-Za-z][A-Za-z0-9_]*$/.test(v)) push('bad_ref', f.key + ' needs ~action'); else ctx.refs.push({id: v.slice(1), line: f.line, wire: wire.id, sigil: '~'}); break;
    case 'normpat': {
      const a = toks[0]?.startsWith('~') ? (REF.test(toks[0]) && toks.slice(1).every(t => !termError(t)) ? {action: toks[0].slice(1), terms: toks.slice(1)} : {error: 'bad action pattern'}) : atomFrom(toks);
      if (a.error) push('bad_norm_pattern', f.key + ' needs "~action term..." or a state atom: ' + a.error);
      else {
        if (a.action) ctx.refs.push({id: a.action, line: f.line, wire: wire.id, sigil: '~'}); else (ctx.atoms ??= []).push({...a, line: f.line, wire: wire.id, key: f.key});
        wire.normPat = a.action ? {action: a.action, terms: a.terms} : {pred: a.p, terms: a.terms};
        wire.modality = f.key;
      }
      break;
    }
    case 'prefer': {
      const ok = toks.length >= 3 && toks[0].startsWith('~') && toks.includes('over') && toks[toks.indexOf('over') + 1]?.startsWith('~');
      if (!ok) push('bad_prefer', 'prefer ~a over ~b');
      else for (const t of [toks[0], toks[toks.indexOf('over') + 1]]) ctx.refs.push({id: t.slice(1), line: f.line, wire: wire.id, sigil: '~'});
      break;
    }
    case 'onfail': if (!(['replan', 'abort'].includes(v) || /^\$[A-Za-z][A-Za-z0-9_]*$/.test(v))) push('bad_value', 'on_failure is $method, replan or abort'); else if (v.startsWith('$')) ctx.refs.push({id: v.slice(1), line: f.line, wire: wire.id, sigil: '$'}); break;
    case 'viastep': case 'groundstep': {
      if (!toks[0]?.startsWith('~') || !REF.test(toks[0])) { push('bad_step', f.key + ' needs "~action term..."'); break; }
      // a trace step may end with "at DATE" (round 3: conformance is judged against the versions in force at that time)
      if (spec.kind === 'groundstep' && toks.length > 2 && toks.at(-2) === 'at') { if (DATE.test(toks.at(-1))) toks = toks.slice(0, -2); else push('bad_time', 'at needs a date or timestamp'); }
      ctx.refs.push({id: toks[0].slice(1), line: f.line, wire: wire.id, sigil: '~'});
      const bad = toks.slice(1).map(termError).find(Boolean);
      if (bad) push('bad_step', bad);
      if (spec.kind === 'groundstep' && toks.slice(1).some(t => VAR.test(t))) push('trace_step_not_ground', 'a trace step has constants only');
      (ctx.stepCalls ??= []).push({action: toks[0].slice(1), n: toks.length - 1, line: f.line, wire: wire.id});
      break;
    }
    case 'atom': case 'groundatom': case 'natom': case 'groundnatom': {
      const a = atomFrom(toks, {allowNeg: spec.kind.includes('n') && spec.kind !== 'groundatom' && spec.kind !== 'atom' ? true : false, ground: spec.kind.startsWith('ground')});
      if (a.error) push('bad_atom', a.error + ' in "' + v + '"');
      else (ctx.atoms ??= []).push({...a, line: f.line, wire: wire.id, key: f.key});
      break;
    }
    case 'cond': {
      const sub = [];
      const tree = parseCondition(f, sub, {allowAbsent: !(wire.type === 'fact')});
      for (const p of sub) problems.push({...p, wire: wire.id});
      if (tree) (wire.conds ??= []).push({key: f.key, tree});
      break;
    }
    case 'aggspec': {
      const ok = (toks.length === 2 && toks[0] === 'as' && VAR.test(toks[1])) || (toks.length === 3 && VAR.test(toks[0]) && toks[1] === 'as' && VAR.test(toks[2]));
      if (!ok) push('bad_aggspec', f.key + ' needs "?field as ?out" (count may be "as ?out")');
      else wire.aggs = [...(wire.aggs ?? []), {fn: f.key, field: toks.length === 3 ? toks[0] : null, out: toks[toks.length - 1]}];
      break;
    }
    case 'vardecl': {
      const ok = VAR.test(toks[0] ?? '') && toks[1] === 'int' && (toks.length === 2 || (toks.length === 4 && INTEGER.test(toks[2]) && INTEGER.test(toks[3]) && Number(toks[2]) <= Number(toks[3])));
      if (!ok) push('bad_var_decl', 'var needs "?name int [MIN MAX]" with MIN <= MAX'); else (wire.vars ??= []).push(toks[0]);
      break;
    }
    case 'cmp': case 'expr': {
      const e = exprError(toks, spec.kind === 'cmp');
      if (e) push('bad_expression', e + ' in "' + v + '"');
      else (wire.exprVars ??= []).push(...varsOf(toks));
      break;
    }
    case 'step': {
      checkSteps(f, wire, ctx, push);
      break;
    }
    case 'role': {
      if (!ROLE_NAMES.includes(toks[0]) || toks.length !== 2) push('bad_role', 'role NAME VALUE with NAME in ' + ROLE_NAMES.join(', '));
      break;
    }
    case 'numnext': case 'numguard': case 'numobserve': for (const p of checkNumericValue(spec.kind, f)) push(p.code, p.message); break;
    case 'compareline': case 'orderline': case 'argline': break;
    default: break;
  }
}


/** Validate one `step` field of a method: a leaf, or a block (choose, any_order, if/else, until ... max N) closed by end. */
function checkSteps(f, wire, ctx, push) {
  const lines = [{text: f.value.trim(), line: f.line}, ...f.block];
  const stack = [];
  const pushLeafAtom = (a, line) => { (ctx.atoms ??= []).push({...a, line, wire: wire.id, key: 'step'}); };
  const leaf = (toks, line) => {
    let t = toks;
    if (t[0] === 'optional') t = t.slice(1);
    if (t[0] === 'achieve') {
      const a = atomFrom(t.slice(1));
      if (a.error) push('bad_step', 'achieve ATOM: ' + a.error); else pushLeafAtom(a, line);
      return;
    }
    if (t[0] === 'pick') {
      if (!VAR.test(t[1] ?? '') || t[2] !== 'where') { push('bad_step', 'pick ?x where ATOM'); return; }
      const a = atomFrom(t.slice(3));
      if (a.error) push('bad_step', 'pick ?x where ATOM: ' + a.error); else pushLeafAtom(a, line);
      return;
    }
    if (t[0]?.startsWith('~')) {
      if (!REF.test(t[0])) { push('bad_step', 'bad action handle'); return; }
      ctx.refs.push({id: t[0].slice(1), line, wire: wire.id, sigil: '~'});
      const bad = t.slice(1).map(termError).find(Boolean);
      if (bad) push('bad_step', bad);
      (ctx.stepCalls ??= []).push({action: t[0].slice(1), n: t.length - 1, line, wire: wire.id});
      return;
    }
    const a = atomFrom(t);
    if (a.error) push('bad_step', 'a step is "~action term...", a sub-task atom, achieve, pick, optional or a block: ' + a.error);
    else { (ctx.tasksCalled ??= []).push({p: a.p, line, wire: wire.id}); pushLeafAtom(a, line); }
  };
  for (const l of lines) {
    const toks = tokens(l.text);
    const head = toks[0];
    if (l.text === 'end') { stack.pop(); continue; }
    if (l.text === 'else') {
      const top = stack.at(-1);
      if (!top || top.kind !== 'if' || top.seenElse) push('else_outside_if', 'else belongs inside "step if ... end" once');
      else top.seenElse = true;
      continue;
    }
    if (STEP_BLOCKS.includes(head)) {
      const top = {kind: head, line: l.line};
      if (head === 'choose' || head === 'any_order') { if (toks.length !== 1) push('bad_step', head + ' takes no arguments'); }
      if (head === 'if') {
        const a = atomFrom(toks.slice(1), {allowNeg: true, allowAbsent: true});
        if (a.error) push('bad_step', 'if ATOM: ' + a.error);
        else (wire.conds ??= []).push({key: 'step_if', tree: {kind: 'atom', ...a, line: l.line}});
      }
      if (head === 'until') {
        const mi = toks.indexOf('max');
        if (mi < 0 || !/^[1-9]\d*$/.test(toks[mi + 1] ?? '') || mi + 2 !== toks.length) push('until_needs_max', 'until ATOM max N: a loop needs a positive integer step cap');
        const a = atomFrom(toks.slice(1, mi < 0 ? undefined : mi), {allowNeg: true, allowAbsent: true});
        if (a.error) push('bad_step', 'until ATOM max N: ' + a.error);
        else (wire.conds ??= []).push({key: 'step_until', tree: {kind: 'atom', ...a, line: l.line}});
      }
      stack.push(top);
      continue;
    }
    leaf(toks, l.line);
  }
  // a choose block needs at least two alternatives (counted separately, on close)
  const stack2 = [];
  for (const l of lines) {
    const head = tokens(l.text)[0];
    if (l.text === 'end') { const t = stack2.pop(); if (t?.kind === 'choose' && t.branches < 2) push('choose_needs_alternatives', 'choose needs at least two alternatives'); continue; }
    if (l.text === 'else') continue;
    const p = stack2.at(-1);
    if (p?.kind === 'choose') p.branches++;
    if (STEP_BLOCKS.includes(head)) stack2.push({kind: head, branches: 0});
  }
}

function exprError(toks, comparison) {
  const sides = [[]];
  for (const t of toks) {
    if (COMPARATORS.includes(t)) { if (!comparison || sides.length > 1) return 'one comparator word only'; sides.push([]); } else sides[sides.length - 1].push(t);
  }
  if (comparison && sides.length !== 2) return 'a comparison needs one of ' + COMPARATORS.join('|');
  for (const side of sides) {
    if (!side.length || side.length % 2 === 0) return 'malformed arithmetic';
    for (let i = 0; i < side.length; i++) {
      if (i % 2 === 1) { if (!ARITHMETIC.includes(side[i])) return 'expected one of ' + ARITHMETIC.join('|') + ', got ' + side[i]; } else if (!(VAR.test(side[i]) || NUMBER.test(side[i]))) return 'bad operand ' + side[i];
    }
  }
  return null;
}
