/**
 * Bulk review with a cheap model, then automatic repair, check and re-review (owner, 2026-10-02).
 *
 * Input tokens are cheap and output tokens are dear: the reviewer reads many items in one call (a token budget per batch) and writes
 * one JSON line per problem only, `{"id","problem","severity"}`, then the end marker `{"done":true}`. Items whose problem is confirmed
 * by deterministic rules are repaired by a cheap model, checked by the kind's validator and reviewed again; only what stays unresolved
 * is escalated, as a short record, never the raw findings.
 *
 * An item: `{id, material, work, context_id?, context?}`. `material` is what the work must be faithful to (a source quote, a user
 * message, a problem text), `work` the product under review (a wire, a circuit, an answer). Items that share `context_id` share one
 * `context` (a source passage), printed once per batch. All prose sent to the model lives in `config/review/` (a protocol file and one
 * folder per review kind with `kind.json`, `review.md` and `repair.md`); the code holds structure only.
 */
import {pworker} from '../pworker.mjs';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REVIEW_CONFIG_DIR = join(HERE, '..', '..', 'config', 'review');
export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);
const RANK = {high: 3, medium: 2, low: 1};

/** A rough, conservative token estimate (characters / 3.5). */
export const estimateTokens = text => Math.ceil(String(text ?? '').length / 3.5);

/** Loads a review kind: `{name, review, repair, protocol, repairProtocol, check, policy, ...kind.json}`. */
export function loadKind(name, {dir = REVIEW_CONFIG_DIR} = {}) {
  const base = join(dir, name);
  if (!existsSync(join(base, 'kind.json'))) throw new Error(`unknown review kind ${JSON.stringify(name)} (no ${join(base, 'kind.json')})`);
  const kind = JSON.parse(readFileSync(join(base, 'kind.json'), 'utf8'));
  const read = f => readFileSync(join(base, f), 'utf8').trim();
  return {
    name, ...kind,
    review: read(kind.reviewFile ?? 'review.md'),
    repair: existsSync(join(base, kind.repairFile ?? 'repair.md')) ? read(kind.repairFile ?? 'repair.md') : null,
    protocol: readFileSync(join(dir, 'protocol-review.md'), 'utf8').trim(),
    repairProtocol: readFileSync(join(dir, 'protocol-repair.md'), 'utf8').trim(),
    policy: {repairAt: 'high', confirmAt: 'medium', secondOpinion: true, maxRepairRounds: 2, ...(kind.policy ?? {})},
  };
}

/** Validates and normalises input items; throws on a missing id, duplicate id or missing work. */
export function normaliseItems(items) {
  const seen = new Set();
  return items.map((it, i) => {
    const id = String(it.id ?? '').trim();
    if (!id) throw new Error(`item ${i + 1} has no id`);
    if (seen.has(id)) throw new Error(`duplicate item id ${id}`);
    seen.add(id);
    if (it.work == null || String(it.work).trim() === '') throw new Error(`item ${id} has no work`);
    return {id, material: String(it.material ?? ''), work: String(it.work), context_id: it.context_id ?? null, context: it.context ?? null, meta: it.meta ?? null};
  });
}

const itemText = it => `=== ITEM ${it.id}${it.context_id ? ` (context ${it.context_id})` : ''} ===\nMATERIAL:\n${it.material}\nWORK:\n${it.work}\n`;
const contextText = (cid, text) => `=== CONTEXT ${cid} ===\n${text}\n`;

/**
 * Packs items into batches of at most `budgetTokens` estimated input tokens (instruction included). Items are kept in input order
 * and grouped by context so that each batch prints a context once. An item larger than the budget gets a batch of its own.
 */
export function packBatches(items, {budgetTokens = 80000, fixedTokens = 0} = {}) {
  const contexts = new Map();
  for (const it of items) if (it.context_id && it.context != null && !contexts.has(it.context_id)) contexts.set(it.context_id, String(it.context));
  const order = [];
  const groups = new Map();
  for (const it of items) {
    const key = it.context_id ?? `\u0000${it.id}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(it);
  }
  const batches = [];
  let cur = null;
  const open = () => { cur = {items: [], contexts: new Set(), tokens: fixedTokens}; batches.push(cur); };
  for (const key of order) {
    for (const it of groups.get(key)) {
      const ctxCost = it.context_id && contexts.has(it.context_id) ? estimateTokens(contextText(it.context_id, contexts.get(it.context_id))) : 0;
      const cost = estimateTokens(itemText(it));
      if (!cur) open();
      const extra = cost + (it.context_id && !cur.contexts.has(it.context_id) ? ctxCost : 0);
      if (cur.items.length && cur.tokens + extra > budgetTokens) open();
      if (it.context_id && !cur.contexts.has(it.context_id)) { cur.contexts.add(it.context_id); cur.tokens += ctxCost; }
      cur.items.push(it);
      cur.tokens += cost;
    }
  }
  return batches.map((b, i) => ({index: i, items: b.items, tokens: b.tokens, text: renderBatch(b.items, contexts)}));
}

/** The user message of a batch: each context once, then the items. */
export function renderBatch(items, contexts = new Map()) {
  const out = [];
  const printed = new Set();
  for (const it of items) {
    if (it.context_id && !printed.has(it.context_id)) {
      const text = contexts.get(it.context_id) ?? it.context;
      if (text != null) out.push(contextText(it.context_id, text));
      printed.add(it.context_id);
    }
    out.push(itemText(it));
  }
  out.push(`=== END OF ITEMS (${items.length}) ===`);
  return out.join('\n');
}

/** Every `{...}` object on its own line or inside a JSON array, code fences and prose ignored. */
function jsonObjects(text) {
  const out = [];
  const src = String(text ?? '').replace(/```[a-z]*\n?/gi, '');
  for (const raw of src.split('\n')) {
    const line = raw.trim().replace(/,$/, '');
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      const v = JSON.parse(line);
      for (const o of Array.isArray(v) ? v : [v]) if (o && typeof o === 'object') out.push(o);
    } catch { out.push({__bad: line.slice(0, 200)}); }
  }
  if (!out.length) { // a whole-text JSON array spanning several lines
    try { const v = JSON.parse(src.trim()); for (const o of Array.isArray(v) ? v : [v]) if (o && typeof o === 'object') out.push(o); } catch { /* none */ }
  }
  return out;
}

/**
 * Parses reviewer output. Returns `{findings, done, bad, unknownIds, malformed}`; `malformed` when the end marker is missing or more
 * than a third of the lines are unusable. Findings for unknown ids are dropped (reported in `unknownIds`).
 */
export function parseFindings(text, ids) {
  const known = new Set(ids);
  const objs = jsonObjects(text);
  const findings = [];
  const unknownIds = [];
  let done = false, bad = 0;
  for (const o of objs) {
    if (o.__bad) { bad += 1; continue; }
    if (o.done === true && o.id == null) { done = true; continue; }
    const id = o.id == null ? null : String(o.id);
    if (!id || typeof o.problem !== 'string' || !o.problem.trim()) { bad += 1; continue; }
    if (!known.has(id)) { unknownIds.push(id); continue; }
    const sev = String(o.severity ?? '').toLowerCase();
    findings.push({id, problem: o.problem.trim(), severity: SEVERITIES.includes(sev) ? sev : 'medium'});
  }
  const malformed = !done || bad > Math.max(1, (findings.length + bad) / 3);
  return {findings, done, bad, unknownIds, malformed};
}

/** Parses repair output: `{id, work}` or `{id, work: null, reason}` lines, then `{"done":true}`. */
export function parseRepairs(text, ids) {
  const known = new Set(ids);
  const repairs = [];
  let done = false, bad = 0;
  for (const o of jsonObjects(text)) {
    if (o.__bad) { bad += 1; continue; }
    if (o.done === true && o.id == null) { done = true; continue; }
    const id = o.id == null ? null : String(o.id);
    if (!id || !known.has(id)) { bad += 1; continue; }
    if (typeof o.work === 'string' && o.work.trim()) repairs.push({id, work: o.work, note: typeof o.note === 'string' ? o.note : null});
    else repairs.push({id, work: null, reason: String(o.reason ?? 'declined')});
  }
  return {repairs, done, bad, malformed: !done || (bad > 0 && repairs.length === 0)};
}

/**
 * One chat completion through the Ploinky proxy: a `tier`, or a concrete `model` of a provider (`upstream`, default `openrouter`:
 * the review kinds are calibrated on deepseek/deepseek-v4-flash). Returns `{text, usage, usd, ms, finish}`; throws on a failed call.
 */
export async function chat({tier = null, upstream = 'openrouter', model = null, system, user, clientName, purpose = null, maxTokens = 8000, temperature = 0, reasoning = 'off', fetchImpl = null, timeoutMs = 900000, noFallback = true, ta = null}) {
  const extraBody = reasoning === 'off' ? {reasoning: {enabled: false}} : reasoning && reasoning !== 'default' ? {reasoning: {effort: reasoning}} : {};
  // `ta`: a caller's Ploinky client (a task's, tagged with its run and budget); otherwise one tagged review:<client>.
  const agent = ta ?? pworker({purpose: purpose ?? `review:${clientName}`, client: clientName, fetchImpl});
  const r = await agent.chat({...(tier ? {tier} : {upstream, model}), system, prompt: user, maxTokens, temperature, extraBody, noFallback, timeoutMs});
  if (!r.ok) throw new Error(`model call failed: ${r.reason}`);
  return {text: r.raw ?? '', usage: {in: r.usage.in, out: r.usage.out, reasoning: r.usage.reasoning}, usd: r.usd, ms: r.ms, finish: r.finish};
}

/** A small cost ledger per stage. */
export class Ledger {
  constructor() { this.stages = {}; }
  add(stage, call) {
    const s = (this.stages[stage] ||= {calls: 0, in_tokens: 0, out_tokens: 0, reasoning_tokens: 0, usd: 0, usd_missing: 0, retries: 0});
    s.calls += 1; s.in_tokens += call.usage.in; s.out_tokens += call.usage.out; s.reasoning_tokens += call.usage.reasoning;
    if (call.usd == null) s.usd_missing += 1; else s.usd += call.usd;
  }
  retry(stage) { (this.stages[stage] ||= {calls: 0, in_tokens: 0, out_tokens: 0, reasoning_tokens: 0, usd: 0, usd_missing: 0, retries: 0}).retries += 1; }
  total() {
    const t = {calls: 0, in_tokens: 0, out_tokens: 0, reasoning_tokens: 0, usd: 0, usd_missing: 0, retries: 0};
    for (const s of Object.values(this.stages)) for (const k of Object.keys(t)) t[k] += s[k];
    return t;
  }
}

/** Runs a prompt over batches, `concurrency` at a time; a malformed answer (or a failed call) is retried once. Results keep batch order. */
async function runBatches({batches, system, parse, call, ledger, stage, log = () => {}, concurrency = 4}) {
  const one = async b => {
    const ids = b.items.map(i => i.id);
    let parsed = null, lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2) ledger.retry(stage);
      try {
        const r = await call({system, user: b.text});
        ledger.add(stage, r);
        parsed = parse(r.text, ids);
        parsed.finish = r.finish;
        if (r.finish === 'length') parsed.malformed = true;
        if (!parsed.malformed) break;
        lastErr = `malformed output (done=${parsed.done}, bad=${parsed.bad}, finish=${r.finish})`;
      } catch (e) { lastErr = e.message; parsed = null; }
      log(`${stage} batch ${b.index + 1}/${batches.length} attempt ${attempt}: ${lastErr}`);
    }
    return {batch: b.index, ids, parsed, error: parsed && !parsed.malformed ? null : lastErr};
  };
  const results = new Array(batches.length);
  let next = 0;
  const worker = async () => { while (next < batches.length) { const i = next++; results[i] = await one(batches[i]); } };
  await Promise.all(Array.from({length: Math.max(1, Math.min(concurrency, batches.length))}, worker));
  return results;
}

const atLeast = (sev, min) => RANK[sev] >= RANK[min];
const worst = fs => fs.reduce((m, f) => (!m || RANK[f.severity] > RANK[m.severity] ? f : m), null);
const shortProblem = fs => fs.map(f => f.problem).join(' | ').slice(0, 300);

/**
 * The automated loop. Stages: review (all items) -> second opinion (items whose worst finding is between `confirmAt` and below
 * `repairAt`) -> repair (confirmed items) -> check (kind validator) -> re-review (repaired items). Decisions are deterministic:
 *   - worst finding >= policy.repairAt: confirmed;
 *   - worst finding >= policy.confirmAt and < repairAt: confirmed only if the second pass flags the item at >= confirmAt;
 *   - below confirmAt: noted, not repaired, not escalated;
 *   - a repair is kept only if the check passes and the re-review finds nothing at >= confirmAt; otherwise it is retried with the
 *     reasons (up to policy.maxRepairRounds), then escalated.
 * Items a batch could not review (malformed twice) are escalated as `review_failed`.
 *
 * `check(item, work)` returns `{ok, problems: [string]}`. Returns `{findings, confirmed, repaired, escalations, noted, ledger}`.
 */
export async function reviewLoop({items, kind, call, check = () => ({ok: true, problems: []}), budgetTokens = 80000, repair = true, concurrency = 4, log = () => {}}) {
  items = normaliseItems(items);
  const byId = new Map(items.map(i => [i.id, i]));
  const ledger = new Ledger();
  const policy = kind.policy;
  const reviewSystem = `${kind.review}\n\n${kind.protocol}`;
  const fixed = estimateTokens(reviewSystem) + 200;
  const pack = list => packBatches(list, {budgetTokens, fixedTokens: fixed});
  const review = async (list, stage) => runBatches({batches: pack(list), system: reviewSystem, parse: parseFindings, call, ledger, stage, log, concurrency});

  const escalations = [];
  const findings = [];
  const pass1 = await review(items, 'review');
  const flagged = new Map();
  for (const r of pass1) {
    if (!r.parsed || r.parsed.malformed) { for (const id of r.ids) escalations.push({id, stage: 'review', reason: 'review_failed', detail: r.error}); continue; }
    for (const f of r.parsed.findings) { findings.push({...f, pass: 1}); (flagged.get(f.id) ?? flagged.set(f.id, []).get(f.id)).push(f); }
  }
  const confirmed = new Map();
  const unsure = [];
  const noted = [];
  for (const [id, fs] of flagged) {
    const w = worst(fs);
    if (atLeast(w.severity, policy.repairAt)) confirmed.set(id, fs);
    else if (atLeast(w.severity, policy.confirmAt)) (policy.secondOpinion ? unsure.push(id) : confirmed.set(id, fs));
    else noted.push({id, severity: w.severity, problem: shortProblem(fs)});
  }
  const dismissed = [];
  if (unsure.length) {
    const pass2 = await review(unsure.map(id => byId.get(id)), 'second_opinion');
    for (const r of pass2) {
      const second = new Map();
      if (r.parsed && !r.parsed.malformed) for (const f of r.parsed.findings) { findings.push({...f, pass: 2}); (second.get(f.id) ?? second.set(f.id, []).get(f.id)).push(f); }
      for (const id of r.ids) {
        const agree = (second.get(id) ?? []).some(f => atLeast(f.severity, policy.confirmAt));
        if (!r.parsed || r.parsed.malformed) confirmed.set(id, flagged.get(id)); // cannot settle: treat as confirmed (the loop decides)
        else if (agree) confirmed.set(id, [...flagged.get(id), ...second.get(id)]);
        else dismissed.push({id, problem: shortProblem(flagged.get(id))});
      }
    }
  }

  const repaired = [];
  if (repair && kind.repair && confirmed.size) {
    const repairSystem = `${kind.repair}\n\n${kind.repairProtocol}`;
    let pending = [...confirmed.keys()].map(id => ({id, reasons: confirmed.get(id).map(f => `[${f.severity}] ${f.problem}`), current: byId.get(id).work}));
    for (let round = 1; pending.length && round <= policy.maxRepairRounds; round++) {
      const repairItems = pending.map(p => {
        const it = byId.get(p.id);
        return {...it, work: `${p.current}\nPROBLEMS FOUND:\n${p.reasons.map(r => `- ${r}`).join('\n')}`};
      });
      const rr = await runBatches({batches: packBatches(repairItems, {budgetTokens, fixedTokens: estimateTokens(repairSystem) + 200}), system: repairSystem, parse: parseRepairs, call, ledger, stage: 'repair', log, concurrency});
      const proposals = new Map();
      for (const r of rr) if (r.parsed) for (const x of r.parsed.repairs) proposals.set(x.id, x);
      const toRecheck = [];
      const next = [];
      for (const p of pending) {
        const x = proposals.get(p.id);
        if (!x) { next.push({...p, reasons: [...p.reasons, 'no repair returned'], last: 'repair_missing'}); continue; }
        if (x.work == null) { escalations.push({id: p.id, stage: 'repair', reason: 'repair_declined', detail: x.reason, problem: shortProblem(confirmed.get(p.id))}); continue; }
        const c = await check(byId.get(p.id), x.work);
        if (!c.ok) { next.push({...p, current: x.work, reasons: [...p.reasons, ...c.problems.map(m => `validator: ${m}`)], last: 'check_failed', checkProblems: c.problems}); continue; }
        toRecheck.push({p, work: x.work, note: x.note});
      }
      if (toRecheck.length) {
        const rv = await review(toRecheck.map(({p, work}) => ({...byId.get(p.id), work})), 're_review');
        const again = new Map();
        const failed = new Set();
        for (const r of rv) {
          if (!r.parsed || r.parsed.malformed) { r.ids.forEach(id => failed.add(id)); continue; }
          for (const f of r.parsed.findings) { findings.push({...f, pass: 3, round}); (again.get(f.id) ?? again.set(f.id, []).get(f.id)).push(f); }
        }
        // A re-review flag blocks the repair only when a second pass over the repaired work agrees (cheap models also flag
        // correct work; one unconfirmed flag must not undo a validated repair).
        const flaggedAgain = toRecheck.filter(({p}) => (again.get(p.id) ?? []).some(f => atLeast(f.severity, policy.confirmAt)));
        if (flaggedAgain.length && policy.secondOpinion) {
          const rv2 = await review(flaggedAgain.map(({p, work}) => ({...byId.get(p.id), work})), 're_review_second_opinion');
          const agree = new Map();
          for (const r of rv2) {
            if (!r.parsed || r.parsed.malformed) continue; // cannot settle: the first re-review stands
            const seen = new Set(r.parsed.findings.filter(f => atLeast(f.severity, policy.confirmAt)).map(f => f.id));
            for (const f of r.parsed.findings) findings.push({...f, pass: 4, round});
            for (const id of r.ids) agree.set(id, seen.has(id));
          }
          for (const [id, ok] of agree) if (!ok) again.delete(id);
        }
        for (const {p, work, note} of toRecheck) {
          const fs = (again.get(p.id) ?? []).filter(f => atLeast(f.severity, policy.confirmAt));
          if (failed.has(p.id)) next.push({...p, current: work, last: 're_review_failed'});
          else if (fs.length) next.push({...p, current: work, reasons: fs.map(f => `[${f.severity}] ${f.problem}`), last: 'still_flagged'});
          else repaired.push({id: p.id, original: byId.get(p.id).work, work, round, problem: shortProblem(confirmed.get(p.id)), note});
        }
      }
      pending = next;
    }
    for (const p of pending) escalations.push({id: p.id, stage: 'repair', reason: p.last ?? 'unresolved', problem: shortProblem(confirmed.get(p.id)), last_reasons: p.reasons.slice(-2).join(' | ').slice(0, 300)});
  } else if (confirmed.size) {
    for (const [id, fs] of confirmed) escalations.push({id, stage: 'review', reason: 'confirmed_problem', severity: worst(fs).severity, problem: shortProblem(fs)});
  }
  return {items: items.length, findings, flagged: [...flagged.keys()], confirmed: [...confirmed.keys()], dismissed, noted, repaired, escalations, ledger};
}


function readdirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

/** Recall and false-alarm rate of flagged ids against a truth map `{id: true (has a planted error) | false}`. */
export function score(flaggedIds, truth) {
  const flagged = new Set(flaggedIds);
  let tp = 0, fn = 0, fp = 0, tn = 0;
  for (const [id, bad] of Object.entries(truth)) {
    if (bad) (flagged.has(id) ? tp++ : fn++);
    else (flagged.has(id) ? fp++ : tn++);
  }
  return {tp, fn, fp, tn, recall: tp + fn ? tp / (tp + fn) : null, false_alarm_rate: fp + tn ? fp / (fp + tn) : null};
}
