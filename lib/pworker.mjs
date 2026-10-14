/**
 * MRP-LLM's access to models: every model call goes through the Ploinky Workers proxy (`pworker`, the sibling project
 * Ploinky-Worker, installed as the `pworker` dependency), by tier name, tagged with a purpose; no module calls a model endpoint
 * itself (tests/pworker/no-direct-model-calls.test.mjs). One proxy serves one Pworker home (~/.pworker or PWORKER_HOME) on
 * http://127.0.0.1:18080 (PWORKER_URL); a client starts it when none answers. Which provider and model serve a tier, and the API
 * keys, are Ploinky configuration (the user layer ~/.pworker/config.json and keys/), edited from /admin (lib/mrp/pworker-admin.mjs).
 *
 *   const pw = pworker({purpose: 'formalize'});
 *   const r = await pw.chat({tier: 'tiny', messages, maxTokens: 400, temperature: 0});   // {ok, text, finish, cut, served, cached, ...}
 *
 * `fetchImpl` is the transport (tests pass a fake that answers the Ploinky HTTP API).
 */
import {createPworkerClient} from 'pworker/client';

export {jsonOf, stripThinking, PworkerUnavailable} from 'pworker/client';

/** The Ploinky project layer of MRP-LLM: none. Tiers and keys belong to the user's Pworker home, so every program shares one mapping. */
export const PWORKER_CONFIG_FILE = null;

/** A Ploinky client (`purpose` required: chat, formalize, answer-*, normalize, voice, ingest, discover, bench:<name>, test:<name>). */
export function pworker({purpose, run = null, client = null, cache = null, fetchImpl = null, url = null, autostart = null, priority = null} = {}) {
  return createPworkerClient({purpose, run, client: client ?? 'mrp-llm', cache, fetchImpl, url, autostart, priority, config: PWORKER_CONFIG_FILE});
}

/** Whether the proxy serves `tier` (from its tier list), with the reason when it does not; never starts anything. */
export async function tierReadiness(tier, {fetchImpl = null, url = null} = {}) {
  const pw = pworker({purpose: 'chat', fetchImpl, url, autostart: false});
  for (const wait of [1, 3]) {
    try {
      const tiers = await Promise.race([pw.tiers(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000 * wait))]);
      const item = Array.isArray(tiers) ? tiers.find(t => t === tier || t?.id === tier) : null;
      if (item && !item.x_tier?.error) return {available: true};
      return {available: false, reason: item?.x_tier?.error ?? `the Ploinky proxy has no tier ${tier}`};
    } catch (error) {
      if (error?.code === 'pworker_unavailable') return {available: false, reason: error.message};
    }
  }
  return {available: false, reason: 'the Ploinky proxy did not answer in time'};
}
