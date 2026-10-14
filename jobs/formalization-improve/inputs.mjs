/**
 * Inputs of jobs/formalization-improve: one item per failure cluster of the current regression baseline
 * (state/formalization-regression/current.json; clusters by tools/eval/formalization/regression/run.mjs clusterOf). An item shows the
 * proposer up to `maxCases` failed cases of the cluster (the problem, the expected answer, the small model's answers in order, what the
 * circuit answered), the problem-mode protocol (config/knowledge/formalizer-protocol-v1/0060-problem.sop) and the learned layer.
 * `case_ids` (every failed case of the cluster) go to the regression gate, never to the prompt.
 * Options (job.json inputs.options): clusters (list; env FI_CLUSTERS overrides; default the largest cluster), maxCases, skip (clusters
 * that need a language construct, reported as missing_construct instead).
 */
import fs from 'node:fs';
import path from 'node:path';
import {loadCases, loadItems, resolveCase} from '../../tools/eval/formalization/regression/cases.mjs';
import {baselineResults, currentBaseline, LEARNED_DIR} from '../../tools/eval/formalization/regression/gate.mjs';
import {SEEDS_DIR} from '../../lib/knowledge-seeds.mjs';

const WHAT = {
  'not_problem': 'the request states its own data, but the own-data gate was answered "no", so the general protocol looked in the memory instead of modelling the problem',
  problem_unreadable: 'the problem questions were asked but an answer could not be read twice (early exit), so the general protocol took over',
  formula_wrong: 'a compute problem was modelled and executed, but the answer is wrong: a wrong value read, a wrong formula, or an intermediate value asked instead of the result',
  choose_wrong: 'a choice between options was modelled and executed, but the chosen option or its value is wrong',
  compute_unknown: 'a compute or choose problem was modelled, but the circuit gave no answer (a value or formula missing, a formula over an unknown name)',
  deduce_unknown: 'a deduction was modelled (facts, rules, the question), but nothing followed: the facts, the rules and the question do not share property names, or a rule is missing',
  deduce_wrong: 'a deduction was modelled and executed, but the answer is wrong',
  invalid: 'the validator refused the circuit the answers produced',
};
const describe = cluster => WHAT[cluster] ?? WHAT[cluster.split(':')[0]] ?? cluster;

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };

function renderCase(k, c, r) {
  const dialog = (r.dialog ?? []).map(d => `- ${d.name}: ${clip(String(d.answer).replace(/\s*\n\s*/g, ' / '), 400)}`).join('\n');
  return `### Case ${k} (outcome: ${r.outcome})\nProblem:\n${clip(c.message, 1500)}\nExpected answer: ${clip(c.gold, 400)}\nThe small model's answers, in order (question name: answer):\n${dialog || '(none)'}\nWhat the system answered: ${clip(r.response ?? r.text ?? r.error?.message ?? '', 300)}`;
}

export async function inputs({options = {}} = {}) {
  const baseline = currentBaseline();
  if (!baseline) throw new Error('no regression baseline (tools/eval/formalization/regression/gate.mjs set-current RUN_ID)');
  const results = [...baselineResults(baseline).values()];
  const byCluster = new Map();
  for (const r of results) if (r.cluster && !['infrastructure', ...(options.skip ?? [])].includes(r.cluster)) (byCluster.get(r.cluster) ?? byCluster.set(r.cluster, []).get(r.cluster)).push(r);
  const wanted = (process.env.FI_CLUSTERS ? process.env.FI_CLUSTERS.split(',') : options.clusters) ?? [[...byCluster.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0]].filter(Boolean);
  const items = loadItems(), cases = new Map(loadCases().map(c => [c.id, c]));
  // The facts only (one `holds` line each): the texts, choices, order, conditions and exits the proposer may change.
  const holds = text => text.split(/\n(?=@)/).filter(b => /^@\S+\s+fact\s*\n/.test(b)).map(b => /\n\s+holds\s+(.+)/.exec(b)?.[1]).filter(Boolean).join('\n');
  const protocol = holds(fs.readFileSync(path.join(SEEDS_DIR, 'formalizer-protocol-v1', '0060-problem.sop'), 'utf8'));
  const learned = holds(fs.readdirSync(LEARNED_DIR).filter(f => f.endsWith('.sop')).sort().map(f => fs.readFileSync(path.join(LEARNED_DIR, f), 'utf8')).join('\n')) || '(empty)';
  return wanted.filter(w => byCluster.has(w)).map(cluster => {
    const failed = byCluster.get(cluster).sort((a, b) => a.id.localeCompare(b.id));
    const shown = failed.slice(0, options.maxCases ?? 6).map(r => ({r, c: resolveCase(cases.get(r.id), {items})})).filter(x => x.c);
    return {id: cluster.replace(/[^\w-]+/g, '_'), cluster, description: describe(cluster), size: failed.length, case_ids: failed.map(r => r.id),
      cases: shown.map(({c, r}, k) => renderCase(k + 1, c, r)).join('\n\n'), protocol, learned};
  });
}
