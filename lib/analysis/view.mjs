/**
 * The document view of an analysis run (DS022 "Analysis procedures"): structure, not understanding. The document layer is closed under
 * the run's rules (the members of the selected procedures, defaults desugared, integrity constraints left out) by the oracle's
 * saturation, and every literal whose derivation uses a document wire is written as a fact of the view predicates of analysis-core-v1:
 *
 *   asserted_atom "TEXT"        the atom has positive evidence (stated, or derived by the document's own rules)
 *   denied_atom "TEXT"          the atom has negative evidence (an explicit `not`)
 *   keyed_value "P KEY" "REST"  a positive atom of a predicate declared `key N`: the predicate with its key argument, and the rest
 *
 * TEXT is the canonical SOP text of the atom (`termText`). Each view fact remembers the document wires and the rules its literal rests
 * on (one sufficient support set, the oracle's `used`), so a finding over the view is reported with the document's own words.
 */
import {desugar, parse, tokens} from '../../sop/knowledge/index.mjs';
import {closeFacts} from '../../reasoning/strategies/js-reference/index.mjs';
import {usedOf} from '../../reasoning/strategies/js-reference/support.mjs';
import {SYMBOL, DATE} from '../../sop/knowledge/lexical.mjs';

export const VIEW_PREDICATES = Object.freeze(['asserted_atom', 'denied_atom', 'keyed_value']);
const SKIP = new Set([...VIEW_PREDICATES, 'violation']);
const VIEW_TYPES = new Set(['predicate', 'fact', 'rule', 'default', 'aggregate']);

/** A ground term as SOP text: numbers and symbols as they are, dates bare, any other string JSON-quoted. */
export const termText = v => (typeof v === 'number' ? String(v) : typeof v === 'string' && (SYMBOL.test(v) || DATE.test(v)) ? v : JSON.stringify(String(v)));
/** The canonical text of a literal. */
export const atomText = (p, args, neg = false) => [neg ? 'not' : null, p, ...args.map(termText)].filter(Boolean).join(' ');

/** The key position (1-based) of each predicate declared with `key N`. */
export function keyPositions(wires) {
  const out = new Map();
  for (const w of wires) if (w.type === 'predicate') {
    const k = w.fields.find(f => f.key === 'key')?.value.trim();
    if (k && /^\d+$/.test(k)) out.set(w.id, Number(k));
  }
  return out;
}

/**
 * Builds the view. `documentWires` and `runWires` are parsed wires (the run wires: declarations and members); `budget` bounds the
 * saturation. Returns {text, facts: Map(viewId → {predicate, atom, polarity, documents: [wire ids], rules: [wire ids]}), literals,
 * exhausted}.
 */
export function documentView({documentWires, runWires, budget = {}, prefix = 'av'}) {
  const documentIds = new Set(documentWires.map(w => w.id));
  const wires = [...runWires, ...documentWires].filter(w => VIEW_TYPES.has(w.type));
  const {wires: core, origin} = desugar(wires);
  const {ev, exhausted} = closeFacts({wires: core, budget});
  const keys = keyPositions(wires);
  const timed = new Set(documentWires.filter(w => w.type === 'fact' && w.fields.some(f => f.key === 'valid')).map(w => w.id));
  const real = id => origin.get(id) ?? id;
  const memo = new Map();
  const fromDocument = node => {
    if (memo.has(node)) return memo.get(node);
    memo.set(node, false);
    const own = node.ref && documentIds.has(real(node.ref.id));
    const result = own || (node.premises ?? []).some(p => p && p.absent === undefined && fromDocument(p));
    memo.set(node, result);
    return result;
  };
  const facts = new Map(), lines = [];
  let n = 0;
  const add = (predicate, args, node, atom, polarity) => {
    const id = `${prefix}_${++n}`;
    const used = usedOf([node]).used.map(u => real(u.id));
    facts.set(id, {predicate, atom, polarity, documents: [...new Set(used.filter(u => documentIds.has(u)))], rules: [...new Set(used.filter(u => !documentIds.has(u)))]});
    lines.push(`@${id} fact\n  holds ${predicate} ${args.map(a => JSON.stringify(a)).join(' ')}`);
  };
  let literals = 0;
  for (const [neg, side] of [[false, ev.pos], [true, ev.neg]]) for (const [p, table] of side) {
    if (SKIP.has(p) || p.startsWith('x_')) continue;
    for (const node of table.list) {
      if (!fromDocument(node)) continue;
      literals++;
      const atom = atomText(p, node.args);
      add(neg ? 'denied_atom' : 'asserted_atom', [atom], node, atom, neg ? 'denied' : 'asserted');
      const k = keys.get(p);
      if (!neg && k && k <= node.args.length && node.args.length > 1 && !(node.factId && timed.has(node.factId))) {
        const keyText = `${p} ${termText(node.args[k - 1])}`;
        const rest = node.args.filter((_, i) => i !== k - 1).map(termText).join(' ');
        add('keyed_value', [keyText, rest], node, atom, 'asserted');
      }
    }
  }
  return {text: lines.join('\n\n') + (lines.length ? '\n' : ''), facts, literals, exhausted};
}

/** Parsed wires of a text (a ProgramError-like error on a syntax problem). */
export function wiresOf(text, what) {
  const {wires, errors} = parse(text);
  if (errors.length) throw Object.assign(new Error(`${what}: ${errors[0].message} (line ${errors[0].line})`), {code: 'invalid_circuit', status: 422});
  return wires;
}

/** The predicates a wire reads or concludes (for the declarations a run needs). */
export function predicatesOf(w) {
  const out = new Set();
  const visit = text => {
    const t = tokens(text);
    const p = ['not', 'absent'].includes(t[0]) ? t[1] : t[0];
    if (p && SYMBOL.test(p) && !['all', 'any', 'end', 'compare', 'compute', 'order', 'start_of', 'end_of', 'match'].includes(p)) out.add(p);
  };
  for (const f of w.fields) {
    if (['holds', 'then', 'yields', 'report'].includes(f.key)) visit(f.value);
    if (['when', 'over', 'never', 'except', 'where'].includes(f.key)) (f.block?.length ? f.block.map(b => b.text) : [f.value]).forEach(visit);
  }
  return out;
}

