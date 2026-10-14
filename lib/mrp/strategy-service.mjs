/**
 * The client of the MRP strategy service (DS028 "External strategies", services/strategy-service/server.py): the strategies that need
 * Python run in a local process with a two-call HTTP API, `GET /selfcheck` (which strategies it can run, which packages are missing)
 * and `POST /run {slot, strategy, input, params}` (`{ok, output, trace}`). The service never calls a language model.
 *
 * Its address is `MRP_STRATEGY_SERVICE_URL` or config `mrp.strategyService.url` (default http://127.0.0.1:18090); start it with
 * `python3 services/strategy-service/server.py`. A service that does not answer makes its strategies unavailable with that reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:18090';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SERVICE_SCRIPT = path.join(ROOT, 'services', 'strategy-service', 'server.py');
/** The Python of the strategy service: MRP_PYTHON, else the private environment tools/.solvers/mrp-env (dependencies.md), else python3. */
export function servicePython(env = process.env) {
  if (env.MRP_PYTHON) return env.MRP_PYTHON;
  const own = path.join(ROOT, 'tools', '.solvers', 'mrp-env', 'bin', 'python');
  return fs.existsSync(own) ? own : 'python3';
}
let configured = null;
const cache = new Map();

/** Sets the service address from the runtime configuration (server start-up). */
export function configureStrategyService(url) { configured = url ?? null; cache.clear(); }
export const serviceUrl = (env = process.env) => (env.MRP_STRATEGY_SERVICE_URL ?? configured ?? DEFAULT_SERVICE_URL).replace(/\/+$/, '');

/** The service's self-check, cached for 30 s: `{ok, strategies: {"slot/id": {available, missing, reason?}}}` or `{ok: false, reason}`. */
export async function serviceSelfcheck({url = serviceUrl(), fetchImpl = globalThis.fetch, now = Date.now()} = {}) {
  const hit = cache.get(url);
  if (hit && now - hit.at < 30_000) return hit.value;
  let value;
  try {
    const r = await fetchImpl(`${url}/selfcheck`, {signal: AbortSignal.timeout(1500)});
    value = r.ok ? await r.json() : {ok: false, reason: `the strategy service answered ${r.status}`};
  } catch (e) { value = {ok: false, reason: `the strategy service at ${url} does not answer (start: python3 services/strategy-service/server.py)`}; }
  cache.set(url, {at: now, value});
  return value;
}

/** Whether the service runs `slot/id` now: `{available, reason?}`. */
export async function serviceAvailability(slot, id, options = {}) {
  const check = await serviceSelfcheck(options);
  if (!check.ok) return {available: false, reason: check.reason};
  const s = check.strategies?.[`${slot}/${id}`];
  if (!s) return {available: false, reason: `the strategy service has no strategy ${slot}/${id}`};
  return s.available ? {available: true} : {available: false, reason: `the strategy service: ${s.reason ?? 'unavailable'}`};
}

/** Runs one strategy in the service: `{ok, output, trace}` or `{ok: false, error}`. */
export async function runService(slot, id, input, params = {}, {url = serviceUrl(), fetchImpl = globalThis.fetch, timeoutMs = 600_000} = {}) {
  try {
    const r = await fetchImpl(`${url}/run`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({slot, strategy: id, input, params}), signal: AbortSignal.timeout(timeoutMs)});
    const body = await r.json().catch(() => null);
    return body ?? {ok: false, error: `the strategy service answered ${r.status} without JSON`};
  } catch (e) { return {ok: false, error: `the strategy service did not answer: ${e.message}`}; }
}

/**
 * Starts the strategy service as a child process when none answers at `url` (config `mrp.strategyService.autostart`, default true):
 * `{child, started}`; the child is stopped with the parent. Waits up to `waitMs` for its self-check.
 */
export async function startStrategyService({url = serviceUrl(), waitMs = 15_000, env = process.env} = {}) {
  configured ??= url;
  if ((await serviceSelfcheck({url, now: 0})).ok) return {child: null, started: false};
  const port = new URL(url).port || '18090';
  const child = spawn(servicePython(env), ['-I', SERVICE_SCRIPT], {env: {...env, MRP_STRATEGY_SERVICE_PORT: port}, stdio: 'ignore'});
  const stop = () => { try { child.kill(); } catch { /* already gone */ } };
  process.once('exit', stop);
  for (const t0 = Date.now(); Date.now() - t0 < waitMs;) {
    await new Promise(r => setTimeout(r, 250));
    cache.delete(url);
    if ((await serviceSelfcheck({url})).ok) return {child, started: true, stop};
  }
  return {child, started: false, stop, reason: 'the strategy service did not answer its self-check in time'};
}

/** One operation of the service that must succeed: its output, or an Error with the service's reason. */
export async function serviceCall(slot, id, input, params = {}, options = {}) {
  const r = await runService(slot, id, input, params, options);
  if (!r.ok) throw Object.assign(new Error(`strategy service ${slot}/${id}: ${r.error}`), {code: 'strategy_failed'});
  return r.output;
}
