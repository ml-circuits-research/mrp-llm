/**
 * Document ingestion v2 (owner decision 2026-10-03): long documents → SOP knowledge wires for a base memory or a session, on the
 * structure-and-formalizer architecture instead of one free-form authoring conversation per chunk (v1, ../direct-author.mjs, kept until
 * v2 measures better):
 *   1. structure pass   every chunk of every document through the structure role (./roles.mjs `structurePass`, tier `small`): entities
 *                       with all their mentions, relations as predicates, values, the certainty of each sentence
 *   2. vocabulary       one CANONICAL vocabulary, deterministically (./vocabulary.mjs), plus one call (tier `medium`) for its conflicts;
 *                       stored as the document's vocabulary layer (predicate and entity wires with provenance)
 *   3. per sentence     the FOL role (config/prompts/fol-v2.md, tier `small`) per chunk with the canonical vocabulary as its
 *                       inventory; the converter (./to-knowledge.mjs) turns the formulas into facts and rules; a formula it cannot
 *                       convert is asked again once with the converter's reason
 *   4. checks           the knowledge validator (bounded: a wire it refuses is dropped and reported, never replaced), the contradiction
 *                       check against the memory and the chunks stored before, the quote check (every wire keeps document, location and
 *                       the exact quote); what stays unresolved goes to `escalations.jsonl`
 *   5. storage          the vocabulary layer, then each chunk, through `addKnowledge` (base memory) or `addCircuit` (session), each with
 *                       its provenance (document, SHA-256, chunk coordinates); a chunk already ingested is skipped
 * No manual acceptance (owner, 2026-10-02). Source rights are checked as in v1 (DS011). The run folder gets ingestion.json, summary.md
 * (at most 10 lines), escalations.jsonl and the intermediate files (structure.jsonl, vocabulary.json, fol.jsonl, knowledge/*.sop).
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chunkDocument} from '../chunk.mjs';
import {checkDocuments} from '../index.mjs';
import {quoteProblems, memoryConflicts, withoutWires, wireCounts, normalizeText} from '../checks.mjs';
import {validateCircuits} from '../../chat-data/memories.mjs';
import {parse} from '../../../sop/knowledge/index.mjs';
import {chunkUnits} from './units.mjs';
import {structurePass, mergePass, folPass, folRepair, alignPass, template} from './roles.mjs';
import {collect, conflictCases, canonical, lookups, inventoryText, camel, sharedPredicates, SHARED_VOCABULARY} from './vocabulary.mjs';
import {convertDocument, renderWires, groupStatements, unmatchedValues} from './to-knowledge.mjs';
import {tierChat} from './client.mjs';

export const VERSION = 'v2';
/**
 * Tiers per role (owner, 2026-10-03: `small` for the bulk, `medium` where more reasoning helps, `tiny` only for simple steps). Measured
 * on the handbook (2026-10-03): the FOL role on `small` writes group-level facts and leaves definitions as text; on `medium` with
 * reasoning it writes member-level rules and derived quantities, so the FOL role, its repair, the vocabulary conflicts and the
 * alignment run on `medium` with reasoning; the structure pass stays on `small`.
 */
export const DEFAULT_TIERS = Object.freeze({structure: 'small', merge: 'medium', fol: 'medium', repair: 'medium', fallback: 'small'});
/** Reasoning effort per role, sent to the reasoning tiers (`medium`, `good`) only. */
export const DEFAULT_REASONING = Object.freeze({structure: null, merge: 'low', fol: 'medium', repair: 'low', fallback: null});
const sha = text => createHash('sha256').update(text).digest('hex');
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const appendJsonl = (file, row) => fs.appendFileSync(file, JSON.stringify(row) + '\n');
const field = (w, key) => w.fields.find(f => f.key === key)?.value ?? null;

/** Runs `fn` over `items` with at most `width` at once, keeping the order of the results. */
async function pool(items, width, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.max(1, Math.min(width, items.length))}, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

/** The predicates and ids a set of circuits declares: {predicates: Map id → {arity, closed}, ids: Set, entities: [{id, label, aliases, kind}]}. */
export function declarations(circuits) {
  const predicates = new Map(), ids = new Set(), entities = [];
  for (const c of circuits) for (const w of parse(c.text).wires) {
    ids.add(w.id);
    if (w.type === 'predicate') {
      const args = String(field(w, 'args') ?? '').trim();
      predicates.set(w.id, {arity: args === 'none' || !args ? 0 : args.split(/\s+/).length, closed: field(w, 'closed') === 'true'});
    }
    if (w.type === 'entity' && field(w, 'kind') !== 'class') {
      const labels = w.fields.filter(f => f.key === 'label' || f.key === 'alias').map(f => { try { return JSON.parse(String(f.value).replace(/^[a-z]{2}\s+/, '')); } catch { return null; } }).filter(Boolean);
      entities.push({id: w.id, label: labels[0] ?? w.id, aliases: labels.slice(1), kind: field(w, 'kind') ?? 'thing', passages: [], local: []});
    }
  }
  return {predicates, ids, entities};
}

/** The known vocabulary shown to the structure role: the memory's own predicates (core layers excluded) and named things. */
function knownText(decl, circuits) {
  const own = circuits.filter(c => !String(c.name).startsWith('core-'));
  const preds = [];
  for (const c of own) for (const w of parse(c.text).wires.filter(w => w.type === 'predicate')) preds.push(`${w.id}(${field(w, 'args')})`);
  const things = decl.entities.slice(0, 80).map(e => `${e.label} (${e.kind})`);
  return [preds.length ? `predicates: ${preds.slice(0, 80).join(', ')}` : '', things.length ? `things: ${things.join(', ')}` : ''].filter(Boolean).join('\n') || '(none)';
}

/**
 * The input of the alignment role from a first conversion: `dangling` conditions (a predicate of the document used positively in a
 * rule condition, with no fact and no rule concluding it, not declared by the memory) and `grounded` relations (with facts: argument
 * kinds, example facts and the values of each position).
 */
export function alignmentInput(conv, existing = new Map()) {
  const rulesUsing = new Map();
  for (const w of conv.wires) if (w.type !== 'fact') for (const l of w.when) if (l.kind === 'lit' && !l.neg) { if (!rulesUsing.has(l.p.id)) rulesUsing.set(l.p.id, w); }
  const vars = n => ['x', 'y', 'z', 'u', 'v', 'w'].slice(0, n).join(', ');
  const dangling = conv.predicates.filter(p => !p.aux && !existing.has(p.id) && rulesUsing.has(p.id) && !p.facts.some(f => !f.negated) && !p.rules.length)
    .map(p => ({id: p.id, fol: `${camel(p.id)}(${vars(p.arity)})`, rule: rulesUsing.get(p.id).fol, sentence: rulesUsing.get(p.id).quote}));
  const grounded = conv.predicates.filter(p => !p.aux && p.facts.some(f => !f.negated)).map(p => {
    const facts = p.facts.filter(f => !f.negated);
    const values = Array.from({length: p.arity}, (_, i) => [...new Set(facts.map(f => f.args[i]))]);
    const shown = values.map((v, i) => (v.length <= 12 && v.length < facts.length ? `position ${i + 1}: ${v.join(', ')}` : null)).filter(Boolean);
    return `- ${camel(p.id)}(${vars(p.arity)}): ${facts.slice(0, 3).map(f => `${camel(p.id)}(${f.args.join(', ')})`).join('; ')}${shown.length ? `; values ${shown.join('; ')}` : ''}`;
  });
  return {dangling, grounded};
}

/** A definition of the alignment role as a unit of the chunk that holds its quote (the quote as the chunk writes it). */
function alignmentUnit(d, i, chunks) {
  const q = normalizeText(d.quote).toLowerCase();
  for (const c of chunks) {
    const text = normalizeText(c.text), at = text.toLowerCase().indexOf(q);
    if (at < 0) continue;
    const quote = text.slice(at, at + q.length);
    const lines = c.text.split('\n');
    const k = lines.findIndex(l => normalizeText(l).toLowerCase().includes(q));
    const unit = c.units.find(u => normalizeText(u.quote).toLowerCase().includes(q)) ?? null;
    return {key: `${c.key}_a${i + 1}`, passage: c.key, condition: d.condition, unit: {index: 0, line: c.start_line + Math.max(0, k), text: quote, quote, section: unit?.section ?? (c.path?.at(-1) ?? '')}, fol: [d.fol], status: null};
  }
  return null;
}

/**
 * Validates `circuits` against `existing`, dropping each wire the validator refuses, for at most `rounds` rounds.
 * Returns {circuits, dropped: [{wire, file, code, message}], validation}.
 */
export function validateDropping(circuits, existing, {rounds = 6} = {}) {
  let current = circuits.map(c => ({...c}));
  const dropped = [];
  let validation = null;
  for (let r = 0; r < rounds; r++) {
    validation = validateCircuits(current.filter(c => c.text.trim()), existing);
    if (validation.ok) break;
    const bad = new Map();
    for (const p of validation.problems) if (p.wire) { const k = `${p.file}\u0000${p.wire}`; if (!bad.has(k)) bad.set(k, p); }
    if (!bad.size) break;
    for (const p of bad.values()) dropped.push({wire: p.wire, file: p.file, code: p.code, message: p.message});
    current = current.map(c => ({...c, text: withoutWires(c.text, [...bad.values()].filter(p => p.file === c.name).map(p => p.wire))}));
  }
  return {circuits: current, dropped, validation};
}

/**
 * Ingests documents into a target. `target`: {kind: 'memory'|'session', id}; `memories` (BaseMemories) and, for a session, `sessions`
 * (Sessions). `chat`: ./client.mjs tierChat (or a fake with the same contract and a `ledger`). Returns the ingestion record.
 */
export async function ingestV2({documents, target, memories, sessions = null, chat = tierChat(), tiers = {}, reasoning = {}, sharedVocabulary = SHARED_VOCABULARY, dir, maxChunkBytes = 3000, concurrency = 3, user = 'document-ingestion', purpose = '', store = true, now = new Date(), onProgress = () => {}}) {
  tiers = {...DEFAULT_TIERS, ...tiers};
  reasoning = {...DEFAULT_REASONING, ...reasoning};
  const extra = role => (['medium', 'good'].includes(tiers[role]) && reasoning[role] ? {reasoning_effort: reasoning[role]} : {});
  const started = Date.now();
  const docs = checkDocuments(documents);
  if (!['memory', 'session'].includes(target?.kind) || !target.id) throw Object.assign(new Error('ingestion v2 writes into a base memory or a session: give target {kind, id}'), {code: 'invalid_target', status: 400});
  if (target.kind === 'session' && !sessions) throw Object.assign(new Error('a session target needs the sessions store'), {code: 'invalid_target', status: 400});
  const existingCircuits = () => (target.kind === 'memory' ? memories.layeredCircuits(target.id).map(({name, text}) => ({name, text})) : [...sessions.baseCircuits(target.id), ...sessions.circuits(target.id)].map(({name, text}) => ({name, text})));
  const ingested = () => new Set((target.kind === 'memory' ? memories.provenance(target.id).map(r => r.source?.chunk_sha256) : sessions.provenance(target.id).map(r => r.request?.chunk_sha256)).filter(Boolean));
  fs.mkdirSync(path.join(dir, 'knowledge'), {recursive: true});
  const escalations = path.join(dir, 'escalations.jsonl');
  fs.writeFileSync(escalations, '');
  const escalate = row => appendJsonl(escalations, {at: new Date().toISOString(), ...row});
  const record = {version: VERSION, target, created_at: now.toISOString(), created_by: user, purpose, tiers, reasoning, documents: [], status: 'running'};
  const save = () => writeJson(path.join(dir, 'ingestion.json'), record);
  save();

  for (const [di, doc] of docs.entries()) {
    const existing = existingCircuits();
    const decl = declarations(existing);
    const done = ingested();
    const prefix = `d${doc.sha256.slice(0, 8)}`;
    const chunks = chunkDocument(doc.text, {maxBytes: maxChunkBytes}).map(c => ({...c, key: `c${c.index}`, units: chunkUnits(c)})).filter(c => c.units.length);
    const todo = chunks.filter(c => !done.has(c.sha256));
    const drec = {name: doc.name, title: doc.title, sha256: doc.sha256, bytes: doc.bytes, source: doc.source, chunks: chunks.length, skipped: chunks.length - todo.length, units: todo.reduce((n, c) => n + c.units.length, 0)};
    record.documents.push(drec);
    save();
    if (!todo.length) { drec.status = 'nothing_new'; continue; }
    const section = c => c.path?.length ? c.path[c.path.length - 1] : doc.title;
    // 1. Structure pass.
    onProgress({phase: 'structure', document: doc.name, chunks: todo.length});
    const shared = sharedPredicates(sharedVocabulary).map(p => `${p.id}(${p.args.join(', ')})`);
    const known = [knownText(decl, existing), shared.length ? `shared relations (use them for totals, parts, limits, shares, start and end dates, order of events): ${shared.join(', ')}` : ''].filter(x => x && x !== '(none)').join('\n') || '(none)';
    const structures = await pool(todo, concurrency, async c => {
      const r = await structurePass({chat, tier: tiers.structure, title: doc.title, section: section(c), units: c.units, known, extraBody: extra('structure')});
      appendJsonl(path.join(dir, 'structure.jsonl'), {document: doc.name, chunk: c.key, ok: r.ok, problems: r.problems, calls: r.calls, value: r.value ?? null});
      if (!r.ok) escalate({stage: 'structure', document: doc.name, chunk: c.key, problems: r.problems});
      return r.value ?? {entities: [], relations: [], values: [], certainty: []};
    });
    const passages = todo.map((c, i) => ({key: c.key, units: c.units, structure: structures[i]}));
    // 2. Canonical vocabulary.
    const collected = collect(passages);
    const cases = conflictCases(collected);
    onProgress({phase: 'vocabulary', document: doc.name, conflicts: cases.length});
    const merged = await mergePass({chat, tier: tiers.merge, title: doc.title, cases, extraBody: extra('merge')});
    if (cases.length && !merged.ok) escalate({stage: 'vocabulary', document: doc.name, problems: merged.problems, cases: cases.map(k => ({case: k.case, type: k.type, names: k.names}))});
    const vocab = canonical(collected, cases, merged.value?.decisions ?? new Map(), passages, {reserved: decl.ids});
    // Things the memory already names are the same things: the FOL role reuses their symbols. The shared relations (amount, upper_limit,
    // share_of, starts_on, ...) join the document's own predicates; a document predicate of the same name and arity is the shared one.
    for (const e of decl.entities) if (!vocab.entities.some(x => x.id === e.id)) vocab.entities.push(e);
    for (const sp of sharedPredicates(sharedVocabulary)) {
      const own = vocab.predicates.findIndex(p => p.id === sp.id && p.args.length === sp.args.length);
      if (own >= 0) vocab.predicates[own] = {...sp, names: [...new Set([...sp.names, ...vocab.predicates[own].names])], passages: vocab.predicates[own].passages};
      else if (!vocab.predicates.some(p => p.id === sp.id)) vocab.predicates.push(sp);
    }
    for (const a of vocab.report.ambiguous_aliases) escalate({stage: 'vocabulary', document: doc.name, kind: 'ambiguous_alias', ...a});
    for (const u of vocab.report.undecided) escalate({stage: 'vocabulary', document: doc.name, kind: 'undecided_conflict', ...u});
    writeJson(path.join(dir, `vocabulary-${di + 1}.json`), {cases: cases.map(k => ({case: k.case, type: k.type, names: k.names, decision: merged.value?.decisions?.get(k.case) ?? null})), ...vocab});
    const look = lookups(vocab);
    // 3. FOL per chunk with the vocabulary as inventory (a chunk whose replies cannot be read is asked once of the fallback tier), then
    // one repair round per chunk with the converter's findings over the whole document: formulas it refuses, and statements made of a
    // group's name that other facts give to members (the sentence may be about the members: the model decides).
    onProgress({phase: 'fol', document: doc.name, chunks: todo.length});
    const certainty = new Map(passages.flatMap(p => (p.structure.certainty ?? []).map(c => [`${p.key}_s${c.s}`, c.status])));
    const unitsOf = (c, perInput) => c.units.map((u, i) => ({key: `${c.key}_s${u.index}`, passage: c.key, unit: u, fol: perInput[i] ?? [], status: certainty.get(`${c.key}_s${i + 1}`) ?? null}));
    const drafted = await pool(todo, concurrency, async c => {
      const inventory = inventoryText(vocab, c.key, template('inventory').inventory, {title: doc.title, section: section(c)});
      let r = await folPass({chat, tier: tiers.fol, units: c.units, inventory, extraBody: extra('fol'), maxTokens: 16000});
      let tier = tiers.fol;
      if ((!r.ok || !(r.value?.perInput ?? []).some(l => l.length)) && tiers.fallback && tiers.fallback !== tiers.fol) {
        const f = await folPass({chat, tier: tiers.fallback, units: c.units, inventory, extraBody: extra('fallback'), maxTokens: 6000});
        if (f.ok) { r = f; tier = tiers.fallback; }
      }
      if (!r.ok) escalate({stage: 'fol', document: doc.name, chunk: c.key, problems: r.problems});
      return {c, inventory, tier, raw: r.raw?.at(-1) ?? null, problems: r.problems ?? [], perInput: r.value?.perInput ?? c.units.map(() => [])};
    });
    const trial = convertDocument({units: drafted.flatMap(d => unitsOf(d.c, d.perInput)), look, existing: decl.predicates, prefix, title: doc.title});
    const findings = [...trial.rejected.map(r => ({unit: r.unit, text: `${r.fol} -- ${r.why}. Write the formulas of this sentence again so that they have a reading.`})), ...groupStatements(trial), ...unmatchedValues(trial)];
    // The repair sees the relations the document's facts use and their values, so that rules pick out members with the same names.
    const factsBlock = alignmentInput(trial, decl.predicates).grounded;
    const fol = await pool(drafted, concurrency, async d => {
      const {c} = d;
      const index = new Map(c.units.map((u, i) => [`${c.key}_s${u.index}`, i]));
      const mine = findings.filter(f => index.has(f.unit));
      let perInput = d.perInput, repaired = 0;
      if (mine.length && d.raw) {
        const reasons = [...(factsBlock.length ? [`For reference, the relations the document's facts use, with their values:\n${factsBlock.slice(0, 40).join('\n')}`] : []), ...mine.slice(0, 30).map(f => `s${index.get(f.unit) + 1}: ${f.text}`)];
        const again = await folRepair({chat, tier: d.tier === tiers.fol ? tiers.repair : d.tier, units: c.units, inventory: d.inventory, previous: d.raw, reasons, extraBody: d.tier === tiers.fol ? extra('repair') : extra('fallback'), maxTokens: 16000});
        if (!again.ok) escalate({stage: 'fol_repair', document: doc.name, chunk: c.key, findings: mine.length, problems: again.problems});
        if (again.ok) {
          const bad = new Set(mine.map(f => index.get(f.unit)));
          perInput = perInput.map((lines, i) => (bad.has(i) && again.value.perInput[i]?.length ? again.value.perInput[i] : lines));
          repaired = [...bad].filter(i => again.value.perInput[i]?.length).length;
        }
      }
      appendJsonl(path.join(dir, 'fol.jsonl'), {document: doc.name, chunk: c.key, tier: d.tier, problems: d.problems, findings: mine.map(f => f.text), repaired, units: c.units.map((u, i) => ({s: i + 1, line: u.line, text: u.text, fol: perInput[i]}))});
      return perInput;
    });
    // 4. Alignment: a condition no fact states and no rule concludes is asked once (tier `merge`) for its definition through the
    // relations that have facts, with the document's words that justify it; then the whole document is converted.
    const units = todo.flatMap((c, i) => unitsOf(c, fol[i]));
    const first = convertDocument({units, look, existing: decl.predicates, prefix, title: doc.title});
    const {dangling, grounded} = alignmentInput(first, decl.predicates);
    onProgress({phase: 'align', document: doc.name, dangling: dangling.length});
    const aligned = await alignPass({chat, tier: tiers.merge, title: doc.title, dangling, grounded, documentText: doc.text, extraBody: tiers.merge === tiers.fol ? extra('fol') : extra('merge')});
    if (dangling.length && !aligned.ok) escalate({stage: 'align', document: doc.name, problems: aligned.problems});
    const alignUnits = (aligned.value?.definitions ?? []).map((d, i) => alignmentUnit(d, i, todo)).filter(Boolean);
    appendJsonl(path.join(dir, 'align.jsonl'), {document: doc.name, dangling: dangling.map(d => d.fol), definitions: aligned.value?.definitions ?? [], problems: aligned.problems ?? []});
    for (const d of dangling.filter(d => !alignUnits.some(u => u.condition === d.id))) escalate({stage: 'align', document: doc.name, kind: 'dangling_condition', condition: d.fol, rule: d.rule});
    const conv = convertDocument({units: [...units, ...alignUnits], look, existing: decl.predicates, prefix, title: doc.title});
    for (const r of conv.rejected) { escalate({stage: 'conversion', document: doc.name, ...r}); appendJsonl(path.join(dir, 'rejected.jsonl'), {document: doc.name, ...r}); }
    const docSource = `${doc.title} (${doc.name}, sha256 ${doc.sha256.slice(0, 12)})`;
    const rendered = renderWires(conv, {existing: decl.predicates, existingIds: decl.ids, entityVocab: vocab.entities, title: doc.title, docSource});
    const vocabName = `ingest-v2-${prefix}-vocabulary`;
    const drafts = [{name: vocabName, text: rendered.vocabulary}, ...todo.map(c => ({name: `ingest-v2-${prefix}-${c.key}`, text: rendered.passages.get(c.key) ?? '', chunk: c}))];
    // Quote check: every quote must be words of its chunk (by construction; checked, not assumed).
    for (const d of drafts.filter(x => x.chunk && x.text)) {
      const bad = quoteProblems(d.text, d.chunk.text);
      if (bad.length) { d.text = withoutWires(d.text, bad.map(p => p.wire)); for (const p of bad) escalate({stage: 'quote', document: doc.name, chunk: d.chunk.key, ...p}); }
    }
    // Contradiction check against the memory and the chunks before (memory wins: duplicates and contradictions are held back).
    let before = [...existing, {name: vocabName, text: rendered.vocabulary}];
    const held = [];
    for (const d of drafts.filter(x => x.chunk && x.text)) {
      const conflicts = memoryConflicts(d.text, before);
      if (conflicts.length) {
        d.text = withoutWires(d.text, conflicts.map(p => p.wire));
        for (const p of conflicts) { held.push({chunk: d.chunk.key, ...p}); if (p.code !== 'duplicate_of_memory') escalate({stage: 'contradiction', document: doc.name, chunk: d.chunk.key, ...p}); }
      }
      before = [...before, {name: d.name, text: d.text}];
    }
    const checked = validateDropping(drafts.map(d => ({name: d.name, text: d.text})), existing);
    for (const p of checked.dropped) escalate({stage: 'validator', document: doc.name, ...p, fol: conv.wires.find(w => w.id === p.wire)?.fol ?? null});
    checked.circuits.forEach((c, i) => { drafts[i].text = c.text; fs.writeFileSync(path.join(dir, 'knowledge', `${c.name}.sop`), c.text); });
    Object.assign(drec, {vocabulary: {entities: vocab.entities.length, predicates: vocab.predicates.length, conflicts: cases.length, merge_ok: merged.ok, report: vocab.report, closed: rendered.closed},
      conversion: conv.stats, rejected: conv.rejected.length, held_back: held.length, dropped_by_validator: checked.dropped.length, validation_ok: Boolean(checked.validation?.ok),
      wires: wireCounts(drafts.map(d => d.text).join('\n'))});
    save();
    // 5. Storage with provenance.
    if (!store) { drec.status = 'drafted'; continue; }
    const stored = [];
    for (const d of drafts) {
      if (!d.text.trim()) continue;
      const provenance = {kind: 'document', version: VERSION, document: doc.name, title: doc.title, document_sha256: doc.sha256, url: doc.source?.url ?? null, licence: doc.source?.licence ?? null, rights: doc.source?.rights ?? null,
        ...(d.chunk ? {chunk: d.chunk.index, lines: [d.chunk.start_line, d.chunk.end_line], section: d.chunk.path, chunk_sha256: d.chunk.sha256} : {stage: 'vocabulary'})};
      try {
        if (target.kind === 'memory') memories.addKnowledge(target.id, {circuits: [{name: d.name, text: d.text}], approvedBy: user, reason: `document ingestion ${VERSION}`, source: provenance, now});
        else sessions.addCircuit(target.id, {name: d.name, text: d.text, request: provenance, model: `tiers ${tiers.structure}/${tiers.fol}/${tiers.merge}`, origin: 'document_ingestion', by: user, now});
        stored.push(d.name);
      } catch (error) {
        escalate({stage: 'store', document: doc.name, circuit: d.name, code: error.code ?? null, message: error.message, problems: (error.problems ?? []).slice(0, 10)});
      }
    }
    drec.stored = stored;
    drec.status = stored.length ? 'stored' : 'failed';
    save();
  }
  record.usage = {...chat.ledger, credits: Math.round((chat.ledger?.credits ?? 0) * 100) / 100};
  record.ms = Date.now() - started;
  record.status = record.documents.every(d => d.status === 'nothing_new') ? 'nothing_new' : record.documents.some(d => ['stored', 'drafted'].includes(d.status)) ? (store ? 'stored' : 'drafted') : 'failed';
  save();
  const esc = fs.readFileSync(escalations, 'utf8').split('\n').filter(Boolean).length;
  const lines = [`# ingestion ${VERSION} into ${target.kind}:${target.id}: ${record.status}`,
    ...record.documents.map(d => `- ${d.name}: ${d.status}; ${d.units ?? 0} units in ${d.chunks - d.skipped}/${d.chunks} chunks; wires ${Object.entries(d.wires ?? {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`),
    ...record.documents.filter(d => d.conversion).map(d => `- ${d.name}: formulas ${d.conversion.converted}/${d.conversion.formulas} converted, ${d.rejected} rejected, ${d.dropped_by_validator} dropped by the validator, ${d.held_back} held back; vocabulary ${d.vocabulary.entities} things, ${d.vocabulary.predicates} predicates, ${d.vocabulary.conflicts} conflicts; ${d.conversion.vocabulary_misses.length} predicates outside the vocabulary`),
    `- calls ${record.usage.calls} (${Object.entries(record.usage.by_tier ?? {}).map(([t, v]) => `${t} ${v.calls}`).join(', ')}), credits ${record.usage.credits}, ${Math.round(record.ms / 1000)} s; escalations ${esc}`];
  fs.writeFileSync(path.join(dir, 'summary.md'), lines.slice(0, 10).join('\n') + '\n');
  record.summary = lines.slice(0, 10).join('\n');
  save();
  return record;
}
