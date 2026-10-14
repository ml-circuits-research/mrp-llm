/**
 * The TaskLambdas of the offline formalization regression (owner request 2026-10-03; AGENTS.md "Offline formalization regression"),
 * registered through the Ploinky user configuration (~/.pworker/config.json) `lambdas.project` (the folder jobs/lambdas). They run inside the Ploinky Workers server, one
 * operation at a time in a worker, and reach models only through Ploinky Workers:
 *
 *   regression-record     a tier answers the step-by-step questions of a case set through the CURRENT protocol and the product chat
 *                         turn (ChatSOPAdapter's stepwise path); the answers become recordings keyed by tier and model, which the
 *                         offline regression (tools/eval/formalization/regression/offline.mjs) replays with no model. A local tier runs
 *                         at normal priority (Ploinky Workers shares its slots), a cloud tier at background priority.
 *   regression-reference  the SAME questions answered by larger tiers (small, medium, good) on a stratified sample, at background
 *                         priority (at most 70% of each plan window); then the offline attribution of the recorded tier's failures
 *                         (`attribute`: which step's answer differs from the reference's, by a counterfactual comparison of readings).
 *   regression-grow       new regression cases from the owner's books (local only, DS011), stratified by book and section; a case is
 *                         added only where a stratum is under-represented; never a sealed suite, a seen (evaluation) item, a held-out
 *                         unit or a reviewed gold defect. `set: argument-balanced` builds the balanced Yes/No argument set of the FOL path.
 *   regression-argument   the balanced argument set on ChatSOPAdapter's FOL path (routed mode) and the direct answer of the same tier:
 *                         `record` once through Ploinky Workers, then `replay` offline with no model; Yes and No scored apart, against the
 *                         constant majority answer and the direct answer.
 *
 * Library: `ta.call('regression-record', {tier: 'tiny'}, {wait: false})`; command line: `pworker call regression-record --params '{"tier":"tiny"}'`
 * (`--detach` returns the operation id at once: the background form; `pworker ops <id>` follows it). Every recording run registers its
 * run id with a budget, so its spend (calls, plan credits) is read back from Ploinky Workers's /jobs.
 */
import fs from 'node:fs';
import path from 'node:path';

const TIERS = ['nano', 'micro', 'tiny', 'small', 'medium', 'good'];
const REGRESSION = '../../tools/eval/formalization/regression/';
const lib = name => import(`${REGRESSION}${name}.mjs`);
const writeJson = (ctx, name, value) => fs.writeFileSync(path.join(ctx.dir, name), JSON.stringify(value, null, 1) + '\n');
const histogram = rows => Object.fromEntries(Object.entries(rows.reduce((h, k) => ((h[k] = (h[k] ?? 0) + 1), h), {})).sort((a, b) => b[1] - a[1]));

/** The offline replay of a tier's recordings: counts, the first-failing-step histogram and the attribution against references. */
async function offlineSummary(tier, {model = null, refTiers = ['small', 'good'], ids = null} = {}) {
  const {runOffline} = await lib('offline');
  const out = await runOffline({tier, model, refTiers, ids});
  return {recordings: out.recordings, refs: out.refs, cases: out.results.length, counts: out.counts, first_divergence: out.firsts, attribution: out.causes,
    attributed: out.results.filter(r => r.attribution).map(r => ({id: r.id, cause: r.attribution.cause, step: r.attribution.step, why: r.attribution.why}))};
}

export const lambdas = [
  {
    name: 'regression-record',
    description: 'Record the step-by-step formalization answers of one Ploinky Workers tier on the regression cases (current protocol, product chat turn), keyed by tier and model, so the offline formalization regression replays them with no model; reports the offline floor and the first-failing-step histogram of the new recordings.',
    // Writes recordings and run folders of the repository's gitignored stores; the chat turns run in child processes.
    effects: ['model-calls', 'writes-external'],
    params: {
      tier: {type: 'string', enum: TIERS, default: 'tiny', description: 'the tier that answers every question (no fallback)'},
      set: {type: 'string', enum: ['recorded', 'cases', 'failed'], default: 'recorded', description: 'recorded: the ids of the floor recordings; cases: every runnable regression case; failed: the cases whose recording by this tier\'s model holds a call that gave no answer'},
      ids: {type: 'string[]', required: false, description: 'record only these case ids'},
      n: {type: 'integer', min: 1, max: 5000, required: false, description: 'record only the first N ids'},
      priority: {type: 'string', enum: ['normal', 'background'], required: false, description: 'default: normal for a local tier, background for a cloud tier'},
      workers: {type: 'integer', min: 1, max: 8, default: 2, description: 'chat-turn processes'},
      concurrency: {type: 'integer', min: 1, max: 8, default: 2, description: 'turns at a time per process'},
    },
    async run(ctx) {
      const {recordTier, caseIds} = await lib('record');
      const {tier, set, ids, n, priority, workers, concurrency} = ctx.params;
      const todo = caseIds({set, ids, from: set === 'failed' ? tier : null}).slice(0, n ?? undefined);
      if (!todo.length) return {status: 'failed', summary: 'no case to record'};
      const rec = await recordTier({tier, ids: todo, priority, workers, concurrency, purpose: ctx.ta.purpose, ta: ctx.ta, log: ctx.log});
      const offline = await offlineSummary(tier, {model: rec.slug, ids: todo, refTiers: []});
      writeJson(ctx, 'recording.json', rec);
      writeJson(ctx, 'offline.json', offline);
      return {status: 'finished', recording: rec, offline: {counts: offline.counts, first_divergence: offline.first_divergence},
        summary: `${rec.recorded} recordings of ${tier} (${rec.slug}) from ${todo.length} cases (${rec.not_problem} not in problem mode); offline ${JSON.stringify(offline.counts)}; first divergence ${JSON.stringify(offline.first_divergence)}; spend ${JSON.stringify(rec.spend)}; ${rec.file}`};
    },
  },
  {
    name: 'regression-reference',
    description: 'Answer the same step-by-step questions with larger tiers (small, medium, good) on a stratified sample of the regression cases at background priority, record them keyed by tier and model, then attribute each failure of the recorded tier to the step whose answer differs from the reference (offline, no model).',
    effects: ['model-calls', 'writes-external'],
    params: {
      tiers: {type: 'string[]', enum: ['small', 'medium', 'good'], default: ['small'], description: 'the reference tiers, asked in this order'},
      n: {type: 'integer', min: 1, max: 1000, default: 60, description: 'the size of the stratified sample (by book and section)'},
      seed: {type: 'string', max: 64, default: 'reference-v1', description: 'the sample seed (the same seed gives the same sample)'},
      failing: {type: 'boolean', default: false, description: 'sample only the cases the floor tier fails (what the attribution needs)'},
      ids: {type: 'string[]', required: false, description: 'these case ids instead of a sample'},
      from: {type: 'string', max: 80, required: false, description: 'the recordings the sample is drawn from, tier@model (default: the floor)'},
      priority: {type: 'string', enum: ['normal', 'background'], default: 'background', description: 'background: quiet periods only, within 70% of each plan window'},
      workers: {type: 'integer', min: 1, max: 8, default: 2, description: 'chat-turn processes'},
      concurrency: {type: 'integer', min: 1, max: 8, default: 2, description: 'turns at a time per process'},
    },
    async run(ctx) {
      const {recordTier, referenceIds} = await lib('record');
      const {tiers, n, seed, failing, ids, from, priority, workers, concurrency} = ctx.params;
      const runs = [];
      for (const tier of tiers) {
        const pick = await referenceIds({tier, n, seed, from: from ?? null, failing, ids: ids ?? null});
        ctx.log(`${tier}: ${pick.ids.length} to record, ${pick.already.length} already recorded (pool ${pick.pool})`);
        if (pick.ids.length) runs.push(await recordTier({tier, ids: pick.ids, priority, workers, concurrency, purpose: ctx.ta.purpose, ta: ctx.ta, log: ctx.log}));
      }
      const [floorTier, floorModel] = (from ?? '').split('@');
      const offline = await offlineSummary(floorTier || 'tiny', {model: floorModel || null, refTiers: tiers});
      const steps = histogram(offline.attributed.map(a => `${a.cause}@${a.step}`));
      writeJson(ctx, 'runs.json', runs);
      writeJson(ctx, 'attribution.json', offline);
      return {status: 'finished', runs, attribution: steps,
        summary: `${runs.map(r => `${r.tier} ${r.recorded}/${r.cases} recorded (${JSON.stringify(r.outcomes)}; spend ${JSON.stringify(r.spend)})`).join('; ') || 'nothing new recorded'}; attribution of ${offline.attributed.length} failures: ${JSON.stringify(steps)}`};
    },
  },
  {
    name: 'regression-grow',
    description: 'Add new formalization regression cases from the owner\'s books where a book section is under-represented (stratified, seeded; never a sealed suite, an evaluation item, a held-out unit or a gold defect); or build the balanced Yes/No argument set of the FOL path (set argument-balanced, gold checked against the worked solution by a cheap tier).',
    effects: ['model-calls', 'writes-external'],
    params: {
      set: {type: 'string', enum: ['sections', 'argument-balanced'], default: 'sections', description: 'sections: under-represented book sections; argument-balanced: the logic book\'s argument questions, half Yes, half No'},
      minPerStratum: {type: 'integer', min: 1, max: 20, default: 2, description: 'sections: a book section with fewer runnable cases than this is under-represented'},
      max: {type: 'integer', min: 1, max: 500, default: 80, description: 'at most this many new cases in one growth step'},
      n: {type: 'integer', min: 2, max: 200, default: 40, description: 'argument-balanced: the size of the set (half Yes, half No)'},
      seed: {type: 'string', max: 64, default: 'grow-v1', description: 'the sample seed'},
      checkTier: {type: 'string', enum: ['tiny', 'small', 'medium'], default: 'small', description: 'argument-balanced: the tier that reads the worked solution to check the gold'},
      dryRun: {type: 'boolean', default: false, description: 'report what would be added, write nothing'},
    },
    async run(ctx) {
      const grow = await lib('grow');
      const {set, minPerStratum, max, n, seed, checkTier, dryRun} = ctx.params;
      const out = set === 'argument-balanced'
        ? await grow.growArgument({n, seed, checkTier, dryRun, ta: ctx.ta.with({priority: 'background'}), log: ctx.log})
        : await grow.growSections({minPerStratum, max, seed, dryRun, log: ctx.log});
      writeJson(ctx, 'grow.json', out);
      return {status: 'finished', ...out, summary: out.summary};
    },
  },
  {
    name: 'regression-argument',
    description: 'The balanced Yes/No argument set on ChatSOPAdapter\'s FOL path and the direct answer of the same tier: record once through Ploinky Workers (transport recordings), or replay offline with no model; scores Yes and No apart against the constant majority answer and the direct answer.',
    effects: ['model-calls', 'writes-external'],
    params: {
      action: {type: 'string', enum: ['record', 'replay'], default: 'replay', description: 'record: ask the tiers once (cache first); replay: offline, no model'},
      tier: {type: 'string', enum: ['tiny', 'small', 'medium', 'good'], default: 'tiny', description: 'the tier of the direct answer and of the compute paths; the FOL role is the formalizer tier'},
      priority: {type: 'string', enum: ['normal', 'background'], required: false, description: 'default: normal for tiny, background for a cloud tier'},
    },
    async run(ctx) {
      const arg = await lib('argument');
      const {action, tier, priority} = ctx.params;
      const out = action === 'record'
        ? await arg.recordArgument({tier, priority: priority ?? (tier === 'tiny' ? null : 'background'), purpose: ctx.ta.purpose, ta: ctx.ta, log: ctx.log})
        : await arg.replayArgument({tier, log: ctx.log});
      writeJson(ctx, `argument-${action}.json`, out);
      return {status: 'finished', ...out, summary: out.summary};
    },
  },
];
