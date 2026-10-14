import {parse as parseKnowledge, validateProgram, tokens, leaves} from '../../sop/knowledge/index.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {canonical, parse as parseModel, one} from '../../sop/parser.mjs';
import {admitModel} from './admit.mjs';
import {expandCompact} from '../../sop/compact.mjs';

// An aggregate is a definition over existing predicates like a rule (group-by count/sum/min/max); the knowledge validator checks it.
export const SESSION_TYPES = new Set(['predicate', 'rule', 'default', 'aggregate']);
/** The words of rule bodies (sop/knowledge/lexical.mjs) that cannot be predicate ids. */
const RESERVED_WORDS = new Set(['not', 'absent', 'compare', 'compute', 'order', 'start_of', 'end_of', 'all', 'any', 'end', 'match', 'else']);

/** Split by wire headers, retaining the exact authored text for both validators. */
export function splitCircuits(sop) {
  sop = expandCompact(sop);
  const starts = [...sop.matchAll(/^@([A-Za-z][A-Za-z0-9_]*)\s+([A-Za-z][A-Za-z0-9_]*)\s*$/gm)];
  const parts = starts.map((m, i) => ({id: m[1], type: m[2], text: sop.slice(m.index, starts[i + 1]?.index ?? sop.length)}));
  if (!starts.length || sop.slice(0, starts[0].index).split('\n').some(l => l.trim() && !l.trimStart().startsWith('#'))) throw new Error('invalid_wire: expected circuit headers');
  if (new Set(parts.map(p => p.id)).size !== parts.length) throw new Error('duplicate_id: wire ids must be unique');
  return {parts, model: parts.filter(p => !SESSION_TYPES.has(p.type)).map(p => p.text).join('\n'), definitions: parts.filter(p => SESSION_TYPES.has(p.type)).map(p => p.text).join('\n')};
}

/** Declarations for embeddings which supply a lexicon instead of layered circuits. */
const predicateText = new WeakMap();
export function predicateCircuits(lexicon) {
  // One text per lexicon object (the memory's vocabulary does not change under a lexicon; a new layer is a new lexicon).
  if (lexicon && typeof lexicon === 'object' && predicateText.has(lexicon)) return [{name: 'memory-predicates.sop', text: predicateText.get(lexicon)}];
  const out = predicateCircuitsOf(lexicon);
  if (lexicon && typeof lexicon === 'object') predicateText.set(lexicon, out[0].text);
  return out;
}
function predicateCircuitsOf(lexicon) {
  const type = t => ['integer', 'value'].includes(t) ? t : 'entity';
  return [{name: 'memory-predicates.sop', text: Object.values(lexicon?.predicates ?? {}).map(p => `@${p.id} predicate\n  args ${p.roles?.length ? p.roles.map(r => `${r.name}:${type(r.type)}`).join(' ') : (p.args ?? []).map(type).join(' ') || 'none'}\n`).join('\n')}];
}

/**
 * A new session predicate defined only by rules whose positive and absent conditions read closed (complete) predicates is
 * itself complete: the least fixpoint over complete relations derives every instance (eval-generality-v1: "how many stations
 * can be reached" over a closed link list was answered "at least 3" for exactly 3). Defaults, explicit negations, aggregates
 * over open input and any open dependency keep the predicate open. The inferred declaration is written into the text.
 */
export function closeDerived(text, wires, lexicon) {
  const declared = new Set(wires.filter(w => w.type === 'predicate').map(w => w.id));
  const closed = new Set([...Object.values(lexicon?.predicates ?? {}).filter(p => p.closed === true).map(p => p.id),
    ...wires.filter(w => w.type === 'predicate' && w.fields.some(f => f.key === 'closed' && f.value.trim() === 'true')).map(w => w.id)]);
  const headOf = w => { const t = tokens(w.fields.find(f => f.key === (w.type === 'aggregate' ? 'yields' : 'then'))?.value ?? ''); return t[0] === 'not' ? null : t[0]; };
  const bodies = new Map();
  for (const w of wires.filter(w => ['rule', 'default', 'aggregate'].includes(w.type))) {
    const head = headOf(w);
    if (!head || !declared.has(head)) continue;
    const atoms = w.type === 'aggregate' ? w.fields.filter(f => f.key === 'over').map(f => ({kind: 'atom', neg: 'none', p: tokens(f.value)[0]})) : (w.conds ?? []).flatMap(c => leaves(c.tree));
    (bodies.get(head) ?? bodies.set(head, []).get(head)).push(w.type === 'default' ? null : atoms);
  }
  // Greatest fixpoint, so a recursive definition (path over link and path) can close: drop a candidate while one of its
  // conditions reads anything other than a closed predicate or a remaining candidate.
  const inferred = new Set([...bodies].filter(([head, list]) => !closed.has(head) && !list.some(b => b === null)).map(([head]) => head));
  let changed = true;
  while (changed) {
    changed = false;
    for (const head of [...inferred]) {
      const ok = bodies.get(head).every(atoms => atoms.every(a => a.kind !== 'atom' || (['none', 'absent'].includes(a.neg) && (closed.has(a.p) || (a.neg === 'none' && inferred.has(a.p))))));
      if (!ok) { inferred.delete(head); changed = true; }
    }
  }
  if (!inferred.size) return text;
  return text.replace(/^@([A-Za-z][A-Za-z0-9_]*)\s+predicate\s*$/gm, (line, id) => inferred.has(id) ? `${line}\n  closed true` : line);
}

/**
 * The circuits reduced to what a turn's definitions can interact with: the wires that name a predicate or wire id the definitions name
 * (their declarations, rules over them, lexemes of them). The memory's own circuits were validated when the memory was built;
 * re-parsing and re-validating all of them for every formalization was most of a turn's time (profile 2026-10-02: about 20 s of a
 * 40 s book problem). Duplicate ids, arities, types and stratification through rules that name the definitions' predicates are still
 * checked. The block index of a circuit text is cached by the text itself.
 */
const blockIndex = new Map();
function blocksOf(text) {
  if (blockIndex.has(text)) return blockIndex.get(text);
  const blocks = String(text).split(/\n(?=@)/).map(block => ({block, ids: new Set(block.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])}));
  // id → indices of the blocks that mention it (the inverted index: a turn's names find their wires without a scan).
  blocks.mentions = new Map();
  blocks.forEach((b, k) => { for (const id of b.ids) (blocks.mentions.get(id) ?? blocks.mentions.set(id, []).get(id)).push(k); });
  if (blockIndex.size > 16) blockIndex.delete(blockIndex.keys().next().value);
  blockIndex.set(text, blocks);
  return blocks;
}
/** id → block indices that declare it (`@id ...`) in one circuit text, cached with the text's block index. */
const declarationIndex = new Map();
function declarationsOf(text) {
  if (declarationIndex.has(text)) return declarationIndex.get(text);
  const out = new Map();
  blocksOf(text).forEach((b, k) => { const id = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(b.block)?.[1]; if (id) (out.get(id) ?? out.set(id, []).get(id)).push(k); });
  if (declarationIndex.size > 16) declarationIndex.delete(declarationIndex.keys().next().value);
  declarationIndex.set(text, out);
  return out;
}
/** id → [[circuit index, block index]] of its declarations across a list of circuits (cached for the same list of texts). */
let across = null;
function declarationsAcross(circuits) {
  if (across && across.texts.length === circuits.length && across.texts.every((t, i) => t === circuits[i].text)) return across.map;
  const map = new Map();
  circuits.forEach((c, i) => { for (const [id, ks] of declarationsOf(c.text)) for (const k of ks) (map.get(id) ?? map.set(id, []).get(id)).push([i, k]); });
  across = {texts: circuits.map(c => c.text), map};
  return map;
}
function onlyNamed(circuits, text, lexicon) {
  const declared = new Set([...String(text).matchAll(/^@([A-Za-z_][A-Za-z0-9_]*)/gm)].map(m => m[1]));
  const known = id => declared.has(id) || Boolean(lexicon?.predicates?.[id]) || Boolean(lexicon?.entities?.[id]);
  const named = new Set((String(text).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter(known));
  // The kept wires bring the declarations of what they reference (the class of an entity, the class type of a role, the predicates of
  // a rule's body), transitively: a kept wire never names something the reduced program lacks. Only declaring wires are added here.
  const keep = circuits.map(c => { const index = blocksOf(c.text).mentions; return new Set([...named].flatMap(id => index.get(id) ?? [])); });
  const decl = declarationsAcross(circuits);
  const seen = new Set(), queue = [];
  const visit = (i, k) => { for (const id of blocksOf(circuits[i].text)[k].ids) if (!seen.has(id) && decl.has(id)) { seen.add(id); queue.push(id); } };
  keep.forEach((set, i) => set.forEach(k => visit(i, k)));
  while (queue.length && seen.size < 5000) {
    for (const [i, k] of decl.get(queue.shift())) if (!keep[i].has(k)) { keep[i].add(k); visit(i, k); }
  }
  return circuits.map((c, i) => ({...c, text: blocksOf(c.text).filter((_, k) => keep[i].has(k)).map(b => b.block).join('\n')}));
}

export function admitCircuits(sop, text, lexicon, {circuits = predicateCircuits(lexicon), policy = {}, admit = admitModel} = {}) {
  const split = splitCircuits(sop);
  let effective = lexicon, hypothetical = new Set(), hypotheticalSop = '';
  const definitions = parseKnowledge(split.definitions);
  if (split.definitions) {
    // A word of the condition language cannot name a predicate (`start_of ?a ?s` is a time leaf, not an atom): say so before the
    // knowledge validator reads the rule bodies with it.
    for (const m of split.definitions.matchAll(/^@([A-Za-z][A-Za-z0-9_]*)\s+predicate\s*$/gm)) {
      if (RESERVED_WORDS.has(m[1])) throw new Error(`reserved_predicate_id: ${m[1]} is a word of the condition language (${[...RESERVED_WORDS].join(', ')}); give the predicate another id, for example ${m[1]}_value`);
    }
    // Only the memory predicates the definitions name are validated with them (duplicate ids, arities, types): the memory's own
    // declarations were validated when the memory was built, and re-parsing thousands of them per turn was most of a turn's time.
    circuits = onlyNamed(circuits, split.definitions, lexicon);
    const check = validateProgram([...circuits.map(c => ({...c, role: 'knowledge'})), {name: 'coding-agent.sop', text: split.definitions, role: 'knowledge'}], {authoring: true});
    // A session predicate may share its id with a form of a memory lexeme ("cost" next to the memory's `costs`): the round trip
    // of that memory lexeme is a property of the accepted memory, not of this output, and the session layer is turn-local.
    const problem = check.problems.find(p => p.severity !== 'warning' && !(p.code === 'form_does_not_link' && p.file !== 'coding-agent.sop'));
    if (problem?.code === 'duplicate_id' && /also defined in/.test(problem.message)) {
      const id = problem.message.match(/wire id (\S+)/)?.[1], known = lexicon?.predicates?.[id];
      throw new Error(`duplicate_id: ${problem.message}; ${known ? `the memory already has the predicate ${id}(${(known.roles ?? []).map(r => `${r.name}:${r.type}`).join(', ')}): use it with those roles, or` : ''} give your session wire another id (for example a more specific one)`);
    }
    if (problem) throw new Error(`${problem.code}: ${problem.message}`);
    definitions.wires = check.wires.filter(w => w.file === 'coding-agent.sop');
    const known = new Set([...Object.keys(lexicon?.predicates ?? {}), ...definitions.wires.filter(w => w.type === 'predicate').map(w => w.id)]);
    for (const wire of definitions.wires) {
      for (const field of wire.fields) if (['source', 'approval', 'approved_by', 'approved_at', 'state'].includes(field.key)) throw new Error('governance_not_allowed: the runtime assigns origin and approval');
      const relations = (wire.conds ?? []).flatMap(c => leaves(c.tree)).filter(l => l.kind === 'atom').map(l => l.p);
      if (wire.type === 'rule' || wire.type === 'default') {
        const then = tokens(wire.fields.find(f => f.key === 'then')?.value ?? '');
        relations.push(then[0] === 'not' ? then[1] : then[0]);
      }
      if (wire.type === 'aggregate') for (const field of wire.fields.filter(f => ['over', 'yields'].includes(f.key))) relations.push(tokens(field.value)[0]);
      for (const relation of relations) if (!known.has(relation)) throw new Error(`unknown_predicate: ${relation} is neither in memory nor declared in this output`);
    }
    // A problem's own vocabulary (declared here and used by its asserted statements) holds exactly the problem's data: it is complete
    // (closed), so counts, totals and maxima over it, and what is derived from it, are complete answers, not partial views.
    let statedRelations = new Set();
    try { statedRelations = new Set(parseModel(split.model).wires.filter(w => w.type === 'stated' && one(w, 'certainty', 'asserted') !== 'supposed').map(w => JSON.parse(one(w, 'relation', '""')))); } catch { /* admission reports it */ }
    const problemIds = new Set(definitions.wires.filter(w => w.type === 'predicate' && statedRelations.has(w.id)).map(w => w.id));
    if (problemIds.size) {
      split.definitions = split.definitions.replace(/^@([A-Za-z][A-Za-z0-9_]*)\s+predicate\s*$/gm, (line, id) => problemIds.has(id) && !new RegExp(`^@${id}\\s+predicate\\s*\\n(?:  .*\\n)*?  closed true`, 'm').test(split.definitions) ? `${line}\n  closed true` : line);
      definitions.wires = validateProgram([...circuits.map(c => ({...c, role: 'knowledge'})), {name: 'coding-agent.sop', text: split.definitions, role: 'knowledge'}], {authoring: true}).wires.filter(w => w.file === 'coding-agent.sop');
    }
    // A session rule or default the model output names with `candidate` or with `if` on a query is hypothetical (Q-LANG-10): in force only
    // in that query's runs, never in the session theory. It leaves the definitions and is handed to the runtime as a proposed wire
    // (`hypotheticalSop`, `approval proposed`), which the engines use only where a query supposes it; it is never stored.
    hypothetical = hypotheticalRuleIds(split.model, definitions.wires);
    split.definitions = closeDerived(split.definitions, definitions.wires.filter(w => !hypothetical.has(w.id)), lexicon);
    if (hypothetical.size) {
      const blocks = split.definitions.split(/\n(?=@)/), idOf = block => /^@([A-Za-z][A-Za-z0-9_]*)/.exec(block)?.[1];
      hypotheticalSop = blocks.filter(b => hypothetical.has(idOf(b))).map(b => b.replace(/\s*$/, '') + '\n  approval proposed\n').join('\n');
      split.definitions = blocks.filter(b => !hypothetical.has(idOf(b))).join('\n');
    }
    // Keep the memory's indexed entity tables; only the tiny turn-local predicate layer is new.
    effective = Object.assign(Object.create(Object.getPrototypeOf(lexicon ?? {})), lexicon ?? {});
    const added = Lexicon.fromCircuits([{name: 'coding-agent.sop', text: split.definitions}]);
    // Predicates this output declares are marked: their entity arguments are the conversation's own things (sop/declarative.mjs).
    effective.predicates = {...lexicon?.predicates, ...added.predicates};
  }
  const model = admit(split.model, text, effective, policy, {definitions: new Map(definitions.wires.map(w => [w.id, w.type]))});
  // A predicate this output declares and its asserted statements use is a problem's own vocabulary (DS014 "Problems that state their
  // own data"): its entity arguments are the conversation's own things (sop/declarative.mjs). A definition over memory facts is not marked.
  const problemVocabulary = new Set(model.wires.filter(w => w.type === 'stated').map(w => String(w.fields?.relation?.[0] ?? '').replace(/^"|"$/g, '')).filter(id => definitions.wires.some(d => d.type === 'predicate' && d.id === id)));
  if (problemVocabulary.size) effective.predicates = Object.fromEntries(Object.entries(effective.predicates).map(([id, p]) => [id, problemVocabulary.has(id) ? {...p, session: true} : p]));
  if (definitions.wires.length && model.wires.some(w => w.type === 'unclear')) throw new Error('unclear_not_alone: clarification cannot install definitions');
  const defs = definitions.wires.map(w => ({id: w.id, type: w.type, line: w.line, fields: Object.fromEntries([...new Set(w.fields.map(f => f.key))].map(k => [k, w.fields.filter(f => f.key === k).map(f => [f.value, ...(f.block ?? []).map(b => b.text)].join('\n'))]))}));
  const byId = new Map([...model.wires, ...defs].map(w => [w.id, w]));
  return {wires: split.parts.map(p => byId.get(p.id)), modelSop: canonical(model), definitionSop: split.definitions, hypotheticalSop, lexicon: effective, origin: 'coding_agent'};
}

/** The session rules and defaults a query of the model output names with `candidate` or `if` (Q-LANG-10). */
function hypotheticalRuleIds(modelSop, definitionWires) {
  const rules = new Set(definitionWires.filter(w => ['rule', 'default'].includes(w.type)).map(w => w.id));
  const out = new Set();
  let wires = [];
  try { wires = parseModel(modelSop).wires; } catch { return out; /* admission reports the error */ }
  for (const q of wires.filter(w => w.type === 'query')) for (const key of ['candidate', 'if']) for (const value of q.fields[key] ?? []) {
    const id = String(value).trim().replace(/^\$/, '');
    if (rules.has(id)) out.add(id);
  }
  return out;
}
