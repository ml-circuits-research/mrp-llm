#!/usr/bin/env node
/**
 * The "no capability loss" gate of the capability battery (owner request 2026-10-02). It runs
 *   L1  every generated and hand-written validation case (tools/capabilities/l1.mjs) and the converter cases of the FOL path
 *       (tools/capabilities/l1-fol.mjs: fixed fol-v3 lines converted and executed on the product route, no model),
 *   L2  the generated programs of the tier on the oracle and on every engine (tools/capabilities/l2-run.mjs, in parallel workers),
 *   L3  nothing: it reads the last formalization run (eval/capabilities/l3/results.json, written by tools/capabilities/l3-run.mjs),
 * and compares the outcomes with the committed ledger eval/capabilities/ledger.json:
 *   loss      a case or program/engine cell that passed in the ledger and does not pass now (an engine that agreed and now refuses
 *             or answers differently, a validation case that passed and now fails, an L3 message answered and now not); a metamorphic
 *             relation that held and now does not
 *   failure   a NEW wrong answer: an engine that answers differently from the oracle (d) or crashes (e), a metamorphic relation broken, an
 *             oracle error, where the ledger did not already record it
 * The check fails on any loss or failure. `--update` writes the ledger from a full run; when the run loses something it is refused
 * unless `--accept-loss "<reason>"` is given, which records the reason in the ledger and in the project journal.
 *
 *   node tools/capabilities/check.mjs [--tier fast|full] [--workers N] [--update] [--accept-loss "reason"] [--report]
 * `--report` also writes eval/reports/current/capabilities/check-<tier>.json with the per-capability table.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {allCases, runCase} from './l1.mjs';
import {runFolCases} from './l1-fol.mjs';
import {battery} from './l2-generator.mjs';
import {ENGINES} from './l2-run.mjs';
import {knowledgeTags} from './tags.mjs';
import {loadInventory, ROOT} from './inventory.mjs';
import {combinationsOf} from './coverage.mjs';

export const LEDGER = path.join(ROOT, 'eval/capabilities/ledger.json');
export const L3_RESULTS = path.join(ROOT, 'eval/capabilities/l3/results.json');
const REPORTS = path.join(ROOT, 'eval/reports/current/capabilities');
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const loadLedger = (file = LEDGER) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

/** Wall limit of one L2 worker; a worker past it is killed with its whole process group (solver children included). */
const SHARD_WALL_MS = 15 * 60_000;
/**
 * L2 in `workers` child processes (the engines spawn solvers synchronously). At most 4 workers: the solvers are processes of their own,
 * and the battery must leave the machine to other work. Each worker leads its own process group, killed after it ends or times out,
 * so no solver outlives the check.
 */
export async function runL2(tier, workers = Math.max(1, Math.min(4, os.availableParallelism?.() ?? 2))) {
  const killGroup = child => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
  const one = k => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, 'l2-run.mjs'), '--tier', tier, '--shard', `${k}/${workers}`], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    let out = '', err = '';
    const timer = setTimeout(() => { err += `\nkilled after ${SHARD_WALL_MS / 1000} s`; killGroup(child); }, SHARD_WALL_MS);
    const onExit = () => killGroup(child);
    process.once('exit', onExit);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => {
      clearTimeout(timer);
      process.removeListener('exit', onExit);
      killGroup(child);
      if (code === 0) resolve(JSON.parse(out)); else reject(new Error(`l2 shard ${k}/${workers} exited ${code}: ${err.slice(-800)}`));
    });
  });
  return (await Promise.all([...Array(workers).keys()].map(one))).flat();
}

const l2Cell = r => ({o: ENGINES.map(e => r.outcomes[e] ?? (r.oracle.error ? 'x' : '-')).join(''), m: r.metamorphic ?? null, oracle: r.oracle.error ? (r.oracle.refused ? 'refused' : 'error') : r.oracle.status});

export function readL3() {
  if (!fs.existsSync(L3_RESULTS)) return null;
  return JSON.parse(fs.readFileSync(L3_RESULTS, 'utf8'));
}

/** Compare the current outcomes with the ledger: {losses, failures, known}. */
export function compare(current, ledger) {
  const losses = [], failures = [], known = [];
  const L = ledger ?? {l1: {}, l2: {}, l3: {}};
  for (const [id, pass] of Object.entries(current.l1)) {
    if (L.l1[id] === true && !pass) losses.push({layer: 'L1', id, detail: current.l1Got[id]});
    else if (!pass && L.l1[id] === undefined) failures.push({layer: 'L1', id, detail: current.l1Got[id]});
    else if (!pass) known.push({layer: 'L1', id});
  }
  for (const [id, cell] of Object.entries(current.l2)) {
    const old = L.l2[id];
    if (cell.oracle === 'error' && old?.oracle !== 'error') failures.push({layer: 'L2', id, engine: 'oracle', detail: current.l2Detail[id]?.oracle});
    ENGINES.forEach((engine, i) => {
      const now = cell.o[i], was = old?.o?.[i];
      if (now === 'u') return;
      if ((now === 'd' || now === 'e') && was !== now) failures.push({layer: 'L2', id, engine, detail: current.l2Detail[id]?.[engine]});
      else if (now === 'd' || now === 'e') known.push({layer: 'L2', id, engine});
      if (was === 'a' && now !== 'a') losses.push({layer: 'L2', id, engine, detail: `was a, now ${now}` + (current.l2Detail[id]?.[engine] ? ' ' + JSON.stringify(current.l2Detail[id][engine]).slice(0, 300) : '')});
    });
    if (cell.m === 'd' && old?.m !== 'd') (old?.m === 'a' ? losses : failures).push({layer: 'L2', id, engine: 'metamorphic', detail: current.l2Detail[id]?.metamorphic});
  }
  if (current.l3 && L.l3) for (const [id, outcome] of Object.entries(current.l3)) if (L.l3[id] === 'correct' && outcome !== 'correct') losses.push({layer: 'L3', id, detail: outcome});
  return {losses, failures, known};
}

/** Per-capability table: L1 pass/total, L2 per engine agree/refused/wrong/total, L3 pass/total. */
export function capabilityTable(current, {l1Cases, programs, l3Catalog = []}, inventory = loadInventory()) {
  const table = {};
  const cell = id => (table[id] ??= {l1: [0, 0], l2: {}, l3: [0, 0]});
  // a case counts for its capability and for the others it also exercises (`also`, the converter cases)
  for (const c of l1Cases) for (const id of [c.capability, ...(c.also ?? [])]) { const t = cell(id); t.l1[1]++; if (current.l1[c.id]) t.l1[0]++; }
  for (const p of programs) {
    const res = current.l2[p.id];
    if (!res || res.oracle === 'error') continue;
    const tags = knowledgeTags(p.knowledge, p.query);
    for (const id of [...tags, ...combinationsOf(tags, inventory)]) {
      const t = cell(id);
      ENGINES.forEach((engine, i) => {
        const o = res.o[i];
        const e = (t.l2[engine] ??= {agree: 0, refused: 0, wrong: 0, total: 0});
        e.total++;
        if (o === 'a') e.agree++; else if (o === 'n' || o === 'b') e.refused++; else if (o === 'd' || o === 'e') e.wrong++;
      });
      const m = (t.l2.metamorphic ??= {agree: 0, wrong: 0, total: 0});
      if (res.m) { m.total++; if (res.m === 'a') m.agree++; else m.wrong++; }
      const oc = (t.l2.oracle ??= {total: 0});
      oc.total++;
    }
  }
  for (const c of l3Catalog) for (const cap of c.capabilities ?? []) { const t = cell(cap); t.l3[1]++; if (current.l3?.[c.id] === 'correct') t.l3[0]++; }
  return table;
}

export async function runCheck({tier = 'fast', workers} = {}) {
  const t0 = performance.now();
  const {cases, missing} = allCases();
  const l1 = {}, l1Got = {};
  const fol = await runFolCases(cases.filter(c => c.fol));
  for (const c of cases) { const r = c.fol ? fol[c.id] : runCase(c); l1[c.id] = r.pass; if (!r.pass) l1Got[c.id] = String(r.got).slice(0, 300); }
  const t1 = performance.now();
  const results = await runL2(tier, workers);
  const l2 = {}, l2Detail = {};
  for (const r of results) {
    l2[r.id] = l2Cell(r);
    if (r.details || r.oracle.error || r.metamorphic === 'd') l2Detail[r.id] = {...r.details, oracle: r.oracle.error, metamorphic: r.metamorphicDetail};
  }
  const t2 = performance.now();
  const l3run = readL3();
  const l3 = l3run ? Object.fromEntries(Object.entries(l3run.cases).map(([id, c]) => [id, c.outcome])) : null;
  return {tier, l1, l1Got, l1Missing: missing, l2, l2Detail, l3, l3Run: l3run?.run ?? null, l1Cases: cases, programs: battery(tier).programs,
    seconds: {l1: +((t1 - t0) / 1000).toFixed(1), l2: +((t2 - t1) / 1000).toFixed(1), total: +((t2 - t0) / 1000).toFixed(1)}};
}

function summary(current, table) {
  const engines = {};
  for (const cell of Object.values(current.l2)) ENGINES.forEach((e, i) => { const x = (engines[e] ??= {}); x[cell.o[i]] = (x[cell.o[i]] ?? 0) + 1; });
  const caps = Object.keys(table).length;
  return {l1: {cases: Object.keys(current.l1).length, pass: Object.values(current.l1).filter(Boolean).length, missingSamples: current.l1Missing.length},
    l2: {programs: Object.keys(current.l2).length, engines, metamorphic: Object.values(current.l2).reduce((a, c) => { if (c.m) a[c.m] = (a[c.m] ?? 0) + 1; return a; }, {})},
    l3: current.l3 ? {cases: Object.keys(current.l3).length, correct: Object.values(current.l3).filter(o => o === 'correct').length, run: current.l3Run} : null,
    capabilities: caps};
}

export function writeLedger(current, table, {reason = null} = {}) {
  const old = loadLedger();
  const ledger = {
    note: 'The no-capability-loss ledger (tools/capabilities/check.mjs). Generated; update only with `node tools/capabilities/check.mjs --tier full --update`; a lower ledger needs --accept-loss "<reason>".',
    updated: new Date().toISOString(), tier: current.tier, engines: ENGINES, acceptedLosses: [...(old?.acceptedLosses ?? []), ...(reason ? [{at: new Date().toISOString(), reason}] : [])],
    summary: summary(current, table),
    l1: current.l1, l2: current.l2, l3: current.l3 ?? old?.l3 ?? {}, l3Run: current.l3Run ?? old?.l3Run ?? null,
    capabilities: Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)).map(([id, t]) => [id, {l1: t.l1, l2: Object.fromEntries(Object.entries(t.l2).map(([e, x]) => [e, e === 'oracle' ? x.total : e === 'metamorphic' ? [x.agree, x.total] : [x.agree, x.refused, x.wrong, x.total]])), l3: t.l3}]))
  };
  fs.mkdirSync(path.dirname(LEDGER), {recursive: true});
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 0).replace(/,"(l1|l2|l3|capabilities|summary|acceptedLosses|engines)":/g, ',\n"$1":') + '\n');
  return ledger;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const tier = opt('--tier', 'fast'), update = args.includes('--update'), reason = opt('--accept-loss', null);
  const current = await runCheck({tier, workers: opt('--workers', null) ? Number(opt('--workers')) : undefined});
  const ledger = loadLedger();
  const {losses, failures, known} = compare(current, ledger);
  const needTable = update || args.includes('--report');
  const l3Catalog = fs.existsSync(path.join(ROOT, 'eval/capabilities/l3/catalog.jsonl')) ? fs.readFileSync(path.join(ROOT, 'eval/capabilities/l3/catalog.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const table = needTable ? capabilityTable(current, {l1Cases: current.l1Cases, programs: current.programs, l3Catalog}) : null;
  if (args.includes('--report')) { fs.mkdirSync(REPORTS, {recursive: true}); fs.writeFileSync(path.join(REPORTS, `check-${tier}.json`), JSON.stringify({summary: summary(current, table), losses, failures, known, table}, null, 1)); }
  const s = {tier, seconds: current.seconds, l1: `${Object.values(current.l1).filter(Boolean).length}/${Object.keys(current.l1).length}`, l2Programs: Object.keys(current.l2).length,
    losses: losses.length, failures: failures.length, known: known.length, ledger: ledger ? ledger.updated : 'none',
    // programs whose text changed (an enumeration grew) are new ids: the ledger is refreshed with --update, which is never a loss
    unrecorded: Object.keys(current.l2).filter(id => !ledger?.l2?.[id]).length + Object.keys(current.l1).filter(id => ledger?.l1?.[id] === undefined).length};
  console.log(JSON.stringify(s));
  for (const x of [...losses.map(l => ({...l, kind: 'LOSS'})), ...failures.map(f => ({...f, kind: 'FAILURE'}))].slice(0, 40)) console.log(`${x.kind} ${x.layer} ${x.id}${x.engine ? ' [' + x.engine + ']' : ''}: ${typeof x.detail === 'string' ? x.detail : JSON.stringify(x.detail ?? '').slice(0, 300)}`);
  if (update) {
    if (tier !== 'full') { console.error('--update needs --tier full (the ledger records every program)'); process.exit(2); }
    if (losses.length && !reason) { console.error(`refused: ${losses.length} capability losses; fix them, or pass --accept-loss "<reason>"`); process.exit(1); }
    writeLedger(current, table, {reason: losses.length ? reason : null});
    if (losses.length && reason) {
      const {appendJournal} = await import('../../lib/journal.mjs');
      appendJournal({area: 'eval', state: 'decision', actor: process.env.CHATSOP_ACTOR ?? 'agent', title: `Capability ledger lowered: ${losses.length} losses accepted`, detail: reason + ' | ' + losses.slice(0, 10).map(l => `${l.layer} ${l.id}${l.engine ? ' ' + l.engine : ''}`).join('; '), links: ['eval/capabilities/ledger.json']});
    }
    console.log('ledger written: ' + path.relative(ROOT, LEDGER));
  }
  process.exit(losses.length || failures.length ? 1 : 0);
}
