/**
 * The Ploinky tasks of the MRP strategies (DS025 "Prompts as Ploinky tasks"): every strategy that calls a model keeps its prompts as a
 * Ploinky Workers phase map in Markdown under `config/tasks/<name>.md` (`## phase`, `### tier`, `### template`, `### code`, `### next`,
 * `### request`). A task runs in this process (`Pworker` of the `pworker` package): its model phases go through the caller's Ploinky
 * client, so the calls keep the caller's purpose, run and priority tags; its local phases (`tier null`) run in Ploinky's confined
 * sandbox and only compose prompts or read replies. What the sandbox cannot do (Node built-ins, the SOP validator, the memory) stays in
 * this process, between tasks.
 *
 * The tier written in a task file is the strategy's default; `runTask(..., {tier})` replaces the tier of every model phase with the
 * strategy's `tier` parameter. `extraBody` (config `mrp.extraBody`, for example thinking disabled) is added to every model call.
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Pworker, loadTask} from 'pworker';
import {jsonOf} from 'pworker/client';

export const TASKS_DIR = fileURLToPath(new URL('../../config/tasks/', import.meta.url));
const loaded = new Map();

/** The validated phase map of `config/tasks/<name>.md` (cached per process). */
export async function taskOf(name) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new TypeError(`invalid task name ${JSON.stringify(name)}`);
  if (!loaded.has(name)) loaded.set(name, loadTask(path.join(TASKS_DIR, `${name}.md`)));
  return structuredClone(await loaded.get(name));
}

/** The model tiers a task file names (its strategy's defaults). */
export async function tiersOf(name) { return [...new Set(Object.values(await taskOf(name)).map(p => p.tier).filter(t => t != null))]; }

/**
 * Runs one task to its end: `{ok, value, error, served, calls, ms}`. `client` is a Ploinky client (or a fake with `chat`); `input`
 * becomes the task's state; `tier` replaces the tier of every model phase.
 */
export async function runTask(name, input, options = {}) {
  return (await runTasks(name, [input], options))[0];
}

/**
 * Runs one task on several inputs in one worker flush: `[{ok, value, error, served, calls, ms}]` in input order. With `batch`, the
 * phases marked `batch: true` may share one model request (Ploinky's prompt batching: one instruction, a JSON list of inputs, one
 * result per id). `calls` counts the responses a member took part in; `requests` (the same on every result) counts the model requests
 * the whole flush sent, the number to report as cost.
 */
export async function runTasks(name, inputs, {client, tier = null, extraBody = null, batch = false, maxItems = 20} = {}) {
  const task = await taskOf(name);
  if (tier) for (const phase of Object.values(task)) if (phase.tier != null) phase.tier = tier;
  const tiers = [...new Set(Object.values(task).map(p => p.tier).filter(t => t != null))];
  const withBody = o => ({...o, ...(extraBody ? {extraBody: {...(o.extraBody ?? {}), ...extraBody}} : {})});
  const config = batch ? {batching: Object.fromEntries(tiers.map(t => [t, {enabled: true, maxItems}]))} : {};
  let requests = 0;
  const chat = o => { requests++; return client.chat(withBody(o)); };
  // A batched phase reads the reply as JSON ({results: {id: result}}), as the Ploinky client's own `json` does.
  const json = async o => { const r = await chat(o); if (!r.ok) return {...r, json: null}; const parsed = jsonOf(r.text); return parsed ? {...r, json: parsed} : {...r, ok: false, json: null, reason: 'the reply holds no JSON object'}; };
  const worker = new Pworker({client: {chat, json}, config});
  const t0 = Date.now();
  const ids = inputs.map(input => worker.enqueue(task, input));
  const byId = new Map((await worker.flush()).map(r => [r.id, r]));
  return ids.map(id => {
    const r = byId.get(id);
    const last = r.responses.at(-1) ?? null;
    return {ok: r.ok, value: r.value, error: r.error ?? null, served: last?.served ?? null, calls: r.responses.length, requests, ms: Date.now() - t0};
  });
}
