/**
 * Core-to-core desugaring of the sugar wires `default` and `integrity` into core rules (DS004 "Desugaring"). The desugared
 * program is the normative semantics of the sugar; the result is a list of parsed wires plus an `origin` map (generated id ->
 * the author's wire id) so that `used` and proofs name the claim the author wrote, never a generated `x_` wire. The text form
 * (`desugarWires`, `desugarText`, `wireText`) is what the engines that read SOP text consume.
 *
 *   default   -> `applies`, one `blocked` rule per exception, one from the strict contrary (clones of the strict contrary facts
 *                and of the strict rules, i.e. rules whose body does not depend on any default conclusion; "depends" is tested on
 *                predicate names), one per overriding default (`overrides`, or a higher `priority` on a contrary head), a `fired`
 *                rule (`applies`, `absent blocked`) and a conclusion rule. Blocking is by FIRE, not by `applies`.
 *   integrity -> one rule deriving `violation ID WITNESS`. Violations are data, never a hard assertion.
 *
 * Generated ids and predicates start with the reserved prefix `x_`. The generated `blocked` predicate is closed: its
 * completeness is RETRIEVAL completeness for the keys (a keyed lookup of the exception atoms, of `not p a` and of the rules of
 * the contrary), which the host checks; inside the oracle the whole supplied theory is the view.
 */
import {parse, tokens, parseCondition, leaves} from './lexical.mjs';
import {selectInForce} from './governance.mjs';

const lower = s => s.toLowerCase();
const fieldsOf = (w, key) => w.fields.filter(f => f.key === key);

/** Re-emit a condition field with its block lines at a consistent indentation. */
export function emitField(f) {
  const lines = ['  ' + f.key + (f.value ? ' ' + f.value : '')];
  let depth = 0;
  for (const b of f.block) {
    if (b.text === 'end') depth--;
    lines.push('  ' + '  '.repeat(Math.max(depth, 0) + 1) + b.text);
    if (['all', 'any', 'match', 'choose', 'any_order'].includes(b.text) || /^(if|until) /.test(b.text)) depth++;
  }
  if (f.block.length && f.block.at(-1).text === 'end') lines[lines.length - 1] = '  end';
  return lines.join('\n');
}

function headOf(value) {
  const t = tokens(value);
  const neg = t[0] === 'not';
  const rest = neg ? t.slice(1) : t;
  return {neg, p: rest[0], args: rest.slice(1)};
}

const bodyPreds = w => {
  const out = new Set();
  for (const f of fieldsOf(w, 'when')) for (const l of leaves(parseCondition(f, []))) if (l.kind === 'atom') out.add(l.p);
  return out;
};

/** Desugar the wires in force. Returns {wires, origin}. */
export function desugar(wires) {
  const defaults = wires.filter(w => w.type === 'default');
  const integrity = wires.filter(w => w.type === 'integrity');
  if (!defaults.length && !integrity.length) return {wires, origin: new Map()};

  const meta = defaults.map(d => ({
    w: d, id: lower(d.id), head: headOf(fieldsOf(d, 'then')[0].value),
    priority: Number(fieldsOf(d, 'priority')[0]?.value ?? 0),
    overrides: fieldsOf(d, 'overrides').map(f => lower(f.value.trim().slice(1)))
  }));
  // predicates that depend on a default's conclusion: a rule whose body touches them is not STRICT
  const defDep = new Set(meta.map(m => m.head.p));
  for (let changed = true; changed;) {
    changed = false;
    for (const r of wires.filter(w => w.type === 'rule')) {
      const h = headOf(fieldsOf(r, 'then')[0].value).p;
      if (!defDep.has(h) && [...bodyPreds(r)].some(p => defDep.has(p))) { defDep.add(h); changed = true; }
    }
  }

  const texts = [], origin = new Map();
  const emit = (text, source) => {
    texts.push(text);
    origin.set(/^@(\S+)/.exec(text)[1], source);
  };
  const strictName = (p, neg) => `x_strict_${p}_${neg ? 'neg' : 'pos'}`;
  const wantStrict = new Set(meta.map(m => `${m.head.p}|${!m.head.neg}`));
  const declared = new Set();
  const declare = (name, arity, closed) => {
    if (declared.has(name)) return;
    declared.add(name);
    emit(`@${name} predicate\n  args ${arity ? Array(arity).fill('value').join(' ') : 'none'}${closed ? '\n  closed true' : ''}`, name);
  };
  const strictHeads = new Set();
  for (const w of wires) {
    if (w.type !== 'fact' && w.type !== 'rule') continue;
    const h = headOf(fieldsOf(w, w.type === 'fact' ? 'holds' : 'then')[0].value);
    if (!wantStrict.has(`${h.p}|${h.neg}`)) continue;
    if (w.type === 'rule' && [...bodyPreds(w)].some(p => defDep.has(p))) continue;
    const name = strictName(h.p, h.neg);
    strictHeads.add(`${h.p}|${h.neg}`);
    declare(name, h.args.length, false);
    if (w.type === 'fact') emit(`@x_${lower(w.id)}_strict fact\n  holds ${name} ${h.args.join(' ')}`.trimEnd(), w.id);
    else emit(`@x_${lower(w.id)}_strict rule\n${fieldsOf(w, 'when').map(emitField).join('\n')}\n  then ${name} ${h.args.join(' ')}`.trimEnd(), w.id);
  }

  for (const m of meta) {
    const headArgs = m.head.args.join(' ');
    const body = fieldsOf(m.w, 'when').map(emitField).join('\n');
    const arity = m.head.args.length;
    const vars = Array.from({length: arity}, (_, i) => '?v' + (i + 1)).join(' ');
    const src = m.w.id;
    declare(`x_${m.id}_blocked`, arity, true);
    emit(`@x_${m.id}_applies rule\n${body}\n  then x_${m.id}_applies ${headArgs}`.trimEnd(), src);
    for (const [i, ex] of fieldsOf(m.w, 'except').entries()) {
      emit(`@x_${m.id}_exception_${i + 1} rule\n${body}\n${emitField({...ex, key: 'when'})}\n  then x_${m.id}_blocked ${headArgs}`.trimEnd(), src);
    }
    if (strictHeads.has(`${m.head.p}|${!m.head.neg}`)) {
      emit(`@x_${m.id}_strict_contrary rule\n  when ${strictName(m.head.p, !m.head.neg)} ${vars}\n  then x_${m.id}_blocked ${vars}`.trimEnd(), src);
    }
    for (const o of meta) {
      if (o === m) continue;
      const contrary = o.head.p === m.head.p && o.head.neg !== m.head.neg && o.head.args.length === arity;
      const explicit = o.overrides.includes(m.id);
      if (!(explicit || (contrary && o.priority > m.priority))) continue;
      emit(`@x_${m.id}_overridden_by_${o.id} rule\n  when x_${o.id}_fired ${vars}\n  then x_${m.id}_blocked ${vars}`.trimEnd(), src);
    }
    emit(`@x_${m.id}_fire rule\n  when x_${m.id}_applies ${headArgs}\n  when absent x_${m.id}_blocked ${headArgs}\n  then x_${m.id}_fired ${headArgs}`.trimEnd(), src);
    emit(`@x_${m.id}_conclude rule\n  when x_${m.id}_fired ${headArgs}\n  then ${m.head.neg ? 'not ' : ''}${m.head.p} ${headArgs}`.trimEnd(), src);
  }
  for (const w of integrity) {
    const witness = fieldsOf(w, 'witness')[0].value.trim();
    emit(`@x_${lower(w.id)}_violation rule\n${fieldsOf(w, 'never').map(f => emitField({...f, key: 'when'})).join('\n')}\n  then violation ${lower(w.id)} ${witness}`, w.id);
  }
  const generated = parse(texts.join('\n\n') + '\n').wires;
  const passthrough = wires.filter(w => w.type !== 'default' && w.type !== 'integrity');
  return {wires: [...passthrough, ...generated], origin};
}

/** Re-emit a parsed wire as text. */
export function wireText(w) {
  return `@${w.id} ${w.type}\n` + w.fields.map(emitField).join('\n');
}

/** The desugared wires as one program text. */
export const wiresText = wires => wires.map(wireText).join('\n\n') + '\n';

/** Desugar wires already in force; returns {wires, origin, text}. */
export function desugarWires(wires) {
  const r = desugar(wires);
  return {...r, text: wiresText(r.wires)};
}

/** Desugar a program text (knowledge circuits) into core text over the wires in force; `violation` is declared once when needed. */
export function desugarText(text, {asof = null, include = []} = {}) {
  const wires = selectInForce(parse(text).wires, {asof, include});
  const needsViolation = wires.some(w => w.type === 'integrity') && !wires.some(w => w.id === 'violation' && w.type === 'predicate');
  return (needsViolation ? '@violation predicate\n  args subject:entity object:entity\n\n' : '') + desugarWires(wires).text;
}
