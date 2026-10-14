/**
 * The base-memory composer (DS022 "Composing a base memory", owner request of 2026-10-02): a base memory is built, or rebuilt, from
 * prepared layers chosen from a list (the seed layers of config/knowledge such as world knowledge, common sense and the conversation
 * collections, and any other base memory of the chat data root). It uses the ordinary import path (`BaseMemories.create` with
 * `imports`: each layer's circuits are snapshotted and their facts ingested); nothing is written by hand.
 *
 *   composableLayers(memories)                   -> [{id, name, description, seed, role, group, licence, counts, imports, ...}]
 *   compose(memories, {id, name, layers, ...})   -> the new manifest; refreshes a composed memory that holds no circuits of its own
 *   conversationCircuits(memories, id)           -> the circuits of the conversation layers of a memory (the chat's reply layer)
 *   ensureReplyMemory(memories, config)          -> the id of the chat's reply memory (config.conversation), composed when missing
 *
 * Rules: a seed memory and a memory with circuits of its own are never replaced (their content would be lost; a seed is renewed by
 * tools/refresh-seed-memories.mjs); layers must exist; at most one layer of an exclusive `group` (seed.json, e.g. the register
 * collections) is accepted. Sessions forked earlier are clones and keep what they had.
 */
import fs from 'node:fs';
import path from 'node:path';
import {SEEDS_DIR, seedIds, seedInfo, seedIsCurrent, seedCircuits} from '../knowledge-seeds.mjs';
import {validateCircuits} from './memories.mjs';

/** The seed memory whose reply wires are the chat's phrasing (sop/replies.mjs CONVERSATION_LAYER). */
export const CONVERSATION_SEED = 'conversation-v1';
/** Layers bigger than this (characters of circuits) are not validated again when composed: they were validated when they were built. */
const VALIDATE_LIMIT = 8_000_000;

const fail = (message, code, status = 400) => Object.assign(new Error(message), {code, status});
const seedSet = () => new Set(seedIds({all: true}));
const seedMeta = id => { try { return seedInfo(id); } catch { return null; } };

/** Whether a layer is part of the conversation layer: conversation-v1 itself or a seed whose seed.json says `role: conversation`. */
export const isConversationLayer = id => id === CONVERSATION_SEED || seedMeta(id)?.role === 'conversation';

/** The layers the composer offers: every base memory of the root, seeds first, with what their manifests and seed.json say. */
export function composableLayers(memories) {
  const seeds = seedSet();
  return memories.list().map(m => {
    const meta = seeds.has(m.id) ? seedMeta(m.id) : null;
    const own = m.circuits ?? 0;
    return {
      id: m.id, name: m.name, description: m.description ?? '', seed: Boolean(meta), role: meta?.role ?? (m.id === CONVERSATION_SEED ? 'conversation' : 'knowledge'),
      group: meta?.group ?? null, licence: meta?.licence ?? null, counts: meta?.counts ?? null,
      imports: (m.imports ?? []).filter(l => l.direct).map(l => l.id), layers: (m.imports ?? []).map(l => l.id),
      composition: m.composition ?? null, facts: m.facts ?? 0, circuits: own,
      stale: meta && fs.existsSync(path.join(SEEDS_DIR, m.id)) ? !seedIsCurrent(memories, m.id) : false,
      replaceable: !meta && own === 0,
    };
  }).sort((a, b) => Number(b.seed) - Number(a.seed) || a.id.localeCompare(b.id));
}

/**
 * Builds base memory `id` from `layers` (ids of base memories, in order). An existing memory is replaced only when it is not a seed
 * and holds no circuits of its own. Returns `{memory, replaced, validated, ms}`.
 */
export function compose(memories, {id, name, description = '', layers, strategy, now = new Date()} = {}) {
  const started = Date.now();
  if (typeof id !== 'string' || !id) throw fail('Provide id: the base memory to build', 'invalid_parameter');
  if (!Array.isArray(layers) || !layers.length || layers.some(l => typeof l !== 'string')) throw fail('Provide layers: a non-empty array of base memory ids', 'invalid_layers');
  if (new Set(layers).size !== layers.length) throw fail('A layer is listed twice', 'invalid_layers');
  if (layers.includes(id)) throw fail('A memory cannot be built from itself', 'invalid_layers');
  const known = new Map(memories.list().map(m => [m.id, m]));
  const missing = layers.filter(l => !known.has(l));
  if (missing.length) throw fail(`Unknown layer ${JSON.stringify(missing[0])} (GET /v1/memory-composer lists them)`, 'unknown_layer', 404);
  const groups = new Map();
  for (const l of layers) { const g = seedMeta(l)?.group; if (g) groups.set(g, [...(groups.get(g) ?? []), l]); }
  for (const [g, ls] of groups) if (ls.length > 1) throw fail(`At most one layer of the group ${g} may be chosen (${ls.join(', ')})`, 'exclusive_layers');
  const existing = known.get(id);
  if (existing && seedSet().has(id)) throw fail(`${id} is a seed memory; renew it with tools/refresh-seed-memories.mjs`, 'seed_memory', 409);
  if (existing && (existing.circuits ?? 0) > 0) throw fail(`${id} holds circuits of its own and cannot be rebuilt; build a new memory or fork it`, 'memory_has_circuits', 409);
  if (existing && layersDependOn(memories, layers, id)) throw fail(`A chosen layer imports ${id}`, 'invalid_layers');
  // The chosen layers, flattened in import order, must hold together (duplicate ids, arities): validated unless very large.
  const flat = memories.resolveImports(layers);
  const circuits = flat.flatMap(l => memories.circuits(l.id).map(c => ({name: `${l.id}:${c.name}`, text: c.text})));
  const size = circuits.reduce((a, c) => a + c.text.length, 0);
  let validated = false;
  if (size <= VALIDATE_LIMIT) {
    const check = validateCircuits(circuits, []);
    if (!check.ok) throw Object.assign(fail('The chosen layers do not hold together; nothing was built', 'validation_failed', 422), {problems: check.problems, warnings: check.warnings});
    validated = true;
  }
  if (existing) memories.delete(id);
  const memory = memories.create({id, name: name || existing?.name || id, description: description || existing?.description || `Composed from ${layers.join(', ')}`, imports: layers, ...(strategy ? {strategy} : {}), now});
  const manifest = {...memories.manifest(id), composition: {layers, at: now.toISOString(), validated}};
  fs.writeFileSync(memories.manifestFile(id), JSON.stringify(manifest, null, 2) + '\n');
  return {memory: manifest, replaced: Boolean(existing), validated, ms: Date.now() - started, created: memory.id};
}

const layersDependOn = (memories, layers, id) => layers.some(l => (memories.manifest(l).imports ?? []).some(x => x.id === id));

/** The circuits of a memory's conversation layers, in order: what the chat's reply layer reads (sop/replies.mjs setReplyLayer). */
export function conversationCircuits(memories, id) {
  const layers = memories.layers(id).filter(l => isConversationLayer(l.id));
  const own = isConversationLayer(id) || layers.length ? memories.circuits(id).map(c => ({...c, name: `${id}:${c.name}`})) : [];
  return [...layers.flatMap(l => memories.layerCircuits(id, l.id)), ...own].map(({name, text}) => ({name, text}));
}

/**
 * The chat's reply memory: `config.conversation.memory` (default: the seed conversation-v1 alone). A configured memory that is
 * missing is composed from `config.conversation.layers`. Returns `{id, created, stale}`; `stale` lists the conversation seed layers
 * whose stored copy differs from config/knowledge (renew with tools/refresh-seed-memories.mjs, then the composed memory is rebuilt).
 */
export function ensureReplyMemory(memories, config = {}) {
  const wanted = config.conversation?.memory ?? CONVERSATION_SEED;
  const have = new Set(memories.list().map(m => m.id));
  let created = false;
  if (!have.has(wanted)) {
    const layers = (config.conversation?.layers ?? [CONVERSATION_SEED]).filter(l => have.has(l));
    if (!layers.length) return {id: have.has(CONVERSATION_SEED) ? CONVERSATION_SEED : null, created, stale: []};
    compose(memories, {id: wanted, name: config.conversation?.name ?? 'Conversation (composed)', description: `The chat's reply layer, composed from ${layers.join(', ')} (config conversation.layers).`, layers});
    created = true;
  }
  const seeds = seedSet();
  const shipped = l => seedCircuits(l).map(c => c.text);
  const same = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);
  // A seed layer is stale when the snapshot the reply memory holds differs from config/knowledge (or, for the seed itself, its stored copy).
  const stale = wanted === CONVERSATION_SEED
    ? (seeds.has(wanted) && !seedIsCurrent(memories, wanted) ? [wanted] : [])
    : memories.layers(wanted).map(l => l.id).filter(l => seeds.has(l) && isConversationLayer(l) && fs.existsSync(path.join(SEEDS_DIR, l)) && !same(memories.layerCircuits(wanted, l).map(c => c.text), shipped(l)));
  return {id: wanted, created, stale};
}
