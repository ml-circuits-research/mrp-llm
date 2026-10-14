/**
 * Checks of books-triage (pure functions): one JSONL line per item with a known layer and a non-empty reason. The layer vocabulary is
 * the operating loop's (TODO.md section 0); the deterministic rules of tools/eval/books/triage.mjs decide every row they can before this job.
 */
const LAYERS = new Set(['formalization', 'knowledge', 'engine', 'construct', 'gold', 'infrastructure']);

export function check(item, output) {
  const rec = output?.records?.[0] ?? null;
  const problems = [];
  if (!rec || !LAYERS.has(rec.layer)) problems.push(`layer must be one of ${[...LAYERS].join(', ')}`);
  if (!rec?.reason || String(rec.reason).trim().length < 8) problems.push('reason is missing or too short');
  if (problems.length) return {ok: false, problems, hint: 'Reply with exactly one JSON line: {"id": ..., "layer": ..., "faithful": ..., "sub": ..., "reason": ..., "fix": ...}.'};
  return {ok: true, value: rec};
}
