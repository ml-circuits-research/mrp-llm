/**
 * The message acts of the reply memory (P-2.1, owner request of 2026-10-03; DS023 "The pragmatic wire"): what a message does besides
 * asking or stating (a greeting, how are you, a joke request, grief, a manipulation attempt, ...) is data of the conversation layers,
 * not a list in code. A layer declares
 *
 *   cv_act_group GROUP "line"        a group, asked as one line of the coarse question (groups in file order; a group without a line is not asked)
 *   cv_act KIND GROUP                an act and its group
 *   cv_act_description KIND "line"   the act as one line of the fine question
 *   cv_act_example KIND "message"    a short example message
 *   cv_act_standalone KIND           the act can be the whole request (the protocol then asks whether the message also asks about the world)
 *   cv_act_span KIND "what"          the protocol copies this part of the message verbatim as the span of the wire
 *   cv_act_sets_slot KIND SLOT       the span fills this conversation slot from this turn on (user_name)
 *
 * The admission accepts a `pragmatic` kind only when the reply memory declares it (sop/parser.mjs, the `pragmatic` wire); the
 * step-by-step protocol builds its act questions from the same data (lib/query-author/step-by-step/protocol.mjs).
 *
 *   messageActs(layer)  -> {version, groups: [{id, line, acts: [act]}], acts: Map(kind -> act), kinds: [kind]}
 *     act = {kind, group, description, examples, standalone, span, slot}
 */
import {parse} from './knowledge/lexical.mjs';
import {replyLayer} from './replies.mjs';

const cache = new Map();
/** The terms of a `holds` line: symbols and JSON-quoted texts (this module is imported by sop/parser.mjs, so it does not import it). */
const words = line => [...String(line).matchAll(/"(?:\\.|[^"\\])*"|\S+/g)].map(m => m[0]);
const term = t => (t.startsWith('"') ? JSON.parse(t) : t);

/** The facts `holds <predicate> ...` of circuits, in file order: Map predicate -> [[args...]]. */
function factsOf(circuits) {
  const out = new Map();
  for (const c of circuits) for (const w of parse(c.text).wires) {
    if (w.type !== 'fact') continue;
    const holds = w.fields.find(f => f.key === 'holds')?.value.trim();
    if (!holds) continue;
    const [p, ...args] = words(holds);
    if (!p.startsWith('cv_act')) continue;
    if (!out.has(p)) out.set(p, []);
    out.get(p).push(args.map(term));
  }
  return out;
}

/** The message acts declared by the layers of a reply memory (default: the layer in use). Cached per layer version. */
export function messageActs(layer = replyLayer()) {
  if (cache.has(layer.version)) return cache.get(layer.version);
  const facts = factsOf(layer.circuits);
  const rows = p => facts.get(p) ?? [];
  const acts = new Map();
  for (const [kind, group] of rows('cv_act')) if (!acts.has(kind)) acts.set(kind, {kind, group, description: null, examples: [], standalone: false, span: null, slot: null});
  for (const [kind, text] of rows('cv_act_description')) if (acts.has(kind)) acts.get(kind).description = text;
  for (const [kind, text] of rows('cv_act_example')) acts.get(kind)?.examples.push(text);
  for (const [kind] of rows('cv_act_standalone')) if (acts.has(kind)) acts.get(kind).standalone = true;
  for (const [kind, text] of rows('cv_act_span')) if (acts.has(kind)) acts.get(kind).span = text;
  for (const [kind, slot] of rows('cv_act_sets_slot')) if (acts.has(kind)) acts.get(kind).slot = slot;
  const seen = new Set();
  const groups = rows('cv_act_group').filter(([id]) => !seen.has(id) && seen.add(id)).map(([id, line]) => ({id, line, acts: [...acts.values()].filter(a => a.group === id && a.description)})).filter(g => g.acts.length);
  const out = {version: layer.version, groups, acts, kinds: [...acts.keys()]};
  cache.set(layer.version, out);
  return out;
}

/** Whether the reply memory declares `kind` as a message act. */
export const isMessageAct = (kind, layer) => messageActs(layer).acts.has(kind);
