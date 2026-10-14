/**
 * The retrieve and memory slots of a Symbolic Model (DS025, DS028 "Retrieval for the formalizer"). The engine's slice stays exact and
 * demand-driven (the query's predicates and the closure of the rules, with the completeness guard); what these strategies choose is the
 * vocabulary the one-shot formalizers are offered: the candidate predicates of the prompt, ranked before the lexical candidates. A
 * question worded unlike the memory ("Who is employed by Acme?" for `works_at`) is where lexical retrieval fails and these help.
 *
 *   slice          nothing added: the lexical candidates of the formalizer (the default)
 *   splade-slice   SPLADE terms of the message against the SPLADE index of the memory's predicate documents (dot product)
 *   dense-slice    dense embeddings (cosine) against the dense index of the same documents
 *   graph-walk     the predicates of the facts about the entities the message names, one hop, then the predicates their objects carry
 *   hybrid-rerank  the union of the three, ranked by how many lists name a predicate and by rank, cut to `k`
 *
 * A predicate document is its label, description and lexeme forms followed by up to five example facts in words. Indexes (the memory
 * slot strategies splade-index and dense-index) are built from the layered circuits of the base memory on first use and kept under
 * state/indexes/<memory>/<kind>-<circuits sha>.json; a changed memory gets a new file. The strategy service only encodes texts.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parse} from '../../sop/knowledge/index.mjs';
import {entityHints} from '../query-author/retrieval.mjs';
import {serviceCall} from './strategy-service.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const INDEX_DIR = path.join(ROOT, 'state', 'indexes');
const memo = new Map();

const labelOf = (lexicon, id) => lexicon.entities?.[id]?.labels?.en ?? lexicon.predicates?.[id]?.labels?.en ?? String(id).replace(/_/g, ' ');

/** The facts of the circuits as `{p, args}` (ground `holds` lines of fact wires). */
export function factsOf(circuits) {
  const out = [];
  for (const c of circuits) {
    if (!/\bholds\b/.test(c.text)) continue;
    let wires;
    try { wires = parse(c.text).wires; } catch { continue; }
    for (const w of wires) {
      if (w.type !== 'fact') continue;
      const holds = w.fields.find(f => f.key === 'holds')?.value.trim();
      if (!holds || holds.startsWith('not ')) continue;
      const [p, ...args] = holds.split(/\s+/);
      out.push({p, args: args.map(a => a.replace(/^"|"$/g, ''))});
    }
  }
  return out;
}

/** One document per predicate of the lexicon: `[{predicate, text}]`. */
export function predicateDocuments(lexicon, facts, {examples = 5} = {}) {
  const byPredicate = new Map();
  for (const f of facts) { const list = byPredicate.get(f.p) ?? byPredicate.set(f.p, []).get(f.p); if (list.length < examples) list.push(f); }
  return Object.values(lexicon.predicates ?? {}).map(p => {
    const forms = [...new Set((p.lexemes ?? []).flatMap(l => l.forms))].slice(0, 8);
    const sample = (byPredicate.get(p.id) ?? []).map(f => `${labelOf(lexicon, f.args[0])} ${p.labels?.en ?? p.id.replace(/_/g, ' ')} ${f.args.slice(1).map(a => labelOf(lexicon, a)).join(' ')}`.trim());
    return {predicate: p.id, text: [p.labels?.en ?? p.id.replace(/_/g, ' '), p.description, forms.length ? `phrases: ${forms.join('; ')}` : '', sample.length ? `examples: ${sample.join('; ')}` : ''].filter(Boolean).join('. ')};
  });
}

const shaOf = circuits => createHash('sha256').update(circuits.map(c => c.name + '\0' + c.text).join('\0')).digest('hex').slice(0, 16);

/** The index of `kind` (`splade` or `dense`) for a memory: built and stored on first use. `encode(texts)` returns the vectors. */
export async function memoryIndex({memory, kind, lexicon, circuits, encode = defaultEncoder(kind), dir = INDEX_DIR}) {
  const file = path.join(dir, memory, `${kind}-${shaOf(circuits)}.json`);
  if (memo.has(file)) return memo.get(file);
  let index = null;
  if (fs.existsSync(file)) { try { index = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { index = null; } }
  if (!index) {
    const docs = predicateDocuments(lexicon, factsOf(circuits));
    const vectors = [];
    for (let i = 0; i < docs.length; i += 64) vectors.push(...await encode(docs.slice(i, i + 64).map(d => d.text)));
    index = {memory, kind, built: new Date().toISOString(), docs: docs.map((d, i) => ({predicate: d.predicate, vector: vectors[i]}))};
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify(index));
  }
  memo.set(file, index);
  return index;
}

/** The encoders of the strategy service: SPLADE term weights or normalized dense vectors. */
export const defaultEncoder = kind => async texts => (await serviceCall('encode', kind, {texts})).vectors;

const dot = (q, d) => { let s = 0; for (const [t, w] of Object.entries(q)) if (d[t]) s += w * d[t]; return s; };
const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

async function ranked(kind, {memory, english, lexicon, circuits, k, encode}) {
  const index = await memoryIndex({memory, kind, lexicon, circuits, ...(encode ? {encode: encode(kind)} : {})});
  const [q] = await (encode ? encode(kind) : defaultEncoder(kind))([english]);
  const score = kind === 'splade' ? dot : cosine;
  return index.docs.map(d => ({id: d.predicate, score: Math.round(score(q, d.vector) * 1000) / 1000})).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

/** graph-walk: the predicates of the facts about the entities the message names (one hop, then the objects' facts). */
export function graphWalk({english, lexicon, circuits, k = 12}) {
  const seeds = new Set(entityHints(english, lexicon).flatMap(m => m.candidates.map(c => c.id)));
  if (!seeds.size) return [];
  const facts = factsOf(circuits);
  const count = new Map(), next = new Set();
  for (const f of facts) if (f.args.some(a => seeds.has(a))) { count.set(f.p, (count.get(f.p) ?? 0) + 2); for (const a of f.args) if (!seeds.has(a)) next.add(a); }
  for (const f of facts) if (f.args.some(a => next.has(a))) count.set(f.p, (count.get(f.p) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id, n]) => ({id, score: n}));
}

/**
 * The candidate predicates of a turn for a retrieve strategy: `{strategy, predicates: [{id, score, why}]}`, or null for `slice`.
 * `encode(kind)` replaces the service encoders (tests).
 */
export async function retrieveCandidates({strategy, params = {}, memory, english, lexicon, circuits, encode = null}) {
  const k = params.k ?? 12;
  const args = {memory, english, lexicon, circuits, k, encode};
  const tag = (list, why) => list.map(r => ({...r, why}));
  if (strategy === 'slice') return null;
  if (strategy === 'splade-slice') return {strategy, predicates: tag(await ranked('splade', args), 'splade')};
  if (strategy === 'dense-slice') return {strategy, predicates: tag(await ranked('dense', args), 'dense')};
  if (strategy === 'graph-walk') return {strategy, predicates: tag(graphWalk(args), 'graph')};
  if (strategy === 'hybrid-rerank') {
    const lists = [await ranked('splade', args), await ranked('dense', args), graphWalk(args)];
    const score = new Map();
    lists.forEach(list => list.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 + (k - i) / k)));
    return {strategy, predicates: [...score].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id, s]) => ({id, score: Math.round(s * 1000) / 1000, why: 'hybrid'}))};
  }
  throw new TypeError(`unknown retrieve strategy ${strategy}`);
}
