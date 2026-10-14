/**
 * Verification worlds shared by reference (DS015). A generated corpus row carries only its own world: the entity
 * declarations of `ontology_sop` and the facts and family rules of `setup_sop` / `late_setup_sop`. The predicate
 * declarations and the converse-equivalence rules are the same for every row, so they are stored once per corpus
 * in `<world.dir>/predicates.sop` and `<world.dir>/rules.sop`, and a row names the blocks it uses:
 *
 *   "world": {"dir": "datasets_archive/formalizer-v1/world", "predicates": ["works_at", "works_at__converse"], "rules": ["works_at"]}
 *
 * `rowWorld(row)` assembles the full evaluation-only world text exactly as if it were inline. Rows without `world`
 * (inline worlds) are returned unchanged. None of this is model input.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveDatasetPath} from './dataset-paths.mjs';
import {convertOntology} from './ontology-conversion.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Split a shared world file into blocks. A file with `# block KEY` marker lines is split at the markers (a block may
 * hold several wires, for example the four converse rules of a predicate); otherwise each `@id` wire is a block
 * keyed by its id. Other comment lines are ignored.
 */
export function blocksOf(text) {
  const blocks = new Map();
  const source = String(text);
  if (/^# block \S+/m.test(source)) {
    const parts = source.split(/^# block (\S+)[ \t]*$/m);
    for (let i = 1; i < parts.length; i += 2) blocks.set(parts[i], parts[i + 1].replace(/^#.*$/gm, '').trim());
    return blocks;
  }
  for (const chunk of source.replace(/^#.*$/gm, '').split(/\n(?=@)/)) {
    const trimmed = chunk.trim(), key = trimmed.match(/^@([A-Za-z][A-Za-z0-9_]*)/)?.[1];
    if (key) blocks.set(key, trimmed);
  }
  return blocks;
}

/**
 * Predicate blocks written in the retired ontology grammar (the archived worlds, kept as they were generated: `role NAME TYPE`
 * and `alias` lines on the predicate, no `args`) are converted to the knowledge grammar when read, so the rows always see
 * `predicate` and `lexeme` wires (lib/ontology-conversion.mjs). Blocks already in the knowledge grammar pass through.
 */
const retiredGrammar = text => /^@\S+ predicate\s*$/m.test(text) && !/^  args /m.test(text);
const knowledgeBlock = (id, text) => (retiredGrammar(text) ? convertOntology(text).blocks.get(id) ?? text : text);

/** A predicate block, converted when it is still written in the retired ontology grammar (a block handed in memory by the generator). */
const knowledgeBlockOf = text => (retiredGrammar(text) ? convertOntology(text).blocks.get(/^@(\S+)/.exec(text.trim())[1]) ?? text : text);

const cache = new Map();
export function sharedFile(root, dir, name) {
  const file = path.join(root, resolveDatasetPath(dir), name);
  if (!cache.has(file)) {
    const blocks = blocksOf(fs.readFileSync(file, 'utf8'));
    if (name === 'predicates.sop') for (const [id, text] of blocks) blocks.set(id, knowledgeBlock(id, text));
    cache.set(file, blocks);
  }
  return cache.get(file);
}

/**
 * The full world of a row: {ontology, setup, late}. `shared` ({predicates: Map, rules: Map}) supplies the shared
 * blocks in memory (the generator, before the files exist); otherwise they are read from `row.world.dir`.
 */
export function rowWorld(row, {root = repositoryRoot, shared = null} = {}) {
  const world = row.world;
  if (!world) return {ontology: row.ontology_sop ?? '', setup: row.setup_sop ?? '', late: row.late_setup_sop ?? ''};
  const predicates = shared?.predicates ?? sharedFile(root, world.dir, 'predicates.sop');
  const rules = shared?.rules ?? sharedFile(root, world.dir, 'rules.sop');
  const pick = (map, ids, kind) => ids.map(id => { if (!map.has(id)) throw Error(`${row.id}: shared world has no ${kind} block ${id}`); return map.get(id); });
  const join = parts => parts.filter(part => part && part.trim()).map(part => part.trim()).join('\n\n');
  return {
    ontology: join([row.ontology_sop ?? '', ...pick(predicates, world.predicates ?? [], 'predicate').map(text => knowledgeBlockOf(text))]) + '\n',
    setup: join([row.setup_sop ?? '', ...pick(rules, world.rules ?? [], 'rule')]),
    late: row.late_setup_sop ?? '',
  };
}

/** The row with its world inlined (ontology_sop, setup_sop, late_setup_sop), for tools that expect inline worlds. */
export function withInlineWorld(row, options = {}) {
  if (!row?.world) return row;
  const world = rowWorld(row, options);
  const {world: _reference, ...rest} = row;
  return {...rest, ontology_sop: world.ontology, setup_sop: world.setup, late_setup_sop: world.late};
}

/**
 * The evaluation-only verification context of a row: `{now, language, model_visible: false, entities, predicates}`,
 * the runtime clock and the entity/predicate index of the verification world. It is never model input; the field
 * is named `verification_context` (DS015 row fields). Rows written before 2026-09-28 call it `context`.
 */
export const verificationContext = row => row?.verification_context ?? row?.context ?? null;
