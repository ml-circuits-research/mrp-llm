/**
 * Seed base memories: vocabulary and knowledge that ships with the product under `config/knowledge/<id>/` (one folder per memory,
 * `seed.json` with name, description and imports, the circuits as `NNNN-name.sop`). `core-min` is the smallest shared vocabulary every
 * memory imports; `demo` is the small demonstration vocabulary (formerly the global `config/ontology.sop`). `ensureSeedMemories`
 * creates the seeds that are missing in a chat data root, in import order; `seedLexicon` compiles a seed's layered lexicon without
 * any chat data (CLI without a server, tests, examples). A seed whose `seed.json` says `"chat": false` is not a chat base memory (the
 * InternalReasoningStepByStep protocol, config/knowledge/formalizer-protocol-v1, loaded only by its strategy): `seedIds` and the
 * chat roots leave it out, `seedCircuits` and `seedLayers` still read it.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Lexicon} from '../sop/lexicon.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SEEDS_DIR = path.join(ROOT, 'config', 'knowledge');
/** The memory every other memory imports. */
export const CORE_SEED = 'core-min';
export const DEMO_SEED = 'demo';

export const seedInfo = id => JSON.parse(fs.readFileSync(path.join(SEEDS_DIR, id, 'seed.json'), 'utf8'));
export const seedIds = ({all = false} = {}) => fs.readdirSync(SEEDS_DIR).filter(id => fs.existsSync(path.join(SEEDS_DIR, id, 'seed.json')) && (all || seedInfo(id).chat !== false)).sort();

/** The own circuits of a seed: [{name, text}], names without the sequence prefix and extension (the base memory numbers them). */
export function seedCircuits(id) {
  const folder = path.join(SEEDS_DIR, id);
  return fs.readdirSync(folder).filter(n => n.endsWith('.sop')).sort().map(file => ({name: file.replace(/^\d+-/, '').replace(/\.sop$/, ''), file, text: fs.readFileSync(path.join(folder, file), 'utf8')}));
}

/** The seeds in import order: every seed after the seeds it imports. */
export function seedOrder(ids = seedIds()) {
  const out = [];
  const visit = id => { if (out.includes(id)) return; for (const dep of seedInfo(id).imports ?? []) visit(dep); out.push(id); };
  ids.forEach(visit);
  return out;
}

/** The layered circuits of a seed (its imports first, then its own), for a lexicon outside any base memory. */
export function seedLayers(id) {
  return seedOrder([id]).flatMap(seed => seedCircuits(seed).map(c => ({name: `${seed}:${c.file}`, text: c.text})));
}

/** The compiled lexicon of a seed with everything it imports. */
export const seedLexicon = id => Lexicon.fromCircuits(seedLayers(id), {provenance: `seed:${id}`});
/** The lexicon the examples, the CLI and the tests without chat data use: the `demo` seed over `core-min`. */
export const demoLexicon = () => seedLexicon(DEMO_SEED);

/** Is the stored seed memory the one the checkout ships? (its circuit texts equal config/knowledge/<id>, in order) */
export function seedIsCurrent(memories, id) {
  const stored = memories.circuits(id).map(c => c.text), shipped = seedCircuits(id).map(c => c.text);
  return stored.length === shipped.length && stored.every((text, i) => text === shipped[i]);
}

/**
 * Creates the seed memories a chat data root lacks, in import order, with their circuits added by the user `seed`. It never
 * deletes or rewrites a stored memory: a stored seed that differs from the checkout (the seeds changed, for example when the
 * Romanian lexemes left the core) is listed in the `stale` property of the result, and `tools/refresh-seed-memories.mjs` renews
 * it on an explicit administrator action. Returns the ids created. `ids` limits the seeds to those and what they import (a test that
 * needs only a few seeds does not build the others).
 */
export function ensureSeedMemories(memories, {strategy, ids = null} = {}) {
  const have = new Set(memories.list().map(m => m.id));
  const created = [];
  const order = ids ? seedOrder(ids) : seedOrder();
  for (const id of order) {
    if (have.has(id)) continue;
    const info = seedInfo(id);
    memories.create({id, name: info.name, description: info.description, imports: info.imports ?? [], ...(strategy ? {strategy} : {})});
    memories.addKnowledge(id, {circuits: seedCircuits(id).map(({name, text}) => ({name, text})), approvedBy: 'seed', reason: `seed ${id} (config/knowledge/${id})`, source: `config/knowledge/${id}`});
    created.push(id);
  }
  created.stale = order.filter(id => (have.has(id) || created.includes(id)) && !seedIsCurrent(memories, id));
  return created;
}
