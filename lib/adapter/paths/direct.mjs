/**
 * The direct path of ChatSOPAdapter (mode `direct-verified`): the model solves the problem itself and ends with one line
 * `FINAL ANSWER: <short answer>` (role prompt config/prompts/direct-v1.md, data). Only that line is read: a value, a choice,
 * yes/no or a short list, parts separated by semicolons. A reply without the line, or whose final answer is itself a calculation, is
 * asked once more with the format reminder. The direct answer is never a proof: the adapter tries to verify it symbolically.
 * Structure only: the marker the question asks for, the length of the line and an `=` sign.
 */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseTemplate, fill} from '../../prompt-template.mjs';
import {allCached} from '../clients.mjs';
import {pathResult} from './result.mjs';

export const DIRECT_PROMPT = fileURLToPath(new URL('../../../config/prompts/direct-v1.md', import.meta.url));
let template = null;
const loadTemplate = (file = DIRECT_PROMPT) => (template && file === DIRECT_PROMPT ? template : (template = parseTemplate(fs.readFileSync(file, 'utf8'))));

/** The short final answer of a reply, or null (no marker); {invalid} when the line is a calculation or too long. */
export function finalAnswerOf(text) {
  const t = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\*\*|`|\\boxed\{([^}]*)\}/g, '$1');
  const all = [...t.matchAll(/final\s+answer\s*[:=]\s*(.+)/gi)];
  if (!all.length) return null;
  const line = all.at(-1)[1].trim().replace(/[.\s]+$/, '');
  if (!line) return null;
  if (line.length > 120 || /=/.test(line)) return {invalid: 'the final answer must be the answer only, short, without a calculation'};
  return line;
}

/** The direct answer of a message: pathResult('direct') with answers [{kind: 'text', value: part}] and detail.text (the whole line). */
export async function pathDirect({message, chat, file = DIRECT_PROMPT}) {
  const t0 = performance.now();
  const t = loadTemplate(file), budget = t.options.maxTokens ?? 1200;
  const messages = [{role: 'system', content: t.system}, {role: 'user', content: fill(t.user, {problem: message})}];
  const attempts = [];
  for (let round = 0; round < 2; round++) {
    const reply = await chat(messages, budget);
    attempts.push({answer: reply.ok ? reply.text : null, reason: reply.ok ? null : reply.reason ?? 'no answer'});
    if (!reply.ok) return pathResult('direct', {status: 'unavailable', tier: chat.tier ?? null, calls: chat.calls, cached: allCached(chat), ms: Math.round(performance.now() - t0), detail: {attempts}});
    const line = finalAnswerOf(reply.text);
    if (typeof line === 'string') {
      const parts = line.split(/\s*;\s*/).filter(Boolean);
      return pathResult('direct', {status: 'ok', answers: parts.map(value => ({kind: 'text', value})), tier: chat.tier ?? null, calls: chat.calls, cached: allCached(chat),
        ms: Math.round(performance.now() - t0), detail: {text: line, attempts: attempts.length}});
    }
    messages.push({role: 'assistant', content: reply.text}, {role: 'user', content: t.again});
  }
  return pathResult('direct', {status: 'rejected', tier: chat.tier ?? null, calls: chat.calls, cached: allCached(chat), ms: Math.round(performance.now() - t0), detail: {attempts, why: 'no FINAL ANSWER line'}});
}
