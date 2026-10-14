/**
 * The settings of ChatSOPAdapter: the defaults merged with `config.adapter` (config/runtime.json), then with a session's or a request's
 * options. Tiers are proxy tier names (AGENTS.md "Proxy tiers"), never models.
 *
 *   mode                     stepwise | routed | direct-verified (the chat default; a session or a request may choose another)
 *   tiers.structure          the structure role (PSM) of the routed paths
 *   tiers.formalizer         the FOL formalizer role (the proxy names its role prompt, today fol-v2)
 *   tiers.compute            the chat tier of path B, jsEval and engineCode
 *   tiers.direct             the chat tier of the direct answer (mode direct-verified)
 *   routed.second            the second formalizations of a compute problem, in order: jsEval, engineCode
 *   routed.engineCodeLanguages   the engine languages of the engineCode call (each a formalization of its own)
 *   routed.fallbackToFol     a compute problem whose compute paths answer nothing goes to FOL
 *   routed.earlyStop         stop asking further formalizations once two agree (and, in direct-verified, once one verifies the answer)
 *   purpose / run / cache / noFallback / timeoutSeconds   the proxy tags of every call
 */
export const MODE_NAMES = Object.freeze(['stepwise', 'routed', 'direct-verified']);
/** The modes a request may name: the built-in ones and those registered later (lib/adapter/index.mjs registerMode). */
export const KNOWN_MODES = new Set(MODE_NAMES);

export const DEFAULT_ADAPTER = Object.freeze({
  mode: 'stepwise',
  tiers: Object.freeze({structure: 'structure', formalizer: 'formalizer', compute: 'tiny', direct: 'tiny'}),
  routed: Object.freeze({second: Object.freeze(['jsEval', 'engineCode']), engineCodeLanguages: Object.freeze(['js', 'smt']), fallbackToFol: true, earlyStop: true}),
  purpose: 'formalize', run: null, cache: null, noFallback: false, timeoutSeconds: 300,
});

const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => {
  const out = {...a};
  for (const [k, v] of Object.entries(b ?? {})) if (v !== undefined && !k.startsWith('_')) out[k] = isObject(v) && isObject(a?.[k]) ? merge(a[k], v) : v;
  return out;
};

/** The adapter settings of a runtime configuration, with `overrides` (a session's or a request's options) on top. */
export function adapterSettings(config = {}, overrides = {}) {
  const s = merge(merge(DEFAULT_ADAPTER, config.adapter ?? {}), overrides);
  if (!KNOWN_MODES.has(s.mode)) throw Object.assign(new Error(`adapter mode must be one of ${[...KNOWN_MODES].join(', ')} (got ${JSON.stringify(s.mode)})`), {code: 'invalid_parameter', status: 400});
  return s;
}

/** The checked options a client may send for a turn ({mode, ...}); unknown keys are refused. */
export function checkAdapterOptions(options) {
  if (options === undefined || options === null) return {};
  if (!isObject(options)) throw Object.assign(new Error('adapter must be an object {mode, options?}'), {code: 'invalid_parameter', status: 400});
  const known = new Set(['mode', 'options']);
  const bad = Object.keys(options).filter(k => !known.has(k));
  if (bad.length) throw Object.assign(new Error(`unknown adapter field ${bad[0]}; known: mode, options`), {code: 'invalid_parameter', status: 400});
  if (options.mode !== undefined && !KNOWN_MODES.has(options.mode)) throw Object.assign(new Error(`adapter.mode must be one of ${[...KNOWN_MODES].join(', ')}`), {code: 'invalid_parameter', status: 400});
  const extra = options.options ?? {};
  if (!isObject(extra)) throw Object.assign(new Error('adapter.options must be an object'), {code: 'invalid_parameter', status: 400});
  const allowed = new Set(['tiers', 'routed']);
  const unknown = Object.keys(extra).filter(k => !allowed.has(k));
  if (unknown.length) throw Object.assign(new Error(`unknown adapter option ${unknown[0]}; known: tiers, routed`), {code: 'invalid_parameter', status: 400});
  for (const [k, v] of Object.entries(extra.tiers ?? {})) if (!['structure', 'formalizer', 'compute', 'direct'].includes(k) || typeof v !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(v)) throw Object.assign(new Error(`adapter tier ${k} must name a proxy tier`), {code: 'invalid_parameter', status: 400});
  return {...(options.mode ? {mode: options.mode} : {}), ...extra};
}
