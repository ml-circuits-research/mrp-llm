#!/usr/bin/env node
/**
 * Trace explanation quality of eval-internal-reasoning-stepbystep-v1: for the same stratified rows (5 per level, fixed seed) the record
 * each strategy leaves of one formalization (IR: its trace explanation; B: its step list and report) is judged blind, one record per
 * call and in shuffled order, by an LLM judge through Ploinky (owner, 2026-10-02: the openference Qwen3.8 27b, tier small, is the
 * default for judging) on a 3-point rubric:
 *   0  the record does not say why the questions were asked
 *   1  it names what was asked and answered, but not why each question was asked
 *   2  it says why each question was asked and how its answer was used
 *   node tools/eval/formalization/internal-reasoning/judge-traces.mjs --run final [--per-level 5] [--tier small | --model "Qwen3.8 27b" [--upstream openference]]
 * Writes judge-traces.jsonl and judge-traces.json (mean per arm, paired difference) next to the records.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readRecords, DIR} from './summarize.mjs';
import {pairedBootstrap} from '../stepbystep-protocol/summarize.mjs';
import {pworker} from '../../../../lib/pworker.mjs';

const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const sha = s => createHash('sha256').update(s).digest('hex');

export const RUBRIC = `You judge the record a system left of how it turned a user's request into a formal query by asking a small model short questions.
Score how well the record explains WHY each question was asked:
0 = the record does not say why the questions were asked;
1 = the record names what was asked and answered, but not why each question was asked;
2 = the record says why each question was asked and how its answer was used.
Judge only the explanation, not whether the final answer is right. Reply with JSON only: {"score": 0|1|2, "reason": "one sentence"}.`;

/** The record a strategy leaves: IR its trace explanation, B its questions and answers with its report. */
export function recordText(r) {
  const steps = (r.author?.steps ?? []).map((s, i) => `${i + 1}. question "${s.name}" -> answer ${JSON.stringify(s.answer)}`).join('\n');
  const own = r.author?.explanation ?? `Report: ${r.author?.plan ?? '{}'}`;
  return `Request: ${r.question}\n\nQuestions asked and answers:\n${steps || '(none)'}\n\nThe system's own record:\n${own}`.slice(0, 12000);
}

/** One judgement through Ploinky: `target` is {tier} or {upstream, model}. */
async function judge({target, text}) {
  const r = await pworker({purpose: 'job:judge-traces'}).chat({...target, temperature: 0, maxTokens: 300, messages: [{role: 'system', content: RUBRIC}, {role: 'user', content: text}], timeoutMs: 180000});
  const content = r.raw ?? '';
  const m = /\{[\s\S]*\}/.exec(content);
  try { const v = JSON.parse(m?.[0] ?? ''); return {score: [0, 1, 2].includes(v.score) ? v.score : null, reason: v.reason ?? null, raw: content.slice(0, 400)}; } catch { return {score: null, reason: null, raw: content.slice(0, 400)}; }
}

export async function main(args = process.argv.slice(2)) {
  const run = opt(args, '--run', 'final'), perLevel = Number(opt(args, '--per-level', 5));
  if (args.includes('--endpoint')) throw new Error('--endpoint is gone: every model call goes through Ploinky; use --tier or --model [--upstream]');
  const target = opt(args, '--model', null) ? {upstream: opt(args, '--upstream', 'openference'), model: opt(args, '--model', null)} : {tier: opt(args, '--tier', 'small')};
  const model = target.model ?? `tier:${target.tier}`;
  const arms = opt(args, '--arms', 'IR,B').split(',');
  const records = readRecords([run]).filter(r => arms.includes(r.method));
  const ids = [...new Set(records.map(r => r.id))];
  const level = id => records.find(r => r.id === id).level;
  const chosen = ['a', 'b', 'c', 'n'].flatMap(l => ids.filter(id => level(id) === l).sort((x, y) => sha(`traces/${x}`).localeCompare(sha(`traces/${y}`))).slice(0, perLevel));
  const jobs = chosen.flatMap(id => arms.map(arm => records.find(r => r.id === id && r.method === arm)).filter(Boolean)).sort((x, y) => sha(`order/${x.id}/${x.method}`).localeCompare(sha(`order/${y.id}/${y.method}`)));
  const out = path.join(DIR, run, 'judge-traces.jsonl');
  const done = new Map(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(JSON.parse).map(j => [`${j.id}/${j.arm}`, j]) : []);
  for (const r of jobs) {
    const key = `${r.id}/${r.method}`;
    if (done.has(key) && done.get(key).score !== null) continue;
    const verdict = await judge({target, text: recordText(r)});
    const row = {id: r.id, arm: r.method, level: r.level, model, ...verdict};
    done.set(key, row);
    fs.appendFileSync(out, JSON.stringify(row) + '\n');
    console.error(`${key} ${verdict.score} ${verdict.reason ?? verdict.raw}`);
  }
  const rows = [...done.values()];
  const mean = arm => { const s = rows.filter(r => r.arm === arm && r.score !== null).map(r => r.score); return {n: s.length, mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null, counts: [0, 1, 2].map(k => s.filter(x => x === k).length)}; };
  const paired = chosen.map(id => [rows.find(r => r.id === id && r.arm === arms[0])?.score, rows.find(r => r.id === id && r.arm === arms[1])?.score]).filter(([x, y]) => x != null && y != null).map(([x, y]) => x - y);
  const summary = {model, rubric: RUBRIC, rows: chosen.length, arms: Object.fromEntries(arms.map(a => [a, mean(a)])), difference: pairedBootstrap(paired)};
  fs.writeFileSync(path.join(DIR, run, 'judge-traces.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary.arms), JSON.stringify(summary.difference));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
