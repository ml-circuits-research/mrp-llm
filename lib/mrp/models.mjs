/**
 * Models (DS025 "Models"): the unit a user talks to and an API client names in `model`. A Model is a base memory (its knowledge: facts,
 * rules, procedures, schemas; `memories` lists the base memories it was composed from when there are several) plus the configuration of how the pipeline runs on it: one strategy with parameters per slot
 * (lib/mrp/strategies.mjs), the output language, the FAQ of the reflex slot, and whether a session or a request may override the slots.
 * How memory is kept, when a reflex fires, how much round-trip checking is paid for and who commits knowledge are therefore settings
 * of a model, never global decisions.
 *
 * Storage: `<chat data root>/models/<id>/model.json` (the configuration, edited on /models or through /v1/mrp/models) and `state.json`
 * (what the model learns while it runs: the learned reflex boundary, reflex statistics, the review queue). Profiles
 * (config/profiles/*.json) are ready-made configurations a new model starts from.
 *
 * Effective settings of a turn: the defaults of the catalog < the model < the session (settings `slots`, `language`) < the request
 * (`metadata.mrp`), the last two only when the model allows overrides.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {SLOT_IDS, DEFAULT_SLOTS, strategy as findStrategy, checkParams} from './strategies.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PROFILES_DIR = path.join(ROOT, 'config', 'profiles');
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LANGUAGE = /^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/;
const fail = (message, code = 'invalid_request', status = 400) => Object.assign(new Error(message), {code, status});

const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

/** The ready-made profiles: `[{id, name, description, slots, language, ...}]`. */
export function profiles(dir = PROFILES_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => ({id: f.replace(/\.json$/, ''), ...readJson(path.join(dir, f), {})}));
}

/** Checked slot settings: `{slot: {strategy, params}}` for the slots given; unknown slots, strategies and parameters are refused. */
export function checkSlots(slots = {}, {partial = true} = {}) {
  if (slots == null) return {};
  if (typeof slots !== 'object' || Array.isArray(slots)) throw fail('slots must be an object {slot: {strategy, params}}', 'invalid_parameter');
  const out = {};
  for (const [slot, value] of Object.entries(slots)) {
    if (!SLOT_IDS.includes(slot)) throw fail(`unknown slot ${JSON.stringify(slot)}; slots: ${SLOT_IDS.join(', ')}`, 'invalid_parameter');
    const v = typeof value === 'string' ? {strategy: value} : value;
    if (!v || typeof v !== 'object') throw fail(`slot ${slot}: expected {strategy, params}`, 'invalid_parameter');
    const id = v.strategy ?? (partial ? null : DEFAULT_SLOTS[slot]);
    if (id == null) { out[slot] = {params: v.params ?? {}}; continue; }
    const entry = findStrategy(slot, id);
    if (!entry) throw fail(`slot ${slot} has no strategy ${JSON.stringify(id)}`, 'invalid_parameter');
    out[slot] = {strategy: id, params: checkParams(entry, v.params ?? {})};
  }
  return out;
}

function checkFaq(faq = []) {
  if (!Array.isArray(faq) || faq.length > 2000) throw fail('faq must be a list of {q, a, variants?} (at most 2000)', 'invalid_parameter');
  return faq.map((item, i) => {
    if (!item || typeof item.q !== 'string' || !item.q.trim() || typeof item.a !== 'string' || !item.a.trim() || item.q.length > 2000 || item.a.length > 8000) throw fail(`faq entry ${i + 1} needs a question q and an answer a`, 'invalid_parameter');
    const variants = item.variants ?? [];
    if (!Array.isArray(variants) || variants.length > 50 || variants.some(v => typeof v !== 'string' || !v.trim() || v.length > 2000)) throw fail(`faq entry ${i + 1}: variants must be a list of questions`, 'invalid_parameter');
    return {id: typeof item.id === 'string' && ID.test(item.id) ? item.id : `faq-${i + 1}`, q: item.q.trim(), a: item.a.trim(), ...(variants.length ? {variants: variants.map(v => v.trim())} : {})};
  });
}

/** Merges slot layers: a later layer's strategy replaces the earlier one (with its params), a later params-only layer tunes them. */
function mergeSlots(...layers) {
  const out = {};
  for (const slot of SLOT_IDS) out[slot] = {strategy: DEFAULT_SLOTS[slot], params: {}};
  for (const layer of layers) for (const [slot, v] of Object.entries(layer ?? {})) {
    if (!v) continue;
    if (v.strategy && v.strategy !== out[slot].strategy) out[slot] = {strategy: v.strategy, params: {...(v.params ?? {})}};
    else out[slot] = {strategy: out[slot].strategy, params: {...out[slot].params, ...(v.params ?? {})}};
  }
  for (const slot of SLOT_IDS) out[slot].params = checkParams(findStrategy(slot, out[slot].strategy), out[slot].params);
  return out;
}

export class Models {
  /** `root`: the folder of the models (`<chat data>/models`); `memories`: BaseMemories, to check that a base exists. */
  constructor({root, memories = null, profilesDir = PROFILES_DIR}) {
    Object.assign(this, {root, memories, profilesDir});
    fs.mkdirSync(root, {recursive: true, mode: 0o700});
  }

  memoryExists(id) { if (!this.memories) return true; try { this.memories.manifest(id); return true; } catch { return false; } }

  dir(id) { if (!ID.test(String(id))) throw fail('invalid model id', 'invalid_model'); return path.join(this.root, id); }
  exists(id) { return typeof id === 'string' && ID.test(id) && fs.existsSync(path.join(this.root, id, 'model.json')); }
  ids() { return fs.readdirSync(this.root).filter(id => ID.test(id) && fs.existsSync(path.join(this.root, id, 'model.json'))).sort(); }
  list() { return this.ids().map(id => this.get(id)); }

  get(id) {
    const model = this.exists(id) ? readJson(path.join(this.dir(id), 'model.json')) : null;
    if (!model) throw fail(`Unknown model ${JSON.stringify(id)}; GET /v1/models lists the models`, 'unknown_model', 404);
    return model;
  }

  /** Creates a model from a profile and/or explicit fields: `{id, name, description, base, profile, slots, language, faq, allowOverrides}`. */
  create(fields = {}) {
    const id = fields.id;
    if (!ID.test(String(id ?? ''))) throw fail('a model needs an id: lowercase letters, digits, - and _', 'invalid_model');
    if (this.exists(id)) throw fail(`model ${id} already exists`, 'model_exists', 409);
    const profile = fields.profile ? profiles(this.profilesDir).find(p => p.id === fields.profile) : null;
    if (fields.profile && !profile) throw fail(`unknown profile ${JSON.stringify(fields.profile)}`, 'invalid_parameter');
    const now = new Date().toISOString();
    const model = this.#checked({
      id, name: fields.name ?? profile?.name ?? id, description: fields.description ?? profile?.description ?? '',
      base: fields.base ?? profile?.base ?? 'default', ...(fields.memories ? {memories: fields.memories} : {}), profile: profile?.id ?? null,
      language: {output: 'auto', ...(profile?.language ?? {}), ...(fields.language ?? {})},
      slots: {...(profile?.slots ?? {}), ...(fields.slots ?? {})},
      faq: fields.faq ?? profile?.faq ?? [], allowOverrides: fields.allowOverrides ?? profile?.allowOverrides ?? true,
      created_at: now, updated_at: now,
    });
    writeJson(path.join(this.dir(id), 'model.json'), model);
    return model;
  }

  /** Replaces the given fields of a model (id and created_at stay). */
  update(id, fields = {}) {
    const old = this.get(id);
    const allowed = ['name', 'description', 'base', 'memories', 'language', 'slots', 'faq', 'allowOverrides'];
    const extra = Object.keys(fields).filter(k => !allowed.includes(k));
    if (extra.length) throw fail(`unsupported model field ${extra[0]}; editable: ${allowed.join(', ')}`, 'unsupported_parameter');
    const model = this.#checked({...old, ...fields, language: {...old.language, ...(fields.language ?? {})}, id: old.id, created_at: old.created_at, updated_at: new Date().toISOString()});
    writeJson(path.join(this.dir(id), 'model.json'), model);
    return model;
  }

  delete(id) { this.get(id); fs.rmSync(this.dir(id), {recursive: true, force: true}); return true; }

  #checked(model) {
    if (typeof model.name !== 'string' || !model.name.trim() || model.name.length > 120) throw fail('a model needs a name (at most 120 characters)', 'invalid_parameter');
    if (typeof model.description !== 'string' || model.description.length > 4000) throw fail('description must be text', 'invalid_parameter');
    if (!ID.test(String(model.base))) throw fail('base must be the id of a base memory', 'invalid_parameter');
    if (!this.memoryExists(model.base)) throw fail(`the base memory ${model.base} does not exist (GET /v1/memories)`, 'unknown_memory');
    if (model.memories != null && (!Array.isArray(model.memories) || !model.memories.length || model.memories.some(m => !ID.test(String(m))) || new Set(model.memories).size !== model.memories.length)) throw fail('memories must be a non-empty list of distinct base memory ids', 'invalid_parameter');
    if (model.memories) for (const m of model.memories) if (!this.memoryExists(m)) throw fail(`the base memory ${m} does not exist (GET /v1/memories)`, 'unknown_memory');
    if (!LANGUAGE.test(String(model.language?.output))) throw fail('language.output must be auto or a language code such as en, ro, fr', 'invalid_parameter');
    return {...model, slots: checkSlots(model.slots), faq: checkFaq(model.faq), allowOverrides: Boolean(model.allowOverrides)};
  }

  /** The learned state of a model (reflex boundary, statistics, review queue). */
  state(id) { this.get(id); return readJson(path.join(this.dir(id), 'state.json'), {}) ?? {}; }
  saveState(id, state) { writeJson(path.join(this.dir(id), 'state.json'), state); return state; }
  updateState(id, fn) { const s = this.state(id); const next = fn(structuredClone(s)) ?? s; return this.saveState(id, next); }

  /**
   * The effective configuration of a turn: `{model, slots: {slot: {strategy, params}}, language: {output}, overridden: [...]}`.
   * Session and request layers apply only when the model allows overrides; a refused override is reported, not ignored silently.
   */
  effective(id, {session = {}, request = {}} = {}) {
    const model = this.get(id);
    const overridden = [], refused = [];
    const layers = [model.slots];
    let output = model.language?.output ?? 'auto';
    for (const [name, layer] of [['session', session], ['request', request]]) {
      if (!layer || (!layer.slots && !layer.language)) continue;
      if (!model.allowOverrides) { refused.push(name); continue; }
      if (layer.slots) { layers.push(checkSlots(layer.slots)); overridden.push(`${name}:slots`); }
      if (layer.language) { if (!LANGUAGE.test(layer.language)) throw fail('language must be auto or a language code', 'invalid_parameter'); output = layer.language; overridden.push(`${name}:language`); }
    }
    const state = this.state(id);
    const slots = mergeSlots(...layers);
    // A boundary learned from feedback replaces the configured starting threshold.
    if (slots.reflex.strategy === 'faq-feedback' && typeof state.reflex?.learnedThreshold === 'number') slots.reflex.params.threshold = state.reflex.learnedThreshold;
    return {model, slots, language: {output}, overridden, refused};
  }

  /**
   * Feedback on a reflex answer (faq-feedback): a down vote raises the boundary by `step`, an up vote on an answer whose score was within
   * two steps of the boundary lowers it by half a step; the value stays within [min, max]. Statistics are kept for every reflex strategy.
   */
  reflexFeedback(id, {score, helpful}) {
    const {slots} = this.effective(id);
    const p = slots.reflex.params;
    return this.updateState(id, state => {
      const r = state.reflex ??= {hits: 0, up: 0, down: 0};
      if (helpful) r.up++; else r.down++;
      if (slots.reflex.strategy === 'faq-feedback' && typeof score === 'number') {
        const now = typeof r.learnedThreshold === 'number' ? r.learnedThreshold : p.threshold;
        const next = helpful ? (score - now <= 2 * p.step ? now - p.step / 2 : now) : Math.max(now, Math.min(score + p.step, now + p.step));
        r.learnedThreshold = Math.round(Math.min(p.max, Math.max(p.min, next)) * 1000) / 1000;
      }
      return state;
    });
  }

  recordReflexHit(id) { return this.updateState(id, s => { (s.reflex ??= {hits: 0, up: 0, down: 0}).hits++; return s; }); }

  /** Review queue (commit strategy review-queue): items `{id, session, circuits: [{name, text}], added_at, status}`. */
  queueReview(id, item) {
    return this.updateState(id, s => { (s.review ??= []).push({id: randomUUID(), status: 'pending', added_at: new Date().toISOString(), ...item}); s.review = s.review.slice(-500); return s; });
  }
  reviewItem(id, itemId) { const item = (this.state(id).review ?? []).find(r => r.id === itemId); if (!item) throw fail('unknown review item', 'not_found', 404); return item; }
  setReviewStatus(id, itemId, status, extra = {}) {
    return this.updateState(id, s => { const item = (s.review ?? []).find(r => r.id === itemId); if (!item) throw fail('unknown review item', 'not_found', 404); Object.assign(item, {status, decided_at: new Date().toISOString(), ...extra}); return s; });
  }

  /** Creates the models of the shipped profiles whose base memory exists, when no model exists yet. Returns the ids created. */
  ensureDefaults() {
    if (this.ids().length) return [];
    const created = [];
    for (const p of profiles(this.profilesDir).filter(p => p.createOnFirstStart)) {
      const base = p.base ?? 'default';
      if (!this.memoryExists(base)) continue;
      try { this.create({id: p.modelId ?? p.id, profile: p.id}); created.push(p.modelId ?? p.id); } catch (e) { if (e.code !== 'model_exists') throw e; }
    }
    return created;
  }
}
