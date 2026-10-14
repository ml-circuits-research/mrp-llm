/**
 * SpladeRouted and SaeRouted (DS028 "Routed formalizers"): the interpreter is chosen by what the message is sensitive to. The `extractor`
 * wires of the memory name a schema, a formalize strategy and triggers; the message activates triggers, the extractors whose triggers
 * fire are selected, and their strategy formalizes the message restricted to the predicates of their schemas (SchemaGuidedLLM's closed
 * vocabulary). A message that fires no extractor is `unclear kind relation_not_in_memory`: it is never sent to a default interpreter.
 *
 *   SpladeRouted  a trigger is a term (`work`, or `term:work`): it fires when the SPLADE expansion of the message holds that term
 *                 (weight at least `minWeight`), so "employed" fires the trigger "work" through the expansion
 *   SaeRouted     a trigger is a feature: `feature:sae:<name>:<id>` (a sparse autoencoder trained by discover sae-sentence-embeddings,
 *                 weights under state/sae/<name>.pt) or `feature:gpt2:<layer>:<id>` (the pre-trained GPT-2 small residual SAEs of
 *                 sae-llm-activations); it fires when the feature is active on the message
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serviceCall} from '../mrp/strategy-service.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SAE_DIR = path.join(ROOT, 'state', 'sae');
const UNCLEAR = '@c unclear\n  kind relation_not_in_memory\n';

/** The extractors whose term triggers fire on the SPLADE terms of the message: `[{extractor, fired: [terms]}]`. */
export function spladeSelect(extractors, terms, {minWeight = 0.3} = {}) {
  return extractors.map(x => ({extractor: x, fired: x.triggers.map(t => t.replace(/^term:/, '').toLowerCase()).filter(t => !t.startsWith('feature:') && (terms[t] ?? 0) >= minWeight)})).filter(r => r.fired.length);
}

/** The extractors whose feature triggers are active: `active` maps `sae:<name>` or `gpt2:<layer>` to the set of active feature ids. */
export function saeSelect(extractors, active) {
  return extractors.map(x => ({extractor: x, fired: x.triggers.filter(t => { const m = /^feature:(sae:[\w-]+|gpt2:\d+):(\d+)$/.exec(t); return m && active.get(m[1])?.has(Number(m[2])); })})).filter(r => r.fired.length);
}

/** The feature sources the extractors name, and the active features of the message under each: Map(source -> Set(id)). */
async function activeFeatures(extractors, message, call) {
  const sources = new Set(extractors.flatMap(x => x.triggers.map(t => /^feature:(sae:[\w-]+|gpt2:\d+):\d+$/.exec(t)?.[1]).filter(Boolean)));
  const active = new Map();
  for (const source of sources) {
    const [kind, arg] = source.split(':');
    const out = kind === 'sae' ? await call('sae', 'encode', {path: path.join(SAE_DIR, `${arg}.pt`), texts: [message], top: 16}) : await call('sae', 'gpt2-encode', {texts: [message], top: 32}, {layer: Number(arg)});
    active.set(source, new Set(out.features[0].map(f => f.id)));
  }
  return active;
}

/**
 * The strategy object of the request parser: `kind` is `splade` or `sae`; `schemaGuided` is the SchemaGuidedLLM strategy object (its
 * `run({..., only})` restricted to the selected schemas' predicates). `call` replaces the strategy service (tests).
 */
export function routedExtractors({kind, schemaGuided, call = serviceCall}) {
  const name = kind === 'splade' ? 'SpladeRouted' : 'SaeRouted';
  return {...schemaGuided, name, tag: schemaGuided.tag.replace('#SchemaGuidedLLM', `#${name}`),
    async run(args) {
      const t0 = Date.now(), lexicon = args.lexicon;
      const extractors = (lexicon?.extractors ?? []).filter(x => lexicon.schemas?.[x.schema] && lexicon.schemas[x.schema].status !== 'deprecated');
      let selected;
      if (kind === 'splade') {
        const [terms] = (await call('encode', 'splade', {texts: [args.message], top: 64})).vectors;
        selected = spladeSelect(extractors, terms);
      } else selected = saeSelect(extractors, await activeFeatures(extractors, args.message, call));
      const routing = {extractors: selected.map(r => ({id: r.extractor.id, schema: r.extractor.schema, fired: r.fired})), considered: extractors.length};
      if (!selected.length) return {ok: true, status: 'validated', sop: UNCLEAR, program: null, validation: {ok: true, problems: [], advice: []}, unclear: 'relation_not_in_memory', routing, model: args.firstTier ?? schemaGuided.tier, ms: Date.now() - t0, steps: []};
      const only = [...new Set(selected.flatMap(r => lexicon.schemas[r.extractor.schema].predicates))];
      const r = await schemaGuided.run({...args, only});
      return {...r, routing, ms: Date.now() - t0};
    }};
}
