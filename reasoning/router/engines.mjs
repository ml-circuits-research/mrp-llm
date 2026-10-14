/**
 * The engines the StrategyRouter knows: the oracle (always), the three wire engines it may route to (`sql-sqlite`, `datalog-souffle`,
 * `asp-clingo`) and the engines that can only be requested by name (`datalog-e10`, `prolog-tabling`). All take the one wire-level
 * problem `{handle: {wires}, query: <text>}` and answer the packet of DS006.
 *
 * `available()` is probed once per process and only reads (a version call); nothing is installed. Qualification is the shadow gate
 * of DS006 (`eval/smoke-reasoning/run.mjs`, zero disagreements with the oracle on the cases the strategy declares it expresses,
 * observed 2026-10-02: sql-sqlite 81, datalog-souffle 68, asp-clingo 96 cases, all pass); `tests/reasoning/strategy-router.test.mjs` repeats
 * that gate on the cases of the router's classes.
 */
import {DatabaseSync} from 'node:sqlite';
import {ask as oracleAsk, capabilities as oracleCapabilities} from '../strategies/js-reference/index.mjs';
import sqlSqlite from '../strategies/sql-sqlite/index.mjs';
import datalogSouffle from '../strategies/datalog-souffle/index.mjs';
import aspClingo from '../strategies/asp-clingo/index.mjs';
import datalogE10 from '../strategies/datalog-e10/index.mjs';
import prologTabling from '../strategies/prolog-tabling/index.mjs';
import {probeSouffle} from '../strategies/datalog-souffle/runner.mjs';
import {clingoVersion} from '../strategies/asp-clingo/clingo.mjs';
import {swiplCommand} from '../strategies/prolog-tabling/swipl.mjs';
import {spawnSync} from 'node:child_process';

const cache = new Map();
const once = (id, probe) => { if (!cache.has(id)) { try { cache.set(id, probe()); } catch { cache.set(id, false); } } return cache.get(id); };

export const ORACLE_IDS = ['reference', 'js-reference', 'js-oracle'];
export const ORACLE = 'js-reference';

/** id -> {capabilities, ask, available(): boolean, routable}. `ask(problem, budget)` is synchronous. */
export const ENGINES = {
  'js-reference': {capabilities: oracleCapabilities, routable: false, available: () => true, ask: (p, b) => oracleAsk({handle: p.handle, queryWires: p.queryWires}, b)},
  'sql-sqlite': {capabilities: sqlSqlite.capabilities, routable: true, available: () => once('sql', () => { new DatabaseSync(':memory:').close(); return true; }), ask: (p, b) => sqlSqlite.ask({handle: p.handle, query: p.query}, b)},
  'datalog-souffle': {capabilities: datalogSouffle.capabilities, routable: true, available: () => once('souffle', () => probeSouffle().ok), ask: (p, b) => datalogSouffle.ask({handle: p.handle, query: p.query}, b, {conditional: false})},
  'asp-clingo': {capabilities: aspClingo.capabilities, routable: true, available: () => once('clingo', () => Boolean(clingoVersion())), ask: (p, b) => aspClingo.ask({handle: p.handle, query: p.query}, b, {conditional: false})},
  'datalog-e10': {capabilities: datalogE10.capabilities, routable: false, available: () => once('e10', () => true), ask: (p, b) => datalogE10.ask({handle: p.handle, query: p.query}, b, {conditional: false})},
  'prolog-tabling': {capabilities: prologTabling.capabilities, routable: false, available: () => once('swipl', () => { const r = spawnSync(swiplCommand(), ['--version'], {encoding: 'utf8', timeout: 5000}); return !r.error && r.status === 0; }), ask: (p, b) => prologTabling.ask({handle: p.handle, query: p.query}, b)},
};

/** The eligibility of an engine for a circuit: its declared features cover everything the circuit requires, and its limits hold. */
export function eligibility(id, features) {
  const {capabilities: c} = ENGINES[id];
  const missing = features.required.filter(r => !c.features.includes(r));
  const refused = features.required.filter(r => c.notExpressible.includes(r));
  const reasons = [];
  if (missing.length) reasons.push('lacks ' + missing.join(', '));
  if (refused.length) reasons.push('declares not expressible: ' + refused.join(', '));
  // exact decimals: a fixed-point engine needs a scale it can carry; an exact-rational engine carries any
  if (features.exact_arithmetic && c.exact?.kind === 'fixed_point') {
    const fp = features.fixed_point;
    const [lo, hi] = c.limits.integer_range;
    if (!fp?.ok) reasons.push('no exact fixed-point form: ' + (fp?.reason ?? 'unknown'));
    else if (fp.max_scaled > Math.min(hi, -lo)) reasons.push(`a scaled value (${fp.max_scaled}) is outside its integer range`);
  }
  const forms = features.host_forms.filter(k => !c.features.includes('query_' + k));
  if (forms.length) reasons.push('query forms not expressed: ' + forms.join(', '));
  if (features.wires > c.limits.max_wires) reasons.push(`above its limit of ${c.limits.max_wires} wires`);
  return {id, eligible: reasons.length === 0, why: reasons.join('; ')};
}
