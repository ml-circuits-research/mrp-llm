#!/usr/bin/env node
/**
 * The smoke-suite arm of the StrategyRouter measurement (reasoning/router, preregistration status/preregistrations/router-v1.json).
 *
 *   node tools/eval/engines/router-smoke.mjs [--out eval/reports/current/router/smoke.json]
 *
 * Every case of eval/smoke-reasoning/cases (knowledge.sop + query.sop; the retrieval cases with a memory.json are skipped, they test
 * the slice path) is asked twice at the wire level: through the oracle alone (`reference`) and through the router (`auto`) with the size
 * thresholds forced to zero and verification off, so that every circuit an installed engine can express is ROUTED to it (the shadow gate
 * of DS006 on the router's classes). Reported: how many cases the router sent to an engine, how many to the oracle and why, and whether
 * the routed packet equals the oracle's (status, completeness, rows, count). A disagreement is a defect of the router or of an engine.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from '../../../sop/knowledge/index.mjs';
import {routedAsk, samePacket, ROUTER_DEFAULTS} from '../../../reasoning/router/index.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const casesDir = path.join(project, 'eval/smoke-reasoning/cases');

export function smokeArm({config = {...ROUTER_DEFAULTS, small_facts: {recursion: 0, other: 0}}} = {}) {
  const rows = [];
  for (const dir of fs.readdirSync(casesDir).sort()) {
    const p = f => path.join(casesDir, dir, f);
    if (!fs.existsSync(p('knowledge.sop')) || fs.existsSync(p('memory.json'))) continue;
    const knowledge = fs.readFileSync(p('knowledge.sop'), 'utf8'), query = fs.readFileSync(p('query.sop'), 'utf8');
    const {wires, errors} = parse(knowledge);
    if (errors.length) { rows.push({case: dir, skipped: 'knowledge does not parse'}); continue; }
    const handle = {kind: 'js-reference-handle', knowledge, wires};
    const run = requested => { const t = performance.now(); try { return {packet: routedAsk({handle, query, requested, verify: 'never', config}), ms: Math.round(performance.now() - t)}; } catch (e) { return {error: String(e.message ?? e).slice(0, 160), ms: Math.round(performance.now() - t)}; } };
    const oracle = run('reference'), routed = run('auto');
    const row = {case: dir, oracle_ms: oracle.ms, router_ms: routed.ms, chosen: routed.packet?.route?.chosen ?? null, rule: routed.packet?.route?.rule ?? null};
    if (oracle.error || routed.error) { row.agree = oracle.error !== undefined && routed.error !== undefined ? true : false; row.error = {oracle: oracle.error ?? null, router: routed.error ?? null}; }
    else row.agree = samePacket(oracle.packet, routed.packet);
    rows.push(row);
  }
  const counted = rows.filter(r => r.agree !== undefined);
  return {
    cases: counted.length, routed_to_engine: counted.filter(r => r.chosen && r.chosen !== 'js-reference').length,
    routed_to_oracle: counted.filter(r => r.chosen === 'js-reference').length, errors_in_both: counted.filter(r => r.error).length,
    agree: counted.filter(r => r.agree).length, disagree: counted.filter(r => !r.agree).map(r => r.case),
    by_engine: Object.fromEntries([...new Set(counted.map(r => r.chosen))].map(e => [e, counted.filter(r => r.chosen === e).length])),
    by_rule: Object.fromEntries([...new Set(counted.map(r => r.rule))].map(e => [e, counted.filter(r => r.rule === e).length])),
    rows,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(project, i >= 0 ? process.argv[i + 1] : 'eval/reports/current/router/smoke.json');
  const result = smokeArm();
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify({generated: new Date().toISOString(), note: 'Regenerable observation (tools/eval/engines/router-smoke.mjs).', ...result}, null, 1) + '\n');
  const {rows, ...summary} = result;
  console.log(JSON.stringify(summary));
}
