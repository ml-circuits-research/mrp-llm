/**
 * The SAE strategies of the discover slot (DS028 "Sparse autoencoder options"). The strategy service finds the features:
 * `sae-sentence-embeddings` trains a small sparse autoencoder on the dense embeddings of the passages (weights kept under
 * state/sae/<name>.pt, so SaeRouted can read the same features later); `sae-llm-activations` reads the residual stream of GPT-2 small
 * through its pre-trained SAEs (sae-lens release gpt2-small-res-jb). A strong tier names each feature from the passages that activate it
 * and picks the memory's predicates those passages express (the batchable Ploinky task mrp-discover-feature). Each named feature with
 * predicates becomes a proposed `schema` wire and an `extractor` wire whose trigger is the feature (`feature:sae:<name>:<id>`,
 * `feature:gpt2:<layer>:<id>`, strategy SaeRouted), queued for review; features only propose, they never decide.
 */
import path from 'node:path';
import {jsonOf, stripThinking} from '../pworker.mjs';
import {SAE_DIR} from '../formalize/routed-extractors.mjs';
import {serviceCall} from './strategy-service.mjs';

const quote = s => JSON.stringify(String(s));
const snake = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

export async function saeDiscover({strategy, passages, params = {}, run, lexicon, validate, model = 'model', call = serviceCall, now = new Date()}) {
  const stamp = now.toISOString().slice(0, 16).replace(/\D/g, '');
  let found, source;
  if (strategy === 'sae-sentence-embeddings') {
    const name = `${snake(model)}_${stamp}`;
    found = await call('sae', 'train', {passages, path: path.join(SAE_DIR, `${name}.pt`)}, {latents: params.latents ?? 512, epochs: params.epochs ?? 300, top: params.top ?? 30});
    source = `sae:${name}`;
  } else {
    found = await call('sae', 'gpt2', {passages}, {layer: params.layer ?? 6, top: params.top ?? 30});
    source = `gpt2:${params.layer ?? 6}`;
  }
  const predicates = Object.values(lexicon?.predicates ?? {}).map(p => `${p.id}: ${p.labels?.en ?? p.id}`).join('\n');
  const inputs = found.features.map(f => ({feature: `PREDICATES:\n${predicates}\n\nPASSAGES:\n${f.passages.map(i => `- ${String(passages[i]).slice(0, 400)}`).join('\n')}`}));
  const named = inputs.length ? await run('mrp-discover-feature', inputs, {tier: params.tier ?? 'good', batch: true}) : [];
  const proposed = [], skipped = [];
  found.features.forEach((f, i) => {
    const r = named[i];
    const j = r?.ok ? (r.value && typeof r.value === 'object' ? r.value : jsonOf(stripThinking(String(r.value ?? '')))) : null;
    const ids = (Array.isArray(j?.predicates) ? j.predicates : []).filter(id => lexicon?.predicates?.[id]);
    if (!j || !ids.length) { skipped.push({feature: f.id, reason: !j ? (r?.error ?? 'unreadable reply') : 'no predicate of the memory fits'}); return; }
    const n = `${snake(j.name) || 'feature'}_${f.id}`;
    const text = [`@s_${n} schema`, `  name ${quote(j.name ?? n)}`, `  provenance ${strategy}`, '  version 1', '  status proposed', ...(j.description ? [`  description ${quote(j.description)}`] : []),
      ...ids.map(id => `  predicate ~${id}`), `  source ${quote(`discover ${strategy} ${source}:${f.id}`)}`, '',
      `@ex_${n} extractor`, `  schema ~s_${n}`, '  strategy SaeRouted', `  trigger ${quote(`feature:${source}:${f.id}`)}`, '  task "mrp-formalize-one-shot"', '  output query', ''].join('\n');
    const check = validate([{name: `discover-${n}`, text}]);
    if (!check.ok) { skipped.push({feature: f.id, reason: (check.problems ?? []).slice(0, 3).map(p => p.code).join(', ')}); return; }
    proposed.push({name: `discover-${n}`, text, feature: f.id, predicates: ids});
  });
  return {strategy, source, features: found.features.length, proposed, skipped, calls: named[0]?.requests ?? 0};
}
