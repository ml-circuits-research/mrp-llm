/**
 * Mode `stepwise` of ChatSOPAdapter: the step-by-step formalizer (DS022 "Formalization strategies", server/query-parser.mjs) writes
 * the circuit of the message and the chat turn (server/agent.mjs) admits, links, routes, verifies with the oracle and renders it, in
 * the session's own memory and conversation context. The formalization is one (no agreement): `unverified` in the adapter's sense; the
 * runtime's own oracle verification of the circuit stays in `packet.route.verification`.
 *
 * `parserFormalizer` is the one circuit author of the chat, the API and the evaluations: the request parser's `parse` for the
 * session's lexicon, preferred first tier and strategy; it records the parse record for the trace.
 */
export function parserFormalizer(queryParser, {lexicon, source = 'chat', preferredModel = null, request = {}, label = 'formalizer (direct model call)'} = {}) {
  const author = {id: 'formalizer', label, parse: null, formalize: async message => {
    // `request`: further fields of the parse request (the strategy of strategyRequest, the message language).
    const done = await queryParser.parse({source, message, lexicon, memoryKey: lexicon?.circuitsSha256 ?? null, preferredModel, ...request});
    author.parse = done.parse; author.id = 'formalizer:' + (done.parse.model ?? done.parse.strategy ?? 'none');
    return done.sop;
  }};
  return author;
}

/**
 * The stepwise turn: `ctx.stepwise` = {agent, formalizer} (a circuit author {id, formalize}; tests and replays inject their own).
 * Returns the adapter's answer fields plus `turn` (the chat turn's full result) and `parse`.
 */
export async function stepwise(ctx, message) {
  const {agent, formalizer, turnOptions = {}} = ctx.stepwise ?? {};
  if (!agent || typeof formalizer?.formalize !== 'function') throw Object.assign(new Error('mode stepwise needs a chat agent and a circuit author'), {code: 'adapter_misconfigured', status: 500});
  const t0 = performance.now();
  const turn = await agent.turn(message, {...turnOptions, formalizer}).catch(error => { error.parse = error.parse ?? formalizer.parse ?? null; throw error; });
  const ms = Math.round(performance.now() - t0);
  const packet = turn.packet ?? {};
  const result = {path: 'stepwise', status: packet.status ?? 'error', answers: [], values: [], circuits: [turn.sop].filter(Boolean), packets: [packet], proofs: packet.proof ? [packet.proof] : [], ms,
    tier: formalizer.parse?.model ?? null, calls: formalizer.parse?.steps ?? null, cached: formalizer.parse?.cache === 'hit', detail: {strategy: formalizer.parse?.strategy ?? null}};
  return {route: null, results: [result], chosen: result, turn, parse: formalizer.parse ?? null, timings: {stepwise: ms}, tiers: {stepwise: formalizer.parse?.ladder ?? formalizer.parse?.model ?? null},
    verification: {status: 'unverified', paths: ['stepwise'], runtime: packet.route?.verification ?? null}};
}
