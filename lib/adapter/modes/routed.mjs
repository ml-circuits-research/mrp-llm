/**
 * Mode `routed` of ChatSOPAdapter (owner decision 2026-10-03):
 *   1. the structure role (tier `structure`) and the deterministic route (lib/formalize/structure/route.mjs);
 *   2. a compute problem: path B first, then the second formalizations in order (jsEval, engineCode with its languages), stopping
 *      once two formalizations agree (`routed.earlyStop`); when no compute path answers, FOL (`routed.fallbackToFol`);
 *   3. every other problem: FOL v2.
 * Everything executes on our engines (the oracle for an unlowerable jsEval program, the sandboxed engines for engineCode), with the
 * static data-dependency checks of each path and the FOL converters' withholding of unsafe closed-world answers.
 * Verification: two different formalizations that agree give `verified`; a single answered path gives `unverified` (formalized once);
 * several that disagree give `unresolved` (the primary's answer, the others reported); nothing answered gives `unresolved` without an
 * answer.
 */
import {registryOf} from '../../formalize/expression-program.mjs';
import {structureRoute} from '../paths/structure.mjs';
import {pathB, pathJsEval} from '../paths/compute.mjs';
import {pathEngineCode} from '../paths/engine-code.mjs';
import {pathFol} from '../paths/fol.mjs';
import {decideAgreement} from '../agreement.mjs';

/**
 * The symbolic formalizations of a message: {route, results: [pathResult], timings, tiers}. `await stop(results)` is asked after every
 * step of the compute route (early stop); the FOL fallback runs only when no compute path answered.
 */
export async function symbolicPaths(ctx, message, {stop = () => false} = {}) {
  const {settings, clients, executor} = ctx;
  const timings = {}, tiers = {}, results = [];
  const route = await structureRoute({message, structure: clients.structure(settings.tiers.structure)});
  timings.structure = route.ms; tiers.structure = settings.tiers.structure;
  const registry = registryOf(message);
  const fol = async () => {
    const r = await pathFol({message, fol: clients.fol(settings.tiers.formalizer), executor, names: route.names, registry, tier: settings.tiers.formalizer});
    timings.fol = r.ms; tiers.fol = settings.tiers.formalizer; results.push(r);
  };
  if (route.route === 'js') {
    const steps = [['B', () => pathB({message, chat: clients.chat(settings.tiers.compute), executor, registry})]];
    for (const name of settings.routed.second ?? []) {
      if (name === 'jsEval') steps.push(['jsEval', () => pathJsEval({message, chat: clients.chat(settings.tiers.compute), executor, registry})]);
      else if (name === 'engineCode') steps.push(['engineCode', async () => (await pathEngineCode({message, chat: clients.chat(settings.tiers.compute), registry, langs: settings.routed.engineCodeLanguages})).results]);
      else throw Object.assign(new Error(`unknown second formalization ${name}`), {code: 'invalid_parameter', status: 400});
    }
    for (const [name, run] of steps) {
      const out = [].concat(await run());
      results.push(...out);
      timings[name] = Math.max(...out.map(r => r.ms)); tiers.compute = settings.tiers.compute;
      if (await stop(results)) break;
    }
    if (settings.routed.fallbackToFol && !results.some(r => r.status === 'ok')) await fol();
  } else await fol();
  return {route: {route: route.route, reason: route.reason, goal: route.goal, quantities: route.quantities, numbers: route.numbers, structure_ok: route.ok, ...(route.error ? {error: route.error} : {})}, results, timings, tiers};
}

/** The routed answer of a message: the adapter's answer fields (./index.mjs `answerPacket`). */
export async function routed(ctx, message) {
  const earlyStop = ctx.settings.routed.earlyStop !== false;
  const s = await symbolicPaths(ctx, message, {stop: results => earlyStop && decideAgreement(results).status === 'verified'});
  const d = decideAgreement(s.results);
  return {...s, chosen: d.chosen, verification: {status: d.status === 'none' ? 'unresolved' : d.status, paths: d.paths, alternatives: d.alternatives, ...(d.sameCall ? {same_call: true} : {})}};
}
