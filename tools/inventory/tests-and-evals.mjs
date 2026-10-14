#!/usr/bin/env node
/**
 * The inventory of tests and evaluations (owner request 2026-10-03): the registry eval/registry.json maps every test file, every
 * harness file under tools/eval and tools/capabilities, every eval/ data folder, every verify job and every package script to an
 * entry (one per test group by component, one per evaluation or harness). This tool validates the registry against the tree and
 * renders docs/tests-inventory.html; tests/project/tests-inventory.test.mjs runs `check` so nothing new goes unregistered.
 *
 *   node tools/inventory/tests-and-evals.mjs [write]          validate, then write docs/tests-inventory.html (exit 1 on a problem)
 *   node tools/inventory/tests-and-evals.mjs check            validate only (lists every problem)
 *   node tools/inventory/tests-and-evals.mjs measure [--only id,id]
 *        runs every test group of npm test (node --test on the entry's test files, one group at a time), writes the timings and
 *        pass/fail counts to eval/reports/current/inventory/test-groups.json and copies them into the entries' `runtime` and `latest`.
 *
 * No model is called. The registry is data maintained by hand; latest results are copied from the reports they name, never invented.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REGISTRY = 'eval/registry.json';
export const PAGE = 'docs/tests-inventory.html';
const MEASURE_OUT = 'eval/reports/current/inventory/test-groups.json';
// Folders the scan never enters: archives, run state, local caches, model files and dependencies. The gitignored local cache
// datasets_sources/ is entered only for the unpacked external experiments (their test files are registered as one local entry).
const SKIP_DIRS = new Set(['.git', 'node_modules', 'probably_obsolete', 'state', 'work', 'vendor', 'models', 'chat_data', 'outputs', '.venv', 'datasets_sources', '__pycache__', '.solvers']);
const LOCAL_TEST_ROOTS = ['datasets_sources/experiments_unpacked'];
const REQUIRED = ['id', 'title', 'kind', 'measures', 'components', 'paths', 'modelCalls', 'dataSource', 'command', 'runsIn', 'runtime', 'latest', 'status'];

const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');
const exists = (root, p) => fs.existsSync(path.join(root, p));

/** The registry as parsed JSON (throws with the file name on a JSON error). */
export function loadRegistry(root = ROOT) {
  const file = path.join(root, REGISTRY);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw Error(`${REGISTRY}: ${e.message}`); }
}

/**
 * sha256 of the registry: the page carries it, so a page older than its registry is detected. The measured runtime and result of a
 * test group (written by `measure`) are left out, so a measurement does not invalidate the page it is about to regenerate.
 */
export function registryDigest(root = ROOT) {
  const registry = loadRegistry(root);
  const stable = {...registry, entries: registry.entries.map(e => (e.latest?.path === MEASURE_OUT ? {...e, runtime: null, latest: null} : e))};
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function walk(root, dir, out, {skip = SKIP_DIRS} = {}) {
  let items;
  try { items = fs.readdirSync(path.join(root, dir), {withFileTypes: true}); } catch { return out; }
  for (const item of items) {
    const p = dir ? `${dir}/${item.name}` : item.name;
    if (item.isDirectory()) { if (!skip.has(item.name) && p !== 'eval/reports') walk(root, p, out, {skip}); } else if (item.isFile()) out.push(p);
  }
  return out;
}

/**
 * What must be registered: test files (every *.test.mjs outside the skipped folders, plus the other .mjs files of tests/ and its
 * component subfolders except tests/fixtures/, of Ploinky/test/ and of the Ploinky bench Ploinky/bench/), harness files (every file under tools/eval and tools/capabilities), eval/ data folders (each folder of eval/
 * except reports, each suite of eval/suites, and the files at eval/'s top level), the jobs of tools/verify.mjs and the scripts of
 * package.json.
 */
export function scanTree(root = ROOT) {
  const all = walk(root, '', []);
  const local = LOCAL_TEST_ROOTS.filter(d => exists(root, d)).flatMap(d => walk(root, d, [], {skip: new Set(['node_modules', '.git'])}));
  const testFiles = [...new Set([
    ...all.filter(f => f.endsWith('.test.mjs')),
    ...local.filter(f => f.endsWith('.test.mjs')),
    ...all.filter(f => /^tests\/(?!fixtures\/).+\.mjs$/.test(f) || /^Ploinky\/(test|bench)\/.+\.mjs$/.test(f))
  ])].sort();
  const harnessFiles = all.filter(f => f.startsWith('tools/eval/') || f.startsWith('tools/capabilities/')).sort();
  const evalDir = path.join(root, 'eval');
  const dataFolders = [];
  for (const item of fs.readdirSync(evalDir, {withFileTypes: true})) {
    if (item.name === 'reports') continue;
    if (item.isFile()) dataFolders.push(`eval/${item.name}`);
    else if (item.name === 'suites') for (const s of fs.readdirSync(path.join(evalDir, 'suites'), {withFileTypes: true})) { if (s.isDirectory()) dataFolders.push(`eval/suites/${s.name}/`); }
    else if (item.isDirectory()) dataFolders.push(`eval/${item.name}/`);
  }
  const verify = fs.readFileSync(path.join(root, 'tools/verify.mjs'), 'utf8');
  const verifyJobs = [...verify.matchAll(/\['([\w-]+)',\s*process\.execPath/g)].map(m => m[1]);
  const scripts = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {});
  return {testFiles, harnessFiles, dataFolders: dataFolders.sort(), verifyJobs, scripts, localTestFiles: local.filter(f => f.endsWith('.test.mjs')).length};
}

/** True when the registry path `entryPath` maps the scanned item `item` (same path, a folder that contains it, or a path inside a scanned folder). */
export function covers(entryPath, item) {
  if (entryPath === item) return true;
  if (entryPath.endsWith('/') && item.startsWith(entryPath)) return true;
  if (item.endsWith('/') && entryPath.startsWith(item)) return true;
  return false;
}

/** Every problem of the registry on its own (schema, vocabulary, references) and against the tree (missing paths, unmapped items). */
export function check(root = ROOT) {
  const registry = loadRegistry(root), scan = scanTree(root), problems = [];
  const v = registry.vocabulary ?? {};
  const kinds = Object.keys(v.kinds ?? {}), components = Object.keys(v.components ?? {});
  const entries = registry.entries ?? [], ids = new Set(), localRoots = registry.localRoots ?? [];
  for (const e of entries) {
    const at = `entry ${e.id ?? '(no id)'}`;
    for (const k of REQUIRED) if (e[k] === undefined || e[k] === null || e[k] === '') problems.push(`${at}: missing field ${k}`);
    if (ids.has(e.id)) problems.push(`${at}: duplicate id`);
    ids.add(e.id);
    if (e.kind && !kinds.includes(e.kind)) problems.push(`${at}: unknown kind ${e.kind}`);
    for (const c of e.components ?? []) if (!components.includes(c)) problems.push(`${at}: unknown component ${c}`);
    if (e.modelCalls && !(v.modelCalls ?? []).includes(e.modelCalls.level)) problems.push(`${at}: unknown model-call level ${e.modelCalls.level}`);
    for (const d of e.dataSource ?? []) if (!(v.dataSources ?? []).includes(d)) problems.push(`${at}: unknown data source ${d}`);
    for (const r of e.runsIn ?? []) if (!(v.runsIn ?? []).includes(r)) problems.push(`${at}: unknown runsIn ${r}`);
    if (e.status && !(v.status ?? []).includes(e.status)) problems.push(`${at}: unknown status ${e.status}`);
    if (e.status === 'superseded' && !e.supersededBy) problems.push(`${at}: superseded without supersededBy`);
    if (e.status === 'duplicate' && !e.duplicateOf) problems.push(`${at}: duplicate without duplicateOf`);
    if (e.latest && typeof e.latest.result !== 'string') problems.push(`${at}: latest.result must be text ("no recorded run" when there is none)`);
    if (e.latest && e.latest.result !== 'no recorded run' && e.latest.result !== 'not run' && !e.latest.date) problems.push(`${at}: latest result without a date`);
    for (const p of e.paths ?? []) {
      // the page itself is checked by its own test (it is written after a successful check)
      const isLocal = e.local || localRoots.some(r => p.startsWith(r)) || p === PAGE;
      if (!isLocal && !exists(root, p)) problems.push(`${at}: path ${p} does not exist`);
    }
  }
  for (const e of entries) {
    for (const ref of [e.supersededBy, e.duplicateOf].filter(Boolean)) if (!ids.has(ref)) problems.push(`entry ${e.id}: refers to unknown entry ${ref}`);
  }
  const headlines = entries.filter(e => e.headline).map(e => e.headline.id);
  for (const h of registry.headlineOrder ?? []) if (headlines.filter(x => x === h).length !== 1) problems.push(`headline ${h}: needs exactly one entry`);
  const allPaths = entries.flatMap(e => e.paths ?? []);
  const unmapped = (label, items) => { for (const item of items) if (!allPaths.some(p => covers(p, item))) problems.push(`${label} ${item} is not mapped to a registry entry`); };
  unmapped('test file', scan.testFiles);
  unmapped('harness file', scan.harnessFiles);
  unmapped('eval data', scan.dataFolders);
  const jobs = new Set(entries.flatMap(e => e.verifyJobs ?? []));
  for (const j of scan.verifyJobs) if (!jobs.has(j)) problems.push(`verify job ${j} is not mapped to a registry entry`);
  for (const j of jobs) if (!scan.verifyJobs.includes(j)) problems.push(`verify job ${j} named by the registry is not a job of tools/verify.mjs`);
  const scripts = new Set([...entries.flatMap(e => e.scripts ?? []), ...Object.keys(registry.ignoredScripts ?? {})]);
  for (const s of scan.scripts) if (!scripts.has(s)) problems.push(`package script ${s} is not mapped to a registry entry`);
  return {registry, scan, problems};
}

/** The test files of an entry that npm test runs (every *.test.mjs of tests/ and its component subfolders; Ploinky's run through tests/pworker/pworker.test.mjs). */
const testFilesOf = e => (e.paths ?? []).filter(p => /^tests\/.+\.test\.mjs$/.test(p));

/** Counts per test file of the registry entry: every scanned test file that one of its paths covers. */
function filesOf(e, scan) {
  return scan.testFiles.filter(f => f.endsWith('.test.mjs') && (e.paths ?? []).some(p => covers(p, f))).length;
}

/** Runs each test group with node --test and records its time and counts; returns the measurements by entry id. */
export function measure(root = ROOT, {only = null} = {}) {
  const registry = loadRegistry(root), out = {};
  for (const e of registry.entries) {
    const files = testFilesOf(e);
    if (!files.length || (only && !only.includes(e.id))) continue;
    const start = performance.now();
    const run = spawnSync(process.execPath, ['--test', '--test-timeout=120000', ...files], {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900000});
    const log = (run.stdout ?? '') + (run.stderr ?? '');
    const num = key => Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? NaN);
    out[e.id] = {files: files.length, seconds: Number(((performance.now() - start) / 1000).toFixed(1)), tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped'), exit: run.status};
    console.log(`${e.id}: ${JSON.stringify(out[e.id])}`);
  }
  return out;
}

/** Copies measurements into the registry entries (runtime and latest) and writes both files. */
function applyMeasurements(root, results) {
  const file = path.join(root, MEASURE_OUT), at = new Date().toISOString();
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).groups ?? {} : {};
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify({at, groups: {...previous, ...results}}, null, 1) + '\n');
  const text = fs.readFileSync(path.join(root, REGISTRY), 'utf8'), registry = JSON.parse(text);
  for (const e of registry.entries) {
    const r = results[e.id];
    if (!r) continue;
    e.runtime = `${r.seconds} s for ${r.files} file${r.files === 1 ? '' : 's'} (measured, one group at a time)`;
    const failures = r.fail ? `, ${r.fail} fail` : '', skipped = r.skipped ? `, ${r.skipped} skipped` : '';
    e.latest = {result: `${r.tests} tests: ${r.pass} pass${failures}${skipped}`, date: at.slice(0, 10), path: MEASURE_OUT};
  }
  fs.writeFileSync(path.join(root, REGISTRY), JSON.stringify(registry, null, 1) + '\n');
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const code = s => `<code>${esc(s)}</code>`;
const list = items => items.map(code).join(', ');

/** docs/tests-inventory.html from the registry and the scan. */
export function renderPage(registry, scan, {digest}) {
  const entries = registry.entries, v = registry.vocabulary, comps = Object.keys(v.components), kinds = Object.keys(v.kinds);
  const testCount = e => filesOf(e, scan);
  const byComp = c => entries.filter(e => e.components.includes(c));
  const evalKinds = ['live-eval', 'benchmark', 'capability-battery', 'offline-regression'], testKinds = ['unit', 'integration', 'offline-regression'];
  const compRows = comps.map(c => {
    const es = byComp(c);
    const cells = kinds.map(k => es.filter(e => e.kind === k).length || '');
    return `<tr><th scope="row">${esc(v.components[c])}</th>${cells.map(n => `<td class="num">${n}</td>`).join('')}<td class="num">${es.reduce((s, e) => s + testCount(e), 0) || ''}</td></tr>`;
  }).join('');
  const kindRows = kinds.map(k => {
    const es = entries.filter(e => e.kind === k);
    const by = r => es.filter(e => e.runsIn.includes(r)).length;
    const calls = l => es.filter(e => e.modelCalls.level === l).length;
    return `<tr><th scope="row">${esc(k)}</th><td>${esc(v.kinds[k])}</td><td class="num">${es.length}</td><td class="num">${es.reduce((s, e) => s + testCount(e), 0) || ''}</td><td class="num">${by('npm test')}</td><td class="num">${by('verify')}</td><td class="num">${by('manual')}</td><td class="num">${calls('none')}</td><td class="num">${es.length - calls('none')}</td></tr>`;
  }).join('');
  const headlines = (registry.headlineOrder ?? []).map(h => entries.find(e => e.headline?.id === h)).map(e => `<tr><th scope="row">${esc(e.headline.label)}</th><td>${esc(e.headline.value)}</td><td>${esc(e.headline.date)}</td><td>${esc(e.headline.source)}</td><td><a href="#${esc(e.id)}">${esc(e.id)}</a></td></tr>`).join('');
  const calls = m => m.level === 'none' ? 'none' : `${esc(m.level)}${m.typical ? `: ${esc(m.typical)}` : ''}${m.cost ? ` (${esc(m.cost)})` : ''}`;
  const statusText = e => e.status === 'superseded' ? `superseded by <a href="#${esc(e.supersededBy)}">${esc(e.supersededBy)}</a>` : e.status === 'duplicate' ? `duplicate of <a href="#${esc(e.duplicateOf)}">${esc(e.duplicateOf)}</a>` : esc(e.status);
  const card = e => `<section class="entry" id="${esc(e.id)}"><h4>${esc(e.title)} <span class="tag">${esc(e.kind)}</span> <span class="tag s-${esc(e.status)}">${statusText(e)}</span></h4>
<p>${esc(e.measures)}</p>
<dl><dt>id</dt><dd>${code(e.id)}</dd><dt>components</dt><dd>${e.components.map(c => esc(v.components[c].split(' (')[0])).join('; ')}</dd><dt>paths</dt><dd>${list(e.paths)}${testCount(e) ? ` (${testCount(e)} test file${testCount(e) === 1 ? '' : 's'})` : ''}</dd><dt>model calls</dt><dd>${calls(e.modelCalls)}</dd><dt>data</dt><dd>${esc(e.dataSource.join(', '))}</dd><dt>run</dt><dd>${code(e.command)}</dd><dt>runs in</dt><dd>${esc(e.runsIn.join(', '))}${e.verifyJobs ? ` (verify jobs ${list(e.verifyJobs)})` : ''}${e.scripts ? ` (scripts ${list(e.scripts)})` : ''}</dd><dt>runtime</dt><dd>${esc(e.runtime)}</dd><dt>latest</dt><dd>${esc(e.latest.result)}${e.latest.date ? ` <span class="muted">(${esc(e.latest.date)}${e.latest.path ? `, ${code(e.latest.path)}` : ''})</span>` : ''}</dd>${e.notes ? `<dt>notes</dt><dd>${esc(e.notes)}</dd>` : ''}</dl></section>`;
  const sections = comps.map(c => {
    const es = entries.filter(e => e.components[0] === c);
    return es.length ? `<h3 id="c-${esc(c)}">${esc(v.components[c])}</h3>${es.map(card).join('\n')}` : '';
  }).join('\n');
  const flagged = s => entries.filter(e => e.status === s);
  const flaggedList = s => flagged(s).length ? `<ul>${flagged(s).map(e => `<li><a href="#${esc(e.id)}">${esc(e.title)}</a>: ${statusText(e)}${e.notes ? `. ${esc(e.notes)}` : ''}</li>`).join('')}</ul>` : '<p>None.</p>';
  const gaps = comps.filter(c => c !== 'project' && c !== 'eval-tooling').map(c => {
    const es = byComp(c);
    const tests = es.some(e => testKinds.includes(e.kind) && e.status === 'active');
    const evals = es.some(e => evalKinds.includes(e.kind) && e.status === 'active');
    return !tests || !evals ? `<li>${esc(v.components[c])}: ${!tests ? 'no active test group' : ''}${!tests && !evals ? ' and ' : ''}${!evals ? 'no active evaluation, benchmark or regression' : ''}</li>` : '';
  }).join('');
  const archived = (registry.archived ?? []).map(a => `<li>${code(a.path)} → ${code(a.to)} (${esc(a.date)}): ${esc(a.why)}</li>`).join('');
  const recs = (registry.recommendations ?? []).map(r => `<li><b>${esc(r.id)} ${esc(r.title)}.</b> ${esc(r.detail)} <span class="muted">${esc(r.decision)}</span></li>`).join('');
  const totalTests = scan.testFiles.filter(f => f.endsWith('.test.mjs')).length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="registry-digest" content="${digest}"><title>Tests and evaluations</title><link rel="stylesheet" href="styles.css">
<style>
.num{text-align:right}
.entry{border-top:1px solid rgba(127,127,127,.35);padding:.4rem 0}
.entry h4{margin:.4rem 0}
.entry dl{display:grid;grid-template-columns:max-content 1fr;gap:.15rem .8rem;margin:.3rem 0}
.entry dt{font-weight:600}
.entry dd{margin:0;overflow-wrap:anywhere}
.tag{font-size:.75em;font-weight:500;border:1px solid currentColor;border-radius:.6em;padding:0 .45em;opacity:.8}
.muted{opacity:.7}
</style></head><body>
<div data-include="partials/header.html"></div><main class="page"><article class="page__panel"><p class="breadcrumb"><a href="index.html">Overview</a> / Tests and evaluations</p><h1>Tests and evaluations: the inventory</h1>
<p>Every test file, evaluation harness and evaluation data folder of ChatSOP is mapped to one entry of the registry <code>eval/registry.json</code>: what it measures, which component it covers, whether it calls a model, where its data come from, how to run it, where it runs, how long it takes, its latest recorded result with date and report, and whether it is still active. This page is generated by <code>node tools/inventory/tests-and-evals.mjs</code> from the registry; <code>tests/project/tests-inventory.test.mjs</code> (part of <code>npm test</code>) fails when a test file, a harness file under <code>tools/eval</code> or <code>tools/capabilities</code>, an <code>eval/</code> data folder, a verify job or a package script is not registered, or when an entry names a path that does not exist. A latest result is copied from the report it names; an entry without one says "no recorded run". Paths under <code>state/</code>, <code>datasets_sources/</code> and <code>eval/reports/current/</code> are local and regenerable. This page reports observations; it never asserts progress.</p>
<p>Scanned now: ${totalTests} test files (${scan.localTestFiles} of them in the local cache of external experiments), ${scan.harnessFiles.length} harness files, ${scan.dataFolders.length} evaluation data folders and files, ${scan.verifyJobs.length} verify jobs; ${entries.length} registry entries.</p>
<section id="layout"><h2>Where tests and evaluations live</h2><div class="table-wrap"><table><thead><tr><th scope="col">Folder</th><th scope="col">What</th></tr></thead><tbody>
<tr><th scope="row"><code>tests/&lt;component&gt;/</code></th><td>Unit and integration tests and offline regressions, one folder per component (<code>sop</code>, <code>reasoning</code>, <code>engines</code>, <code>memory</code>, <code>linker</code>, <code>formalizer</code>, <code>routed</code>, <code>adapter</code>, <code>conversation</code>, <code>ingestion</code>, <code>analysis</code>, <code>pworker</code>, <code>server</code>, <code>docs</code>, <code>project</code>, <code>eval-tooling</code>); <code>npm test</code> runs <code>tests/**/*.test.mjs</code>. Shared helpers <code>tests/helpers.mjs</code>, <code>tests/product-helpers.mjs</code>; fixtures <code>tests/fixtures/</code>.</td></tr>
<tr><th scope="row"><code>tools/eval/&lt;component&gt;/</code></th><td>Evaluation harnesses by component: <code>books</code>, <code>formalization</code> (with <code>regression</code>), <code>routed</code>, <code>kbqa</code>, <code>ingestion</code>, <code>linking</code>, <code>conversation</code>, <code>chat</code>, <code>analysis</code>, <code>engines</code>, <code>review</code>, <code>symbolic-vs-llm</code>, <code>pworker</code>.</td></tr>
<tr><th scope="row"><code>tools/eval/lib/</code></th><td>The shared harness library: the chat turn through ChatSOPAdapter, sessions, tier settings, the graded-severity scale and metrics.</td></tr>
<tr><th scope="row"><code>tools/capabilities/</code></th><td>The capability battery and its no-loss gate.</td></tr>
<tr><th scope="row"><code>eval/</code></th><td>Data and suites only: sealed suites (<code>eval/suites/**</code>), development sets, the battery's cases and ledger, this registry; reports in <code>eval/reports/{current,history}</code>.</td></tr>
<tr><th scope="row"><code>state/</code></th><td>Run outputs of jobs and live evaluations (local).</td></tr>
</tbody></table></div><p>The full description is in <code>eval/README.md</code>.</p></section>
<section id="getting-better"><h2>What tells us the system is getting better</h2><p>The few measures to watch, each with its latest value and date. Book problems and their recordings stay local (DS011), so their reports live under <code>state/</code> or <code>eval/reports/current/</code>.</p><div class="table-wrap"><table><thead><tr><th scope="col">Measure</th><th scope="col">Latest value</th><th scope="col">Date</th><th scope="col">Source</th><th scope="col">Entry</th></tr></thead><tbody>${headlines}</tbody></table></div></section>
<section id="by-component"><h2>By component</h2><p>Entries per component and kind (an entry counts under every component it covers), and the test files of those entries.</p><div class="table-wrap"><table><thead><tr><th scope="col">Component</th>${kinds.map(k => `<th scope="col">${esc(k)}</th>`).join('')}<th scope="col">test files</th></tr></thead><tbody>${compRows}</tbody></table></div></section>
<section id="by-kind"><h2>By kind</h2><div class="table-wrap"><table><thead><tr><th scope="col">Kind</th><th scope="col">Meaning</th><th scope="col">entries</th><th scope="col">test files</th><th scope="col">npm test</th><th scope="col">verify</th><th scope="col">manual</th><th scope="col">no model</th><th scope="col">model calls</th></tr></thead><tbody>${kindRows}</tbody></table></div></section>
<section id="flagged"><h2>Superseded, obsolete and duplicate entries</h2><h3>Superseded</h3>${flaggedList('superseded')}<h3>Obsolete (refers to archived components)</h3>${flaggedList('obsolete')}<h3>Duplicate</h3>${flaggedList('duplicate')}</section>
<section id="archived"><h2>Archived by this inventory</h2>${archived ? `<ul>${archived}</ul><p>Recorded in <code>CHANGES.md</code>; the archive is history only (<code>probably_obsolete/README.md</code>).</p>` : '<p>Nothing.</p>'}</section>
<section id="recommendations"><h2>Recommendations</h2><p>None of them changes what the system does, so none is an owner question; each records the decision taken.</p><ul>${recs}</ul></section>
<section id="gaps"><h2>Gaps by component</h2>${gaps ? `<ul>${gaps}</ul>` : '<p>Every component has an active test group and an active evaluation, benchmark or regression.</p>'}<p>Finer gaps are listed in recommendation R8.</p></section>
<section id="entries"><h2>All entries</h2><p>Grouped by the first component of each entry.</p>${sections}</section>
</article></main><div data-include="partials/footer.html"></div><script type="module" src="partials-loader.mjs"></script></body></html>
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd = 'write', ...rest] = process.argv.slice(2);
  if (cmd === 'measure') {
    const i = rest.indexOf('--only');
    applyMeasurements(ROOT, measure(ROOT, {only: i >= 0 ? rest[i + 1].split(',') : null}));
  } else if (cmd !== 'check' && cmd !== 'write') {
    console.error('usage: tests-and-evals.mjs [write|check|measure [--only id,id]]');
    process.exit(2);
  }
  const {registry, scan, problems} = check(ROOT);
  if (problems.length) {
    console.error(problems.map(p => '- ' + p).join('\n'));
    console.error(`${problems.length} problem(s) in ${REGISTRY}`);
    process.exit(1);
  }
  if (cmd !== 'check') {
    fs.writeFileSync(path.join(ROOT, PAGE), renderPage(registry, scan, {digest: registryDigest(ROOT)}));
    console.log(`wrote ${PAGE}: ${registry.entries.length} entries, ${scan.testFiles.length} test files, ${scan.harnessFiles.length} harness files, ${scan.dataFolders.length} eval data items`);
  } else console.log(`${REGISTRY}: ${registry.entries.length} entries, no problem`);
}
