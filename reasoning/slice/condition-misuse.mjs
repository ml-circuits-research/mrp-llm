import {Lexicon} from '../../sop/lexicon.mjs';
import {tokens} from '../../sop/knowledge/lexical.mjs';

const field = (w, key) => w.fields.find(f => f.key === key)?.value.trim();
const variable = v => typeof v === 'string' && v.startsWith('?');
const informative = classes => new Set([...classes].filter(c => c !== 'entity' && c !== 'class'));
const lexicons = new WeakMap();

function lexiconOf(theory) {
  const cached = lexicons.get(theory);
  if (cached?.revision === theory.revision) return cached.lexicon;
  // Only metadata and class membership are needed, never a second fact index.
  const metadata = [];
  for (const w of theory.byId.values()) {
    if (!['predicate', 'entity'].includes(w.type) && !(w.type === 'fact' && tokens(field(w, 'holds') ?? '')[0] === 'is_a')) continue;
    metadata.push(`@${w.id} ${w.type}\n${w.fields.map(f => `  ${f.key} ${f.value}\n`).join('')}`);
  }
  const lexicon = Lexicon.fromCircuits([{name: 'condition-domain-metadata', text: metadata.join('\n')}]);
  lexicons.set(theory, {revision: theory.revision, lexicon});
  return lexicon;
}

const decode = t => t.startsWith('"') ? JSON.parse(t) : /^-?\d+$/.test(t) ? Number(t) : t;
const localAtoms = wires => wires.filter(w => w.type === 'fact').map(w => {
  const t = tokens(field(w, 'holds') ?? ''), start = t[0] === 'not' ? 1 : 0;
  return {p: t[start], a: t.slice(start + 1).map(decode)};
});

/** Position-domain admission, independent of tuple truth and of query-time validity.
 * Exact keyed lookups establish occurrence; complete bounded samples establish exclusion.
 * Partial samples never establish that a class is absent. */
export function conditionMisuses({theory, atoms, source, localWires = [], lexicon = null,
  maxLookups = 128, maxProbes = 2048, maxExamples = 16}) {
  const problems = [], diagnostics = {lookups: 0, probes: 0, incomplete: false};
  const local = localAtoms([...theory.carry, ...localWires]);
  const cache = new Map();
  const lookup = pattern => {
    const key = JSON.stringify(pattern);
    if (cache.has(key)) return cache.get(key);
    if (diagnostics.lookups >= maxLookups || diagnostics.probes >= maxProbes) {
      diagnostics.incomplete = true;
      return {rows: [], complete: false, exact: false};
    }
    const r = source.lookup(pattern, {cap: maxExamples, probes: maxProbes - diagnostics.probes});
    diagnostics.lookups++;
    diagnostics.probes += r.probes;
    if (!r.complete || !r.exact) diagnostics.incomplete = true;
    cache.set(key, r);
    return r;
  };
  const occurrence = (atom, position, constant) => {
    const pattern = {p: atom.p, a: atom.a.map((_, i) => i === position ? constant : `?domain${i}`), neg: false};
    const pos = lookup(pattern), neg = lookup({...pattern, neg: true});
    const locals = local.filter(a => a.p === atom.p && a.a.length === atom.a.length && (variable(constant) || a.a[position] === constant));
    return {values: [...new Set([...pos.rows, ...neg.rows].map(r => r.atom.a[position]).concat(locals.map(a => a.a[position])))],
      complete: pos.complete && neg.complete && pos.exact && neg.exact};
  };
  for (const atom of atoms) {
    const declared = theory.predicates.get(atom.p);
    if (!declared) continue; // The grammar validator diagnoses undeclared predicates.
    lexicon ??= lexiconOf(theory);
    const schema = lexicon.predicates[atom.p];
    const arity = schema?.arity ?? 0;
    const condition = `${atom.absent ? 'absent ' : atom.neg ? 'not ' : ''}${atom.p} ${atom.a.map(v => typeof v === 'string' && !variable(v) ? JSON.stringify(v) : v).join(' ')}`.trim();
    const problem = (position, value, reason, values = [], valuesComplete = true) => problems.push({code: 'condition_misuse', predicate: atom.p, condition,
      position: position + 1, role: schema?.roles[position]?.name ?? null, value, reason, values: values.slice(0, maxExamples), values_complete: valuesComplete && values.length <= maxExamples});
    if (arity !== atom.a.length) { problem(-1, null, 'arity_mismatch'); continue; }
    for (let i = 0; i < atom.a.length; i++) {
      const constant = atom.a[i];
      if (variable(constant)) continue;
      const type = schema.args[i];
      if (type === 'integer') {
        if (!Number.isSafeInteger(constant)) problem(i, constant, 'type_mismatch');
        continue; // A numeric domain is its declared type, not its observed values.
      }
      // A value-typed position (a value, a free text such as the activity of used_for, a rational) has no class domain.
      if (type === 'value' || type === 'text' || type === 'rational') continue;
      const classes = informative(lexicon.classesOf(constant));
      if (type && type !== 'entity') {
        const localOccurrence = !classes.size && local.some(a => a.p === atom.p && a.a.length === atom.a.length && a.a[i] === constant);
        if (!classes.has(type) && !localOccurrence) problem(i, constant, 'class_mismatch');
        // A declared class supplies typing even with no observed instances.
        continue;
      }
      // Absence ranges over the declared entity universe, not just its positive
      // members. Without a narrower class, a registered entity is well typed.
      if (atom.absent && !classes.size && Object.hasOwn(lexicon.entities, constant)) continue;
      // A derived relation's domain is supplied by its definition, not by direct facts.
      if (theory.byHead.has(atom.p)) continue;
      if (!theory.closed.has(atom.p)) continue; // Open membership is not an exhaustive position domain.
      const exact = occurrence(atom, i, constant);
      if (exact.values.length) continue;
      if (!exact.complete) { problem(i, constant, 'domain_check_incomplete', [], false); continue; }
      const observed = occurrence(atom, i, '?domainValue');
      if (!observed.values.length) {
        if (!observed.complete) problem(i, constant, 'domain_check_incomplete', [], false);
        continue; // A proven empty relation cannot infer a narrower entity domain.
      }
      if (classes.size && observed.values.some(v => [...informative(lexicon.classesOf(v))].some(c => classes.has(c)))) continue;
      if (classes.size && !observed.complete) { problem(i, constant, 'domain_check_incomplete', observed.values, false); continue; }
      problem(i, constant, 'position_domain', observed.values, observed.complete);
    }
  }
  return {problems, diagnostics};
}
