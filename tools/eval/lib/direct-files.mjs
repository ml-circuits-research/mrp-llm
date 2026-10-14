/**
 * Direct replacement of the earlier fenced file-agent runs (owner order 2026-10-02: no omp on any path). A task folder holds TASK.md and
 * input files; the model gets them in one message through Ploinky (`lib/llm-providers.mjs`), and the JSON lines or text of its reply
 * are written to the output file of the folder, so the callers keep reading the same files. Never throws for a model failure.
 *   const r = await runDirect({folder, model: 'openference/Qwen3.8 27b', files: ['TASK.md', 'input/facts.txt'], output: 'answers.jsonl', prompt: '...'});
 *   -> {ok, reason?, usage, duration_ms, model}
 */
import fs from 'node:fs';
import path from 'node:path';
import {providerChat, parseEntry} from '../../../lib/llm-providers.mjs';

export const DEFAULT_MODEL = 'openference/Qwen3.8 27b';

/** The model's reply as the lines of the output file: JSON lines only when `jsonl`, else the reply without a code fence. */
export function outputLines(text, {jsonl = true} = {}) {
  const body = String(text).replace(/^```[a-z]*\n?/im, '').replace(/```\s*$/m, '');
  if (!jsonl) return body.trim() + '\n';
  const lines = [];
  for (const line of body.split('\n').map(l => l.trim())) {
    if (!line.startsWith('{')) continue;
    try { JSON.parse(line); lines.push(line); } catch { /* not a JSON line */ }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

export async function runDirect({folder, model = DEFAULT_MODEL, files = [], prompt, output, jsonl = true, timeoutMs = 600_000, maxTokens = 16000, config = {}} = {}) {
  const started = Date.now();
  const entry = parseEntry(model);
  const parts = files.map(f => `=== ${f} ===\n${fs.readFileSync(path.join(folder, f), 'utf8')}`);
  const r = await providerChat({prompt: `${prompt}\n\nReply with the content of ${output} only (no explanation, no code fence).\n\n${parts.join('\n\n')}`, ...(entry.tier ? {provider: entry.tier} : {provider: entry.provider, model: entry.model}), config, timeoutMs, maxTokens, purpose: 'job:direct-files'});
  const duration_ms = Date.now() - started;
  if (!r.ok) return {ok: false, reason: r.reason, usage: r.usage ?? null, duration_ms, model: r.model};
  const content = outputLines(r.text, {jsonl});
  if (!content.trim()) return {ok: false, reason: 'the reply holds no output lines', usage: r.usage ?? null, duration_ms, model: r.model};
  fs.writeFileSync(path.join(folder, output), content);
  return {ok: true, usage: r.usage ?? null, duration_ms, model: r.model};
}
