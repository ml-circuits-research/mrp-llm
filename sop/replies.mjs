/**
 * The assistant's phrasing as data (DS023 "Conversation layer"; owner rule of 2026-10-02: no user-facing text in code). Every sentence
 * the chat says comes from a `reply` wire of the conversation layer (config/knowledge/conversation-v1, stored as the base memory
 * `conversation-v1` and visible in /review): `situation`, `part` (opening, body, closing, or `line` of the answer renderer),
 * `language` and `text` with {{slot}} placeholders. This module only indexes the wires and fills slots; which situation a turn is in
 * is decided by the JS oracle over the layer's rules (lib/conversation/), and which renderer line a packet needs by the structure of
 * the packet (sop/answer-text.mjs).
 *
 *   replyLayer()                      -> {circuits, version, replies: Map(id -> reply), bySituation: Map(situation -> [reply])}
 *   setReplyLayer(circuits, origin)   the layer the server read from its chat data (the reviewed stored copy)
 *   say(situation, slots, options)    the text of a situation with its slots filled (the first variant unless `variant` is given)
 *   fill(text, slots)                 the placeholders of one text, filled
 *
 * Without `setReplyLayer` the shipped layer (config/knowledge/conversation-v1) is read. A missing layer or a situation the layer does
 * not phrase is a configuration error (`reply_layer_missing`, `reply_missing`), never a built-in sentence.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parse} from './knowledge/lexical.mjs';
import {REPLY_SLOT} from './knowledge/grammar.mjs';

export const CONVERSATION_LAYER = 'conversation-v1';
const SHIPPED = fileURLToPath(new URL(`../config/knowledge/${CONVERSATION_LAYER}/`, import.meta.url));
const configError = (code, message) => Object.assign(new Error(message), {code, status: 500});
const field = (w, key) => w.fields.find(f => f.key === key)?.value.trim();
const unquote = v => (v?.startsWith('"') ? JSON.parse(v) : v);

let active = null;

/** Indexes the reply wires of a layer's circuits ([{name, text}]). */
export function indexLayer(circuits, origin = 'given', {allowEmpty = false} = {}) {
  const replies = new Map(), bySituation = new Map();
  for (const c of circuits) for (const w of parse(c.text).wires) {
    if (w.type !== 'reply') continue;
    const reply = {id: w.id, situation: field(w, 'situation'), part: field(w, 'part') ?? 'body', language: field(w, 'language') ?? 'en', text: unquote(field(w, 'text'))};
    replies.set(w.id, reply);
    if (!bySituation.has(reply.situation)) bySituation.set(reply.situation, []);
    bySituation.get(reply.situation).push(reply);
  }
  if (!replies.size && !allowEmpty) throw configError('reply_layer_missing', `the conversation layer (${origin}) holds no reply wires`);
  const version = createHash('sha256').update(circuits.map(c => c.text).join('\n')).digest('hex').slice(0, 16);
  return {circuits, origin, version, replies, bySituation};
}

/** The shipped layer's circuit files, in order. */
export function shippedCircuits() {
  if (!fs.existsSync(SHIPPED)) throw configError('reply_layer_missing', `the conversation layer is missing: ${SHIPPED}`);
  return fs.readdirSync(SHIPPED).filter(n => n.endsWith('.sop')).sort().map(name => ({name, text: fs.readFileSync(path.join(SHIPPED, name), 'utf8')}));
}

/** Sets the layer the renderer uses (the server passes the stored base memory's circuits). */
export function setReplyLayer(circuits, origin = 'chat data') { active = indexLayer(circuits, origin); return active; }

/** The layer in use: the one set by the server, else the shipped one. */
export function replyLayer() { return active ??= indexLayer(shippedCircuits(), `config/knowledge/${CONVERSATION_LAYER}`); }

/** Fills the {{slot}} placeholders; a slot without a value is a configuration error of the caller or the layer. */
export function fill(text, slots = {}, situation = '?') {
  return text.replace(REPLY_SLOT, (m, name) => {
    if (slots[name] === undefined || slots[name] === null) throw configError('reply_slot_missing', `the reply of ${situation} needs the slot ${name}`);
    return String(slots[name]);
  });
}

/** The variants of a situation in a language (English is the only knowledge language; the answer-formulation step translates). */
export function variants(situation, {language = 'en', layer = replyLayer()} = {}) {
  return (layer.bySituation.get(situation) ?? []).filter(r => r.language === language);
}

/** The filled text of a situation: variant `variant` (an index, wrapped) of the layer's replies. */
export function say(situation, slots = {}, {variant = 0, language = 'en', layer = replyLayer()} = {}) {
  const options = variants(situation, {language, layer});
  if (!options.length) throw configError('reply_missing', `the conversation layer has no reply for the situation ${situation} (${language})`);
  return fill(options[((variant % options.length) + options.length) % options.length].text, slots, situation);
}

/** Shorthand for the renderer's lines: `line('yes')` is the situation `line_yes`. */
export const line = (name, slots, options) => say(`line_${name}`, slots, options);

/** A list joined by the layer's separator and conjunction ("a, b and c"). */
export function joinList(items, options) {
  if (items.length < 2) return items[0] ?? '';
  return line('list_and', {first: items.slice(0, -1).join(line('list_separator', {}, options)), last: items.at(-1)}, options);
}
