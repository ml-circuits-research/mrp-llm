/**
 * The step-by-step formalization protocol as base-memory data (AGENTS.md "Formalization improvement", DS022 "LocalLLMStepByStep" and
 * "InternalReasoningStepByStep"): the protocol layer `config/knowledge/formalizer-protocol-v1` plus the learned-rules layer
 * `config/knowledge/formalizer-learned-v1`. Both step-by-step strategies read their questions, choices, order and early exits here:
 * InternalReasoningStepByStep prepares the circuits for its planner (reasoner.mjs `loadProtocol`), LocalLLMStepByStep reads the facts.
 *
 * A fact is `@id fact` with one `holds <predicate> <args...>` line; `facts()` indexes them by predicate (namespace `fp_` stripped).
 * The learned layer may be replaced for one process by `useLearnedLayer(dir)` (the regression gate of a candidate change); the
 * returned function restores the shipped layer.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {seedCircuits, SEEDS_DIR} from '../knowledge-seeds.mjs';
import {words, unquote} from '../../sop/parser.mjs';

export const PROTOCOL_LAYER = 'formalizer-protocol-v1';
export const LEARNED_LAYER = 'formalizer-learned-v1';
const NS = 'fp_';

let learnedDir = null;
const cache = new Map();

/** Use `dir` (a folder of NNNN-name.sop files) as the learned layer until the returned restore function is called. */
export function useLearnedLayer(dir) {
  const before = learnedDir;
  learnedDir = dir;
  return () => { learnedDir = before; };
}

const ownCircuits = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.sop')).sort().map(file => ({name: file.replace(/^\d+-/, '').replace(/\.sop$/, ''), file, text: fs.readFileSync(path.join(dir, file), 'utf8')})) : [];

/** The circuits of the protocol and the learned layer, in that order: [{name, file, text, layer}]. */
export function protocolCircuits() {
  const learned = learnedDir ?? path.join(SEEDS_DIR, LEARNED_LAYER);
  return [...seedCircuits(PROTOCOL_LAYER).map(c => ({...c, layer: PROTOCOL_LAYER})), ...ownCircuits(learned).map(c => ({...c, layer: LEARNED_LAYER}))];
}

const term = t => t.startsWith('"') ? unquote(t) : /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : t;
const strip = p => p.startsWith(NS) ? p.slice(NS.length) : p;

/** The facts of circuits: Map predicate (without `fp_`) → [[args...]] in file order. */
export function factsOf(circuits) {
  const out = new Map();
  for (const c of circuits) {
    let inFact = false;
    for (const line of c.text.split('\n')) {
      if (/^@\S+/.test(line)) { inFact = /^@\S+\s+fact\s*$/.test(line); continue; }
      const m = inFact && /^\s+holds\s+(.+)$/.exec(line);
      if (!m) continue;
      const [p, ...args] = words(m[1].trim());
      const key = strip(p);
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(args.map(term));
    }
  }
  return out;
}

/** The protocol data of the current layers (cached per content digest): {version, circuits, rows(p), one(p, key)}. */
export const protocolData = () => dataOf(protocolCircuits());

/** The protocol data of explicit circuits (a candidate change is checked with the shipped layers plus its own wires). */
export function dataOf(circuits) {
  const version = createHash('sha256').update(circuits.map(c => `${c.layer ?? ''}/${c.file ?? c.name ?? ''}\n${c.text}`).join('\n')).digest('hex').slice(0, 16);
  if (cache.has(version)) return cache.get(version);
  const facts = factsOf(circuits);
  const rows = p => facts.get(p) ?? [];
  const data = {version, circuits, facts, rows, one: (p, ...key) => rows(p).find(r => key.every((k, i) => r[i] === k))?.[key.length] ?? null};
  cache.set(version, data);
  return data;
}
