/**
 * Record and replay of the small model's answers (owner request 2026-10-02: the formalization regression runs on CPU, without a model,
 * from a cache). Every question the step-by-step protocol sends to a proxy tier is keyed by the tier, the whole conversation (the
 * system message, the earlier questions and answers, the new question: the exact filled text of every protocol template), the token
 * limit and the sampling settings; the answer is stored under that key. A replayed run makes exactly the protocol's decisions, the
 * answer readers, the circuit assembly, the validator and the execution deterministic and offline.
 *
 * Modes: `replay` (strict: a question not in the cache is a `replay_miss` failure naming the new prompt), `fill` (a miss is asked
 * live and recorded), `record` (always asked live, recorded; a run for a new measurement of the model itself).
 * Storage: content-addressed JSONL under `dir`, one file per first two hex digits of the key (`<dir>/<kk>.jsonl`, lines
 * {key, model, text, usage, at}); appends only. The cache holds answers derived from the owner's books, so its default place is the
 * gitignored datasets_sources/formalization-regression/replay/ (DS011; docs/runtime.html "Evaluating on the owner's problem books").
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadLayers} from 'pworker/config';
import {PWORKER_CONFIG_FILE} from '../pworker.mjs';

export const REPLAY_MODES = Object.freeze(['replay', 'fill', 'record']);
const stores = new Map();

/** The cache of a directory (loaded once per process). */
export function replayStore(dir) {
  if (stores.has(dir)) return stores.get(dir);
  const map = new Map();
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(n => /^[0-9a-f]{2}\.jsonl$/.test(n)))
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (!line) continue; try { const r = JSON.parse(line); map.set(r.key, r); } catch { /* a torn line */ } }
  const store = {dir, map, hits: 0, misses: 0, recorded: 0, missed: [],
    put(row) { map.set(row.key, row); fs.mkdirSync(dir, {recursive: true}); fs.appendFileSync(path.join(dir, `${row.key.slice(0, 2)}.jsonl`), JSON.stringify(row) + '\n'); store.recorded++; }};
  stores.set(dir, store);
  return store;
}

/**
 * The identity of the model a tier serves, from the Ploinky configuration layers (no network, so a strict replay works offline): the
 * first entry of the tier's chain (upstream/model) and, for a local GGUF, the file's size and modification time (a new GGUF is a new
 * model). A tier served by its fallback is a different model: the live caller asks without fallback (`noFallback`) when it records.
 */
const identities = new Map();
export function modelIdentity(tier, {project = PWORKER_CONFIG_FILE} = {}) {
  if (identities.has(tier)) return identities.get(tier);
  let id = `tier:${tier}`;
  try {
    const c = loadLayers({project, user: false}).config;
    let entry = c.tiers?.[tier];
    for (let i = 0; typeof entry === 'string' && i < 8; i++) entry = c.tiers?.[entry];
    entry = Array.isArray(entry) ? entry[0] : null;
    if (entry) {
      id += `=${entry.upstream}/${entry.model}`;
      const gguf = c.providers?.[entry.upstream]?.start?.gguf;
      if (gguf) {
        const st = fs.statSync(gguf);
        id += `#gguf:${st.size}:${Math.round(st.mtimeMs)}`;
      }
    }
  } catch { /* the bare tier name */ }
  identities.set(tier, id);
  return id;
}

export const replayKey = ({model, messages, maxTokens, sampling}) => createHash('sha256').update(JSON.stringify({model, messages, maxTokens, sampling})).digest('hex');

/** Wraps `chat(messages, maxTokens)` with the cache. `sampling` names the settings that shape an answer (temperature, extra body). */
export function replayChat(chat, {dir, mode = 'fill', model, sampling = {temperature: 0}}) {
  if (!REPLAY_MODES.includes(mode)) throw new TypeError(`replay mode must be one of ${REPLAY_MODES.join(', ')}`);
  const store = replayStore(dir);
  return async (messages, maxTokens) => {
    const key = replayKey({model, messages, maxTokens, sampling});
    const hit = mode !== 'record' ? store.map.get(key) : null;
    if (hit) { store.hits++; return {ok: true, text: hit.text, ms: 0, usage: hit.usage ?? {}, cached: null, evaluated: null, replayed: true}; }
    store.misses++;
    if (mode === 'replay') { store.missed.push({key, question: String(messages.at(-1)?.content ?? ''), turn: messages.length}); return {ok: false, text: '', ms: 0, reason: `replay_miss: no recorded answer for the question ${JSON.stringify(String(messages.at(-1)?.content ?? '').slice(0, 160))}`, replayMiss: key}; }
    const reply = await chat(messages, maxTokens);
    if (reply.ok) store.put({key, model, question: String(messages.at(-1)?.content ?? ''), text: reply.text, usage: reply.usage ?? {}, at: new Date().toISOString()});
    return reply;
  };
}
