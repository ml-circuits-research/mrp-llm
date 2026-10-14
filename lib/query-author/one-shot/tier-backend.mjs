/**
 * The completion backend of the one-shot authors DirectSOP and SchemaGuidedLLM (DS025 "The catalog", DS028 "Routed formalizers"): the
 * Ploinky task config/tasks/mrp-formalize-one-shot.md (lib/mrp/tasks.mjs) on the strategy's tier. The prompt is the context of the
 * archived completion backend (the rules, the guide and the vocabulary; the request as data); a repair round appends each previous
 * circuit with the validator's output, since a task phase sends one prompt. The reply is read as the content of `query.sop`; a reply cut
 * by its token limit fails the task and is never read as a circuit.
 */
import {runTask} from '../../mrp/tasks.mjs';

const strip = text => String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/g, '').trim();

/** The query.sop text of a model reply: the first code block that holds a wire, else everything from the first wire line. */
export function extractSop(reply) {
  const text = strip(reply);
  for (const m of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) if (/^\s*@\w+\s+\w+/m.test(m[1])) return m[1].trim();
  const start = text.search(/^@\w+\s+\w+/m);
  return start >= 0 ? text.slice(start).replace(/```[\s\S]*$/, '').trim() : '';
}

/** `client`: a Ploinky client (its purpose and run tags reach every call); `tier`: the tier recorded in the parse record. */
export function tierBackend({client, model, extraBody = null}) {
  return {
    id: 'completion', kind: 'completion', model,
    async generate({context, history = []}) {
      const repairs = history.map((turn, i) => `\n\n---\n\nYOUR query.sop OF ROUND ${i + 1}:\n${turn.sop}\n\n${context.repair(turn.problems)}`).join('');
      const t0 = Date.now();
      const r = await runTask('mrp-formalize-one-shot', {system: context.system, user: context.user, repairs}, {client, tier: model, extraBody});
      const usage = {turns: 1, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0};
      if (!r.ok) return {ok: false, sop: '', usage, duration_ms: Date.now() - t0, reason: r.error ?? 'the tier did not answer'};
      const sop = extractSop(r.value);
      return {ok: true, sop, raw: r.value, usage, duration_ms: Date.now() - t0, ...(r.served ? {served: r.served} : {}), ...(sop ? {} : {reason: 'the reply holds no wire'})};
    },
  };
}
