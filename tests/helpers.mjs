// Shared test fixtures. Every bundled resource is resolved relative to this
// module, never relative to the working directory.
import {demoLexicon, ensureSeedMemories} from '../lib/knowledge-seeds.mjs';
import {ChatData} from '../lib/chat-data/index.mjs';
import {BaseMemories} from '../lib/chat-data/memories.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Repository} from '../memory/repository.mjs';
import {Runtime} from '../sop/runtime.mjs';
import {Lexicon} from '../sop/lexicon.mjs';
import {publishKnowledge} from '../sop/ingest.mjs';
import {jsonlExists, shardPaths} from '../lib/jsonl-shards.mjs';

/** Repository-root URL and path for a project-relative resource. */
export const repoUrl = (relative = '') => new URL(`../${relative}`, import.meta.url);
export const repoPath = (relative = '') => fileURLToPath(repoUrl(relative));

/** A short digest of project files and directories (by relative path) and an extra text: the key of a cached test fixture. */
export function inputsHash(inputs, extra = '') {
  const hash = createHash('sha256');
  const walk = rel => {
    const abs = repoPath(rel);
    const stat = fs.statSync(abs, {throwIfNoEntry: false});
    if (!stat) return;
    if (stat.isDirectory()) { for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name)); return; }
    hash.update(rel + '\0'); hash.update(fs.readFileSync(abs));
  };
  for (const rel of inputs) walk(rel);
  hash.update('\0' + extra);
  return hash.digest('hex').slice(0, 16);
}

/**
 * A directory built once per content of its inputs and cached under the system temp directory (`chatsop-<name>-<hash>`): the
 * expensive setup of a test (seed memories, a base memory) is paid when the code or data that shape it change, not on every run.
 * `build(dir)` fills a fresh directory; the caller copies the result into its own temporary root before changing anything.
 * SEED_INPUTS: what shapes the seed memories of a chat data root (the seeds, the runtime configuration, the memory and chat-data code).
 */
export const SEED_INPUTS = Object.freeze(['config/knowledge', 'config/runtime.json', 'memory', 'lib/chat-data', 'lib/knowledge-seeds.mjs', 'sop']);
export function cachedDir(name, inputs, build, extra = '') {
  const final = path.join(os.tmpdir(), `chatsop-${name}-${inputsHash(inputs, extra)}`);
  // Test files run in parallel processes: the first one builds under a lock directory, the others wait for its result instead of
  // building the same fixture at the same time (a lock older than ten minutes is taken over).
  const lock = final + '.lock';
  const nap = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  while (!fs.existsSync(final)) {
    try { fs.mkdirSync(lock); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const age = Date.now() - (fs.statSync(lock, {throwIfNoEntry: false})?.mtimeMs ?? Date.now());
      if (age > 600_000) fs.rmSync(lock, {recursive: true, force: true}); else nap(250);
      continue;
    }
    try {
      if (fs.existsSync(final)) break;
      const building = fs.mkdtempSync(final + '-building-');
      try { build(building); } catch (e) { fs.rmSync(building, {recursive: true, force: true}); throw e; }
      fs.renameSync(building, final);
    } finally { fs.rmSync(lock, {recursive: true, force: true}); }
  }
  return final;
}

/**
 * A chat data root (`<dir>/chat_data`) holding every seed memory, built with `strategy` (the runtime's memory engine by default):
 * built once per content of SEED_INPUTS and shared by the tests that need the seeds (copy it before changing anything).
 */
export function seedMemoriesRoot({strategy = null} = {}) {
  const runtime = JSON.parse(fs.readFileSync(repoPath('config/runtime.json'), 'utf8'));
  const chosen = strategy ?? runtime.memory?.engine ?? 'sqlite';
  return cachedDir('seed-memories', SEED_INPUTS, dir => {
    const chatData = ChatData.open({chatData: {root: path.join(dir, 'chat_data')}}, {});
    ensureSeedMemories(new BaseMemories({chatData, memory: runtime.memory}), {strategy: chosen});
  }, chosen);
}

export const lex = demoLexicon();
export const schema = lex.predicates;
export const fixture = fs.readFileSync(new URL('./fixtures/bootstrap.sop', import.meta.url), 'utf8');
export const day = s => Date.parse(s);

export function context({bootstrap = true, memory = {}, now = day('2026-09-26T12:00:00Z')} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sop-test-'));
  const repo = new Repository(root, {memory});
  if (bootstrap) publishKnowledge(repo, 'base', fixture, {schema, reviewed: true, knownAt: day('2024-01-01')});
  else repo.init('base');
  const session = repo.session('base', 'alice', 's1');
  return {
    root, repo, session,
    run: (s, options = {}) => new Runtime({repo, session, schema, now, ...options}).run(s),
    dispose: () => fs.rmSync(root, {recursive: true, force: true}),
  };
}

export const queryProgram = (atom, options = '') => `@q query\n  where ${atom}\n${options}\n@m recall\n  query $q\n@r reason\n  query $q\n  memory $m`;

/** A temporary directory removed when the test (or suite) finishes. */
export function tempDir(t, prefix = 'chatsop-test-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

// ---------------------------------------------------------------------------
// Data files

export const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Parse a newline-terminated JSONL file (path or URL); errors name the line. */
/** Raw text of a JSONL file, or of its shards concatenated in order (lib/jsonl-shards.mjs). */
export function readJsonlText(file) {
  const location = file instanceof URL ? fileURLToPath(file) : file;
  const parts = location.endsWith('.jsonl') ? shardPaths(location) : [];
  return parts.length > 1 || (parts.length === 1 && parts[0] !== location) ? parts.map(part => fs.readFileSync(part, 'utf8')).join('') : fs.readFileSync(file, 'utf8');
}

export function readJsonl(file) {
  const text = readJsonlText(file);
  if (!text.trim()) return [];
  return text.trimEnd().split('\n').map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw Error(`${file}:${index + 1}: ${error.message}`); }
  });
}

export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * Returns a skip reason naming the first missing project-relative file, or
 * false when every file exists. Untracked corpora and raw source caches may be
 * absent on a clean checkout; tests that need them skip instead of crashing.
 */
export function missingFiles(label, ...relatives) {
  const absent = relatives.find(relative => relative.endsWith('.jsonl') ? !jsonlExists(repoPath(relative)) : !fs.existsSync(repoUrl(relative)));
  return absent ? `${label} not available: ${absent} is missing` : false;
}

/** Count occurrences of key(row), with keys sorted for stable comparisons. */
export function tally(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = key(row);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Deterministic stratified sample used to re-execute a bounded subset of a
 * corpus. Order of precedence:
 *   1. one hash-ranked representative for every value of every dimension
 *      (always included, even when that alone exceeds `size`);
 *   2. round-robin over the full strata (all dimensions joined), taking the
 *      hash-ranked first member of every stratum, then the second, and so on;
 * so every dimension value is always represented and every stratum is
 * represented whenever there are no more strata than `size`.
 */
export function stratifiedSample(rows, dimensions, size = 400) {
  const rank = row => sha256(String(row.id));
  const ordered = rows.map(row => ({row, rank: rank(row)})).sort((a, b) => a.rank.localeCompare(b.rank)).map(item => item.row);
  const chosen = new Map();
  const add = row => chosen.set(row.id, row);
  for (const dimension of dimensions) {
    const seen = new Set();
    for (const row of ordered) {
      const value = dimension(row);
      if (!seen.has(value)) { seen.add(value); add(row); }
    }
  }
  const strata = Map.groupBy(ordered, row => JSON.stringify(dimensions.map(dimension => dimension(row))));
  const queues = [...strata.keys()].sort((a, b) => sha256(a).localeCompare(sha256(b))).map(key => strata.get(key));
  for (let depth = 0; chosen.size < Math.min(size, rows.length); depth++) {
    for (const queue of queues) {
      if (queue[depth]) add(queue[depth]);
      if (chosen.size >= size) break;
    }
  }
  return [...chosen.values()];
}

/** Every value of every dimension present in the corpus appears in the sample. */
export function coversDimensions(sample, rows, dimensions) {
  return dimensions.every(dimension => {
    const wanted = new Set(rows.map(dimension));
    const got = new Set(sample.map(dimension));
    return wanted.size === got.size && [...wanted].every(value => got.has(value));
  });
}

// ---------------------------------------------------------------------------
// External solvers
//
// Resolution order: Z3_BIN / SWIPL_BIN (when set, exclusively), then the
// private bundle under tools/.solvers/, then PATH. The resolved command is exported back into the
// same environment variables so that production code (reasoning/registry.mjs
// and the solver adapters read only these variables, falling back to PATH)
// uses exactly the binary the tests probed. CHATSOP_REQUIRE_SOLVERS=1 turns a
// missing solver into a failure instead of a skip.

const SOLVERS = {
  z3: {env: 'Z3_BIN', bundled: 'tools/.solvers/z3/bin/z3', command: 'z3', args: ['-version']},
  prolog: {env: 'SWIPL_BIN', bundled: 'tools/.solvers/swi/swipl', command: 'swipl', args: ['--version']},
};
const runs = (command, args) => {
  const result = spawnSync(command, args, {encoding: 'utf8', timeout: 5000, maxBuffer: 65536});
  return !result.error && result.status === 0;
};
const resolved = new Map();

/** Absolute or PATH command for a solver ('z3' or 'prolog'), or null. */
export function resolveSolver(name) {
  const spec = SOLVERS[name];
  if (!spec) throw Error(`Unknown solver ${name}`);
  if (!resolved.has(name)) {
    // An explicitly configured binary is never substituted by another one.
    const candidates = process.env[spec.env] ? [process.env[spec.env]] : [repoPath(spec.bundled), spec.command];
    resolved.set(name, candidates.find(command => runs(command, spec.args)) ?? null);
  }
  return resolved.get(name);
}

export const solversRequired = () => process.env.CHATSOP_REQUIRE_SOLVERS === '1';

/**
 * Skip reason for a test needing a real solver, or false when it is available.
 * With CHATSOP_REQUIRE_SOLVERS=1 a missing solver throws instead.
 */
export function solverSkip(name) {
  if (resolveSolver(name)) return false;
  const spec = SOLVERS[name];
  const searched = process.env[spec.env] ? `${spec.env}=${process.env[spec.env]}` : `${spec.env} unset, ${spec.bundled}, PATH`;
  const reason = `${name} solver not runnable (${searched})`;
  if (solversRequired()) throw Error(`CHATSOP_REQUIRE_SOLVERS=1: ${reason}`);
  return reason;
}

for (const [name, spec] of Object.entries(SOLVERS)) {
  const command = resolveSolver(name);
  if (command) process.env[spec.env] = command;
}

/** Run fn with an environment variable temporarily replaced, then restore it. */
export async function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

// ---------------------------------------------------------------------------
// HTTP

/** A TCP port that was bound and released, so nothing is listening on it. */
export async function closedPort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const {port} = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

/** Listen on an ephemeral local port; the server is force-closed after the test. */
export async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => close(server));
  return `http://127.0.0.1:${server.address().port}`;
}

/** Close a server without waiting for idle keep-alive connections. */
export function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** JSON-over-HTTP client that keeps the raw text for HTML responses. */
export function httpClient(base) {
  return async (route, {method = 'GET', body, cookie, bearer} = {}) => {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    const response = await fetch(base + route, {method, headers, body: body ? JSON.stringify(body) : undefined});
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* HTML or empty body */ }
    return {status: response.status, headers: response.headers, body: parsed, text};
  };
}

export const cookieOf = response => (response.headers.get('set-cookie') ?? '').split(';')[0];

/**
 * A full ChatSOP server with the administrator auth store, the corpus audit
 * and no model registry (so the chat answers 503 model_unavailable and the readiness check reports not ready). The audit ledger always lives in
 * the test's temporary directory, never in eval/reports/current/audit.
 */
export const STUB_QUERY = '@q query\n  where match\n    relation "likes"\n    role subject "Ana"\n    role object "Alpha Lab"\n    polarity affirmed\n  end';
const STUB_BAD = '@x stated\n  relation "likes"\n  role subject "Nobody"\n  role object "Alpha Lab"\n  polarity affirmed\n  certainty asserted';

/**
 * A request parser stub (the interface of server/query-parser.mjs): it answers every message with the same question, "Does Ana like Alpha Lab?"
 * (a message that contains BADSOP gets a `stated` wire the admission refuses). `calls` records the messages.
 */
export function stubQueryParser({sop = STUB_QUERY, available = true, calls = []} = {}) {
  return {
    calls,
    settings: {models: ['stub/model'], backend: {kind: 'stub'}},
    availability: async () => (available ? {available: true, models: ['stub/model'], skipped: []} : {available: false, reason: 'the stub coding agent is switched off', models: [], skipped: []}),
    parse: async ({message}) => {
      calls.push(message);
      if (!available) throw Object.assign(new Error('the stub coding agent is switched off'), {code: 'parse_unavailable', status: 503, parse: {parser: 'coding_agent', model: null, failed: 'switched off'}});
      return {sop: message.includes('BADSOP') ? STUB_BAD : sop, parse: {parser: 'coding_agent', model: 'stub/model', backend: 'stub', rounds: 1, cost_usd: 0, ms: 1, cache: 'miss', tried: []}};
    },
    stats: () => ({requests: calls.length, cache_hits: 0, cache_size: 0, running: 0}),
    clearCache: () => {},
  };
}


export async function adminServer(t, {apiKey = null, password = null} = {}) {
  const [{createServer}, {Auth}] = await Promise.all([import('../server/http.mjs'), import('../server/auth.mjs')]);
  const root = tempDir(t, 'chatsop-admin-');
  const repo = new Repository(path.join(root, 'state'));
  repo.init('demo');
  const auth = new Auth({file: path.join(root, 'state/auth.json'), apiKey});
  const ledger = path.join(root, 'ledger');
  const server = await withEnv('CHATSOP_AUDIT_LEDGER', ledger, () => createServer({config: {}, repo, lexicon: lex, auth, queryParser: stubQueryParser({available: false})}));
  const base = await listen(t, server);
  const call = httpClient(base);
  let session = null;
  if (password) {
    const response = await call('/admin/setup', {method: 'POST', body: {password}});
    if (response.status !== 200) throw Error(`first-run password rejected: ${response.status} ${response.text}`);
    session = cookieOf(response);
  }
  const chat = (credentials = {}) => call('/v1/chat/completions', {method: 'POST', ...credentials, body: {model: 'chatsop-local', messages: [{role: 'user', content: 'Does Ana like Alpha Lab?'}]}});
  return {base, call, chat, auth, root, ledger, session};
}

/** Asserts that `text` is one of the conversation layer's variants of `situation` ({{slots}} match any text). */
export async function assertReply(text, situation) {
  const {variants} = await import('../sop/replies.mjs');
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const options = variants(situation).map(v => new RegExp('^' + v.text.split(/\{\{[a-z_]+\}\}/).map(escape).join('[\\s\\S]+') + '$'));
  if (!options.length) throw new Error(`no reply for ${situation}`);
  if (!options.some(re => re.test(text))) throw new Error(`${JSON.stringify(text)} is not a reply of ${situation}: ${variants(situation).map(v => JSON.stringify(v.text)).join(' | ')}`);
}
