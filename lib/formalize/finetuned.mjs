/**
 * FineTunedSOP (DS028 "Routed formalizers"): a small model fine-tuned on (prompt, circuit) pairs (tools/finetune/) writes the circuit of
 * a question from a compact prompt, the candidate predicates of the question with their roles and the question, with no authoring guide.
 * It is served by Ploinky Workers on a tier of its own (default `finetuned`, for example an ollama provider); the reply is validated by
 * the request parser's validator, once: a small model gets no repair rounds, an invalid reply is `parse_failed`.
 */
import {runTask} from '../mrp/tasks.mjs';
import {stripThinking} from '../pworker.mjs';
import {validateQuery, unclearKind} from '../query-author/validate.mjs';
import {candidatePredicates} from '../query-author/retrieval.mjs';
import {extractSop} from '../query-author/one-shot/tier-backend.mjs';

/** The candidate predicate ids of a question (lexical, then the retrieve slot's), with `must` included and `exclude` left out. */
export function finetunedCandidates(question, lexicon, {k = 10, must = null, exclude = null, retrieval = null} = {}) {
  const ids = [...new Set([...(retrieval?.predicates ?? []).map(p => p.id), ...candidatePredicates(question, lexicon, {k}).map(p => p.id)])].filter(id => lexicon.predicates?.[id] && id !== exclude && (lexicon.predicates[id].roles ?? []).length);
  if (must && !ids.includes(must)) ids.splice(question.length % (Math.min(ids.length, k) + 1), 0, must);
  return ids.slice(0, k + (must ? 1 : 0)).map(id => ({id, roles: lexicon.predicates[id].roles.map(r => r.name), label: lexicon.predicates[id].labels?.en ?? id.replace(/_/g, ' ')}));
}

/** The compact prompt of the fine-tuned model (the same at training and at inference). */
export const finetunedPrompt = (question, candidates) => `PREDICATES:\n${candidates.map(c => `${c.id}(${c.roles.join(', ')}): ${c.label}`).join('\n')}\nQUESTION: ${question}\nCIRCUIT:`;

/** The strategy object of the request parser. */
export function finetunedStrategy({tier, client, tierReadiness = null}) {
  return {
    name: 'FineTunedSOP', tier, ladder: [tier], tag: `tier:${tier}@pworker#FineTunedSOP`, server: {stop: async () => {}},
    availability: async firstTier => tierReadiness ? tierReadiness(firstTier ?? tier) : {available: true, models: [tier], skipped: []},
    async run({message, lexicon, circuits = [], repo = null, session = null, firstTier = null, retrieval = null}) {
      const t0 = Date.now(), useTier = firstTier ?? tier;
      const prompt = finetunedPrompt(message, finetunedCandidates(message, lexicon, {retrieval}));
      const r = await runTask('mrp-finetuned', {prompt}, {client, tier: useTier});
      if (!r.ok) return {ok: false, status: 'failed', reason: r.error, steps: [], ms: Date.now() - t0};
      const sop = extractSop(stripThinking(String(r.value ?? '')));
      const v = validateQuery({sop, message, lexicon, circuits, repo, session});
      return {ok: v.ok, status: v.ok ? 'validated' : 'invalid', sop, validation: v, program: v.program, unclear: v.ok ? unclearKind(v.program) : null, steps: [{name: 'circuit', answer: sop.slice(0, 400), tier: useTier}], ms: Date.now() - t0, model: useTier};
    },
  };
}
