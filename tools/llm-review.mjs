#!/usr/bin/env node
/**
 * Bulk review -> automatic repair -> check -> re-review with a cheap model through the Ploinky proxy (lib/llm-review).
 * Runs without an LLM controller; only unresolved items are escalated, as escalations.jsonl plus a summary of at most 10 lines.
 *
 *   node tools/llm-review.mjs run --kind knowledge-wires --input items.jsonl --out DIR
 *        [--model M] [--base-url URL] [--budget TOKENS] [--reasoning off|low|medium|high|default] [--max-tokens N]
 *        [--no-repair] [--limit N] [--concurrency 4]    (defaults: "defaults" in config/review/<kind>/kind.json)
 *   node tools/llm-review.mjs score --run RUN_DIR --truth truth.jsonl    recall and false alarms (truth lines: {"id","bad":true|false})
 *
 * Items (JSONL): {"id","material","work","context_id"?,"context"?,"meta"?: {"vocabulary"?: "<declarations the check needs>"}}.
 * Review kinds live in config/review/<kind>/ (kind.json, review.md, repair.md). Outputs in DIR: findings.jsonl, repaired.jsonl,
 * escalations.jsonl, summary.md, run.json (cost per stage, from the model's usage.cost and from Ploinky's statistics), all inside
 * DIR/<run-id>/ so that no run overwrites another.
 */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {loadKind, reviewLoop, chat, score} from '../lib/llm-review/index.mjs';
import {pworker} from '../lib/pworker.mjs';
import {validateProgram} from '../sop/knowledge/index.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const flag = n => args.includes('--' + n);
const readJsonl = f => readFileSync(f, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
const writeJsonl = (f, rows) => writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

/** The kind's check: the SOP knowledge validator over the item's vocabulary plus the work; only problems the original lacked count. */
function makeCheck(kind) {
  if (kind.check?.validator !== 'sop-knowledge') return () => ({ok: true, problems: []});
  const role = kind.check.role ?? 'knowledge';
  const problemsOf = (item, work) => {
    const files = [];
    if (item.meta?.vocabulary) files.push({name: 'vocabulary.sop', text: item.meta.vocabulary, role: 'knowledge'});
    files.push({name: 'work.sop', text: work, role});
    try { return validateProgram(files, {authoring: true}).problems.filter(p => p.file === 'work.sop' && p.severity !== 'warning').map(p => `${p.code}: ${p.message}`); }
    catch (e) { return [`validator error: ${e.message}`]; }
  };
  return (item, work) => {
    const before = new Set(problemsOf(item, item.work));
    const problems = problemsOf(item, work).filter(p => !before.has(p));
    return {ok: problems.length === 0, problems};
  };
}

async function run() {
  const kindName = opt('kind');
  const input = opt('input');
  const outParent = opt('out');
  if (!kindName || !input || !outParent) throw new Error('run needs --kind, --input and --out');
  const kind = loadKind(kindName);
  const d = kind.defaults ?? {};
  const model = opt('model', d.model ?? 'deepseek/deepseek-v4-flash');
  const upstream = opt('provider', d.provider ?? 'openrouter');
  const reasoning = opt('reasoning', d.reasoning ?? 'off');
  const maxTokens = Number(opt('max-tokens', d.maxTokens ?? 8000));
  const budget = Number(opt('budget', d.budgetTokens ?? 80000));
  let items = readJsonl(input);
  if (opt('limit')) items = items.slice(0, Number(opt('limit')));
  const runId = 'llm-review-' + Date.now().toString(36);
  const out = join(outParent, runId); // every run writes into its own directory
  mkdirSync(out, {recursive: true});
  const t0 = Date.now();
  const log = m => console.error(`[${runId}] ${m}`);
  const call = ({system, user}) => chat({upstream, model, system, user, clientName: runId, reasoning, maxTokens});
  log(`${items.length} items, kind ${kindName}, model ${model}, reasoning ${reasoning}`);
  const r = await reviewLoop({items, kind, call, check: makeCheck(kind), budgetTokens: budget, repair: !flag('no-repair'), concurrency: Number(opt('concurrency', 4)), log});
  writeJsonl(join(out, 'findings.jsonl'), r.findings);
  writeJsonl(join(out, 'repaired.jsonl'), r.repaired);
  writeJsonl(join(out, 'escalations.jsonl'), r.escalations);
  const ledger = {stages: r.ledger.stages, total: r.ledger.total()};
  // Ploinky's own count of this run's calls (its statistics by purpose), next to the ledger of the replies.
  let proxy = null;
  try { proxy = (await pworker({purpose: `review:${runId}`}).stats()).last24h?.by_purpose?.[`review:${runId}`] ?? null; } catch { /* the server's statistics are optional here */ }
  const usd = ledger.total.usd;
  const run = {
    run: runId, kind: kindName, model, provider: upstream, reasoning, input, started: new Date(t0).toISOString(), ms: Date.now() - t0,
    items: r.items, flagged: r.flagged.length, confirmed: r.confirmed.length, dismissed_by_second_opinion: r.dismissed.length, noted_low: r.noted.length,
    repaired: r.repaired.length, escalated: r.escalations.length,
    cost: {cheap_model_usd: +usd.toFixed(6), usd_per_100_items: r.items ? +(usd * 100 / r.items).toFixed(6) : null, pworker_stats: proxy, ...ledger},
    orchestrator: {escalated_items: r.escalations.length, note: 'only escalations.jsonl and summary.md are meant for an expensive orchestrator'},
    flagged_ids: r.flagged, confirmed_ids: r.confirmed, dismissed: r.dismissed, noted: r.noted,
  };
  writeFileSync(join(out, 'run.json'), JSON.stringify(run, null, 1) + '\n');
  const reasons = {};
  for (const e of r.escalations) reasons[e.reason] = (reasons[e.reason] || 0) + 1;
  const summary = [
    `# LLM review ${runId} (${kindName}, ${model})`,
    `items ${r.items}; flagged ${r.flagged.length}; confirmed ${r.confirmed.length}; dismissed by second opinion ${r.dismissed.length}; low only ${r.noted.length}`,
    `repaired automatically ${r.repaired.length} (validator passed, re-review clean); escalated ${r.escalations.length}${r.escalations.length ? ' (' + Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ') + ')' : ''}`,
    `cheap-model cost ${usd.toFixed(4)} USD (${ledger.total.calls} calls, ${ledger.total.in_tokens} in / ${ledger.total.out_tokens} out tokens); Ploinky counted ${proxy ? `${proxy.usd.toFixed(4)} USD over ${proxy.calls} calls` : 'nothing (statistics unavailable)'}`,
    ...r.escalations.slice(0, 5).map(e => `- ${e.id}: ${e.reason}: ${(e.problem || e.detail || '').slice(0, 160)}`),
    r.escalations.length > 5 ? `- ... ${r.escalations.length - 5} more in escalations.jsonl` : null,
  ].filter(Boolean).slice(0, 10);
  writeFileSync(join(out, 'summary.md'), summary.join('\n') + '\n');
  console.log(summary.join('\n'));
  console.log(`run directory: ${out}`);
}

function scoreCmd() {
  const out = opt('run');
  const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  const truthRows = readJsonl(opt('truth')).filter(t => !t.kind || t.kind === run.kind);
  const truth = Object.fromEntries(truthRows.map(t => [t.id, !!t.bad]));
  const findings = readJsonl(join(out, 'findings.jsonl'));
  const pass1Any = [...new Set(findings.filter(f => f.pass === 1).map(f => f.id))];
  const pass1Med = [...new Set(findings.filter(f => f.pass === 1 && f.severity !== 'low').map(f => f.id))];
  const res = {
    run: run.run, model: run.model, reasoning: run.reasoning, items: run.items,
    pass1_any: score(pass1Any, truth), pass1_medium_or_high: score(pass1Med, truth), confirmed: score(run.confirmed_ids, truth),
    missed: truthRows.filter(t => t.bad && !run.confirmed_ids.includes(t.id)).map(t => `${t.id} (${t.error ?? 'planted'})`),
    false_alarms: run.confirmed_ids.filter(id => truth[id] === false),
    usd: run.cost.cheap_model_usd, usd_per_100_items: run.cost.usd_per_100_items,
  };
  writeFileSync(join(out, 'score.json'), JSON.stringify(res, null, 1) + '\n');
  console.log(JSON.stringify(res, null, 1));
}

try {
  if (cmd === 'run') await run();
  else if (cmd === 'score') scoreCmd();
  else { console.error('usage: node tools/llm-review.mjs run|score ... (see the header of this file)'); process.exit(2); }
} catch (e) { console.error(e.message); process.exit(1); }
