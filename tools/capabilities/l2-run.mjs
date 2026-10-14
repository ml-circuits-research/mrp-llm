#!/usr/bin/env node
/**
 * Runs the L2 programs of the capability battery (tools/capabilities/l2-generator.mjs) on the js-reference oracle and on every engine.
 * Outcome of one engine on one program:
 *   a  agrees with the oracle (status, rows, count, bound; status only for `explain`)
 *   n  honest refusal: NotExpressibleError, or a packet status unsupported / not_expressible / not_computable
 *   b  honest budget stop (complete false or budget_exhausted)
 *   d  a DIFFERENT answer (a bug: wrong, or a capability the engine should have refused)
 *   e  an error other than an honest refusal while the oracle answered
 *   u  the engine is not available on this machine
 *   -  not compared: the oracle itself stopped at its budget on this program
 * A metamorphic variant (`of` set) is also compared with the oracle's answer on its base program (`m`: a = same, d = different).
 *
 *   node tools/capabilities/l2-run.mjs [--tier fast|full] [--shard k/N] [--engines id,id] [--ids substring]   prints JSON results
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {battery} from './l2-generator.mjs';

export const ENGINES = ['sql-sqlite', 'datalog-souffle', 'datalog-e10', 'asp-clingo', 'prolog-tabling', 'z3-smt-bounded', 'worlds-sopr', 'closure-template'];
/** Wall budget per engine call: a slower engine reports an honest budget stop (b), which the gate tracks like any other outcome. */
export const ENGINE_TIMEOUT_MS = 4000;
const REFUSALS = new Set(['unsupported', 'not_expressible', 'not_computable']);

async function load(id) {
  const m = await import(`../../reasoning/strategies/${id}/index.mjs`);
  return m.default ?? m;
}

const canonValue = v => {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return String(Number(v));
  return typeof v === 'string' ? v : JSON.stringify(v);
};
/** The comparable part of a packet; `map` renames entity values back (the rename relation). */
export function normalize(packet, {mode, map = null} = {}) {
  const value = v => { const c = canonValue(v); return map?.[c] ?? c; };
  const rows = (packet.rows ?? []).map(r => JSON.stringify(Object.entries(r).map(([k, v]) => [k, value(v)]).sort())).sort();
  if (mode === 'explain') return JSON.stringify({status: packet.status});
  const sets = xs => (xs ?? []).map(set => JSON.stringify([...set].map(a => String(a).replace(/\S+/g, w => map?.[w] ?? w)).sort())).sort();
  // a blocker's `support` is one sufficient set and may differ between correct engines: the blocked atom and the reason are compared
  if (mode === 'why_not') return JSON.stringify({status: packet.status, missing: sets(packet.missing), blockers: sets((packet.blockers ?? []).map(b => [`${b.atom} ${b.why}`]))});
  if (mode === 'abduce') return JSON.stringify({status: packet.status, hypotheses: sets(packet.hypotheses)});
  // candidates (Q-LANG-10): the effect class of each candidate, or the explaining sets of candidate ids and the necessary ones
  if (mode === 'effect') return JSON.stringify({status: packet.status, effects: (packet.effects ?? []).map(e => `${e.candidate}:${e.effect}`).sort()});
  if (mode === 'candidates') return JSON.stringify({status: packet.status, explanations: sets((packet.explanations ?? []).map(e => e.hypotheses)), necessary: [...(packet.necessary ?? [])].sort()});
  return JSON.stringify({status: packet.status, rows, count: packet.count ?? null, bound: packet.bound ?? null});
}

const isRefusal = e => /NotExpressible/.test(e?.name ?? '') || /NotExpressible/.test(e?.constructor?.name ?? '');

export async function runPrograms(programs, {engines = ENGINES} = {}) {
  const oracle = await load('js-reference');
  const loaded = {};
  for (const id of engines) { const e = await load(id); loaded[id] = {e, ok: (await e.available?.() ?? {ok: true}).ok}; }
  const baseAnswers = new Map();
  const results = [];
  for (const p of programs) {
    const mode = p.row.candidates && p.row.mode === 'abduce' ? 'candidates' : p.row.mode;
    const problem = {theory: {knowledge: p.knowledge}, query: p.query};
    const res = {id: p.id, of: p.of ?? null, relation: p.relation ?? null, row: p.row, outcomes: {}, ms: {}};
    let expected;
    try {
      const packet = oracle.ask(problem, {}, {conditional: false});
      expected = normalize(packet, {mode, map: p.map});
      // why_not of the solver engines returns the MINIMUM-cardinality sets of additions, the oracle every inclusion-minimal set
      // (reasoning/strategies/asp-clingo/abduce.mjs): an engine is compared with the oracle's sets of the smallest size
      if (mode === 'why_not' && packet.missing?.length) {
        const least = Math.min(...packet.missing.map(m => m.length));
        res.solverExpected = normalize({...packet, missing: packet.missing.filter(m => m.length === least)}, {mode, map: p.map});
      }
      res.oracle = {status: packet.status, complete: packet.complete !== false && packet.status !== 'budget_exhausted'};
      // an incomplete oracle answer is no reference: the program is recorded, the engines are not compared on it
      if (!res.oracle.complete) { for (const id of engines) res.outcomes[id] = '-'; results.push(res); continue; }
    } catch (e) {
      res.oracle = {error: e.message.split('\n')[0], refused: isRefusal(e)};
      results.push(res);
      continue;
    }
    if (!p.of) baseAnswers.set(p.id, expected);
    else if (baseAnswers.has(p.of)) res.metamorphic = baseAnswers.get(p.of) === expected ? 'a' : 'd';
    if (res.metamorphic === 'd') res.metamorphicDetail = {base: baseAnswers.get(p.of), variant: expected};
    for (const id of engines) {
      if (!loaded[id].ok) { res.outcomes[id] = 'u'; continue; }
      const t0 = performance.now();
      try {
        const packet = await loaded[id].e.ask(problem, {timeoutMs: ENGINE_TIMEOUT_MS}, {conditional: false});
        if (REFUSALS.has(packet.status)) res.outcomes[id] = 'n';
        else if (packet.complete === false || packet.status === 'budget_exhausted') res.outcomes[id] = 'b';
        else {
          const got = normalize(packet, {mode, map: p.map});
          const ok = got === expected || (res.solverExpected !== undefined && got === res.solverExpected);
          res.outcomes[id] = ok ? 'a' : 'd';
          if (!ok) (res.details ??= {})[id] = {expected, got};
        }
      } catch (e) {
        if (isRefusal(e)) { res.outcomes[id] = 'n'; (res.refusals ??= {})[id] = String(e.message).split('\n')[0].slice(0, 160); }
        else { res.outcomes[id] = 'e'; (res.details ??= {})[id] = {error: String(e.message).split('\n')[0].slice(0, 300)}; }
      }
      res.ms[id] = Math.round(performance.now() - t0);
    }
    results.push(res);
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const tier = opt('--tier', 'fast');
  let {programs} = battery(tier);
  const filter = opt('--ids', null);
  if (filter) programs = programs.filter(p => p.id.includes(filter) || p.of?.includes(filter));
  const shard = opt('--shard', null);
  if (shard) {
    const [k, n] = shard.split('/').map(Number);
    // a variant stays in the shard of its base program (the metamorphic comparison needs the base answer)
    const bases = programs.filter(p => !p.of).map(p => p.id);
    const mine = new Set(bases.filter((_, i) => i % n === k));
    programs = programs.filter(p => mine.has(p.of ?? p.id));
  }
  const engines = opt('--engines', null)?.split(',') ?? ENGINES;
  const results = await runPrograms(programs, {engines});
  process.stdout.write(JSON.stringify(results) + '\n');
}
