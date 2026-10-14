/**
 * What the knowledge browser reads (DS022 "Knowledge browser"): a TARGET is a base memory or a chat session, seen as its ordered
 * layers. A base memory's layers are its import snapshots (core-min, core-en, commonsense-v1, ...) followed by its own circuits; a chat
 * session's layers are the layers of its base memory (copied into `base_circuits/` when the session was created) followed by the
 * session layer (`circuits/`). Own circuits that came from a document ingestion are labelled with that ingestion (provenance
 * `source.kind: document`).
 *
 * Everything here is read only. The compiled lexicon comes from the shared lexicon cache, facts are read through the memory strategy
 * (indexed SQLite lookups of a temporary reader session that is closed after use), and each layer's circuits are parsed once per
 * fingerprint (circuit file names, sizes and modification times) into a summary: wires by type, files, fact counts per predicate,
 * the vocabulary wires and a token index of the text values of facts. The summaries of the eight most recent targets stay in memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parse} from '../../sop/knowledge/index.mjs';
import {tokens as wireTokens} from '../../sop/knowledge/lexical.mjs';
import {fold, tokens as textTokens} from '../../sop/text-keys.mjs';
import {BASE_NAME} from '../chat-data/memories.mjs';
import {seedIds} from '../knowledge-seeds.mjs';
import {Theory} from '../../reasoning/slice/index.mjs';

const fail = (message, code = 'invalid_request', status = 400) => Object.assign(new Error(message), {code, status});
const sha = text => createHash('sha256').update(text).digest('hex');
/** The vocabulary and theory wires a summary keeps whole (facts and plain entities are counted, not kept). */
const KEPT = new Set(['predicate', 'lexeme', 'rule', 'default', 'aggregate', 'integrity', 'procedure', 'method', 'norm', 'action', 'amendment', 'constraint']);
const MAX_TEXT_FACTS = 120_000;
const unquote = t => (t?.startsWith('"') ? (() => { try { return JSON.parse(t); } catch { return t; } })() : t);

/** The group of a circuit file: its name without the sequence number, the layer prefix of a session copy and a trailing part number. */
export function fileGroup(name) {
  return String(name).replace(/^.*:/, '').replace(/\.sop$/, '').replace(/^\d+-/, '').replace(/-\d{3}$/, '') || name;
}

/** The fact atom of a `fact` wire: {p, a, neg} with quoted strings decoded, or null. */
export function factAtom(w) {
  const holds = w.fields.find(f => f.key === 'holds')?.value;
  if (!holds) return null;
  const t = wireTokens(holds);
  const neg = t[0] === 'not';
  const rest = neg ? t.slice(1) : t;
  return rest[0] ? {p: rest[0], a: rest.slice(1).map(unquote), neg, texts: rest.slice(1).filter(t => t.startsWith('"')).map(unquote)} : null;
}

/** The key of a fact atom for layer attribution (predicate, polarity, arguments). */
export const atomKey = atom => [atom.p, atom.neg ? 1 : 0, ...atom.a.map(String)].join('\u0001');

/** Parses one layer's circuits into its summary (see the header). */
export function summarizeLayer(layer, circuits) {
  const summary = {id: layer.id, kind: layer.kind, name: layer.name, files: [], types: {}, factsByPredicate: {}, entitiesByKind: {}, wires: [], classes: [],
    textIndex: new Map(), textFacts: [], factKeys: null, bytes: 0, facts: 0, parse_errors: 0};
  const keepKeys = layer.indexFacts ? new Set() : null;
  const entityIds = layer.indexFacts ? new Set() : null;
  for (const c of circuits) {
    summary.bytes += Buffer.byteLength(c.text);
    const {wires, errors} = parse(c.text);
    summary.parse_errors += errors.length;
    const counts = {};
    for (const w of wires) {
      counts[w.type] = (counts[w.type] ?? 0) + 1;
      summary.types[w.type] = (summary.types[w.type] ?? 0) + 1;
      if (w.type === 'fact') {
        const atom = factAtom(w);
        if (!atom) continue;
        summary.facts++;
        summary.factsByPredicate[atom.p] = (summary.factsByPredicate[atom.p] ?? 0) + 1;
        keepKeys?.add(atomKey(atom));
        const text = atom.texts.join(' ');
        if (text && summary.textFacts.length < MAX_TEXT_FACTS) {
          const ref = summary.textFacts.push({p: atom.p, a: atom.a, neg: atom.neg, texts: atom.texts, file: c.name}) - 1;
          for (const t of new Set(textTokens(fold(text)))) (summary.textIndex.get(t) ?? summary.textIndex.set(t, []).get(t)).push(ref);
        }
      } else if (w.type === 'entity') {
        const kind = w.fields.find(f => f.key === 'kind')?.value.trim() ?? 'entity';
        summary.entitiesByKind[kind] = (summary.entitiesByKind[kind] ?? 0) + 1;
        if (kind === 'class') summary.classes.push({id: w.id, file: c.name});
        entityIds?.add(w.id);
      } else if (KEPT.has(w.type)) summary.wires.push({w, file: c.name});
    }
    summary.files.push({name: c.name, group: fileGroup(c.name), bytes: Buffer.byteLength(c.text), counts});
  }
  summary.factKeys = keepKeys;
  summary.entityIds = entityIds;
  return summary;
}

/** One target: its layers, fingerprint, summaries, lexicon, theory and reader sessions; built by `Targets.resolve`. */
export class Target {
  constructor({kind, id, name, layers, fingerprint, lexicon, repository, provenance, info = null}) {
    Object.assign(this, {kind, id, name, layers, fingerprint, info});
    this.lexiconOf = lexicon;
    this.repository = repository;
    this.provenanceOf = provenance;
    this.summaries = null;
  }

  get lexicon() { return (this.lex ??= this.lexiconOf()); }

  /** The summaries of every layer, in layer order (parsed once). */
  summary() {
    if (this.summaries) return this.summaries;
    // Facts are attributed to their layer by key; the largest layer is the default and is not indexed (world-v1: 357k facts).
    const largest = this.layers.reduce((best, l) => (l.bytes > (best?.bytes ?? -1) ? l : best), null);
    this.summaries = this.layers.map(l => summarizeLayer({...l, indexFacts: l !== largest}, l.circuits()));
    this.defaultLayer = largest?.id ?? null;
    return this.summaries;
  }

  /** The layer a fact atom comes from: the first indexed layer that holds it, else the largest layer. */
  layerOfFact(atom) {
    const key = atomKey(atom);
    for (const s of this.summary()) if (s.factKeys?.has(key)) return s.id;
    return this.defaultLayer;
  }

  /** The layer that declares an entity: the first indexed layer with its wire, else the largest layer. */
  layerOfEntity(id) {
    for (const s of this.summary()) if (s.entityIds?.has(id)) return s.id;
    return this.defaultLayer;
  }

  /** The kept wire with this id and its layer and file (the last layer that declares it wins, as in the theory). */
  wire(id) {
    let found = null;
    for (const s of this.summary()) for (const x of s.wires) if (x.w.id === id) found = {wire: x.w, layer: s.id, file: x.file};
    return found;
  }

  /** Every kept wire of the target, with its layer and file. */
  wires(types = null) { return this.summary().flatMap(s => s.wires.filter(x => !types || types.includes(x.w.type)).map(x => ({wire: x.w, layer: s.id, file: x.file}))); }

  /** The circuits of all layers (for the oracle's theory). */
  circuits() { return this.layers.flatMap(l => l.circuits()); }

  /** Runs `fn(repo, session)` with a temporary reader session that is always closed. */
  read(fn) {
    const repo = this.repository();
    const session = repo.session(BASE_NAME, 'review', 'browser-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
    try { return fn(repo, session); } finally { repo.closeSession(session); }
  }

  provenance() { return this.provenanceOf(); }
}

const statKey = folder => {
  if (!fs.existsSync(folder)) return '';
  return fs.readdirSync(folder).filter(n => n.endsWith('.sop')).sort().map(n => { const s = fs.statSync(path.join(folder, n)); return `${n}:${s.size}:${s.mtimeMs}`; }).join('|');
};
const readFolder = (folder, filter = () => true) => (fs.existsSync(folder) ? fs.readdirSync(folder).filter(n => n.endsWith('.sop') && filter(n)).sort().map(name => ({name, text: fs.readFileSync(path.join(folder, name), 'utf8')})) : []);
const folderBytes = (folder, filter = () => true) => (fs.existsSync(folder) ? fs.readdirSync(folder).filter(n => n.endsWith('.sop') && filter(n)).reduce((n, f) => n + fs.statSync(path.join(folder, f)).size, 0) : 0);

/** Resolves and caches targets (base memories and chat sessions) for the knowledge browser. */
export class Targets {
  constructor({memories, sessions = null, limit = 8}) {
    Object.assign(this, {memories, sessions, limit});
    this.cache = new Map();
    this.theories = new Map();
  }

  /** `{memory}` or `{session}` (a session must be visible to the user); returns a cached Target while its circuits are unchanged. */
  resolve({memory = null, session = null} = {}, {user = null, admin = false} = {}) {
    if (Boolean(memory) === Boolean(session)) throw fail('Name exactly one of memory or session', 'invalid_parameter');
    if (session && !this.sessions) throw fail('This server has no chat sessions', 'not_available', 501);
    const target = memory ? this.memoryTarget(memory) : this.sessionTarget(session, {user, admin});
    const key = `${target.kind}:${target.id}`;
    const hit = this.cache.get(key);
    if (hit && hit.fingerprint === target.fingerprint) { this.cache.delete(key); this.cache.set(key, hit); return hit; }
    this.cache.set(key, target);
    while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
    return target;
  }

  /** The oracle's theory of a target, cached by its fingerprint (two theories at most: world-v1's holds 400k wires). */
  theory(target) {
    const key = `${target.kind}:${target.id}:${target.fingerprint}`;
    if (!this.theories.has(key)) {
      this.theories.set(key, new Theory(target.circuits()));
      while (this.theories.size > 2) this.theories.delete(this.theories.keys().next().value);
    }
    return this.theories.get(key);
  }

  memoryTarget(id) {
    const memories = this.memories;
    const manifest = memories.manifest(id);
    const dir = memories.dir(id);
    const seeds = new Set(seedIds());
    const provenance = memories.provenance(id);
    // Own circuit files that a document ingestion stored form one layer per ingestion; the rest is the memory's own layer.
    const ingestionOf = new Map(provenance.filter(r => r.file && r.source?.kind === 'document').map(r => [r.file, r.source.ingestion]));
    const layers = (manifest.imports ?? []).map(l => {
      const folder = path.join(dir, 'imports', l.id);
      return {id: l.id, kind: seeds.has(l.id) ? 'seed' : 'import', name: l.name ?? l.id, bytes: folderBytes(folder), circuits: () => memories.layerCircuits(id, l.id)};
    });
    const own = path.join(dir, 'circuits');
    const ingestions = [...new Set(ingestionOf.values())];
    layers.push({id, kind: seeds.has(id) ? 'seed' : 'own', name: manifest.name, bytes: folderBytes(own, n => !ingestionOf.has(n)), circuits: () => readFolder(own, n => !ingestionOf.has(n))});
    for (const ing of ingestions) layers.push({id: `${id}/${ing}`, kind: 'ingestion', name: `ingestion ${ing}`, bytes: folderBytes(own, n => ingestionOf.get(n) === ing), circuits: () => readFolder(own, n => ingestionOf.get(n) === ing)});
    const fingerprint = sha(JSON.stringify(manifest) + '\0' + statKey(own) + '\0' + (manifest.imports ?? []).map(l => l.circuits_sha256).join(','));
    return new Target({kind: 'memory', id, name: manifest.name, layers, fingerprint, info: manifest,
      lexicon: () => memories.lexicon(id), repository: () => memories.repository(id), provenance: () => memories.provenance(id)});
  }

  sessionTarget(id, {user, admin}) {
    const sessions = this.sessions;
    const info = sessions.visible(id, {user, admin});
    const dir = sessions.dir(id);
    const seeds = new Set(seedIds());
    let imports = [];
    try { imports = (this.memories.manifest(info.base.id).imports ?? []).map(l => l.id); } catch { imports = []; }
    // base_circuits/ files are named NNNN-<layer>-<name>.sop for the import layers and NNNN-<name>.sop for the base memory's own circuits.
    const layerOf = name => imports.find(l => name.replace(/^\d+-/, '').startsWith(l + '-')) ?? info.base.id;
    const baseFolder = path.join(dir, 'base_circuits');
    const ids = [...imports, info.base.id];
    const layers = ids.map(l => ({id: l, kind: seeds.has(l) ? 'seed' : l === info.base.id ? 'base' : 'import', name: l, bytes: folderBytes(baseFolder, n => layerOf(n) === l), circuits: () => readFolder(baseFolder, n => layerOf(n) === l)}));
    const own = path.join(dir, 'circuits');
    layers.push({id: `session:${id}`, kind: 'session', name: `session ${info.name ?? id}`, bytes: folderBytes(own), circuits: () => readFolder(own)});
    const fingerprint = sha(JSON.stringify(info.base) + '\0' + statKey(baseFolder) + '\0' + statKey(own));
    return new Target({kind: 'session', id, name: info.name ?? id, layers, fingerprint, info,
      lexicon: () => sessions.lexicon(id), repository: () => sessions.repository(id), provenance: () => sessions.provenance(id)});
  }
}
