/**
 * Mode `direct-verified` of ChatSOPAdapter (owner decision 2026-10-03): the model (tier `direct`, default `tiny`) answers the problem
 * directly with a short FINAL ANSWER (./../paths/direct.mjs); the adapter then tries to verify that answer symbolically with the routed
 * formalizations (./routed.mjs), comparing answers with lib/formalize/equivalence.mjs (symbolic checks first, no model tier):
 *   verified      a symbolic path gives an equivalent answer: the model's answer, verified (with the agreeing paths)
 *   contradicted  two symbolic paths agree with each other on a value the catalog decides is different from the model's: that value
 *                 is answered (the model's answer reported); an `unknown` verdict is no contradiction
 *   unverified    otherwise: the model's answer, clearly labelled as not verified
 * With `routed.earlyStop` the formalizations stop as soon as one verifies the answer. When the model gives no readable answer, the
 * routed decision answers (its own verification status), labelled as such.
 */
import {symbolicPaths} from './routed.mjs';
import {pathDirect} from '../paths/direct.mjs';
import {decideAgreement, directVerdict, agreementGroups} from '../agreement.mjs';

export async function directVerified(ctx, message) {
  const {settings, clients} = ctx;
  const direct = await pathDirect({message, chat: clients.chat(settings.tiers.direct)});
  const text = direct.status === 'ok' ? direct.answers.map(a => a.value).join(', ') : null;
  const verdicts = new Map();
  const check = async results => {
    for (const r of results) if (!verdicts.has(r) && r.values?.length && text !== null) verdicts.set(r, await directVerdict(text, r, {problem: message, lexicon: ctx.lexicon ?? null}));
    return [...verdicts.entries()].find(([, v]) => v.verdict === 'equivalent')?.[0] ?? null;
  };
  const earlyStop = settings.routed.earlyStop !== false && text !== null;
  const s = await symbolicPaths(ctx, message, {stop: async results => earlyStop && (await check(results)) !== null});
  const agreeing = await check(s.results);
  const timings = {direct: direct.ms, ...s.timings}, tiers = {direct: settings.tiers.direct, ...s.tiers};
  const base = {route: s.route, results: [direct, ...s.results], timings, tiers, direct: {status: direct.status, text, verdicts: [...verdicts.entries()].map(([r, v]) => ({path: r.path, verdict: v.verdict, check: v.check}))}};
  if (text === null) {
    const d = decideAgreement(s.results);
    return {...base, chosen: d.chosen, verification: {status: d.status === 'none' ? 'unresolved' : d.status, paths: d.paths, alternatives: d.alternatives, direct: 'unavailable'}};
  }
  if (agreeing) {
    const paths = ['direct', ...[...verdicts.entries()].filter(([, v]) => v.verdict === 'equivalent').map(([r]) => r.path)];
    return {...base, chosen: direct, verification: {status: 'verified', paths, check: verdicts.get(agreeing).check}};
  }
  // Two symbolic paths agreeing with each other on a value the equivalence catalog decided is DIFFERENT from the model's: that value
  // is answered. An `unknown` verdict (a list against one value, a time against a number) is no contradiction: the model's answer stays.
  const group = agreementGroups(s.results.filter(r => r.status === 'ok')).find(g => g.length >= 2 && g.every(r => verdicts.get(r)?.verdict === 'different'));
  if (group) return {...base, chosen: group[0], verification: {status: 'contradicted', paths: group.map(r => r.path), model_answer: text}};
  return {...base, chosen: direct, verification: {status: 'unverified', paths: ['direct'], alternatives: s.results.filter(r => r.values?.length).map(r => ({path: r.path, values: r.values}))}};
}
