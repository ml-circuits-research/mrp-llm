/**
 * Order- and id-free items of a program's wires (DS012 "Keys"): the canonical comparison key of a wire. The
 * evaluation (wire F1, proposition matching) and the product (sentence merging in `lib/sentence-split.mjs`) share
 * it, so it lives with the language modules and imports nothing from `eval/` or `tools/`.
 */
import {parseProposition, propositionPairs, linksOf} from './parser.mjs';
import {propositionOf} from './propositions.mjs';

/**
 * Folding of quoted strings for strict comparison: NFKD, marks removed, lower case, whitespace collapsed. Cedilla
 * letters fold with their comma forms because both lose the mark.
 */
export const foldText = text => String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const REF = /^\$[A-Za-z][A-Za-z0-9_]*$/;
const TOKEN = /"(?:\\.|[^"\\])*"|\?[A-Za-z][A-Za-z0-9_]*|\$[A-Za-z][A-Za-z0-9_]*|\s+/g;
const slot = (kind, text) => ({slot: kind, text: String(text)});

/**
 * Order- and id-free items of a program's wires, for wire F1 and proposition matching. Each item is
 * `{id, type, key, skeleton, slots}`: `skeleton` is the wire with every quoted relation phrase and value replaced
 * by `#`, `slots` lists those strings in skeleton order (`{slot: 'relation'|'value', text}`), and `key` is the
 * skeleton with each slot folded (`foldText`), so equal keys mean strict equality and equal skeletons with
 * pairwise `Dictionary.sameMeaning` slots mean tolerant equality.
 *
 * - `stated`/`assumed`: relation, role names (sorted) with their values, polarity, validity; certainty, speaker
 *   and basis are ignored unless `withCertainty` (then certainty and the speaker join the key).
 * - Other wires (`query`, `constraint`, `unclear`, `unparsed`): the fields in written order with `basis` dropped;
 *   inside a field, the quoted string after `relation` is a relation slot and every other quoted string a value slot.
 * - `?variables` are renamed by first appearance inside each wire.
 * - Wire ids never enter a key: a `$id` role value, a link line (`because $s2`) or a `near $s1` is replaced by the
 *   referenced wire's own item (recursively). An unknown target or a reference cycle falls back to the wire ids
 *   renamed by first appearance in the program (`$w1`, `$w2`, …).
 * - Link lines of a wire are (keyword, target item) pairs, sorted by keyword then target skeleton.
 */
export function wireItems(wires, {withCertainty = false} = {}) {
  const byId = new Map(wires.map(w => [w.id, w]));
  const renamed = new Map(), memo = new Map();
  const rename = id => { if (!renamed.has(id)) renamed.set(id, '$w' + (renamed.size + 1)); return renamed.get(id); };
  const reference = (id, stack) => {
    if (!byId.has(id) || stack.has(id)) return [rename(id)];
    const target = build(byId.get(id), stack);
    return ['{', ...target.parts, '}'];
  };
  const build = (w, stack = new Set()) => {
    if (memo.has(w.id) && !stack.size) return memo.get(w.id);
    const inner = new Set([...stack, w.id]);
    let parts = null;
    if (w.type === 'stated' || w.type === 'assumed') {
      try { parts = propositionParts(w, inner); } catch { parts = null; /* malformed proposition: generic parts */ }
    }
    parts ??= genericParts(w, inner);
    const item = {id: w.id, type: w.type, parts, ...render(w.type, parts)};
    if (!stack.size) memo.set(w.id, item);
    return item;
  };
  const propositionParts = (w, stack) => {
    const p = parseProposition(propositionPairs(w), {where: '@' + w.id + ' ' + w.type});
    const names = new Map();
    const variable = v => (names.has(v) || names.set(v, '?v' + (names.size + 1)), names.get(v));
    const parts = [w.type, ' relation ', slot('relation', p.relation)];
    for (const role of [...p.roles].sort((a, b) => a.name.localeCompare(b.name))) {
      parts.push(' role ' + role.name + ' ');
      const v = role.value;
      if (v && typeof v === 'object' && v.ref) parts.push(...reference(v.ref, stack));
      else if (typeof v === 'number') parts.push(String(v));
      else if (v.startsWith('?')) parts.push(variable(v));
      else parts.push(slot('value', v));
    }
    parts.push(' polarity ' + p.polarity);
    for (const form of Object.keys(p.valid ?? {}).sort()) parts.push(' valid ' + form + ' ', slot('value', p.valid[form]));
    if (withCertainty && w.type === 'stated') {
      const s = propositionOf(w);
      parts.push(' certainty ' + s.certainty + ' speaker ', s.speaker === 'user' ? 'user' : slot('value', s.speaker));
    }
    parts.push(...linkParts(w, stack));
    return parts;
  };
  const linkParts = (w, stack) => {
    let links;
    try { links = linksOf(w); } catch { return []; }
    return links.map(link => [link.keyword, reference(link.target, stack)])
      .map(([keyword, target]) => ({keyword, target, skeleton: render('', target).skeleton}))
      .sort((a, b) => a.keyword.localeCompare(b.keyword) || a.skeleton.localeCompare(b.skeleton))
      .flatMap(link => [' ' + link.keyword + ' ', ...link.target]);
  };
  const genericParts = (w, stack) => {
    const names = new Map();
    const parts = [w.type];
    const keys = Object.keys(w.fields).filter(key => key !== 'basis');
    for (const key of keys) for (const value of w.fields[key]) {
      parts.push(' ' + key + ' ');
      let previous = key, last = 0;
      const text = String(value);
      for (const match of text.matchAll(TOKEN)) {
        const literal = text.slice(last, match.index);
        if (literal) { parts.push(literal); previous = literal.trim().split(/\s+/).pop() || previous; }
        last = match.index + match[0].length;
        const token = match[0];
        if (/^\s+$/.test(token)) { parts.push(' '); continue; }
        if (token.startsWith('"')) {
          let decoded;
          try { decoded = JSON.parse(token); } catch { decoded = token; }
          parts.push(slot(previous === 'relation' ? 'relation' : 'value', decoded));
        } else if (token.startsWith('?')) parts.push((names.has(token) || names.set(token, '?v' + (names.size + 1)), names.get(token)));
        else if (REF.test(token)) parts.push(...reference(token.slice(1), stack));
        previous = token;
      }
      const tail = text.slice(last);
      if (tail) parts.push(tail);
    }
    return parts;
  };
  return wires.map(w => build(w));
}
/** Skeleton, slots and strict key of a parts list. */
function render(type, parts) {
  let skeleton = '', key = '';
  const slots = [];
  for (const part of parts) {
    if (typeof part === 'string') { skeleton += part; key += part; }
    else { skeleton += '#'; key += JSON.stringify(foldText(part.text)); slots.push(part); }
  }
  return {skeleton, key, slots};
}


/** The key of one wire on its own (references to other wires fall back to renamed ids). */
export const wireKey = wire => wireItems([wire])[0].key;
