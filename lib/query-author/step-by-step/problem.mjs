/**
 * Problem mode of LocalLLMStepByStep (DS022 "LocalLLMStepByStep", DS014 "Problems that state their own data"): a message that gives
 * its own numbers, things or conditions and asks about them is modelled from its own text. The small model answers short structured
 * questions (which kind of result, the values the problem gives as `name = number` lines, the formulas of the asked values, the options,
 * or the facts and rules of a deduction); the system writes the circuit: one session predicate per value or property, `stated` wires
 * for the given data, session rules whose `compute` lines are the formulas, and the queries. The engines compute; the model never
 * writes a result. Reading the model's lines is structure (names, numbers, arithmetic), never an interpretation of the user's words.
 */
import {numberMentioned} from '../admit.mjs';
import {readChoice, readChoices} from './answers.mjs';
import {protocolData} from '../../formalize/protocol-data.mjs';

/** The kinds of result a problem asks for (the first problem question), from the protocol layer: [[kind, text]]. */
export const problemKinds = (data = protocolData()) => choicesOf(data, 'problem_kind').map(c => [c.value, c.text]);
const choicesOf = (data, q) => data.rows('choice').filter(r => r[0] === q).map(([, n, value]) => ({n, value, text: data.rows('choice_text').find(r => r[0] === q && r[1] === n)?.[2] ?? String(value)})).sort((a, b) => a.n - b.n);

const strip = text => String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\*\*|`/g, '').trim();
const lines = text => strip(text).split('\n').map(s => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean);
const RESERVED = new Set(['not', 'absent', 'compare', 'compute', 'order', 'start_of', 'end_of', 'all', 'any', 'end', 'match', 'else', 'if', 'then', 'and']);
/** A predicate-safe name from the model's own words (structure: lower case, underscores). */
export const slug = text => String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'n_$1').slice(0, 40);
const number = text => { const t = String(text).replace(/[,  ](?=\d{3}\b)/g, ''); return /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : null; };

/**
 * The text of a problem question from the protocol layer (config/knowledge/formalizer-protocol-v1/0060-problem.sop; the last text wins,
 * so the learned layer may replace one), with its {{placeholders}} filled and the learned hints and examples after it.
 */
export function problemText(data, q, vars = {}) {
  const texts = data.rows('question_text').filter(r => r[0] === q);
  if (!texts.length) throw new Error(`the protocol has no text for the problem question ${q}`);
  const choices = choicesOf(data, q).map(c => `${c.n}. ${c.text}`).join('\n');
  const fill = t => String(t).replace(/\{\{(\w+)\}\}/g, (_, k) => k === 'choices' ? choices : k === 'count' ? String(choicesOf(data, q).length) : String(vars[k] ?? ''));
  const extra = [...data.rows('example').filter(r => r[0] === q).map(r => `Example: ${r[1]}`), ...data.rows('hint').filter(r => r[0] === q).map(r => r[1])].map(fill);
  return [fill(texts.at(-1)[1]), ...extra].join('\n');
}

/** The problem questions as text functions (rendered from the protocol layer; kept for callers and tests). */
export const problemQuestions = {
  kind: (data = protocolData()) => problemText(data, 'problem_kind'),
  values: (data = protocolData()) => problemText(data, 'problem_values'),
  formulas: (names, kind, data = protocolData()) => problemText(data, 'problem_formulas', {names: names.join(', '), kind_note: data.one('problem_kind_note', kind, 'problem_formulas') ?? ''}),
  options: (names, data = protocolData()) => problemText(data, 'problem_options', {names: names.join(', ')}),
  direction: (data = protocolData()) => problemText(data, 'problem_direction'),
  facts: (data = protocolData()) => problemText(data, 'problem_facts'),
  rules: (data = protocolData()) => problemText(data, 'problem_rules'),
  question: (data = protocolData()) => problemText(data, 'problem_question'),
  asked: (names, data = protocolData()) => problemText(data, 'problem_asked', {numbered_names: names.map((n, i) => `${i + 1}. ${n}`).join('\n')}),
  again: (what, data = protocolData()) => problemText(data, 'problem_again', {what}),
};

/** `name = number` lines; numbers must be written in the message (a percentage written as a fraction is kept as written). */
export function readValues(text, message) {
  const out = [];
  for (const line of lines(text)) {
    const m = /^([A-Za-z][\w ]*?)\s*[=:]\s*(-?[\d][\d,.  ]*)\s*(%?)\s*(?:[A-Za-z%$€£].*)?$/.exec(line);
    if (!m) continue;
    const name = slug(m[1]), value = number(m[2].trim().replace(/\.$/, ''));
    if (!name || value === null || out.some(v => v.name === name)) continue;
    if (numberMentioned(value, message)) out.push({name, value});
    else if (numberMentioned(Math.round(value * 1e6) / 1e4, message)) out.push({name, value: Math.round(value * 1e6) / 1e4, percent: true});
  }
  return out.length ? out : null;
}

/** Arithmetic of a formula → {lines: compute lines, result: ?var, uses: [names]} or null. Operators + - * / ^, parentheses, round/ceil/floor. */
export function readFormula(expression, known) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][\w]*)|(\*\*|\/\/|[-+*/^(),×·÷−%]))/y;
  const text = String(expression).trim();
  let at = 0;
  while (at < text.length) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) { if (/^\s*$/.test(text.slice(at))) break; return null; }
    at = re.lastIndex;
    if (m[1] !== undefined) tokens.push({t: 'num', v: Number(m[1])});
    else if (m[2] !== undefined) tokens.push({t: 'name', v: m[2]});
    else tokens.push({t: 'op', v: {'×': '*', '·': '*', '÷': '/', '−': '-', '**': '^'}[m[3]] ?? m[3]});
  }
  let i = 0, counter = 0;
  const out = [], uses = new Set();
  const fresh = () => `?t${++counter}`;
  const peek = () => tokens[i], take = () => tokens[i++];
  const WORDS = {'+': 'plus', '-': 'minus', '*': 'times', '/': 'divided_by', '//': 'whole_divided_by', '%': 'modulo', '^': 'power'};
  const emit = (a, word, b) => { const v = fresh(); out.push(`compute ${v} ${a} ${word} ${b}`); return v; };
  const primary = () => {
    const tok = take();
    if (!tok) throw new Error('end');
    if (tok.t === 'num') return String(tok.v);
    if (tok.t === 'op' && tok.v === '(') { const v = sum(); if (take()?.v !== ')') throw new Error(')'); return v; }
    if (tok.t === 'op' && tok.v === '-') { const v = primary(); return /^\d/.test(v) ? '-' + v : emit('0', 'minus', v); }
    if (tok.t === 'name') {
      const fn = tok.v.toLowerCase();
      // max(a, b, ...) and min(a, b, ...): a chain of the exact compute words maximum_with / minimum_with.
      if (['max', 'min'].includes(fn) && peek()?.v === '(') {
        take();
        let acc = sum();
        while (peek()?.v === ',') { take(); acc = emit(acc, fn === 'max' ? 'maximum_with' : 'minimum_with', sum()); }
        if (take()?.v !== ')') throw new Error(')');
        return acc;
      }
      if (['round', 'ceil', 'floor'].includes(fn) && peek()?.v === '(') {
        take();
        const arg = sum();
        let step = '1';
        if (peek()?.v === ',') { take(); const s = take(); if (s?.t !== 'num') throw new Error('step'); step = String(s.v); }
        if (take()?.v !== ')') throw new Error(')');
        return emit(arg, {round: 'rounded_to', ceil: 'rounded_up_to', floor: 'rounded_down_to'}[fn], step);
      }
      const name = slug(tok.v);
      if (!known.has(name)) throw new Error(`unknown ${name}`);
      uses.add(name);
      return `?v_${name}`;
    }
    throw new Error('token');
  };
  const power = () => { let a = primary(); while (peek()?.v === '^') { take(); a = emit(a, 'power', primary()); } return a; };
  const product = () => { let a = power(); while (['*', '/', '//', '%'].includes(peek()?.v)) { const op = take().v; a = emit(a, WORDS[op], power()); } return a; };
  const sum = () => { let a = product(); while (['+', '-'].includes(peek()?.v)) { const op = take().v; a = emit(a, WORDS[op], product()); } return a; };
  try {
    const result = sum();
    if (i !== tokens.length) return null;
    // A formula that is only a name or a number still needs one line that binds the result.
    const final = out.length ? result : emit(result, 'plus', '0');
    return {lines: out, result: final, uses: [...uses]};
  } catch { return null; }
}

const CHECKS = [['>=', 'at_least', 'below'], ['≥', 'at_least', 'below'], ['<=', 'at_most', 'above'], ['≤', 'at_most', 'above'], ['!=', 'not_equal', 'equal'], ['≠', 'not_equal', 'equal'], ['==', 'equal', 'not_equal'], ['>', 'above', 'at_most'], ['<', 'below', 'at_least'], ['=', 'equal', 'not_equal']];

/**
 * `new_name = formula` lines over the known names; each line may use the names of earlier lines. A formula that compares two sides
 * (`card_ok = price >= 20`) is a check: its rules derive the yes or the explicit no, and the question about it is yes/no.
 */
export function readFormulas(text, names) {
  const known = new Set(names), checks = new Set(), out = [];
  for (const line of lines(text)) {
    const m = /^([A-Za-z][\w ]*?)\s*=(?!=)\s*(.+)$/.exec(line);
    if (!m) continue;
    let name = slug(m[1]);
    const body = m[2].replace(/≈.*$/, '').trim();
    // An identity on a given value (`my_var = my_var`): the asked quantity is that value itself (a message that states a value and
    // asks it back). It becomes the formula `value_of_<name> = <name>`, so the engines answer the given value.
    if (name && known.has(name) && slug(body) === name && names.includes(name)) name = `value_of_${name}`;
    if (!name || known.has(name)) continue;
    // A check: comparisons and earlier checks joined by "and" (`ok = cost <= budget and fits`).
    const parts = body.replace(/^\((.*)\)$/, '$1').split(/\s+and\s+|\s*&&\s*/i);
    if (parts.some(part => CHECKS.some(([symbol]) => part.includes(symbol)) || checks.has(slug(part)))) {
      const conditions = [];
      for (const [k, part] of parts.entries()) {
        const flag = slug(part.replace(/^\(|\)$/g, ''));
        if (checks.has(flag)) { conditions.push({flag}); continue; }
        const check = CHECKS.find(([symbol]) => part.includes(symbol));
        if (!check) { conditions.length = 0; break; }
        const [symbol, word, opposite] = check, at = part.indexOf(symbol);
        const rename = (f, side) => f && {...f, lines: f.lines.map(l => l.replace(/\?t(\d+)/g, (_, n) => `?c${k}${side}${n}`)), result: f.result.replace(/^\?t(\d+)$/, `?c${k}${side}$1`)};
        const left = rename(readFormula(part.slice(0, at).replace(/^\(/, ''), known), 'l'), right = rename(readFormula(part.slice(at + symbol.length).replace(/\)$/, ''), known), 'r');
        if (!left || !right) { conditions.length = 0; break; }
        conditions.push({word, opposite, left: left.result, right: right.result, lines: [...left.lines, ...right.lines], uses: [...new Set([...left.uses, ...right.uses])]});
      }
      if (!conditions.length) continue;
      known.add(name); checks.add(name);
      out.push({name, check: {conditions}, lines: [], uses: [...new Set(conditions.flatMap(c => c.uses ?? []))]});
      continue;
    }
    const formula = readFormula(body.replace(/=.*$/, ''), known);
    if (!formula) continue;
    known.add(name);
    out.push({name, ...formula, ...(name.startsWith('value_of_') && names.includes(name.slice(9)) ? {identity: true} : {})});
  }
  // Identities count only when the reply has no real formula: otherwise they would add answers nobody asked for.
  const real = out.filter(f => !f.identity);
  const kept = (real.length ? real : out).map(({identity: _identity, ...f}) => f);
  return kept.length ? kept : null;
}

/**
 * Fact lines → [{thing, property, negated, object?}]: `thing | property` (a fact about one thing) or `thing | relation | other thing`
 * (a relation between two things), `not` before the property or relation when it does not hold; every thing is written in the
 * message. With `question`, a place may be an unknown (`?x`, `?`), and `count` before the line asks how many: the result carries
 * `ask` ('thing' | 'object') and `count`.
 */
export function readFacts(text, message, {single = false, question = false} = {}) {
  const out = [];
  const folded = String(message).toLowerCase();
  const unknown = t => question && /^\?\w*$/.test(t);
  // The thing is written as in the message; a name the model wrote with underscores is matched with spaces.
  const named = raw => {
    let t = raw.trim().replace(/^["“]|["”]$/g, '');
    if (unknown(t)) return '?';
    if (!folded.includes(t.toLowerCase()) && folded.includes(t.replace(/_/g, ' ').toLowerCase())) t = t.replace(/_/g, ' ');
    return t && folded.includes(t.toLowerCase()) ? t : null;
  };
  for (const raw of lines(text)) {
    const count = question && /^count\s+/i.test(raw);
    const parts = raw.replace(/^count\s+/i, '').split('|').map(x => x.trim());
    if (parts.length < 2 || parts.length > 3) continue;
    const negated = /^not\s+/i.test(parts[1]);
    const property = slug(parts[1].replace(/^not\s+/i, ''));
    const thing = named(parts[0]), object = parts.length === 3 ? named(parts[2]) : null;
    if (!thing || !property || (parts.length === 3 && !object)) continue;
    if (thing === '?' && object === '?') continue;
    const ask = thing === '?' ? 'thing' : object === '?' ? 'object' : null;
    if ((count || ask) && !question) continue;
    out.push({thing, property, negated, ...(parts.length === 3 ? {object} : {}), ...(ask ? {ask} : {}), ...(count && ask ? {count: true} : {})});
    if (single) break;
  }
  return out.length ? out : null;
}

/**
 * Rule lines → [{when: [atom], then: atom}], an atom {property, negated, args?}: `if a and not b then c` over properties of one thing
 * (the implicit unknown ?x), or with explicit unknowns `?x relation ?y` / `?x property` (`if ?x parent_of ?y and ?y parent_of ?z then
 * ?x grandparent_of ?z`).
 */
export function readRules(text) {
  if (/^\s*none\b/i.test(strip(text))) return [];
  const out = [];
  const literal = raw => {
    const n = /^\s*not\s+/i.test(raw);
    const words = raw.replace(/^\s*not\s+/i, '').trim().split(/\s+/);
    const vars = words.filter(w => /^\?[a-z]\w*$/i.test(w)).map(w => w.toLowerCase());
    const p = slug(words.filter(w => !/^\?[a-z]\w*$/i.test(w)).join(' '));
    if (!p) return null;
    if (!vars.length) return {property: p, negated: n};
    if (vars.length > 2 || !/^\?/.test(words[0])) return null;
    return {property: p, negated: n, args: vars};
  };
  for (const line of lines(text)) {
    const m = /^if\s+(.+?)\s*,?\s+then\s+(.+)$/i.exec(line);
    if (!m) continue;
    const when = m[1].split(/\s+and\s+/i).map(literal), then = literal(m[2]);
    if (!when.every(Boolean) || !then) continue;
    // Explicit unknowns: every unknown of the head must occur in a positive condition (a safe rule).
    const bound = new Set(when.filter(w => !w.negated).flatMap(w => w.args ?? ['?x']));
    if (!(then.args ?? ['?x']).every(v => bound.has(v))) continue;
    out.push({when, then});
  }
  return out.length ? out : null;
}

/** A session predicate id that does not collide with the memory's vocabulary or a reserved word. */
function predicateId(name, lexicon, taken) {
  // `x_` is reserved for generated wires (sop/knowledge/validate.mjs reserved_prefix).
  let id = /^[a-z]/.test(name) && !/^x_/.test(name) ? name : `p_${name}`;
  if (RESERVED.has(id) || lexicon?.predicates?.[id] || lexicon?.entities?.[id]) id = `${id}_value`;
  while (taken.has(id)) id = `${id}_x`;
  taken.add(id);
  return id;
}

const stated = (id, relation, roles, negated = false) => `@${id} stated\n  certainty asserted\n  relation "${relation}"\n${roles.map(([name, value]) => `  role ${name} ${typeof value === 'number' ? value : JSON.stringify(value)}`).join('\n')}\n  polarity ${negated ? 'negated' : 'affirmed'}\n`;

/** The circuit of an arithmetic problem: value predicates, stated values, one rule per formula, the queries. */
export function arithmeticCircuit({values, formulas, options = [], direction = null, asked: wanted = null, lexicon, onlyAsked = false}) {
  const taken = new Set(), id = new Map();
  for (const v of values) id.set(v.name, predicateId(v.name, lexicon, taken));
  for (const f of formulas) id.set(f.name, predicateId(f.name, lexicon, taken));
  // A percentage the model wrote as a fraction (0.11 for "11%") is stated as written (11) and divided by 100 in its own rule.
  const percent = new Map(values.filter(v => v.percent).map(v => [v.name, predicateId(`${v.name}_percent`, lexicon, taken)]));
  const out = [];
  for (const pid of [...id.values(), ...percent.values()]) out.push(`@${pid} predicate\n  args object:value\n`);
  values.forEach((v, k) => out.push(stated(`s${k + 1}`, percent.get(v.name) ?? id.get(v.name), [['object', v.value]])));
  for (const [name, pid] of percent) out.push(`@${id.get(name)}_rule rule\n  when ${pid} ?p\n  when compute ?f ?p divided_by 100\n  then ${id.get(name)} ?f\n`);
  formulas.forEach((f, k) => {
    const when = [...f.uses.map(u => `  when ${id.get(u)} ?v_${u}`), ...f.lines.map(l => `  when ${l}`)].join('\n');
    if (!f.check) { out.push(`@r${k + 1} rule\n${when}${when ? '\n' : ''}  then ${id.get(f.name)} ${f.result}\n`); return; }
    // A check derives its yes when every condition holds (`then NAME 1`) and its explicit no when one condition fails (`then not NAME 1`,
    // one rule per condition), so the yes/no question is supported or refuted, never left unknown.
    const lines = c => c.flag ? [] : [...c.uses.map(u => `  when ${id.get(u)} ?v_${u}`), ...c.lines.map(l => `  when ${l}`)];
    const yes = f.check.conditions.flatMap(c => c.flag ? [`  when ${id.get(c.flag)} 1`] : [...lines(c), `  when compare ${c.left} ${c.word} ${c.right}`]);
    out.push(`@r${k + 1} rule\n${[...new Set(yes)].join('\n')}\n  then ${id.get(f.name)} 1\n`);
    f.check.conditions.forEach((c, j) => out.push(`@r${k + 1}n${j + 1} rule\n${(c.flag ? [`  when not ${id.get(c.flag)} 1`] : [...lines(c), `  when compare ${c.left} ${c.opposite} ${c.right}`]).join('\n')}\n  then not ${id.get(f.name)} 1\n`));
  });
  const used = new Set(formulas.flatMap(f => f.uses));
  // The values the question asks for (the model's choice) first, then the values no other formula uses (the final results): a small
  // model often picks an intermediate value, and a question with several parts needs every final result.
  const finals = formulas.filter(f => !used.has(f.name));
  // `onlyAsked` (goals are declared, intermediate values are not answers; written for the stage-A decomposition, archived 2026-10-03 in
  // probably_obsolete/formalization-experiments-2026-10/): exactly the asked values, besides a choice.
  const asked = onlyAsked ? formulas.filter(f => wanted?.includes(f.name)) : wanted?.length ? [...formulas.filter(f => wanted.includes(f.name)), ...finals.filter(f => !wanted.includes(f.name))] : finals;
  if (options.length && direction) {
    out.push('@option_score predicate\n  args subject:entity object:value\n');
    options.forEach((o, k) => out.push(stated(`o${k + 1}`, 'is_option', [['subject', o.option]])));
    out.unshift('@is_option predicate\n  args subject:entity\n');
    // An option's limits (`requires`: checks that must hold) are conditions of its score: an option that fails one is not ranked.
    options.forEach((o, k) => out.push(`@ro${k + 1} rule\n  when ${id.get(o.value)} ?v\n  when is_option ${JSON.stringify(o.option)}\n${(o.requires ?? []).map(r => `  when ${id.get(r)} 1\n`).join('')}  then option_score ${JSON.stringify(o.option)} ?v\n`));
    out.push(`@q query\n  select ?o\n  where match\n    relation "option_score"\n    role subject ?o\n    role object ?v\n    polarity affirmed\n  end\n  rank ${direction} ?v\n`);
    out.push(`@q2 query\n  select ?o ?v\n  where match\n    relation "option_score"\n    role subject ?o\n    role object ?v\n    polarity affirmed\n  end\n`);
  }
  if (onlyAsked && options.length && direction) asked.forEach((f, k) => out.push(f.check ? `@qa${k + 1} query\n  where match\n    relation "${id.get(f.name)}"\n    role object 1\n    polarity affirmed\n  end\n`
    : `@qa${k + 1} query\n  select ?x\n  where match\n    relation "${id.get(f.name)}"\n    role object ?x\n    polarity affirmed\n  end\n`));
  else if (!(options.length && direction)) {
    asked.forEach((f, k) => out.push(f.check ? `@q${k ? k + 1 : ''} query\n  where match\n    relation "${id.get(f.name)}"\n    role object 1\n    polarity affirmed\n  end\n`
      : `@q${k ? k + 1 : ''} query\n  select ?x\n  where match\n    relation "${id.get(f.name)}"\n    role object ?x\n    polarity affirmed\n  end\n`));
  }
  return out.join('\n');
}

/**
 * The circuit of a deduction: one session predicate per property (one place) or relation (two places), the stated facts, the rules,
 * and the question. A problem is its own closed world (DS014 "Problems that state their own data"): what its facts and rules do not
 * give does not hold, so a yes/no question ("does X follow, is X forced, is X shown") is answered yes when X is derived and no
 * otherwise (the asked predicate is closed, and an answer predicate `<name>_follows` is derived from its presence or absence); a
 * who/what question selects the unknown place, `count` counts it.
 */
export function deductionCircuit({facts, rules, question, lexicon}) {
  const taken = new Set(), id = new Map(), arity = new Map();
  const note = (p, n) => { if (arity.has(p) && arity.get(p) !== n) return false; arity.set(p, n); return true; };
  const atomArity = a => a.args ? a.args.length : 1;
  for (const f of facts) if (!note(f.property, f.object ? 2 : 1)) return null;
  for (const r of rules) for (const a of [...r.when, r.then]) if (!note(a.property, atomArity(a))) return null;
  if (!note(question.property, question.object ? 2 : 1)) return null;
  for (const p of arity.keys()) id.set(p, predicateId(p, lexicon, taken));
  const asked = id.get(question.property), binary = Boolean(question.object);
  const args = n => n === 2 ? 'subject:entity object:entity' : 'subject:entity';
  const yesno = !question.ask;
  const follows = yesno ? predicateId(`${question.property}_follows`, lexicon, taken) : null;
  const out = [...[...arity].map(([p, n]) => `@${id.get(p)} predicate\n  args ${args(n)}\n${yesno && id.get(p) === asked ? '  closed true\n' : ''}`), ...(follows ? [`@${follows} predicate\n  args ${args(binary ? 2 : 1)}\n`] : [])];
  facts.forEach((f, k) => out.push(stated(`s${k + 1}`, id.get(f.property), [['subject', f.thing], ...(f.object ? [['object', f.object]] : [])], f.negated)));
  const atom = a => `${a.negated ? 'not ' : ''}${id.get(a.property)} ${(a.args ?? ['?x']).join(' ')}`;
  rules.forEach((r, k) => out.push(`@r${k + 1} rule\n${r.when.map(w => `  when ${atom(w)}`).join('\n')}\n  then ${atom(r.then)}\n`));
  const term = t => JSON.stringify(t);
  if (yesno) {
    const terms = [question.thing, ...(binary ? [question.object] : [])].map(term).join(' ');
    const [yes, no] = question.negated ? [`absent ${asked} ${terms}`, `${asked} ${terms}`] : [`${asked} ${terms}`, `absent ${asked} ${terms}`];
    out.push(`@rq rule\n  when ${yes}\n  then ${follows} ${terms}\n`, `@rqn rule\n  when ${no}\n  then not ${follows} ${terms}\n`);
    out.push(`@q query\n  where match\n    relation "${follows}"\n    role subject ${term(question.thing)}\n${binary ? `    role object ${term(question.object)}\n` : ''}    polarity affirmed\n  end\n`);
    return out.join('\n');
  }
  const place = q => q === '?' ? '?x' : term(q);
  out.push(`@q query\n${question.count ? '  mode count\n' : ''}  select ?x\n  where match\n    relation "${asked}"\n    role subject ${place(question.thing)}\n${binary ? `    role object ${place(question.object)}\n` : ''}    polarity ${question.negated ? 'negated' : 'affirmed'}\n  end\n`);
  return out.join('\n');
}

/**
 * The structural readers of the problem answers, by the answer format the protocol names (fp_answer_format), and where each result is
 * kept. `st` is the state of the problem so far ({message, kind, values, formulas, options, direction, ...}).
 */
export const PROBLEM_READERS = Object.freeze({
  number: {read: (t, st, data, q) => { const n = readChoice(t, choicesOf(data, q).length); return n ? choicesOf(data, q)[n - 1].value : null; }},
  values: {slot: 'values', read: (t, st) => readValues(t, st.message)},
  formulas: {slot: 'formulas', read: (t, st) => readFormulas(t, st.values.map(v => v.name))},
  options: {slot: 'options', read: (t, st) => {
    const computed = st.formulas.map(f => f.name), out = [];
    for (const line of lines(t)) {
      const m = /^(.+?)\s*[=:|]\s*([A-Za-z][\w ]*)$/.exec(line);
      if (!m) continue;
      const option = m[1].trim().replace(/^["“]|["”]$/g, ''), value = slug(m[2]);
      if (String(st.message).toLowerCase().includes(option.toLowerCase()) && computed.includes(value)) out.push({option, value});
    }
    // Each option is judged by one value: an option named on several lines is not a reading (the question is asked again).
    if (new Set(out.map(o => o.option.toLowerCase())).size !== out.length) return null;
    return out.length > 1 ? out : null;
  }},
  asked: {slot: 'asked', read: (t, st) => readChoices(t, st.formulas.length)},
  terms: {slot: 'terms', read: t => readTerms(t)},
  facts: {slot: 'facts', read: (t, st) => declaredOnly(st, readFacts(t, st.message), f => [f])},
  rules: {slot: 'rules', read: (t, st) => { const r = readRules(t); return r && r.length ? declaredOnly(st, r, x => [...x.when, x.then]) : r; }},
  fact: {slot: 'question', read: (t, st) => declaredOnly(st, readFacts(t, st.message, {single: true, question: true})?.[0] ?? null, f => [f])},
});

/** `name` lines → the declared property and relation names (a problem's shared vocabulary), or null. */
export function readTerms(text) {
  const out = [];
  for (const line of lines(text)) {
    const name = slug(line.replace(/^\s*(?:not\s+)?/i, '').replace(/[:(].*$/, ''));
    if (name && !out.includes(name)) out.push(name);
  }
  return out.length ? out.slice(0, 24) : null;
}

/** Keeps only the readings over declared names (the shared vocabulary); null when nothing is left. Without a vocabulary: unchanged. */
const declaredOnly = (st, reading, atoms) => {
  if (!st.terms?.length || reading === null) return reading;
  const ok = new Set(st.terms);
  const kept = (Array.isArray(reading) ? reading : [reading]).filter(x => atoms(x).every(a => ok.has(a.property)));
  return Array.isArray(reading) ? (kept.length ? kept : null) : kept[0] ?? null;
};

/**
 * Whether a message can state its own data, by structure only: it writes a number, or it has a sentence before its last one (a
 * statement before the question). A one-sentence question without a number ("Is a whale a mammal?") asks the memory, so problem mode
 * is not offered for it (chat guard, 2026-10-03). Sentence ends are . ! ? followed by space or the end, not inside a decimal.
 */
export function statesOwnData(message) {
  const text = String(message ?? '').trim();
  if (/(?<![\p{L}])\d/u.test(text)) return true;
  return text.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(x => /\p{L}/u.test(x)).length >= 2;
}

/** The structural preconditions problem mode may require (fp_problem_needs). */
export const PROBLEM_PRECONDITIONS = Object.freeze({stated_data: statesOwnData});

/** Problem mode applies to `message` when every precondition the protocol names holds. */
export const problemModeApplies = (message, data = protocolData()) => data.rows('problem_needs').every(([c]) => PROBLEM_PRECONDITIONS[c]?.(message) ?? true);

/** The structural conditions a problem step may require (fp_problem_step_when). */
const CONDITIONS = Object.freeze({
  options_found: st => (st.options ?? []).length > 0,
  no_direction: st => !st.direction,
  several_formulas: st => (st.formulas ?? []).length > 1,
});

/** The placeholder values of a problem question from the state so far. */
const varsOf = (data, q, st) => ({
  names: (q === 'problem_options' ? st.formulas.map(f => f.name) : (st.values ?? []).map(v => v.name)).join(', '),
  numbered_names: (st.formulas ?? []).map((f, i) => `${i + 1}. ${f.name}`).join('\n'),
  // The shared vocabulary of a deduction, for the questions after it (empty when the protocol does not ask for it).
  terms: st.terms?.length ? st.terms.join(', ') : '',
  terms_note: st.terms?.length ? data.one('problem_terms_note') ? String(data.one('problem_terms_note')).replace('{{terms}}', st.terms.join(', ')) : '' : '',
  kind_note: data.one('problem_kind_note', st.kind, q) ?? '',
});

/**
 * The problem questions, driven by the protocol layer: the kind of problem, then the steps of that kind in order (fp_problem_step),
 * each asked when its conditions hold; an unreadable answer of a required step, or an exit kind, ends problem mode (null: the caller
 * then formalizes the request with the general protocol). `oracle` is the step-by-step oracle. Returns {sop, report} or null.
 */
export async function problemCircuit(oracle, {message, lexicon, data = protocolData()}) {
  const tries = async (q, vars, reader) => {
    const tokens = data.one('problem_tokens', q) ?? 64;
    const again = problemText(data, 'problem_again', {what: String(data.one('problem_again', q) ?? 'Reply in the format asked.').replace(/\{\{count\}\}/g, String(choicesOf(data, q).length))});
    try { return await oracle.read(q, problemText(data, q, vars), reader, again, tokens); } catch { return null; }
  };
  const st = {message, kind: null, values: [], formulas: [], options: [], direction: null, asked: null, terms: null, facts: null, rules: [], question: null};
  st.kind = await tries('problem_kind', {}, t => PROBLEM_READERS.number.read(t, st, data, 'problem_kind'));
  if (!st.kind || data.rows('problem_exit_kind').some(r => r[0] === st.kind)) return null;
  const steps = data.rows('problem_step').filter(r => r[0] === st.kind).sort((a, b) => a[1] - b[1]).map(r => r[2]);
  if (!steps.length) return null;
  for (const q of steps) {
    if (!data.rows('problem_step_when').filter(r => r[0] === q).every(([, c]) => CONDITIONS[c]?.(st))) continue;
    const format = data.one('answer_format', q);
    const reader = PROBLEM_READERS[format];
    if (!reader) throw new Error(`the problem question ${q} names an unknown answer format ${format}`);
    const value = await tries(q, varsOf(data, q, st), t => reader.read(t, st, data, q));
    if (value === null && data.rows('problem_required').some(r => r[0] === q)) return null;
    if (value === null) continue;
    if (reader.slot) st[reader.slot] = value;
    else if (q === 'problem_direction') st.direction = value;
  }
  if (st.facts) {
    if (!st.question) return null;
    const sop = deductionCircuit({facts: st.facts, rules: st.rules ?? [], question: st.question, lexicon});
    if (!sop) return null;
    return {sop, report: {kind: st.kind, facts: st.facts.length, rules: (st.rules ?? []).length, ...(st.question.ask ? {asks: st.question.count ? 'count' : 'which'} : {})}};
  }
  if (!st.values.length || !st.formulas.length) return null;
  const asked = st.asked && st.asked[0] !== 0 ? st.asked.map(k => st.formulas[k - 1].name) : null;
  const direction = st.direction ?? null;
  return {sop: arithmeticCircuit({values: st.values, formulas: st.formulas, options: st.options, direction, asked, lexicon}),
    report: {kind: st.kind, values: st.values.length, formulas: st.formulas.length, options: st.options.length, direction}};
}
