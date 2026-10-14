#!/usr/bin/env node
/** Dev-only benchmark case generator. Never opens or writes a sealed suite. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {benchmarkCase, BENCHMARK_FAMILIES} from './benchmark-families.mjs';
import {worldMultihop} from './benchmark-world.mjs';
import {renderEnglish} from '../../../reasoning/slice/render-english.mjs';
import {conformCore} from '../../../reasoning/strategies/conform/index.mjs';
import {verifyAnswer} from '../../../reasoning/strategies/js-reference/index.mjs';
import {compare} from '../../../eval/smoke-reasoning/lib/compare.mjs';
import {validateProgram, FEATURES} from '../../../eval/smoke-reasoning/validator.mjs';
import {askMemory} from '../../../reasoning/slice/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const option = (args, key, fallback) => { const i = args.indexOf(key); return i === -1 ? fallback : args[i + 1]; };
export const scaleConfigs = [1000, 10000, 100000, 1000000].map(facts => ({facts, generated: facts === 1000, role: facts === 1000 ? 'dev materialization' : 'not materialized; evaluate as a separately budgeted scale cell'}));
function checkCase(c, got) {
  const program = validateProgram([{name: 'knowledge.sop', text: c.knowledge, role: 'knowledge'}, {name: 'query.sop', text: c.query, role: 'query'}]);
  const errors = program.problems.filter(p => p.severity !== 'warning');
  if (errors.length) throw new Error(`${c.family}/${c.id ?? c.variant} invalid: ${errors.map(p => `${p.code}: ${p.message}`).join('; ')}`);
  for (const requirement of c.expected.requires ?? []) if (!FEATURES.includes(requirement)) throw new Error(`${c.family}/${c.id ?? c.variant} unknown smoke feature ${requirement}`);
  const warnings = program.problems.filter(p => p.severity === 'warning').map(p => p.code).sort();
  if (warnings.length) c.expected.warnings = warnings;
  const verdict = compare(c.expected, got);
  if (!verdict.ok) throw new Error(`${c.family}/${c.id ?? c.variant} construction disagrees with oracle: ${verdict.why.join('; ')}`);
  if (got.complete === false || got.retrieval?.complete === false) throw new Error(`${c.family} oracle incomplete`);
  return c;
}
export function checkLocal(c) {
  const got = c.facts > 200000 ? verifyAnswer({theory: {knowledge: c.knowledge}, query: c.query}, {timeoutMs: 120000, maxFacts: 2000000}) : conformCore.ask({theory: {knowledge: c.knowledge}, query: c.query});
  return checkCase(c, got);
}
const clean = text => text.endsWith('\n') ? text : text + '\n';
export function renderedSources(c) {
  if (c.facts < 1000000) return [['source.md', `${renderEnglish(c.knowledge).trimEnd()}\n\nQuestion: ${c.question}\n`]];
  // Preserve all evidence in numbered English parts without a file exceeding 50 MB.
  const first = c.knowledge.indexOf('@f1 fact\n');
  if (first < 0) throw new Error('Large case has no facts to partition');
  const header = c.knowledge.slice(0, first), files = [];
  let start = first, cursor = first, included = 0;
  while (cursor < c.knowledge.length) {
    const next = c.knowledge.indexOf('\n@f', cursor + 1);
    cursor = next < 0 ? c.knowledge.length : next + 1;
    if (++included < 25000 && cursor < c.knowledge.length) continue;
    const name = files.length ? `source.part-${String(files.length + 1).padStart(3, '0')}.md` : 'source.md';
    const text = renderEnglish(header + c.knowledge.slice(start, cursor));
    files.push([name, text]);
    start = cursor; included = 0;
  }
  files[0][1] = `${files[0][1].trimEnd()}\n\nQuestion: ${c.question}\nEvidence continues in ${files.slice(1).map(([name]) => name).join(', ')}; this file alone is partial.\n`;
  return files;
}
async function writeCase(out, c, index, split, {dryRun = false} = {}) {
  const id = c.id ?? `${c.family}-${split}-${String(index + 1).padStart(3, '0')}${c.family === 'f9' && c.facts !== 1000 ? `-1e${Math.log10(c.facts)}` : ''}`;
  const case_dir = path.join('cases', c.family, id), dir = path.join(out, case_dir);
  if (!dryRun) {
    fs.mkdirSync(dir, {recursive: true});
    const values = [['knowledge.sop', c.knowledge], ['query.sop', c.query], ...renderedSources(c), ['expected.json', JSON.stringify(c.expected, null, 2)]];
    for (const [file, value] of values) {
      if (Buffer.byteLength(value, 'utf8') >= 50_000_000) throw new Error(`${id}/${file} exceeds 50 MB; refusing to persist`);
      fs.writeFileSync(path.join(dir, file), clean(value));
    }
  }
  return {id, family: c.family, variant: c.variant, question: c.question, case_dir, facts: c.facts, materialized_facts: c.materialized_facts ?? c.facts, depth: c.depth, split, kb_query: c.query, ...(c.base_memory ? {base_memory: c.base_memory, world_root: c.world_root} : {})};
}
/** Returns manifest rows only after the independent construction and oracle agree. */
export async function buildBenchmark({count = 100, split = 'dev', out = 'eval/smoke-reasoning/bench', families = ['f1', ...BENCHMARK_FAMILIES], scale = 1000, dryRun = false, onRow = () => {}} = {}) {
  if (split !== 'dev') throw new Error('Only the dev split may be persisted by this generator; preview is in-memory only');
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('count must be 1–100 per family');
  const directory = path.resolve(ROOT, out);
  if (!dryRun && !(directory === path.join(ROOT, 'eval/smoke-reasoning/bench') || directory.startsWith(path.join(ROOT, 'eval/smoke-reasoning/bench/')))) throw new Error('Dev output must remain under eval/smoke-reasoning/bench');
  const rows = [], worldRows = families.includes('f1') ? await worldMultihop({split}) : [];
  const file = path.join(directory, 'manifest.jsonl');
  const prior = !dryRun && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(r => !families.includes(r.family)) : [];
  const flush = () => {
    if (dryRun) return;
    fs.mkdirSync(directory, {recursive: true});
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, [...prior, ...rows].sort((a, b) => a.id.localeCompare(b.id)).map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.renameSync(tmp, file);
  };
  let session;
  try {
    if (families.includes('f1')) {
      const {openSession} = await import('../../eval/lib/session.mjs');
      session = openSession({base: 'world-v1', id: `benchmark-dev-${process.pid}`});
    }
    const theory = session?.theories.get([...session.sessions.baseCircuits(session.id), ...session.sessions.circuits(session.id)]);
    const repo = session?.sessions.repository(session.id), agentSession = session?.store.get('qf', 'gold', 'main').agent.session;
    for (const family of families) {
      if (!['f1', ...BENCHMARK_FAMILIES].includes(family)) throw new Error(`Unknown family ${family}`);
      for (let i = 0; i < count; i++) {
        const c = family === 'f1' ? worldRows[i] : benchmarkCase(family, i, {scale: ['f8', 'f9'].includes(family) ? scale : 1000});
        if (family === 'f1') {
          // Gold construction is a join of *source world circuits*, not the oracle's answer.
          // Re-check both the portable proof subset and the ENTIRE base world through the
          // same full-world oracle path as tools/eval/formalization/query-forms/gold.mjs.
          checkLocal(c);
          const packet = askMemory({theory, repo, session: agentSession, query: c.query, reasoning: 'auto', verify: 'auto', limits: {maxLookups: 2000000, maxProbes: 5000000, maxFacts: 400000, maxGoals: 200000, retrievalMs: 120000}, budget: {timeoutMs: 120000}});
          checkCase(c, packet);
        } else checkLocal(c);
        const row = await writeCase(directory, c, i, split, {dryRun});
        rows.push(row); flush(); onRow(row);
      }
    }
  } finally { session?.close(); }
  return rows;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), count = Number(option(args, '--count', '100'));
  const families = option(args, '--family', 'f1,' + BENCHMARK_FAMILIES.join(',')).split(',');
  try {
    const rows = await buildBenchmark({count, families, scale: Number(option(args, '--scale', '1000')), split: option(args, '--split', 'dev'), out: option(args, '--out', 'eval/smoke-reasoning/bench'), dryRun: args.includes('--dry-run'), onRow: row => { if (args.includes('--progress')) console.log(JSON.stringify({id: row.id, facts: row.facts})); }});
    console.log(JSON.stringify({generated: rows.length, families, out: option(args, '--out', 'eval/smoke-reasoning/bench')}));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
