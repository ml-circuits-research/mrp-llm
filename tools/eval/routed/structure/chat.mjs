/**
 * The chat client of a Ploinky tier for the closed-question paths of the structure/formalizer evaluations: ChatSOPAdapter's own client
 * (lib/adapter/clients.mjs), so the evaluations call the tiers exactly as the chat does (greedy, no thinking, tagged, counting cache
 * hits; no fallback for an evaluation). Evaluation harness only.
 */
import {tierChat as adapterChat} from '../../../../lib/adapter/clients.mjs';

/** tierChat(tier, {purpose, run, cache, timeoutMs, thinking}) with the tier's fallback off. */
export const tierChat = (tier, options = {}) => adapterChat(tier, {...options, noFallback: true});
