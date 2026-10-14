/**
 * Dataset rows against their verification worlds (linking suite, differential run). The rows of `symbolic_english` and
 * `neuro_english` carry the message, the grammatical analysis and the SOP of SymbolicLM; the verification world a row
 * was generated with (its entity declarations, the shared predicate blocks and the facts) lives on the legacy source row
 * named by `source.corpus` and `source.id` (DSx008 "Three datasets"). A row whose source has no world (new cases,
 * composed and form-variant rows, wild rows) is linked against the whole shared predicate vocabulary without entities, so
 * that relation and role linking is still exercised.
 *
 * Everything here is evaluation scaffolding: a world is never model input.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readJsonlShardedSync, jsonlExists} from '../../lib/jsonl-shards.mjs';
import {sharedFile, rowWorld, verificationContext} from '../../lib/row-world.mjs';
import {Repository} from '../../memory/repository.mjs';
import {publishKnowledge} from '../../sop/ingest.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {Runtime} from '../../sop/runtime.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The legacy corpora that carry the verification worlds moved with the frozen small-model branch. */
const FROZEN = 'probably_obsolete/tinyLLMExperiments';
export const SHARED_WORLD_DIR = `${FROZEN}/datasets_archive/formalizer-v1/world`;
const LEGACY_FILES = [
  `${FROZEN}/datasets_archive/formalizer-v1/train.jsonl`, `${FROZEN}/datasets_archive/formalizer-v1/dev.jsonl`,
  `${FROZEN}/datasets_archive/legacy-resplit/formalizer-ood-v1/train.jsonl`, `${FROZEN}/datasets_archive/legacy-resplit/formalizer-ood-v1/dev.jsonl`,
  `${FROZEN}/eval/suites/formalizer-v1/test.jsonl`, `${FROZEN}/eval/suites/formalizer-ood-v1/test.jsonl`,
  `${FROZEN}/datasets_archive/clean-english/train.jsonl`, `${FROZEN}/datasets_archive/clean-english/dev.jsonl`, `${FROZEN}/eval/suites/clean-english/test.jsonl`,
];
const DEFAULT_NOW = '2026-09-28T12:00:00Z';

let legacyIndex = null;
/** Legacy source rows by id (the rows that carry a verification world). */
export function legacyRows() {
  if (legacyIndex) return legacyIndex;
  legacyIndex = new Map();
  for (const file of LEGACY_FILES) {
    if (!jsonlExists(path.join(ROOT, file))) continue;
    for (const row of readJsonlShardedSync(path.join(ROOT, file))) if (!legacyIndex.has(row.id)) legacyIndex.set(row.id, row);
  }
  return legacyIndex;
}

let sharedPredicates = null;
/** Every predicate block of the shared archive world, joined (the world of a row without a source world). */
export function allSharedPredicates() {
  if (!sharedPredicates) sharedPredicates = [...sharedFile(ROOT, SHARED_WORLD_DIR, 'predicates.sop').values()].join('\n\n') + '\n';
  return sharedPredicates;
}

/** The verification world of a dataset row: `{ontology, setup, late, now, source: 'row-world'|'predicates-only'}`. */
export function worldOfDatasetRow(row) {
  const legacy = legacyRows().get(row.source?.id);
  if (legacy?.world || legacy?.ontology_sop) {
    const world = rowWorld(legacy);
    return {...world, now: verificationContext(legacy)?.now ?? DEFAULT_NOW, language: legacy.language, source: 'row-world'};
  }
  return {ontology: allSharedPredicates(), setup: '', late: '', now: DEFAULT_NOW, language: null, source: 'predicates-only'};
}

const summarize = result => {
  const packet = result?.result?.packet ?? result?.result ?? {};
  const status = packet.status ?? result?.result?.status ?? result?.status ?? 'error';
  return {
    status,
    answers: (packet.answers ?? []).map(answer => JSON.stringify(Object.values(answer.binding ?? answer ?? {}))).sort(),
    ...(packet.count !== undefined ? {count: packet.count} : {}),
    ...(packet.hypothetical ? {hypothetical: true} : {}),
    text: String(result?.result?.text ?? packet.text ?? ''),
    execution: createHash('sha256').update(String(result?.executionSop ?? '')).digest('hex').slice(0, 16),
  };
};

/**
 * Runs a model-language SOP program for a message against a world through the real runtime (host linking included).
 * `lexicon` defaults to the compiled lexicon of the world's ontology text. Returns the observable summary
 * {status, answers, count, ...} or `{status: 'error', error}`.
 */
export async function runAgainstWorld({sop, message, world, language = 'en', lexicon = null, engine = 'scan'}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linking-rows-'));
  try {
    lexicon ??= new Lexicon(world.ontology);
    let repo = null, session = null;
    if ([world.setup, world.late].some(text => text?.trim())) {
      repo = new Repository(directory, {memory: {engine}});
      if (world.setup?.trim()) publishKnowledge(repo, 'world', world.setup, {schema: lexicon.predicates, reviewed: true, knownAt: Date.parse('2023-06-01T00:00:00Z')});
      if (world.late?.trim()) publishKnowledge(repo, 'world', world.late, {schema: lexicon.predicates, reviewed: true, knownAt: Date.parse('2025-06-01T00:00:00Z')});
      session = repo.session('world', 'reader', 'linking');
    }
    const runtime = new Runtime({repo, session, lexicon, schema: lexicon.predicates, now: Date.parse(world.now), policy: {allowWrite: false, reinforce: false}});
    const result = await runtime.run(sop, {origin: 'model', inputText: message, language});
    return {...summarize(result), result};
  } catch (error) {
    return {status: 'error', error: String(error.message ?? error).slice(0, 300)};
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}
