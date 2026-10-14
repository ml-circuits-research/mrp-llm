/**
 * The structure role of ChatSOPAdapter: the `structure` tier (PSM, schema config/formalize/psm-schema-v1.json) marks the spans of a
 * problem (quantities, goals, entities, ...); the deterministic route (lib/formalize/structure/route.mjs) sends a problem whose goal lies
 * in a question unit and that has registry quantities to the compute paths, every other problem to FOL. The entity spans become the
 * names the FOL constants link to. Labels, offsets and digits only; no word of the problem is interpreted here.
 */
import {loadSchema, schemaRequest} from '../../formalize/structure/schema.mjs';
import {structureToIr} from '../../formalize/structure/to-ir.mjs';
import {routeOf} from '../../formalize/structure/route.mjs';

let schema = null;

/** {route, reason, goal, quantities, numbers, names: Map, extraction, ms, cached, ok, error?}. `structure` is ./clients.mjs structureClient. */
export async function structureRoute({message, structure}) {
  schema ??= loadSchema();
  const t0 = performance.now();
  const r = await structure(schemaRequest(schema, message));
  const extraction = r.ok ? r.body : {error: r.reason};
  const route = routeOf(extraction, message);
  const names = r.ok ? structureToIr(extraction, message).names : new Map();
  return {...route, names, extraction, ok: r.ok, ...(r.ok ? {} : {error: r.reason}), ms: Math.round(performance.now() - t0), cached: r.cached ?? null};
}
