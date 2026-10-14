#!/usr/bin/env node
/**
 * Ploinky latency under load (inventory gap R8, 2026-10-03), on a local tier only: how long a short chat request takes through the
 * Ploinky proxy when 1, 2, 4, ... requests arrive at once, and how much an interactive request is delayed while background work
 * occupies the tier (priority classes of Ploinky). Every request is a fresh one-word question with the cache off, so the numbers are
 * the gateway plus the local model, never cache replays.
 *
 *   node tools/eval/pworker/load.mjs [--tier tiny] [--levels 1,2,4,8] [--rounds 2] [--background 6] [--probes 4] [--out DIR]
 *
 * Refuses a cloud tier (the measure must not spend plan credits) and does not start a server that is not running. Writes
 * <out>/rows.jsonl and <out>/summary.json (default eval/reports/current/pworker-load/<date>/) and prints the summary.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pworker, tierReadiness} from '../../../lib/pworker.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const LOCAL_TIERS = Object.freeze(['tiny', 'supertiny', 'micro']);
const PURPOSE = 'job:pworker-load';

/** p50, p90 and max of a list of milliseconds (nearest rank). */
export function quantiles(ms) {
  const s = [...ms].sort((a, b) => a - b), at = q => s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : null;
  return {n: s.length, p50: at(0.5), p90: at(0.9), max: s.at(-1) ?? null};
}

export async function measure({tier = 'tiny', levels = [1, 2, 4, 8], rounds = 2, background = 6, probes = 4, log = console.error} = {}) {
  if (!LOCAL_TIERS.includes(tier)) throw new Error(`tier ${tier} is not local (${LOCAL_TIERS.join(', ')}): the load measure never spends plan credits`);
  const ready = await tierReadiness(tier);
  if (!ready.available) throw new Error(`tier ${tier} is not available: ${ready.reason}`);
  const run = `pworker-load-${Date.now().toString(36)}`;
  const ta = pworker({purpose: PURPOSE, run, cache: 'off', autostart: false});
  let k = 0;
  const ask = async ({priority = 'interactive', maxTokens = 8, phase, level = null}) => {
    const id = ++k;
    const started = Date.now();
    const r = await ta.with({priority}).chat({tier, maxTokens, temperature: 0, stream: false, timeoutMs: 120_000, noFallback: true,
      extraBody: {chat_template_kwargs: {enable_thinking: false}}, messages: [{role: 'user', content: `Answer with the single word ok. Request ${run}-${id}.`}]});
    return {id, phase, level, priority, ok: r.ok, ms: Date.now() - started, served: r.served ?? null, cached: r.cached ?? null, reason: r.ok ? null : r.reason ?? null};
  };
  const rows = [];
  // A: concurrency levels, interactive priority.
  for (const level of levels) {
    for (let round = 0; round < rounds; round++) rows.push(...await Promise.all(Array.from({length: level}, () => ask({phase: 'concurrency', level}))));
    log(`concurrency ${level}: ${JSON.stringify(quantiles(rows.filter(r => r.level === level && r.ok).map(r => r.ms)))}`);
  }
  // B: interactive probes, one after another, while `background` longer background requests occupy the tier.
  const idle = [];
  for (let i = 0; i < probes; i++) idle.push(await ask({phase: 'idle-probe'}));
  const load = Array.from({length: background}, () => ask({phase: 'background', priority: 'background', maxTokens: 96}));
  await new Promise(r => setTimeout(r, 200));
  const loaded = [];
  for (let i = 0; i < probes; i++) loaded.push(await ask({phase: 'loaded-probe'}));
  rows.push(...idle, ...loaded, ...await Promise.all(load));
  const ok = phase => rows.filter(r => r.phase === phase && r.ok).map(r => r.ms);
  const summary = {tier, run, at: new Date().toISOString(), requests: rows.length, failed: rows.filter(r => !r.ok).length, cached: rows.filter(r => r.cached).length,
    served: [...new Set(rows.map(r => r.served).filter(Boolean))],
    concurrency: Object.fromEntries(levels.map(level => [level, quantiles(rows.filter(r => r.level === level && r.ok).map(r => r.ms))])),
    priority: {idle_interactive: quantiles(ok('idle-probe')), interactive_under_background: quantiles(ok('loaded-probe')), background: quantiles(ok('background')), background_requests: background}};
  return {rows, summary};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const out = path.resolve(opt('--out', path.join(ROOT, 'eval/reports/current/pworker-load', new Date().toISOString().slice(0, 10))));
  const {rows, summary} = await measure({tier: opt('--tier', 'tiny'), levels: opt('--levels', '1,2,4,8').split(',').map(Number), rounds: Number(opt('--rounds', 2)),
    background: Number(opt('--background', 6)), probes: Number(opt('--probes', 4))});
  fs.mkdirSync(out, {recursive: true});
  fs.writeFileSync(path.join(out, 'rows.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
  console.log(JSON.stringify(summary, null, 1));
}
