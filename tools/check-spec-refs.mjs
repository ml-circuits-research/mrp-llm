#!/usr/bin/env node
/** Specification reference check.
 *
 *   node tools/check-spec-refs.mjs [--root <dir>] [--json]
 *
 * Asserts that the design specifications under docs/specs/ are numbered without gaps and that every
 * specification reference in a live file resolves:
 *   1. docs/specs/DSnnn-<slug>.md ids are unique and contiguous from DS000, and each front-matter title
 *      equals the file's basename;
 *   2. docs/specs/matrix.md lists exactly those files, in the same order;
 *   3. every DSnnn token and DSnnn-<slug>.md name in a live file names an existing specification;
 *   4. every probably_obsolete/... path cited in a live file exists, here or in the ChatSOP repository that keeps the archive
 *      (MRP_CHATSOP_ROOT, default ../ChatSOP); without that repository rule 4 is skipped;
 *   5. frozen files (probably_obsolete/**, status/journal.jsonl, status/notes/*.jsonl, eval/reports/history/**, and the legacy
 *      generated corpus artifacts listed in aliases.json `legacyGenerated`) cite only ids that
 *      docs/specs/aliases.json knows, because former ids stay valid only there;
 *   6. no live file links an archived specification through a docs/specs/ path.
 * Live files are the repository's tracked and untracked, non-ignored text files outside the frozen set.
 * Exit status: 0 clean, 1 violations, 2 the check could not run.
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const ARCHIVE_ROOT_CANDIDATE = path.resolve(process.env.MRP_CHATSOP_ROOT ?? new URL('../../ChatSOP', import.meta.url).pathname);
const ARCHIVE_ROOT = fs.existsSync(path.join(ARCHIVE_ROOT_CANDIDATE, 'probably_obsolete')) ? ARCHIVE_ROOT_CANDIDATE : null;
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf('--' + name);
  return index === -1 ? undefined : args[index + 1];
};
const root = path.resolve(option('root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SPEC_DIR = 'docs/specs';
const FROZEN = /^(probably_obsolete\/|eval\/reports\/history\/|status\/journal\.jsonl$|status\/notes\/[^/]+\.jsonl$)/;
// Generated legacy corpus artifacts awaiting regeneration are listed in aliases.json (`legacyGenerated`) and
// treated like frozen files: their generators are retired, so they keep the ids of the time.
const EXEMPT = new Set([SPEC_DIR + '/aliases.json']);
const SKIPPED = /^(datasets_sources\/|models\/|node_modules\/|\.git\/)/;
const TEXT = /\.(md|mjs|js|cjs|json|jsonl|html|sop|ebnf|txt|py|sh|css|ya?ml)$/;
const DATA = /^(datasets|eval\/suites)\/.*\.jsonl$/;
const TOKEN = /\bDS(\d{3})((?:-[a-z0-9]+)*\.md)?/g;
const ARCHIVE_PATH = /probably_obsolete\/[^\s)'"`\]<>#?|,]+/g;

function listFiles() {
  try {
    return execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
      .split('\n').filter(Boolean);
  } catch {
    const walk = dir => fs.readdirSync(path.join(root, dir), {withFileTypes: true}).flatMap(entry => {
      const rel = dir ? dir + '/' + entry.name : entry.name;
      if (SKIPPED.test(rel + '/')) return [];
      return entry.isDirectory() ? walk(rel) : [rel];
    });
    return walk('');
  }
}

function frontTitle(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  return match?.[1].match(/^title:\s*(.+)$/m)?.[1].trim();
}

export function checkSpecRefs(base = root) {
  const violations = [];
  const report = (rule, where, message) => violations.push({rule, where, message});
  const specDir = path.join(base, SPEC_DIR);
  const specFiles = fs.readdirSync(specDir).filter(name => /^DS\d{3}-[a-z0-9-]+\.md$/.test(name)).sort();
  const byId = new Map();
  for (const name of specFiles) {
    const id = name.slice(0, 5);
    if (byId.has(id)) report(1, SPEC_DIR + '/' + name, `duplicate id ${id} (also ${byId.get(id)})`);
    byId.set(id, name);
    const title = frontTitle(fs.readFileSync(path.join(specDir, name), 'utf8'));
    if (title !== name.replace(/\.md$/, '')) report(1, SPEC_DIR + '/' + name, `front-matter title ${JSON.stringify(title ?? null)} does not equal the basename`);
  }
  [...byId.keys()].forEach((id, index) => {
    const expected = 'DS' + String(index).padStart(3, '0');
    if (id !== expected) report(1, SPEC_DIR, `numbering gap: expected ${expected}, found ${id}`);
  });
  const matrixPath = path.join(specDir, 'matrix.md');
  const matrixFiles = fs.existsSync(matrixPath)
    ? [...fs.readFileSync(matrixPath, 'utf8').matchAll(/^\|\s*\[[^\]]*\]\(specsLoader\.html\?spec=(DS\d{3}-[a-z0-9-]+\.md)\)/gm)].map(match => match[1])
    : [];
  if (JSON.stringify(matrixFiles) !== JSON.stringify(specFiles)) report(2, SPEC_DIR + '/matrix.md', `rows [${matrixFiles.join(', ')}] differ from the files [${specFiles.join(', ')}]`);

  const aliasPath = path.join(specDir, 'aliases.json');
  const aliases = fs.existsSync(aliasPath) ? JSON.parse(fs.readFileSync(aliasPath, 'utf8')).ids ?? {} : {};
  const aliasDoc = fs.existsSync(aliasPath) ? JSON.parse(fs.readFileSync(aliasPath, 'utf8')) : {};
  const legacy = new Set(aliasDoc.legacyGenerated ?? []);
  const archivedNames = new Set(Object.values(aliases).filter(entry => entry.archived).map(entry => path.basename(entry.archived)));
  const self = path.relative(base, fileURLToPath(import.meta.url)).split(path.sep).join('/');

  const files = (base === root ? listFiles() : listFilesUnder(base)).filter(file => TEXT.test(file) && !SKIPPED.test(file) && !EXEMPT.has(file) && file !== self && !DATA.test(file));
  for (const file of files) {
    const full = path.join(base, file);
    if (!fs.existsSync(full) || fs.statSync(full).size > 16e6) continue;
    const text = fs.readFileSync(full, 'utf8');
    const frozen = FROZEN.test(file) || legacy.has(file);
    const lineOf = offset => text.slice(0, offset).split('\n').length;
    const archiveSpans = [...text.matchAll(ARCHIVE_PATH)].map(match => [match.index, match.index + match[0].length]);
    for (const match of text.matchAll(TOKEN)) {
      const id = 'DS' + match[1], where = file + ':' + lineOf(match.index);
      if (archiveSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
      if (frozen) {
        if (!aliases[id] && !byId.has(id)) report(5, where, `${id} is neither a current nor a former specification id`);
        continue;
      }
      if (!byId.has(id)) report(3, where, `${match[0]} does not name a current specification` + (aliases[id] ? ` (former id; see ${SPEC_DIR}/aliases.json)` : ''));
      else if (match[2] && byId.get(id) !== id + match[2]) report(3, where, `${match[0]} does not match the current file ${byId.get(id)}`);
    }
    if (frozen) continue;
    for (const match of text.matchAll(ARCHIVE_PATH)) {
      const cited = match[0].replace(/[.:;]+$/, '');
      if (/[*…{}$]/.test(cited)) continue;
      // The archive stays in the ChatSOP repository (MRP-LLM copies only the live core): a cited archive path must exist here or there.
      if (ARCHIVE_ROOT !== null && !fs.existsSync(path.join(base, cited)) && !(ARCHIVE_ROOT && fs.existsSync(path.join(ARCHIVE_ROOT, cited)))) report(4, file + ':' + lineOf(match.index), `${cited} does not exist`);
    }
    for (const match of text.matchAll(/docs\/specs\/([A-Za-z0-9-]+\.md)/g)) {
      if (archivedNames.has(match[1]) || !fs.existsSync(path.join(specDir, match[1]))) report(6, file + ':' + lineOf(match.index), `docs/specs/${match[1]} is not a current specification file`);
    }
  }
  return {specs: specFiles, filesChecked: files.length, violations};
}

function listFilesUnder(base) {
  const walk = dir => fs.readdirSync(path.join(base, dir), {withFileTypes: true}).flatMap(entry => {
    const rel = dir ? dir + '/' + entry.name : entry.name;
    if (SKIPPED.test(rel + '/')) return [];
    return entry.isDirectory() ? walk(rel) : [rel];
  });
  return walk('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    result = checkSpecRefs(root);
  } catch (error) {
    console.error('check-spec-refs could not run: ' + error.message);
    process.exit(2);
  }
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const v of result.violations) console.log(`[${v.rule}] ${v.where}: ${v.message}`);
    console.log(`${result.specs.length} specifications, ${result.filesChecked} files checked, ${result.violations.length} violation(s)`);
  }
  process.exit(result.violations.length ? 1 : 0);
}
