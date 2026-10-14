#!/usr/bin/env node
/**
 * Enforce the repository file-size rule: no tracked or untracked-but-not-ignored file may exceed 50 MB.
 *
 *   node tools/shard-large-files.mjs [--max 45MB] [--check] [paths…]
 *
 * Without paths it scans `datasets/`, `datasets_sources/`, `eval/` and `status/` (gitignored paths excluded). A `.jsonl`
 * file above `--max` is split in place into `<name>.part-NNN.jsonl` by `lib/jsonl-shards.mjs`; the concatenated parts
 * are verified against the original sha256 before the original is removed. Any other oversized file is reported with
 * a suggestion and left untouched. `--check` modifies nothing and exits 1 when any non-ignored file in the whole
 * repository exceeds 50 MB.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DEFAULT_MAX_BYTES, REPOSITORY_FILE_LIMIT, splitJsonlFile} from '../lib/jsonl-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['datasets', 'datasets_archive', 'datasets_sources', 'eval', 'status'];
const UNITS = {b: 1, kb: 1e3, mb: 1e6, gb: 1e9, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3};

export function parseSize(text) {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(String(text).trim());
  const unit = match && UNITS[(match[2] || 'b').toLowerCase()];
  if (!unit) throw Error(`Invalid size: ${text} (use e.g. 45MB)`);
  return Math.floor(Number(match[1]) * unit);
}

/** Tracked plus untracked-but-not-ignored files (existing on disk) under the given repository-relative paths. */
export function repositoryFiles(paths = [], cwd = root) {
  const result = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', ...paths], {cwd, encoding: 'utf8', maxBuffer: 1 << 28});
  if (result.status !== 0) throw Error(`git ls-files failed: ${result.stderr}`);
  return [...new Set(result.stdout.split('\0').filter(Boolean))]
    .map(file => ({file, size: (() => { try { const stat = fs.statSync(path.join(cwd, file)); return stat.isFile() ? stat.size : -1; } catch { return -1; } })()}))
    .filter(entry => entry.size >= 0);
}

export const oversized = (limit = REPOSITORY_FILE_LIMIT, paths = [], cwd = root) =>
  repositoryFiles(paths, cwd).filter(entry => entry.size > limit).sort((a, b) => b.size - a.size);

const mb = bytes => (bytes / 1e6).toFixed(1) + ' MB';

function main(argv) {
  const args = {max: DEFAULT_MAX_BYTES, check: false, paths: []};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--max') args.max = parseSize(argv[++i]);
    else if (argv[i].startsWith('--max=')) args.max = parseSize(argv[i].slice(6));
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node tools/shard-large-files.mjs [--max 45MB] [--check] [paths…]');
      return 0;
    } else args.paths.push(path.relative(root, path.resolve(argv[i])));
  }
  if (args.max > REPOSITORY_FILE_LIMIT) throw Error(`--max must not exceed the ${mb(REPOSITORY_FILE_LIMIT)} repository limit`);
  if (args.check) {
    const bad = oversized(REPOSITORY_FILE_LIMIT, args.paths);
    for (const entry of bad) console.log(`OVER LIMIT ${mb(entry.size).padStart(10)}  ${entry.file}`);
    console.log(bad.length ? `${bad.length} file(s) exceed ${mb(REPOSITORY_FILE_LIMIT)}; run node tools/shard-large-files.mjs` : `ok: no repository file exceeds ${mb(REPOSITORY_FILE_LIMIT)}`);
    return bad.length ? 1 : 0;
  }
  const candidates = oversized(args.max, args.paths.length ? args.paths : ROOTS);
  let failures = 0;
  for (const {file, size} of candidates) {
    const full = path.join(root, file);
    if (!file.endsWith('.jsonl') || /\.part-\d{3,}\.jsonl$/.test(file)) {
      const hint = /\.part-\d{3,}\.jsonl$/.test(file) ? 'rewrite the logical file with writeJsonlSharded and a smaller maxBytes'
        : /\.json$/.test(file) ? 'convert to JSONL and shard, or store compressed / outside git and record it in the source provenance'
          : 'split, compress, or move it to a gitignored location and record how to re-fetch it';
      console.log(`SKIP       ${mb(size).padStart(10)}  ${file}  (not a shardable .jsonl; suggestion: ${hint})`);
      if (size > REPOSITORY_FILE_LIMIT) failures++;
      continue;
    }
    const mtimeAge = Date.now() - fs.statSync(full).mtimeMs;
    if (mtimeAge < 120_000) {
      console.log(`BUSY       ${mb(size).padStart(10)}  ${file}  (modified ${Math.round(mtimeAge / 1000)}s ago; retry later)`);
      failures++;
      continue;
    }
    try {
      const result = splitJsonlFile(full, {maxBytes: args.max});
      console.log(`SHARDED    ${mb(size).padStart(10)}  ${file} -> ${result.paths.length} parts (sha256 ${result.sha256.slice(0, 12)} verified)`);
      for (const part of result.paths) console.log(`             ${mb(fs.statSync(part).size).padStart(10)}  ${path.relative(root, part)}`);
    } catch (error) {
      console.log(`FAILED     ${mb(size).padStart(10)}  ${file}: ${error.message}`);
      failures++;
    }
  }
  if (!candidates.length) console.log(`ok: no file above ${mb(args.max)} under ${(args.paths.length ? args.paths : ROOTS).join(', ')}`);
  return failures ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
