/**
 * Checks of drafted knowledge against its source and against the memory it would join (DS022 "Ingesting documents into a base memory"):
 *
 *   quoteProblems(knowledge, source)       every `quote` must be words of the source passage (whitespace, typographic quotes and dashes and
 *                                          Markdown table and emphasis marks normalised); a paraphrase in `quote` is a problem
 *   missingSentence(knowledge)             facts, rules, defaults, norms and methods without `source` or `quote` (the skill's rule)
 *   memoryConflicts(knowledge, existing)   ground facts against the stored ones: an exact duplicate, an explicit contradiction (`not p a`
 *                                          against `p a`) and a functional conflict (a predicate with `key N`: same first N arguments, other
 *                                          values); memory wins, so a conflicting or duplicate fact is held back and reported
 *   uncertainWires(knowledge)              what the source states weakly: reported or hedged facts, defaults, advisory norms and methods
 *   withoutWires(knowledge, ids)           the knowledge text with the named wires removed
 *   redeclaredPredicates(knowledge, existing)  predicate wires that repeat a declaration already in `existing` with the same `args`,
 *                                          and entity wires of an id `existing` declares
 *                                          (chunks drafted in parallel declare the same predicate; the earlier declaration is kept)
 *
 * Language-neutral and knowledge-blind: no predicate or entity name is written here.
 */
import {parse, tokens} from '../../sop/knowledge/index.mjs';

const SENTENCE_TYPES = new Set(['fact', 'rule', 'default', 'norm', 'method', 'integrity']);
const field = (w, key) => w.fields.find(f => f.key === key)?.value ?? null;
const decode = value => { try { return JSON.parse(value); } catch { return String(value ?? '').replace(/^"|"$/g, ''); } };

/** Normal form for quote matching: typographic marks folded, Markdown table/emphasis marks and whitespace runs collapsed, case kept. */
export function normalizeText(text) {
  return String(text).normalize('NFC').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, '-')
    .replace(/ /g, ' ').replace(/[|*_`#>]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function quoteProblems(knowledge, source) {
  const haystack = normalizeText(source);
  const problems = [];
  for (const w of parse(knowledge).wires) {
    for (const f of w.fields.filter(f => f.key === 'quote')) {
      const quote = normalizeText(decode(f.value));
      if (!quote) problems.push({code: 'quote_empty', wire: w.id, message: 'quote is empty'});
      else if (!haystack.includes(quote)) problems.push({code: 'quote_not_in_source', wire: w.id, message: `the quote ${JSON.stringify(decode(f.value).slice(0, 120))} is not a contiguous passage of the source; copy the exact words of the attached passage or move the reference to \`source\``});
    }
  }
  return problems;
}

export function missingSentence(knowledge) {
  return parse(knowledge).wires.filter(w => SENTENCE_TYPES.has(w.type) && !field(w, 'source') && !field(w, 'quote'))
    .map(w => ({code: 'missing_source_sentence', wire: w.id, message: `${w.type} @${w.id} has neither source nor quote`}));
}

/** Ground facts of circuits: `{id, file, negated, predicate, args, valid}`; facts with variables are skipped. */
export function groundFacts(circuits) {
  const out = [];
  for (const c of circuits) for (const w of parse(c.text).wires.filter(w => w.type === 'fact')) {
    const t = tokens(field(w, 'holds') ?? '');
    const negated = t[0] === 'not';
    const [predicate, ...args] = negated ? t.slice(1) : t;
    if (!predicate || args.some(a => a.startsWith('?'))) continue;
    out.push({id: w.id, file: c.name, negated, predicate, args, valid: field(w, 'valid')});
  }
  return out;
}

/** `key N` of the predicates declared in the circuits. */
function predicateKeys(circuits) {
  const keys = new Map();
  for (const c of circuits) for (const w of parse(c.text).wires.filter(w => w.type === 'predicate')) {
    const k = Number(field(w, 'key'));
    if (Number.isInteger(k) && k > 0) keys.set(w.id, k);
  }
  return keys;
}

const sameValidity = (a, b) => !a.valid || !b.valid || a.valid === b.valid;

/** `[{code, wire, with, message}]`: each new ground fact that duplicates or contradicts a stored one (memory wins). */
export function memoryConflicts(knowledge, existing) {
  const stored = groundFacts(existing);
  const fresh = groundFacts([{name: 'draft', text: knowledge}]);
  const keys = predicateKeys([...existing, {name: 'draft', text: knowledge}]);
  const atom = f => [f.predicate, ...f.args].join('\u0000');
  const byAtom = new Map();
  for (const f of stored) byAtom.set(atom(f), [...(byAtom.get(atom(f)) ?? []), f]);
  const out = [];
  for (const f of fresh) {
    const same = (byAtom.get(atom(f)) ?? []).filter(s => sameValidity(s, f));
    const duplicate = same.find(s => s.negated === f.negated);
    const contradiction = same.find(s => s.negated !== f.negated);
    if (contradiction) { out.push({code: 'contradicts_memory', wire: f.id, with: `${contradiction.file}#${contradiction.id}`, message: `${f.negated ? 'not ' : ''}${f.predicate} ${f.args.join(' ')} contradicts the stored ${contradiction.file}#${contradiction.id}`}); continue; }
    if (duplicate) { out.push({code: 'duplicate_of_memory', wire: f.id, with: `${duplicate.file}#${duplicate.id}`, message: `${f.predicate} ${f.args.join(' ')} is already stored (${duplicate.file}#${duplicate.id})`}); continue; }
    const k = keys.get(f.predicate);
    if (k && !f.negated) {
      const clash = stored.find(s => !s.negated && s.predicate === f.predicate && sameValidity(s, f) && s.args.slice(0, k).join('\u0000') === f.args.slice(0, k).join('\u0000') && s.args.slice(k).join('\u0000') !== f.args.slice(k).join('\u0000'));
      if (clash) out.push({code: 'key_conflict', wire: f.id, with: `${clash.file}#${clash.id}`, message: `${f.predicate} has key ${k}: ${f.args.join(' ')} disagrees with the stored ${clash.args.join(' ')}`});
    }
  }
  return out;
}

export function uncertainWires(knowledge) {
  const out = [];
  for (const w of parse(knowledge).wires) {
    const status = field(w, 'status');
    if (w.type === 'fact' && status && status !== 'asserted') out.push({wire: w.id, type: w.type, why: `status ${status}`});
    else if (w.type === 'default') out.push({wire: w.id, type: w.type, why: 'default (holds unless an exception applies)'});
    else if ((w.type === 'norm' || w.type === 'method') && field(w, 'binding') === 'advisory') out.push({wire: w.id, type: w.type, why: 'binding advisory'});
  }
  return out;
}

/** The knowledge text without the wires `ids` (each wire runs from its header to the next header). */
export function withoutWires(knowledge, ids) {
  const drop = new Set(ids);
  if (!drop.size) return knowledge;
  const lines = knowledge.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^@([A-Za-z][A-Za-z0-9_]*)\s+[A-Za-z]/.exec(line);
    if (header) skipping = drop.has(header[1]);
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Ids of the declarations of `knowledge` that `existing` already has: a predicate with the same `args` (a different signature is not
 * listed: it is a real clash), an entity of the same id (the same symbol names the same thing; the earlier declaration is kept).
 */
export function redeclaredPredicates(knowledge, existing) {
  const declared = new Map();
  for (const c of existing) for (const w of parse(c.text).wires.filter(w => w.type === 'predicate' || w.type === 'entity')) declared.set(w.id, {type: w.type, args: field(w, 'args')});
  return parse(knowledge).wires.filter(w => {
    const d = declared.get(w.id);
    return d && d.type === w.type && (w.type === 'entity' || d.args === field(w, 'args'));
  }).map(w => w.id);
}

/** Counts of the wires of a knowledge text by type. */
export function wireCounts(knowledge) {
  const counts = {};
  for (const w of parse(knowledge).wires) counts[w.type] = (counts[w.type] ?? 0) + 1;
  return counts;
}

/** Entity symbols used as fact arguments (the spelling later chunks must reuse), at most `max`. */
export function knownSymbols(circuits, max = 400) {
  const seen = new Set();
  for (const f of groundFacts(circuits)) for (const a of f.args) if (/^[a-z][a-z0-9_]*$/.test(a)) seen.add(a);
  return [...seen].sort().slice(0, max);
}
