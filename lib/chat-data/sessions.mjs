/**
 * Chat sessions (DS022 "Sessions"): one folder per chat under `chat_data/sessions/<id>/`.
 *
 *   session.json        id, user, base (id, name, strategy, circuits), created_at, last_active_at, settings, kept
 *   repo/               the memory repository cloned from the base memory (hard links) plus the session circuits
 *   base_circuits/      the base memory's circuits at the time of the clone (a session is self-contained)
 *   circuits/           validated circuits added during the conversation (session layer: coding-agent definitions, authored circuits)
 *   requests/<req>/     one temporary folder per authoring request (attached files, TASK.md, omp session, results)
 *   agent/              the conversation context and the last answer of the chat agent (server/session-store.mjs)
 *   provenance.jsonl    circuits added and the commit
 *   transcript.jsonl    the turns
 *
 * Nothing a session holds is knowledge of the base memory. Asserted statements stay turn-local evidence in `agent/`; circuits
 * enter `circuits/` after the knowledge validator (no manual acceptance, owner 2026-10-02); a commit to a fork of a base memory is a separate
 * action of any authenticated user that validates everything again and records provenance in the new memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import {Repository} from '../../memory/repository.mjs';
import {assertFolderId, newId} from './index.mjs';
import {parse} from '../../sop/knowledge/index.mjs';
import {BASE_NAME, cloneRepository, ingestFacts, memoryConfigFor, validateCircuits} from './memories.mjs';
import {createHash} from 'node:crypto';

const fail = (message, code = 'invalid_request', status = 400) => Object.assign(new Error(message), {code, status});
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, data) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n'); fs.renameSync(tmp, file); };
const sha = text => createHash('sha256').update(text).digest('hex');
const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'circuit';

export const SESSION_SETTINGS = Object.freeze({
  // The proxy tier the session's step-by-step questions start at (a tier of the ladder, such as `small`; the ladder continues upward from
  // it); null starts at the configured first tier.
  formalizer_model: {default: null},
  // The formalization strategy of the session (DS009 "Request parser"); null uses the server default. A strategy the server cannot run
  // is refused when the turn starts (`parse_unavailable`), never replaced by another one.
  // The archived one-shot names (LLMDirect, CodingAgent, LocalLLMDirect) are kept as stored and run the default step-by-step strategy,
  // with a note in the trace (owner decision 2026-10-02).
  formalizer: {default: null, nullable: true, values: ['LocalLLMStepByStep', 'InternalReasoningStepByStep', 'LLMDirect']},
  // The ChatSOPAdapter mode of the session's turns (lib/adapter: stepwise, routed, direct-verified); null uses config.adapter.mode.
  adapter_mode: {default: null, nullable: true, values: ['stepwise', 'routed', 'direct-verified']},
  // The MRP-LLM model the session belongs to (lib/mrp/models.mjs, DS025); null uses the server's default model.
  model: {default: null, nullable: true, check: v => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v)},
  // The language of the answers (DS026): `auto` (the language of the user's message), an ISO 639-1 code such as `ro`, or null (the model's setting).
  language: {default: null, nullable: true, check: v => typeof v === 'string' && /^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/.test(v)},
  // Per-session overrides of the model's slot strategies (DS025): {slot: {strategy?, params?}}; validated against the strategy catalog when a turn starts.
  slots: {default: null, nullable: true, check: v => v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length <= 20000},
});
/** Earlier setting names and values, read as the current ones (sessions stored before 2026-10-02 and older clients). */
const LEGACY_KEYS = Object.freeze({omp_model: 'formalizer_model'});
const LEGACY_FORMALIZERS = Object.freeze({CodingAgent: 'LLMDirect', LocalLLMDirect: 'LLMDirect'});

export function checkSettings(settings = {}) {
  const out = {};
  for (let [key, value] of Object.entries(settings)) {
    key = LEGACY_KEYS[key] ?? key;
    if (key === 'formalizer' && typeof value === 'string') value = LEGACY_FORMALIZERS[value] ?? value;
    if (!(key in SESSION_SETTINGS)) throw fail(`Unknown session setting ${JSON.stringify(key)}; known: ${Object.keys(SESSION_SETTINGS).join(', ')}`, 'unsupported_parameter');
    const spec = SESSION_SETTINGS[key];
    if (spec.values && !(spec.nullable && value === null) && !spec.values.includes(value)) throw fail(`${key} must be one of ${spec.values.join(', ')}`, 'invalid_parameter');
    if (spec.check && !(spec.nullable && value === null) && !spec.check(value)) throw fail(`invalid value for the session setting ${key}`, 'invalid_parameter');
    if (key === 'formalizer_model' && value !== null && (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\0\n\r]/.test(value))) throw fail('formalizer_model must be a proxy tier such as small', 'invalid_parameter');
    out[key] = value;
  }
  return out;
}

export class Sessions {
  constructor({chatData, memories, memory = {}}) {
    this.chatData = chatData;
    this.memories = memories;
    this.memory = memory;
    this.root = chatData.sessionsDir;
  }

  dir(id) { return path.join(this.root, assertFolderId(id, 'session id')); }
  infoFile(id) { return path.join(this.dir(id), 'session.json'); }

  info(id) {
    const info = readJson(this.infoFile(id));
    if (!info) throw fail(`Unknown session ${JSON.stringify(id)}`, 'unknown_session', 404);
    return info;
  }

  /** Session information visible to `user` (the owner, or an administrator). */
  visible(id, {user, admin = false}) {
    const info = this.info(id);
    if (!admin && info.user !== user) throw fail('This session belongs to another user', 'forbidden', 403);
    return info;
  }

  save(info) { writeJson(this.infoFile(info.id), info); return info; }

  touch(id, now = new Date()) { const info = this.info(id); info.last_active_at = now.toISOString(); return this.save(info); }

  /** Starts a session on a base memory: the base's repository is cloned by hard links, its circuits are copied. */
  create({base, user, id, name = '', settings = {}, now = new Date()}) {
    const manifest = this.memories.manifest(base);
    id = id ? assertFolderId(id, 'session id') : newId('s', now.getTime());
    if (fs.existsSync(this.dir(id))) throw fail(`Session ${id} already exists`, 'session_exists', 409);
    const folder = this.dir(id);
    fs.mkdirSync(folder, {recursive: true, mode: 0o700});
    for (const sub of ['circuits', 'requests', 'base_circuits', 'agent']) fs.mkdirSync(path.join(folder, sub));
    cloneRepository(path.join(this.memories.dir(base), 'repo'), path.join(folder, 'repo'));
    // The layered circuits of the base (imports first): the session is self-contained, its lexicon and validation never read the base again.
    this.memories.layeredCircuits(base).forEach((c, i) => fs.writeFileSync(path.join(folder, 'base_circuits', `${String(i + 1).padStart(4, '0')}-${c.layer ? c.layer + '-' : ''}${c.name.replace(/^.*:/, '').replace(/^\d+-/, '')}`), c.text));
    const info = {
      id, user, name: String(name).slice(0, 120) || manifest.name, created_at: now.toISOString(), last_active_at: now.toISOString(),
      base: {id: manifest.id, name: manifest.name, strategy: manifest.strategy, circuits: manifest.circuits},
      settings: {formalizer_model: null, formalizer: null, ...checkSettings(settings)}, kept: false, committed_to: [],
    };
    return this.save(info);
  }

  list({user, admin = false}) {
    return fs.readdirSync(this.root).filter(id => fs.existsSync(path.join(this.root, id, 'session.json'))).map(id => this.info(id))
      .filter(info => admin || info.user === user).sort((a, b) => b.last_active_at.localeCompare(a.last_active_at));
  }

  updateSettings(id, settings) {
    const info = this.info(id);
    info.settings = {...info.settings, ...checkSettings(settings)};
    return this.save(info);
  }

  repository(id) {
    const info = this.info(id);
    return new Repository(path.join(this.dir(id), 'repo'), {memory: memoryConfigFor(this.memory, info.base)});
  }

  readCircuits(folder) {
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter(n => n.endsWith('.sop')).sort().map(name => ({name, text: fs.readFileSync(path.join(folder, name), 'utf8')}));
  }

  baseCircuits(id) { return this.readCircuits(path.join(this.dir(id), 'base_circuits')); }
  circuits(id) { return this.readCircuits(path.join(this.dir(id), 'circuits')); }

  /** The compiled lexicon of the session: its base's layered circuits followed by the session circuits (cached by hash). */
  lexicon(id) { return this.chatData.lexicons.get([...this.baseCircuits(id), ...this.circuits(id)], {provenance: `session:${id}`}); }

  /** Base theory followed by the session circuits. */
  theory(id) { return [...this.baseCircuits(id), ...this.circuits(id)].map(c => c.text.trimEnd()).join('\n\n') + '\n'; }

  appendProvenance(id, record) { fs.appendFileSync(path.join(this.dir(id), 'provenance.jsonl'), JSON.stringify(record) + '\n'); }
  provenance(id) {
    const file = path.join(this.dir(id), 'provenance.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  }

  // ---- session circuits -------------------------------------------------------------------------------------------------

  /**
   * Adds a circuit to the session layer (a coding-agent definition or an authored circuit): validated together with the base and session
   * circuits, stored as the next session circuit, its facts ingested into the session's repository, provenance recorded. There is no
   * manual acceptance step (owner, 2026-10-02); a circuit that does not validate is refused with its problems and nothing is stored.
   */
  addCircuit(id, {name, text, request = null, model = null, origin = 'coding_agent', by = null, now = new Date()}) {
    if (typeof text !== 'string' || !text.trim()) throw fail('A session circuit needs a circuit text', 'invalid_circuits');
    const check = validateCircuits([{name, text}], [...this.baseCircuits(id), ...this.circuits(id)]);
    if (!check.ok) throw Object.assign(fail('The circuit does not pass the knowledge validator; nothing was stored', 'validation_failed', 422), {problems: check.problems, warnings: check.warnings});
    const seq = this.circuits(id).length + 1;
    const file = `${String(seq).padStart(4, '0')}-${slug(name)}.sop`;
    fs.writeFileSync(path.join(this.dir(id), 'circuits', file), text);
    const ingest = ingestFacts(this.repository(id), BASE_NAME, text, {knownAt: now.getTime()});
    const record = {kind: 'add', seq, file, sha256: sha(text), origin, by, at: now.toISOString(), request, model, ingest};
    this.appendProvenance(id, record);
    return {file, record, warnings: check.warnings ?? []};
  }

  // ---- commit to a fork --------------------------------------------------------------------------------------------------

  /**
   * Commits the session circuits to a NEW base memory: a fork of the session's base memory plus those circuits.
   * The fork is taken from the base memory's current state (hard-link clone, or a replay when the strategy changes), the session
   * circuits are validated on top of it and added with provenance (`kind: commit`, the session id as source). Any authenticated user
   * action; the base memory the session started from is never changed.
   */
  commit(id, {name, strategy, description = '', approvedBy, newId: wanted, now = new Date()}) {
    if (!approvedBy) throw fail('Committing to a base memory needs the acting user (approvedBy)', 'approval_required', 403);
    const info = this.info(id);
    const sessionCircuits = this.circuits(id);
    if (!sessionCircuits.length) throw fail('The session has no circuits to commit', 'nothing_to_commit', 409);
    const parent = this.memories.manifest(info.base.id);
    const target = strategy ?? info.base.strategy;
    const fork = this.memories.fork(parent.id, {name, strategy: target, description: description || `Committed from session ${id}`, newId: wanted, now});
    const created = fork.memory.id;
    const additions = sessionCircuits.map(c => ({name: c.name.replace(/^\d+-/, ''), text: c.text}));
    const check = validateCircuits(additions, this.memories.layeredCircuits(created));
    if (!check.ok) {
      this.memories.delete(created);
      throw Object.assign(fail('The session circuits do not pass the validator on top of the base memory; nothing was committed', 'validation_failed', 422), {problems: check.problems, warnings: check.warnings});
    }
    const added = additions.map(c => this.memories.store(created, c, {approvedBy, reason: `commit of session ${id}`, source: `session:${id}`, now, kind: 'commit'}));
    const result = this.memories.describe(created);
    const next = this.info(id);
    next.committed_to = [...(next.committed_to ?? []), {id: created, at: now.toISOString(), by: approvedBy}];
    this.save(next);
    return {memory: result, added, fork_method: fork.method};
  }

  // ---- transcript, requests ----------------------------------------------------------------------------------------------

  appendTranscript(id, entry, now = new Date()) {
    fs.appendFileSync(path.join(this.dir(id), 'transcript.jsonl'), JSON.stringify({ts: now.toISOString(), ...entry}) + '\n');
    this.touch(id, now);
  }

  transcript(id, {limit = 200} = {}) {
    const file = path.join(this.dir(id), 'transcript.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(-limit);
  }

  /** The number the next answered chat turn of the session gets (1 for the first): one more than the highest recorded `turn`. */
  nextTurn(id) {
    return this.transcript(id, {limit: Infinity}).reduce((n, e) => (Number.isSafeInteger(e.turn) && e.turn > n ? e.turn : n), 0) + 1;
  }

  /** The recorded assistant entry of turn `n` (message, strategy, model, circuits, status, answer, trace id), or null. */
  turn(id, n) {
    return this.transcript(id, {limit: Infinity}).findLast(e => e.role === 'assistant' && e.turn === n) ?? null;
  }

  /** The temporary folder of one authoring request inside the session. */
  requestFolder(id) {
    const reqId = newId('r');
    const dir = path.join(this.dir(id), 'requests', reqId);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    return {id: reqId, dir};
  }

  describe(id) {
    const info = this.info(id);
    return {...info, ...this.stats(id, info), circuits: this.circuits(id).map(c => c.name), provenance: this.provenance(id).slice(-20)};
  }

  /** `knowledge_files`, `sop_wires` and `wires_by_type` of a session: its base memory's (cached) plus the session's own few circuits. */
  stats(id, info = this.info(id)) {
    let base;
    try { base = this.memories.stats(info.base.id); } catch { return {}; }
    const wires_by_type = {...base.wires_by_type};
    let sop_wires = base.sop_wires;
    const own = this.circuits(id);
    for (const c of own) for (const w of parse(c.text).wires) { wires_by_type[w.type] = (wires_by_type[w.type] ?? 0) + 1; sop_wires++; }
    return {knowledge_files: base.knowledge_files + own.length, sop_wires, wires_by_type};
  }

  delete(id) { this.info(id); fs.rmSync(this.dir(id), {recursive: true, force: true}); }
}
