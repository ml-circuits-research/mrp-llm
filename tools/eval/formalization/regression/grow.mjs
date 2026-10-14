#!/usr/bin/env node
/**
 * Growth of the formalization regression set from the owner's books (owner request 2026-10-03), the library under the TaskLambda
 * `regression-grow` (jobs/lambdas/regression.mjs). Book text stays local (datasets_sources/, DS011): a case in git holds only its id,
 * provenance and labels (cases.mjs).
 *
 *   sections            a case is worth adding where a book section (book and area) has fewer runnable regression cases than
 *                       `minPerStratum`; per under-represented section a seeded random fresh problem is added until it reaches the
 *                       minimum or `max` cases were added. Stopping rule: growth stops when every section has the minimum; after the
 *                       new cases are recorded (regression-record), `saturation` compares their first-failing-step histogram with the
 *                       floor's: when every failure kind of the batch already has at least `rare` cases in the floor, the set is
 *                       saturated for that minimum, and the next step (minPerStratum + 1) is taken only when a kind is still rare.
 *   argument-balanced   the balanced Yes/No argument set of the FOL path (slice `argument`): the logic book's yes/no problems, half
 *                       gold Yes and half gold No; the No side is drawn first from the chapters of the Yes side, so a chapter does
 *                       not predict the answer; every gold is checked against the book's worked solution by a cheap tier (the model
 *                       reads the solution and states its conclusion; a disagreement leaves the problem out and is reported).
 * Never admitted: a sealed suite (cases.mjs `sealedRef`), a unit of the strict held-out split (tools/eval/routed/structure/
 * heldout.mjs), a reviewed gold defect (datasets_sources/books/eval/gold-defects.jsonl), a problem the fol-v3 development used
 * (state/structure-formalizer/fol-v3*, and the problems named in wire-type proposal P-1), a problem already a case (by id or by
 * message hash), a duplicate item (`dup_of`). Sections growth also skips items seen by an evaluation (datasets_sources/books/eval/
 * seen.jsonl); every added problem is marked seen, so no later evaluation samples a regression case.
 *   node tools/eval/formalization/regression/grow.mjs sections [--min 2] [--max 80] [--seed grow-v1] [--dry-run]
 *   node tools/eval/formalization/regression/grow.mjs saturation --ids a,b [--rare 5]
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ROOT, loadCases, loadItems, writeCases, messageHash, sealedRef} from './cases.mjs';

const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const rank = (seed, s) => createHash('sha256').update(`${seed}/${s}`).digest('hex');
const seeded = (list, seed, f = x => x.id) => [...list].sort((a, b) => rank(seed, f(a)).localeCompare(rank(seed, f(b))));
export const SEEN = path.join(ROOT, 'datasets_sources/books/eval/seen.jsonl');
export const DEFECTS = path.join(ROOT, 'datasets_sources/books/eval/gold-defects.jsonl');
export const GOLD_CHECKS = path.join(ROOT, 'datasets_sources/formalization-regression/gold-checks.jsonl');
/** The strata of the books: book and area (a chapter or a subject). */
export const stratumOf = item => `${item.book}/${item.area ?? item.chapter ?? '-'}`;

/** The problems no growth may add, with the reason of each family. */
export async function exclusions({cases = loadCases()} = {}) {
  const {heldoutUnits, unitOf} = await import('../../routed/structure/heldout.mjs');
  let held = new Set();
  try { held = heldoutUnits(); } catch { /* no frozen split on this machine: nothing is held out */ }
  const dev = new Set();
  const sf = path.join(ROOT, 'state/structure-formalizer');
  for (const d of fs.existsSync(sf) ? fs.readdirSync(sf).filter(n => n.startsWith('fol-v3')) : []) {
    const ids = path.join(sf, d, 'ids.json');
    if (fs.existsSync(ids)) for (const id of JSON.parse(fs.readFileSync(ids, 'utf8')).ids ?? []) dev.add(id);
    for (const r of readJsonl(path.join(sf, d, 'raw.jsonl'))) if (r.id) dev.add(r.id);
  }
  // The problems the design of P-1 (claims and their support) worked through by hand are development material too.
  const proposals = path.join(ROOT, 'experiments/proposal/wire-type-proposals.md');
  if (fs.existsSync(proposals)) {
    const text = fs.readFileSync(proposals, 'utf8');
    const p1 = text.slice(text.indexOf('## P-1'), text.indexOf('## P-2') > 0 ? text.indexOf('## P-2') : undefined);
    for (const m of p1.matchAll(/\blogic:\d+\b/g)) dev.add(m[0]);
  }
  return {
    held, unitOf, dev,
    defects: new Set(readJsonl(DEFECTS).map(r => r.id)),
    seen: new Set(readJsonl(SEEN).map(r => r.id)),
    caseIds: new Set(cases.map(c => c.provenance?.problem_id).filter(Boolean)),
    hashes: new Set(cases.map(c => c.message_sha).filter(Boolean)),
  };
}

/** Why an item may not be added (null: it may). `seenToo`: an item seen by an evaluation is refused as well. */
export function refusal(item, ex, {seenToo = true} = {}) {
  if (item.dup_of) return 'duplicate item';
  if (sealedRef(item.source_file ?? '')) return 'sealed suite';
  if (ex.held.has(ex.unitOf(item))) return 'held-out unit';
  if (ex.defects.has(item.id)) return 'gold defect';
  if (ex.dev.has(item.id)) return 'fol-v3 development';
  if (ex.caseIds.has(item.id) || ex.hashes.has(messageHash(item.question))) return 'already a case';
  if (seenToo && ex.seen.has(item.id)) return 'seen by an evaluation';
  if (item.answer_kind === 'unknown' || item.answer == null) return 'no gold';
  return null;
}

/** A regression case of a book item (references and labels only). */
export const caseOf = (item, grow) => ({id: `books/${item.id}`, source: 'books', provenance: {reporter: 'regression-grow', book: item.book, problem_id: item.id, ref: null, first_seen: new Date().toISOString(), grow},
  message_sha: messageHash(item.question), gold_kind: item.answer_kind, area: item.area ?? null, grade: item.grade ?? null, runnable: true, ...(grow.slice ? {slice: grow.slice} : {}), observations: []});

function commit(added, {seed, dryRun}) {
  if (dryRun || !added.length) return;
  const cases = loadCases();
  writeCases([...cases, ...added]);
  fs.appendFileSync(SEEN, added.map(c => JSON.stringify({id: c.provenance.problem_id, run: `formalization-regression-grow-${seed}`, at: new Date().toISOString()})).join('\n') + '\n');
}

/** Under-represented sections: the coverage per stratum and the problems that bring each one to `minPerStratum`. */
export async function growSections({minPerStratum = 2, max = 80, seed = 'grow-v1', dryRun = false, log = () => {}} = {}) {
  const items = [...loadItems().values()], cases = loadCases(), ex = await exclusions({cases});
  const byId = new Map(items.map(i => [i.id, i]));
  const have = new Map();
  for (const c of cases.filter(c => c.runnable && c.source === 'books')) { const i = byId.get(c.provenance?.problem_id); if (i) have.set(stratumOf(i), (have.get(stratumOf(i)) ?? 0) + 1); }
  const strata = [...new Set(items.map(stratumOf))];
  const short = seeded(strata.filter(s => (have.get(s) ?? 0) < minPerStratum), seed, s => s);
  const refused = {}, added = [];
  for (const s of short) {
    const pool = seeded(items.filter(i => stratumOf(i) === s), `${seed}/${s}`).filter(i => { const why = refusal(i, ex); if (why) refused[why] = (refused[why] ?? 0) + 1; return !why; });
    for (const i of pool.slice(0, minPerStratum - (have.get(s) ?? 0))) {
      if (added.length >= max) break;
      added.push(caseOf(i, {seed, stratum: s, minPerStratum}));
      ex.caseIds.add(i.id); ex.hashes.add(messageHash(i.question));
    }
  }
  commit(added, {seed, dryRun});
  const remaining = strata.filter(s => (have.get(s) ?? 0) + added.filter(c => stratumOf(byId.get(c.provenance.problem_id)) === s).length < minPerStratum);
  const out = {set: 'sections', minPerStratum, strata: strata.length, covered_before: strata.filter(s => (have.get(s) ?? 0) >= minPerStratum).length, under_represented: short.length,
    added: added.length, ids: added.map(c => c.id), remaining: remaining.length, refused, dry_run: dryRun,
    stop: remaining.length === 0 ? `every section has ${minPerStratum} case(s): record the batch, then check saturation` : `${remaining.length} section(s) still short (no admissible problem left, or max ${max} reached)`};
  out.summary = `${dryRun ? 'would add' : 'added'} ${added.length} case(s) in ${short.length} under-represented section(s) of ${strata.length} (min ${minPerStratum}); ${out.stop}`;
  log(out.summary);
  return out;
}

/**
 * Saturation of a grown batch: its first-failing-step kinds against the floor's (offline replay of the tier's recordings). A kind is
 * rare below `rare` cases in the floor; the batch is saturated when it found no rare kind (its failures repeat what the floor covers).
 */
export async function saturation({ids, tier = 'tiny', model = null, rare = 5}) {
  const {runOffline, loadFloor} = await import('./offline.mjs');
  const out = await runOffline({tier, model, refTiers: []});
  const batch = new Set(ids);
  const floorKinds = {}, batchKinds = {};
  for (const r of out.results) if (r.first) { const k = `${r.first.kind}@${r.first.step}`; (batch.has(r.id) ? batchKinds : floorKinds)[k] = ((batch.has(r.id) ? batchKinds : floorKinds)[k] ?? 0) + 1; }
  const rareKinds = Object.keys(batchKinds).filter(k => (floorKinds[k] ?? 0) < rare);
  const recorded = out.results.filter(r => batch.has(r.id)).length;
  return {batch: ids.length, recorded, floor: loadFloor()?.model ?? null, batch_kinds: batchKinds, rare_kinds: rareKinds, saturated: recorded > 0 && rareKinds.length === 0,
    next: recorded === 0 ? 'record the batch first (regression-record with its ids)' : rareKinds.length ? `grow again with minPerStratum + 1 (rare kinds: ${rareKinds.join(', ')})` : 'stop: the batch repeats failure kinds the floor already covers'};
}

/** The worked solution's conclusion on a yes/no problem, read by a cheap tier: true, false or null (unclear). */
async function solutionSays(ta, tier, item) {
  const r = await ta.json({tier, maxTokens: 400, temperature: 0, purpose: 'job:formalization-regression',
    system: 'You check answer keys. Read the problem and its worked solution. Say what the worked solution concludes for the yes/no question. Return only JSON {"conclusion": "yes" | "no" | "unclear"}.',
    prompt: `Problem:\n${item.question}\n\nWorked solution:\n${item.solution ?? ''}\n\nJSON:`});
  const c = String(r.json?.conclusion ?? '').toLowerCase();
  return {value: c === 'yes' ? true : c === 'no' ? false : null, credits: r.credits ?? 0, ok: r.ok};
}

/**
 * The balanced argument set: `n` problems of the logic book with a yes/no gold, half Yes and half No (fewer when the book has fewer
 * admissible Yes problems), each gold checked against its worked solution on `checkTier`.
 */
export async function growArgument({n = 40, seed = 'argument-v1', checkTier = 'small', dryRun = false, ta = null, log = () => {}} = {}) {
  const {goldOf} = await import('../../routed/structure/gold.mjs');
  const items = [...loadItems().values()], cases = loadCases(), ex = await exclusions({cases});
  const refused = {};
  const pool = items.filter(i => i.book === 'logic' && goldOf(i)?.kind === 'yes_no').filter(i => { const why = refusal(i, ex, {seenToo: false}); if (why) refused[why] = (refused[why] ?? 0) + 1; return !why; });
  const chapter = i => String(i.section ?? '').split('.')[0];
  const checks = new Map(readJsonl(GOLD_CHECKS).map(r => [`${r.id}|${r.tier}`, r]));
  const check = async i => {
    const key = `${i.id}|${checkTier}`;
    if (!checks.has(key)) {
      if (!ta) return null;
      const s = await solutionSays(ta, checkTier, i);
      if (!s.ok) return null;
      const row = {id: i.id, tier: checkTier, says: s.value, gold: i.answer_value, at: new Date().toISOString()};
      fs.mkdirSync(path.dirname(GOLD_CHECKS), {recursive: true});
      fs.appendFileSync(GOLD_CHECKS, JSON.stringify(row) + '\n');
      checks.set(key, row);
    }
    return checks.get(key).says === i.answer_value;
  };
  const half = Math.floor(n / 2), yes = [], no = [], disagreed = [];
  for (const i of seeded(pool.filter(x => x.answer_value === true), `${seed}/yes`)) { if (yes.length >= half) break; const ok = await check(i); if (ok) yes.push(i); else disagreed.push({id: i.id, gold: true, ok}); }
  // The No side follows the chapters of the Yes side first (a chapter must not predict the answer), then the other chapters in turn.
  const want = yes.length, chapters = yes.map(chapter);
  const nos = seeded(pool.filter(x => x.answer_value === false), `${seed}/no`);
  const order = [...nos.filter(i => chapters.includes(chapter(i))), ...nos.filter(i => !chapters.includes(chapter(i)))];
  for (const i of order) { if (no.length >= want) break; const ok = await check(i); if (ok) no.push(i); else disagreed.push({id: i.id, gold: false, ok}); }
  const added = [...yes, ...no].map(i => caseOf(i, {seed, slice: 'argument', stratum: `logic/${chapter(i)}`}));
  commit(added, {seed, dryRun});
  const out = {set: 'argument-balanced', requested: n, pool: pool.length, pool_yes: pool.filter(i => i.answer_value).length, yes: yes.length, no: no.length,
    chapters: Object.fromEntries([...new Set(added.map(c => c.provenance.grow.stratum))].map(s => [s, {yes: yes.filter(i => `logic/${chapter(i)}` === s).length, no: no.filter(i => `logic/${chapter(i)}` === s).length}])),
    gold_disagreements: disagreed, refused, ids: added.map(c => c.id), dry_run: dryRun};
  out.summary = `${dryRun ? 'would add' : 'added'} ${added.length} argument case(s): ${yes.length} Yes, ${no.length} No (pool ${pool.length}, ${out.pool_yes} Yes); ${disagreed.length} gold(s) left out after the solution check on ${checkTier}`;
  log(out.summary);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  if (cmd === 'sections') console.log(JSON.stringify(await growSections({minPerStratum: Number(opt('--min', 2)), max: Number(opt('--max', 80)), seed: opt('--seed', 'grow-v1'), dryRun: args.includes('--dry-run')})));
  else if (cmd === 'saturation') console.log(JSON.stringify(await saturation({ids: opt('--ids', '').split(',').filter(Boolean), rare: Number(opt('--rare', 5))})));
  else { console.error('usage: grow.mjs sections [--min 2] [--max 80] [--seed s] [--dry-run] | saturation --ids a,b [--rare 5]'); process.exit(2); }
}
