/**
 * Locations of the ChatSOP datasets (owner decision 2026-09-30, DS008 "Three datasets"): `datasets/` holds exactly
 * `bad_english`, `symbolic_english` and `neuro_english` and, since 2026-10-01, the owner-message collection `natural`; the legacy corpora that feed them (formalizer-v1, proofing,
 * proofing-diverse-dev, clean-english, diversity) are provenance inputs and the gold-SOP arbiter, kept in the tracked
 * folder `datasets_archive/`. `archived(relative)` resolves a legacy path to whichever of the two folders holds it, so
 * tools keep working on a checkout that has not been restructured yet and old records that store a
 * `datasets/<legacy>/...` path stay resolvable (`resolveDatasetPath`).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {jsonlExists} from './jsonl-shards.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const ARCHIVE_DIR = 'datasets_archive';
/** The frozen small-model branch (probably_obsolete/tinyLLMExperiments/README.md): the datasets and legacy corpora moved there with their build tools. */
export const FROZEN_DIR = 'probably_obsolete/tinyLLMExperiments';
const SEARCH = Object.freeze(['datasets', ARCHIVE_DIR, `${FROZEN_DIR}/datasets`, `${FROZEN_DIR}/${ARCHIVE_DIR}`]);
export const THREE_DATASETS = Object.freeze(['bad_english', 'symbolic_english', 'neuro_english']);
/** The owner-message collection (owner decision 2026-10-01, DS008 "The natural collection"): a fourth folder of `datasets/` without splits or targets; it is not one of the three datasets. */
export const NATURAL_COLLECTION = 'natural';
export const LEGACY_CORPORA = Object.freeze(['formalizer-v1', 'proofing', 'proofing-diverse-dev', 'clean-english', 'diversity']);

const exists = file => fs.existsSync(file) || (file.endsWith('.jsonl') && jsonlExists(file));

/** Repository-relative path of a legacy corpus file, e.g. archived('formalizer-v1/dev.jsonl'). */
export function archived(relative) {
  for (const base of [ARCHIVE_DIR, 'datasets', `${FROZEN_DIR}/${ARCHIVE_DIR}`, `${FROZEN_DIR}/datasets`]) {
    const candidate = path.posix.join(base, relative);
    if (exists(path.join(ROOT, candidate))) return candidate;
  }
  return path.posix.join(ARCHIVE_DIR, relative);
}

/**
 * Resolve a path stored in an older record (`datasets/<legacy corpus>/...`) to where the file lives now. Other paths
 * are returned unchanged.
 */
export function resolveDatasetPath(stored) {
  const match = /^datasets\/([^/]+)\/(.*)$/.exec(String(stored));
  if (!match || !LEGACY_CORPORA.includes(match[1])) return stored;
  return archived(`${match[1]}/${match[2]}`);
}

const isDirectory = dir => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };

/**
 * Repository-relative directory of a corpus by name: `datasets/<name>` for the three current datasets, otherwise the
 * legacy corpus in `datasets_archive/<name>`. Used by every tool that takes a corpus name.
 */
export function corpusDir(name, root = ROOT) {
  for (const base of SEARCH) if (isDirectory(path.join(root, base, name))) return `${base}/${name}`;
  return `datasets/${name}`;
}

/** Names of all corpus directories under `datasets/` and `datasets_archive/` (sorted, without duplicates). */
export function corpusNames(root = ROOT) {
  const names = new Set();
  for (const base of SEARCH) {
    const dir = path.join(root, base);
    if (!isDirectory(dir)) continue;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) if (entry.isDirectory()) names.add(entry.name);
  }
  return [...names].sort();
}
