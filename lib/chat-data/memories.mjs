/**
 * Base memories (DS022 "Base memories"): named, forkable knowledge stores kept under `chat_data/base_memories/<id>/`.
 *
 *   manifest.json      id, name, parent, strategy, created_at, description, counters
 *   repo/              a memory repository (memory/repository.mjs) of one memory strategy (DS016-DS021), one base named `main`
 *   circuits/NNNN-*.sop  the validated knowledge circuits, the source of truth the repository is derived from
 *   imports/<id>/*.sop   snapshots of the circuits of imported memories (manifest `imports`), taken when the memory was created
 *   provenance.jsonl   one line per addition: who approved it, when, why, the circuit hash and what was ingested
 *
 * A base memory only grows through `addKnowledge`, an action of any authenticated user that validates the circuits with the knowledge
 * validator (sop/knowledge/) and records its provenance (AGENTS.md rules 4 and 5: nothing enters knowledge implicitly). The
 * repository holds what the memory strategy can retrieve (the `fact` wires); every other knowledge wire (rules, defaults,
 * norms, aggregates, ...) lives as a circuit and is the theory the exact engines read (`theory()`).
 *
 * Imports (DS022 "Imports"): a memory may be created with `imports`, base memories whose circuits form its lower layers. The theory,
 * the validation of every addition and the lexicon of a memory are computed over its layers: the imports in order, then its own circuits.
 * An import is a snapshot (circuits copied, hash recorded in the manifest): a later change of the imported memory does not reach the
 * importer; importing again is an explicit act.
 *
 * A fork copies the circuits and, when the strategy is the same, clones the repository: snapshots and shards are content-addressed
 * files that are never modified in place and are hard-linked (copy-on-write at no cost); any other file is copied (`cloneRepository`). A fork that changes the
 * strategy rebuilds the repository by replaying the circuits into the new engine.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {Repository} from '../../memory/repository.mjs';
import {publishKnowledge, prepareKnowledge} from '../../sop/ingest.mjs';
import {parse, validateProgram, wireText} from '../../sop/knowledge/index.mjs';
import {assertFolderId, newId} from './index.mjs';
import {ensureSeedMemories, CORE_SEED} from '../knowledge-seeds.mjs';

export const BASE_NAME = 'main';
/** The strategy of new base memories, of the `default` base memory and of the sessions cloned from it (DS022, owner decision of 2026-10-01). */
export const DEFAULT_STRATEGY = 'sqlite';
/** The product offers SQLite base memories only (hygiene H20, owner decision 2026-10-01); the other engines of `memory/` (DS016, DS017, DS019, DS020) are research engines, selected by the runtime `memory.engine` of tools and tests, never by a chat request. */
export const STRATEGIES = Object.freeze(['sqlite']);
const FORBIDDEN_FIELDS = new Set(['approval', 'approved_by', 'approved_at']);
const FORBIDDEN_TYPES = new Set(['jsEval']);

const fail = (message, code = 'invalid_request', status = 400) => Object.assign(new Error(message), {code, status});
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, data) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n'); fs.renameSync(tmp, file); };
const sha = text => createHash('sha256').update(text).digest('hex');
const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'circuit';

/** Validates the strategy given by a request (the product offers SQLite only; the exact sidecar and the associative engines stay research). */
export function checkStrategy(strategy = DEFAULT_STRATEGY) {
  if (!STRATEGIES.includes(strategy)) throw fail(`strategy must be one of ${STRATEGIES.join(', ')}`, 'invalid_strategy');
  return strategy;
}

/** The memory configuration a repository of this strategy uses: the runtime defaults with the engine chosen. */
export const memoryConfigFor = (base, {strategy}) => ({...base, engine: strategy});

const IMMUTABLE = /^[a-f0-9]{64}\.json$/;

/**
 * Clones a repository folder. Only content-addressed files (`snapshots/<sha256>.json`, `shards/<sha256>.json`, written once through a
 * temporary file and a rename and never modified in place) are hard-linked. Every other file is copied, so a parent and a child never share
 * a mutable inode. Every memory strategy, SQLite included, persists into those JSON files (the SQLite bank is a private in-memory database
 * rebuilt from the snapshot rows); should a native database file ever appear in a repository folder, it is copied through `VACUUM INTO`
 * (a consistent copy with the write-ahead log folded in) and its `-wal` and `-shm` files are never copied or linked.
 */
export function cloneRepository(from, to) {
  fs.mkdirSync(to, {recursive: true});
  for (const dir of ['snapshots', 'shards']) {
    const source = path.join(from, dir);
    fs.mkdirSync(path.join(to, dir), {recursive: true});
    if (!fs.existsSync(source)) continue;
    for (const name of fs.readdirSync(source)) {
      const target = path.join(to, dir, name);
      if (!IMMUTABLE.test(name)) { copyMutable(path.join(source, name), target); continue; }
      try { fs.linkSync(path.join(source, name), target); } catch { fs.copyFileSync(path.join(source, name), target); }
    }
  }
  for (const name of fs.readdirSync(from)) if (/\.(sqlite|db)$/.test(name)) copyMutable(path.join(from, name), path.join(to, name));
  const index = readJson(path.join(from, 'index.json'), {version: 1, bases: {}, users: {}, pins: {}});
  writeJson(path.join(to, 'index.json'), {...index, users: {}, pins: {}});
}

/** Copies a file that may be modified in place: a SQLite database through VACUUM INTO, anything else byte for byte. */
function copyMutable(file, target) {
  if (/\.(sqlite|db)$/.test(file)) {
    const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(file);
    try { db.prepare('VACUUM INTO ?').run(target); } finally { db.close(); }
  } else if (!/-(wal|shm)$/.test(file)) fs.copyFileSync(file, target);
}

/**
 * Checks circuits for a knowledge store. Returns {ok, problems, warnings, wires}. Problems are errors of the knowledge validator,
 * a model-surface or jsEval wire, a governance field (the host writes approval in the provenance, never the author), or a query
 * wire (queries are tests, not knowledge). `existing` circuits are validated together with the new ones (ids, arity, closedness).
 */
export function validateCircuits(circuits, existing = []) {
  const problems = [];
  const wires = [];
  for (const c of circuits) {
    const parsed = parse(c.text);
    for (const w of parsed.wires) {
      wires.push(w);
      if (FORBIDDEN_TYPES.has(w.type)) problems.push({code: 'forbidden_wire', file: c.name, message: `${w.type} is a trusted host wire and never knowledge`, wire: w.id});
      for (const f of w.fields) if (FORBIDDEN_FIELDS.has(f.key)) problems.push({code: 'governance_field', file: c.name, message: `${f.key} is written by the host; remove it`, wire: w.id});
    }
  }
  const all = [...existing, ...circuits].map(c => ({name: c.name, text: c.text, role: 'knowledge'}));
  const result = validateProgram(all, {authoring: true, linking: true});
  const own = new Set(circuits.map(c => c.name));
  for (const p of result.problems) {
    const mine = p.file === undefined || own.has(p.file) || p.severity !== 'warning';
    if (p.severity === 'warning') { if (mine) problems.push({...p, warning: true}); } else problems.push(p);
  }
  const errors = problems.filter(p => !p.warning);
  return {ok: errors.length === 0, problems: errors, warnings: problems.filter(p => p.warning), wires: wires.length};
}

/** Ingests the `fact` wires of a circuit into a repository base; returns what was stored and what stays circuit-only. */
export function ingestFacts(repo, base, text, {knownAt = Date.now()} = {}) {
  const facts = parse(text).wires.filter(w => w.type === 'fact');
  const accepted = [];
  const skipped = [];
  let defaultedValid = 0;
  for (const w of facts) {
    let source = wireText(w);
    let usable = tryPrepare(source, repo);
    if (!usable.ok && /needs valid/.test(usable.error) && !w.fields.some(f => f.key === 'valid')) {
      source += '\n  valid timeless';
      usable = tryPrepare(source, repo);
      if (usable.ok) defaultedValid++;
    }
    if (usable.ok) accepted.push(source); else skipped.push({wire: w.id, reason: usable.error});
  }
  if (accepted.length) publishKnowledge(repo, base, accepted.join('\n\n') + '\n', {reviewed: true, knownAt});
  return {facts_in_circuit: facts.length, facts_ingested: accepted.length, facts_defaulted_valid: defaultedValid, facts_skipped: skipped};
}

function tryPrepare(source, repo) {
  try { prepareKnowledge(source, {memory: repo.memory, reviewed: true}); return {ok: true}; } catch (error) { return {ok: false, error: error.message}; }
}

export class BaseMemories {
  /** `memory` is the runtime `memory` configuration (power, retention, sharding); the strategy of each base memory is added to it. */
  constructor({chatData, memory = {}}) {
    this.chatData = chatData;
    this.root = chatData.baseMemoriesDir;
    this.memory = memory;
  }

  dir(id) { return path.join(this.root, assertFolderId(id, 'base memory id')); }
  manifestFile(id) { return path.join(this.dir(id), 'manifest.json'); }

  manifest(id) {
    const m = readJson(this.manifestFile(id));
    if (!m) throw fail(`Unknown base memory ${JSON.stringify(id)}`, 'unknown_memory', 404);
    return m;
  }

  list() {
    return fs.readdirSync(this.root).filter(id => fs.existsSync(path.join(this.root, id, 'manifest.json'))).map(id => this.manifest(id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  repository(id) {
    const m = this.manifest(id);
    return new Repository(path.join(this.dir(id), 'repo'), {memory: memoryConfigFor(this.memory, m)});
  }

  circuits(id) {
    const folder = path.join(this.dir(id), 'circuits');
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter(n => n.endsWith('.sop')).sort().map(name => ({name, text: fs.readFileSync(path.join(folder, name), 'utf8')}));
  }

  /** The theory of a base memory: its layered circuits concatenated in order (what the exact engines read). */
  theory(id) { return this.layeredCircuits(id).map(c => c.text.trimEnd()).join('\n\n') + '\n'; }

  provenance(id) {
    const file = path.join(this.dir(id), 'provenance.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  }

  appendProvenance(id, record) { fs.appendFileSync(path.join(this.dir(id), 'provenance.jsonl'), JSON.stringify(record) + '\n'); }

  /** The layers a memory is built on: its manifest `imports`, flat and in application order. */
  layers(id) { return this.manifest(id).imports ?? []; }

  /** Circuits of one import layer (the snapshot taken at creation). */
  layerCircuits(id, layer) {
    const folder = path.join(this.dir(id), 'imports', assertFolderId(layer, 'import id'));
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter(n => n.endsWith('.sop')).sort().map(name => ({name: `${layer}:${name}`, text: fs.readFileSync(path.join(folder, name), 'utf8'), layer}));
  }

  /** The circuits the memory's theory, validation and lexicon read: the import layers in order, then its own circuits. */
  layeredCircuits(id) { return [...this.layers(id).flatMap(l => this.layerCircuits(id, l.id)), ...this.circuits(id).map(c => ({...c, layer: null}))]; }

  /**
   * The flat layer list a new memory gets from the imports it names: each imported memory's own imports first, then its own
   * circuits, every memory once (depth first), with the hash of the circuits taken.
   */
  resolveImports(ids = []) {
    const out = [];
    const visit = (id, direct) => {
      if (out.some(l => l.id === id)) { if (direct) out.find(l => l.id === id).direct = true; return; }
      const m = this.manifest(id);
      for (const l of m.imports ?? []) visit(l.id, false);
      const circuits = this.circuits(id);
      out.push({id, name: m.name, direct, circuits: circuits.length, circuits_sha256: sha(circuits.map(c => c.name + '\0' + c.text).join('\0'))});
    };
    for (const id of ids) visit(assertFolderId(id, 'import id'), true);
    return out;
  }

  /** The compiled lexicon of a memory: its layered circuits, cached by hash (chatData.lexicons). */
  lexicon(id) { return this.chatData.lexicons.get(this.layeredCircuits(id).map(({name, text}) => ({name, text})), {provenance: `base-memory:${id}`}); }

  /** Creates a base memory; `imports` names the base memories it is built on (their circuits are snapshotted and their facts ingested). */
  create({id, name, strategy = DEFAULT_STRATEGY, description = '', parent = null, imports = [], now = new Date()} = {}) {
    if (typeof name !== 'string' || !name.trim()) throw fail('Provide a non-empty name', 'invalid_name');
    checkStrategy(strategy);
    id = id ? assertFolderId(id, 'base memory id') : newId('bm', now.getTime());
    if (fs.existsSync(this.dir(id))) throw fail(`Base memory ${id} already exists`, 'memory_exists', 409);
    fs.mkdirSync(path.join(this.dir(id), 'circuits'), {recursive: true});
    const layers = this.resolveImports(imports);
    const manifest = {id, name: name.trim().slice(0, 120), parent, strategy, created_at: now.toISOString(), description: String(description).slice(0, 2000), imports: layers, circuits: 0, facts: 0};
    writeJson(this.manifestFile(id), manifest);
    const repo = new Repository(path.join(this.dir(id), 'repo'), {memory: memoryConfigFor(this.memory, manifest)});
    repo.init(BASE_NAME);
    for (const layer of layers) {
      const folder = path.join(this.dir(id), 'imports', layer.id);
      fs.mkdirSync(folder, {recursive: true});
      for (const c of this.circuits(layer.id)) {
        fs.writeFileSync(path.join(folder, c.name), c.text);
        const ingest = ingestFacts(repo, BASE_NAME, c.text, {knownAt: now.getTime()});
        manifest.facts += ingest.facts_ingested;
      }
      this.appendProvenance(id, {kind: 'import-layer', id: layer.id, direct: layer.direct, circuits: layer.circuits, circuits_sha256: layer.circuits_sha256, at: now.toISOString()});
    }
    if (layers.length) writeJson(this.manifestFile(id), manifest);
    return manifest;
  }

  /** Writes a validated circuit as the next file and ingests its facts; the shared step of add, import and replay. */
  store(id, circuit, {approvedBy, reason = '', source = null, now = new Date(), kind = 'add'} = {}) {
    const manifest = this.manifest(id);
    const seq = manifest.circuits + 1;
    const file = `${String(seq).padStart(4, '0')}-${slug(circuit.name)}.sop`;
    fs.writeFileSync(path.join(this.dir(id), 'circuits', file), circuit.text);
    const ingest = ingestFacts(this.repository(id), BASE_NAME, circuit.text, {knownAt: now.getTime()});
    const record = {kind, seq, file, sha256: sha(circuit.text), approved_by: approvedBy, approved_at: now.toISOString(), reason, source, wires: parse(circuit.text).wires.length, ingest};
    this.appendProvenance(id, record);
    writeJson(this.manifestFile(id), {...manifest, circuits: seq, facts: manifest.facts + ingest.facts_ingested});
    return record;
  }

  /**
   * Adds validated circuits to a base memory (any authenticated user). Nothing is written when any circuit fails validation.
   * `circuits` is [{name, text}]; `approvedBy` names the acting user (provenance).
   */
  addKnowledge(id, {circuits, approvedBy, reason = '', source = null, now = new Date()}) {
    if (!approvedBy) throw fail('Adding knowledge needs the acting user (approvedBy)', 'approval_required', 403);
    if (!Array.isArray(circuits) || !circuits.length) throw fail('Provide circuits: [{name, text}]', 'invalid_circuits');
    for (const c of circuits) if (typeof c?.text !== 'string' || !c.text.trim() || typeof c.name !== 'string') throw fail('Each circuit needs a name and a non-empty text', 'invalid_circuits');
    this.manifest(id);
    const check = validateCircuits(circuits, this.layeredCircuits(id));
    if (!check.ok) throw Object.assign(fail('The circuits did not pass the knowledge validator; nothing was added', 'validation_failed', 422), {problems: check.problems, warnings: check.warnings});
    const added = circuits.map(c => this.store(id, c, {approvedBy, reason, source, now}));
    return {memory: this.manifest(id), added, warnings: check.warnings};
  }

  /** Imports a memory: a new base memory holding the given circuits, all validated first (any authenticated user). */
  importMemory({name, strategy, description, circuits = [], imports = [], approvedBy, reason = 'import', source = null, id, now = new Date()}) {
    if (!approvedBy) throw fail('Importing knowledge needs the acting user (approvedBy)', 'approval_required', 403);
    checkStrategy(strategy ?? DEFAULT_STRATEGY);
    if (circuits.length) {
      for (const c of circuits) if (typeof c?.text !== 'string' || typeof c.name !== 'string') throw fail('Each circuit needs a name and a text', 'invalid_circuits');
      const lower = this.resolveImports(imports).flatMap(l => this.circuits(l.id).map(c => ({name: `${l.id}:${c.name}`, text: c.text})));
      const check = validateCircuits(circuits, lower);
      if (!check.ok) throw Object.assign(fail('The circuits did not pass the knowledge validator; nothing was imported', 'validation_failed', 422), {problems: check.problems, warnings: check.warnings});
    }
    const created = this.create({id, name, strategy, description, imports, now});
    try {
      for (const c of circuits) this.store(created.id, c, {approvedBy, reason, source, now, kind: 'import'});
    } catch (error) { fs.rmSync(this.dir(created.id), {recursive: true, force: true}); throw error; }
    return this.manifest(created.id);
  }

  /** Forks a base memory: its circuits and provenance are copied, the repository is cloned (same strategy) or rebuilt (new one). */
  fork(id, {name, strategy, description = '', newId: wanted, now = new Date()} = {}) {
    const parent = this.manifest(id);
    strategy = checkStrategy(strategy ?? parent.strategy);
    const child = this.create({id: wanted, name, strategy, description, parent: {id: parent.id, name: parent.name, strategy: parent.strategy, circuits: parent.circuits, forked_at: now.toISOString()}, now});
    const from = this.dir(id);
    const to = this.dir(child.id);
    try {
      fs.copyFileSync(path.join(from, 'provenance.jsonl'), path.join(to, 'provenance.jsonl'));
    } catch { /* a base memory without additions has no provenance file */ }
    const copied = this.circuits(id);
    for (const c of copied) fs.writeFileSync(path.join(to, 'circuits', c.name), c.text);
    // The layers are copied as they are: a fork keeps the snapshots of its parent, never a newer version of an imported memory.
    if (fs.existsSync(path.join(from, 'imports'))) fs.cpSync(path.join(from, 'imports'), path.join(to, 'imports'), {recursive: true});
    writeJson(this.manifestFile(child.id), {...this.manifest(child.id), imports: parent.imports ?? []});
    const same = strategy === parent.strategy;
    let rebuilt = null;
    if (same) {
      fs.rmSync(path.join(to, 'repo'), {recursive: true, force: true});
      cloneRepository(path.join(from, 'repo'), path.join(to, 'repo'));
    } else {
      rebuilt = {facts_ingested: 0, facts_skipped: 0};
      const repo = this.repository(child.id);
      for (const c of this.layeredCircuits(child.id)) {
        const r = ingestFacts(repo, BASE_NAME, c.text, {knownAt: now.getTime()});
        rebuilt.facts_ingested += r.facts_ingested;
        rebuilt.facts_skipped += r.facts_skipped.length;
      }
    }
    const manifest = {...this.manifest(child.id), circuits: copied.length, facts: same ? parent.facts : rebuilt.facts_ingested};
    writeJson(this.manifestFile(child.id), manifest);
    this.appendProvenance(child.id, {kind: 'fork', from: parent.id, strategy_from: parent.strategy, strategy_to: strategy, method: same ? 'hard-link clone (copy-on-write)' : 'replay of the circuits into the new engine', at: now.toISOString()});
    return {memory: manifest, method: same ? 'clone' : 'replay', rebuilt};
  }

  /**
   * Intelligible size of a memory (chat users never see "circuits"): the knowledge files of all its layers, the SOP wires in them and the
   * wires by type. Parsed once per content: cached in this process and in `stats.json` of the memory, keyed by the manifest counters,
   * the import hashes and the name/size/mtime of its own files, so a request never parses the texts again.
   */
  stats(id) {
    const manifest = this.manifest(id);
    const own = path.join(this.dir(id), 'circuits');
    const files = fs.existsSync(own) ? fs.readdirSync(own).filter(n => n.endsWith('.sop')).sort().map(n => { const st = fs.statSync(path.join(own, n)); return `${n}:${st.size}:${Math.round(st.mtimeMs)}`; }) : [];
    const key = sha(JSON.stringify([manifest.circuits, (manifest.imports ?? []).map(l => [l.id, l.circuits_sha256]), files]));
    this.statsCache ??= new Map();
    const hit = this.statsCache.get(id);
    if (hit?.key === key) return hit.value;
    const file = path.join(this.dir(id), 'stats.json');
    let value = null;
    const disk = readJson(file);
    if (disk?.key === key) value = disk.value;
    else {
      const layered = this.layeredCircuits(id);
      const wires_by_type = {};
      let sop_wires = 0;
      for (const c of layered) for (const w of parse(c.text).wires) { wires_by_type[w.type] = (wires_by_type[w.type] ?? 0) + 1; sop_wires++; }
      value = {knowledge_files: layered.length, sop_wires, wires_by_type: Object.fromEntries(Object.entries(wires_by_type).sort((a, b) => b[1] - a[1]))};
      try { writeJson(file, {key, value}); } catch { /* a cache never fails a read */ }
    }
    this.statsCache.set(id, {key, value});
    return value;
  }

  /** A manifest with the added `knowledge_files`, `sop_wires` and `wires_by_type` (existing fields stay). */
  withStats(manifest) { return {...manifest, ...this.stats(manifest.id)}; }

  /** The summary of a base memory for the API: the manifest, the circuit names and the last provenance records. */
  describe(id) {
    const manifest = this.manifest(id);
    const provenance = this.provenance(id);
    return {...this.withStats(manifest), circuit_files: this.circuits(id).map(c => c.name), provenance: provenance.slice(-20)};
  }

  /**
   * The facts the memory store holds for a predicate (a read through the memory strategy, so it shows what retrieval would find).
   * The predicates come from the `predicate` wires of the circuits unless one is named; at most `limit` rows per predicate.
   */
  facts(id, {predicate = null, limit = 200} = {}) {
    const circuits = this.layeredCircuits(id);
    const arity = new Map();
    for (const c of circuits) for (const w of parse(c.text).wires) {
      if (w.type !== 'predicate') continue;
      const args = (w.fields.find(f => f.key === 'args')?.value ?? '').trim();
      arity.set(w.id, args ? (args === 'none' ? 0 : args.split(/\s+/).length) : w.fields.filter(f => f.key === 'role').length);
    }
    const names = predicate ? [predicate] : [...arity.keys()];
    const repo = this.repository(id);
    const session = repo.session(BASE_NAME, 'reader', newId('view'));
    const out = {};
    try {
      for (const name of names) {
        const atom = {p: name, a: Array.from({length: arity.get(name) ?? 2}, (_, i) => `?v${i}`), neg: false};
        const rows = repo.recall(session, atom, {asof: Infinity}, {limit}).rows;
        out[name] = rows.map(r => ({id: r.id, args: r.atom.a, source: r.source ?? null, quote: r.quote ?? null}));
      }
    } finally { repo.closeSession(session); }
    return out;
  }

  delete(id) {
    this.manifest(id);
    fs.rmSync(this.dir(id), {recursive: true, force: true});
  }
}

/** The encyclopedic base memory (Wikidata subset, imports core-min and core-en): the default of new sessions when it is loaded. */
export const ENCYCLOPEDIC_BASE = 'world-v1';
/** The minimal base memory created when the configured default is not loaded: it imports `core-min` only. */
export const MINIMAL_DEFAULT = 'default';

/**
 * The base memory that sessions naming none fork from (DS022 "Base memories"): `chatData.defaultBase`, documented default the encyclopedic
 * `world-v1`, which gives every session common sense and basic knowledge. world-v1 is built by `tools/world-kb` (it cannot be created
 * here); when it is not loaded, the minimal memory `default` (imports `core-min`) is used instead, so no chat starts without a vocabulary.
 * Any other configured id is created as a minimal memory when missing. Returns the id in use. The seed memories (config/knowledge) are
 * created first when missing. An EMPTY minimal default without the core-min import or of another strategy (no circuits: nothing to lose)
 * is re-created; one that holds knowledge is left alone.
 */
export function ensureDefaultBase(memories, config = {}) {
  const wanted = config.chatData?.defaultBase ?? ENCYCLOPEDIC_BASE;
  if (wanted === ENCYCLOPEDIC_BASE && memories.list().some(m => m.id === wanted)) return wanted;
  const id = wanted === ENCYCLOPEDIC_BASE ? MINIMAL_DEFAULT : wanted;
  const strategy = STRATEGIES.includes(config.memory?.engine) ? config.memory.engine : DEFAULT_STRATEGY;
  ensureSeedMemories(memories, {strategy});
  const existing = memories.list().find(m => m.id === id);
  const stale = existing && existing.circuits === 0 && (existing.strategy !== strategy || !(existing.imports ?? []).some(l => l.id === CORE_SEED));
  if (stale) memories.delete(id);
  else if (existing) return id;
  memories.create({id, name: 'Default', strategy, imports: [CORE_SEED], description: 'Base memory used by chats that name none; it holds the minimal shared vocabulary (core-min) and grows only through accepted knowledge.'});
  return id;
}
