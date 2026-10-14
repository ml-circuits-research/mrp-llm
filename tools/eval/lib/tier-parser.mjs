/**
 * The request-parser settings of an evaluation tool (owner decision 2026-10-02): formalization is step by step only, and a tool chooses
 * WHO answers the step-by-step questions with `--tier <tiny|small|medium|good>` (one Ploinky tier, like with like: every tier answers the
 * same questions) or `--ladder` (the product's ladder queryParser.local.ladder, escalating per question). Without either, the product's
 * configured ladder runs. One-shot LLMDirect is archived (probably_obsolete/one-shot-formalization/).
 *
 *   import {tierParserSettings, tierOptions} from '../lib/tier-parser.mjs';   (from a harness folder of tools/eval)
 *   const settings = tierParserSettings(config, {tier: 'small', strategy: 'LocalLLMStepByStep', cacheEntries: 0});
 */
import {queryParserSettings} from '../../../server/query-parser.mjs';

/** The single-rung ladder of one tier with the request settings the product ladder gives it (e.g. reasoning off on `good`). */
export function tierLadder(config, tier) {
  const rung = (config.queryParser?.local?.ladder ?? []).find(r => (typeof r === 'string' ? r : r?.tier) === tier);
  return [rung && typeof rung === 'object' ? rung : tier];
}

/** `{tier, ladder}` from command-line arguments (`--tier X`, `--ladder`); a `tier` default applies only without `--ladder`. */
export function tierOptions(args, {tier = null} = {}) {
  const i = args.indexOf('--tier');
  const ladder = args.includes('--ladder');
  return {tier: i >= 0 ? args[i + 1] : ladder ? null : tier, ladder};
}

/**
 * Query-parser settings with the questions on `tier` (single rung) or the product ladder; `tags` ({purpose, run, noFallback}) tag the
 * Ploinky calls of the questions; `extra` merges into queryParser.
 */
export function tierParserSettings(config, {tier = null, ladder = false, tags = null, ...extra} = {}) {
  const base = config.queryParser?.local ?? {};
  const local = tier && !ladder ? {...base, tier, ladder: tierLadder(config, tier)} : {...base};
  if (tags) local.tags = tags;
  const set = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== null));
  return queryParserSettings({...config, queryParser: {...(config.queryParser ?? {}), ...set, local}});
}
