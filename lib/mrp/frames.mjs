/**
 * FrameNet strategies (DS028 "Discovery strategies", "Routed formalizers"), through the strategy service (nltk FrameNet 1.7):
 *
 *   frame-seed    (discover) the frames that the verb lexemes of the memory's predicates evoke, and the lexical units of those frames,
 *                 become proposed `lexeme` wires (new phrases for an existing predicate, same frame of roles), each checked by the
 *                 knowledge validator, whose round trip through the relation linker refuses a phrase that would link elsewhere
 *   FrameGuided   (formalize) the frames that the lemmas of the message evoke select the predicates whose lexemes evoke the same frames;
 *                 SchemaGuidedLLM formalizes over those predicates only; a message that evokes none of them is unclear
 *
 * The map from predicates to frames is computed from the memory's lexemes and cached per lexicon version.
 */
import fs from 'node:fs';
import path from 'node:path';
import {serviceCall} from './strategy-service.mjs';
import {INDEX_DIR} from './retrieve.mjs';

const quote = s => JSON.stringify(String(s));
const cache = new Map();
// Light verbs and function words carry no frame of their own ("have a job at", "get"), and the generic predicates of every memory
// (is_a, part_of, description, has_property) belong to no domain frame.
const LIGHT = new Set(['be', 'is', 'are', 'a', 'an', 'the', 'of', 'at', 'in', 'on', 'to', 'by', 'for', 'with', 'from', 'have', 'has', 'get', 'got', 'make', 'do', 'take', 'give', 'go', 'hold', 'use']);
export const GENERIC = new Set(['is_a', 'part_of', 'description', 'has_property', 'has_occupation', 'named', 'means', 'refers_to', 'has']);
const headOf = form => String(form).toLowerCase().split(/\s+/).find(w => !LIGHT.has(w)) ?? null;

/** `{predicate: Set(frame)}` for the verb and noun lexemes of the lexicon. */
export async function predicateFrames(lexicon, call = serviceCall, dir = INDEX_DIR) {
  const key = lexicon.circuitsSha256 ?? lexicon.version;
  if (cache.has(key)) return cache.get(key);
  const file = path.join(dir, 'frames', `${String(key).slice(0, 24)}.json`);
  if (fs.existsSync(file)) { try { const m = new Map(JSON.parse(fs.readFileSync(file, 'utf8')).map(([id, f]) => [id, new Set(f)])); cache.set(key, m); return m; } catch { /* rebuilt below */ } }
  // The head of the predicate's label and of its verb lexemes (the first word that is not a light verb), as a verb or a noun.
  const heads = new Map();
  for (const p of Object.values(lexicon.predicates ?? {})) {
    if (GENERIC.has(p.id)) continue;
    const forms = [p.labels?.en, ...(p.lexemes ?? []).filter(l => ['verb', 'noun', 'copula'].includes(l.pos)).flatMap(l => l.forms)].filter(Boolean);
    for (const f of forms) { const h = headOf(f); if (h) for (const pos of ['v', 'n']) (heads.get(`${h}.${pos}`) ?? heads.set(`${h}.${pos}`, new Set()).get(`${h}.${pos}`)).add(p.id); }
  }
  const lemmas = [...heads.keys()];
  const frames = {};
  for (let i = 0; i < lemmas.length; i += 200) Object.assign(frames, (await call('frames', 'framenet', {lemmas: lemmas.slice(i, i + 200)})).frames);
  const out = new Map();
  for (const [lemma, ids] of heads) for (const f of frames[lemma] ?? []) for (const id of ids) (out.get(id) ?? out.set(id, new Set()).get(id)).add(f.frame);
  cache.set(key, out);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify([...out].map(([id, f]) => [id, [...f]])));
  return out;
}

/** The frames the content lemmas of a message evoke (spaCy lemmas, FrameNet lexical units). */
export async function messageFrames(message, call = serviceCall) {
  const {tokens} = await call('parse', 'spacy', {text: message});
  const lemmas = [...new Set(tokens.filter(t => ['VERB', 'NOUN'].includes(t.pos) && !LIGHT.has(t.lemma.toLowerCase())).map(t => `${t.lemma.toLowerCase()}.${t.pos === 'VERB' ? 'v' : 'n'}`))];
  const {frames} = await call('frames', 'framenet', {lemmas});
  return new Set(Object.values(frames).flat().map(f => f.frame));
}

/** frame-seed: proposed lexeme wires `[{name, text, predicate, frame, form}]` and what was skipped. */
export async function frameSeed({lexicon, validate, call = serviceCall, max = 40}) {
  const byPredicate = await predicateFrames(lexicon, call);
  const allFrames = [...new Set([...byPredicate.values()].flatMap(s => [...s]))];
  const {units} = allFrames.length ? await call('frames', 'units', {frames: allFrames}) : {units: {}};
  const proposed = [], skipped = [];
  // A lexical unit of the frame is proposed only when it is also a WordNet synonym of the predicate's head verb: frames hold antonyms
  // and neighbours (same_as: clash, rival), synonyms keep the meaning.
  const headsOf = id => [...new Set([lexicon.predicates[id].labels?.en, ...(lexicon.predicates[id].lexemes ?? []).flatMap(l => l.forms)].filter(Boolean).map(headOf).filter(Boolean))];
  const allHeads = [...new Set([...byPredicate.keys()].flatMap(headsOf))];
  const {synonyms} = allHeads.length ? await call('frames', 'synonyms', {lemmas: allHeads}) : {synonyms: {}};
  for (const [id, frames] of byPredicate) {
    const p = lexicon.predicates[id], known = new Set((p.lexemes ?? []).flatMap(l => l.forms.map(f => f.toLowerCase())));
    const roles = (p.roles ?? []).map(r => r.name);
    if (roles.length !== 2) continue;
    const near = new Set(headsOf(id).flatMap(h => synonyms[h] ?? []));
    for (const frame of frames) for (const lu of units[frame] ?? []) {
      if (!lu.endsWith('.v')) continue;
      const form = lu.slice(0, -2).replace(/_/g, ' ');
      if (!near.has(form)) continue;
      if (known.has(form) || proposed.some(x => x.predicate === id && x.form === form)) continue;
      const name = `lx_${id}_fn_${form.replace(/[^a-z0-9]+/g, '_')}`;
      const text = [`@${name} lexeme`, `  of ${id}`, '  language en', '  pos verb', `  form ${quote(form)}`, `  frame ${roles.join(' ')}`, `  source ${quote(`frame-seed FrameNet 1.7 ${frame}`)}`].join('\n') + '\n';
      const check = validate([{name: `discover-${name}`, text}]);
      if (check.ok) proposed.push({name: `discover-${name}`, text, predicate: id, frame, form});
      else skipped.push({predicate: id, form, reason: (check.problems ?? []).slice(0, 2).map(x => x.code).join(', ')});
      if (proposed.length >= max) return {proposed, skipped};
    }
  }
  return {proposed, skipped};
}

/** FrameGuided: the strategy object of the request parser over SchemaGuidedLLM (`schemaGuided.run({..., only})`). */
export function frameGuided({schemaGuided, call = serviceCall}) {
  return {...schemaGuided, name: 'FrameGuided', tag: schemaGuided.tag.replace('#SchemaGuidedLLM', '#FrameGuided'),
    async run(args) {
      const t0 = Date.now();
      const evoked = await messageFrames(args.message, call);
      const byPredicate = await predicateFrames(args.lexicon, call);
      const only = [...byPredicate].filter(([, frames]) => [...frames].some(f => evoked.has(f))).map(([id]) => id);
      const routing = {frames: [...evoked].slice(0, 20), predicates: only};
      if (!only.length) return {ok: true, status: 'validated', sop: '@c unclear\n  kind relation_not_in_memory\n', program: null, validation: {ok: true, problems: [], advice: []}, unclear: 'relation_not_in_memory', routing, model: args.firstTier ?? schemaGuided.tier, ms: Date.now() - t0, steps: []};
      const r = await schemaGuided.run({...args, only});
      return {...r, routing, ms: Date.now() - t0};
    }};
}
