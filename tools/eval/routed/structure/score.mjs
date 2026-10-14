/**
 * Scoring phase of the PSM/LFM roles (written for the zero-shot probe, archived on 2026-10-03 in probably_obsolete/eval-cleanup-2026-10-03/; used by ./ab.mjs). Deterministic: the PSM extraction against the registry, the question
 * units and the worked solution; the LFM's FOL through the converters (lib/formalize/fol, lib/formalize/structure) and the engines,
 * against the book answer (lib/formalize/equivalence.mjs). Eval code reading the gold; never product code.
 */
import fs from 'node:fs';
import path from 'node:path';
import {structureToIr} from '../../../../lib/formalize/structure/to-ir.mjs';
import {compileFol, executeFol} from '../../../../lib/adapter/paths/fol.mjs';
import {registryOf} from '../../../../lib/formalize/expression-program.mjs';
import {decide} from '../../../../lib/formalize/equivalence.mjs';
import {loadItems} from '../../books/sample.mjs';
import {goldOf} from './gold.mjs';
import {askedVerdict} from './asked.mjs';
import {engines} from './engines.mjs';

const readJsonl = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const pct = (a, b) => (b ? `${Math.round(100 * a / b)}%` : 'n/a');
const fold = s => String(s).toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** PSM scores of one item. */
export function psmScore(row, item) {
  if (row.psm?.error) return {error: row.psm.error};
  const s = structureToIr(row.psm, item.question);
  const solution = String(item.solution ?? '');
  const solNums = new Set([...solution.replace(/(\d),(\d{3})/g, '$1$2').matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0])));
  const used = s.numbers.filter(n => solNums.has(n.value) || (n.percent && solNums.has(n.value)));
  const ents = [...s.names.values()];
  return {
    numbers: s.numbers.length, covered: s.numbers.filter(n => n.quantity).length,
    usedInSolution: used.length, usedCovered: used.filter(n => n.quantity).length,
    digitSpans: s.digitQuantities.length, digitSpansOnRegistry: s.digitQuantities.filter(q => q.registry.length).length,
    wordQuantities: s.wordQuantities,
    goals: s.goals.length, goalsInQuestion: s.goals.filter(g => g.inQuestion).length, goalFound: s.goals.some(g => g.inQuestion),
    entities: ents.length, entitiesInSolution: ents.filter(e => fold(solution).includes(fold(e))).length,
    parts: Object.fromEntries(Object.entries(s.parts).map(([k, v]) => [k, v.length])), relations: s.relations.length,
    goalTexts: s.goals.map(g => g.text), names: s.names,
  };
}

/**
 * One LFM arm through ChatSOPAdapter's FOL path (lib/adapter/paths/fol.mjs): the candidate choice per unit, the converters and the
 * engines are the adapter's; this harness only scores the answers against the book answer.
 */
export async function lfmArm(units, results, {registry, names, gold, item}) {
  if (!Array.isArray(results)) return {error: results?.error ?? 'no results'};
  const {ir, link, circuits, rejected, unitStats} = compileFol(units, results, {registry, names});
  const {answers} = await executeFol(circuits, await engines());
  const got = answers.filter(a => a.value !== null && a.value !== undefined);
  let verdict = 'no_answer', weak = false;
  if (got.length) {
    // An existence question (∃x φ) answers yes/no by whether a thing exists, and which by the things.
    // A question that asks several values is answered by several queries: a numeric gold is compared with all answered numbers
    // (unordered; a yes/no check written next to them is not an asked value); otherwise the first answered query decides.
    const nums = got.flatMap(a => [].concat(a.value)).filter(v => typeof v === 'number');
    const sys = gold.kind === 'number' && nums.length > 1 ? nums : gold.kind === 'number' && nums.length === 1 ? nums[0]
      : got[0].kind === 'which' && gold.kind === 'yes_no' ? got[0].value.length > 0 : got[0].value;
    const g = gold.kind === 'yes_no' ? gold.values[0] : gold.kind === 'number' ? gold.values.join(', ') : gold.values.join(', ');
    const d = await decide(Array.isArray(sys) ? sys.join(', ') : sys, g, {problem: item.question, ordered: false});
    verdict = d.verdict === 'equivalent' ? 'correct' : 'wrong';
    // A weak answer: a yes/no gold decided by an empty `which` list (the closed world's "nothing is"), not by a derivation.
    weak = gold.kind === 'yes_no' && ['which', 'none'].includes(got[0].kind) && [].concat(got[0].value).length === 0;
  }
  return {units: unitStats, queriesInIr: ir.queries.length, facts: ir.facts.length, rules: ir.rules.length, values: ir.values.length, queries: ir.queries.length,
    rejected: [...ir.rejected, ...rejected].length, link: {linked: link.linked.length, unlinked: link.unlinked.length},
    circuits: circuits.length, executed: answers.filter(a => a.status !== 'error').length, answered: got.length, answers, verdict, weak,
    // The asked-parts scorer (./asked.mjs), reported next to the old one.
    asked: askedVerdict(item, gold, answers),
    sop: circuits.map(c => c.sop), reasons: [...ir.rejected, ...rejected].map(x => x.why ?? String(x))};
}

export async function scorePhase({OUT, ROOT}) {
  const raw = readJsonl(path.join(OUT, 'raw.jsonl'));
  const items = new Map(loadItems(ROOT).map(i => [i.id, i]));
  const rows = [];
  for (const r of raw) {
    const item = items.get(r.id), gold = goldOf(item), registry = registryOf(item.question);
    const psm = psmScore(r, item);
    const names = psm.names ?? new Map();
    const a = await lfmArm(r.units, r.lfm, {registry, names, gold, item});
    const b = r.sketch?.length ? await lfmArm(r.sketch.map((u, i) => ({index: i, text: u.text, question: u.question})), r.lfm_sketch, {registry, names, gold, item}) : {error: 'no sketch'};
    rows.push({id: r.id, book: r.book, gold: gold.kind, psm: {...psm, names: undefined}, lfm_text: a, lfm_sketch: b, psm_ms: r.psm_ms, lfm_ms: r.lfm_ms});
  }
  (await engines()).dispose();
  fs.writeFileSync(path.join(OUT, 'results.jsonl'), rows.map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'summary.md'), summary(rows));
  console.log(summary(rows));
}

function summary(rows) {
  const P = rows.map(r => r.psm).filter(p => !p.error);
  const sum = f => P.reduce((s, p) => s + f(p), 0);
  const arm = k => {
    const A = rows.map(r => r[k]).filter(a => !a.error);
    const units = A.flatMap(a => a.units);
    const whys = {};
    for (const u of units) if (u.why) { const key = u.why.replace(/at token \d+/, 'at token N').replace(/variable \w+/, 'variable V').replace(/"[^"]*"/g, '"…"').slice(0, 70); whys[key] = (whys[key] ?? 0) + 1; }
    return {n: A.length, units: units.length, parsedUnits: units.filter(u => u.parsed).length, convertedUnits: units.filter(u => u.converted).length,
      qUnits: units.filter(u => u.question).length, qConverted: units.filter(u => u.question && u.converted).length,
      circuits: A.filter(a => a.circuits).length, executed: A.filter(a => a.executed).length, answered: A.filter(a => a.answered).length,
      correct: A.filter(a => a.verdict === 'correct').length, wrong: A.filter(a => a.verdict === 'wrong').length,
      linked: A.reduce((s, a) => s + a.link.linked, 0), unlinked: A.reduce((s, a) => s + a.link.unlinked, 0),
      whys: Object.entries(whys).sort((x, y) => y[1] - x[1]).slice(0, 8)};
  };
  const a = arm('lfm_text'), b = arm('lfm_sketch');
  const byBook = {};
  for (const r of rows) { const e = (byBook[r.book] ??= {n: 0, goal: 0, qrec: [0, 0]}); e.n++; if (r.psm.goalFound) e.goal++; e.qrec[0] += r.psm.covered ?? 0; e.qrec[1] += r.psm.numbers ?? 0; }
  const L = [];
  L.push(`# PSM/LFM zero-shot probe: ${rows.length} book problems`, '');
  L.push('## PSM (GLiNER2.5 base, schema config/formalize/psm-schema-v1.json)', '');
  L.push(`- quantity recall (registry numbers covered by a quantity span): ${sum(p => p.covered)}/${sum(p => p.numbers)} = ${pct(sum(p => p.covered), sum(p => p.numbers))}`);
  L.push(`- recall of the numbers the worked solution uses: ${sum(p => p.usedCovered)}/${sum(p => p.usedInSolution)} = ${pct(sum(p => p.usedCovered), sum(p => p.usedInSolution))}`);
  L.push(`- quantity precision (digit-bearing quantity spans on a registry number): ${sum(p => p.digitSpansOnRegistry)}/${sum(p => p.digitSpans)} = ${pct(sum(p => p.digitSpansOnRegistry), sum(p => p.digitSpans))}; spans without digits: ${sum(p => p.wordQuantities.length)}`);
  L.push(`- goal recall (a goal span inside a question unit): ${P.filter(p => p.goalFound).length}/${P.length} = ${pct(P.filter(p => p.goalFound).length, P.length)}; goal precision: ${sum(p => p.goalsInQuestion)}/${sum(p => p.goals)} = ${pct(sum(p => p.goalsInQuestion), sum(p => p.goals))}`);
  L.push(`- entities mentioned in the worked solution: ${sum(p => p.entitiesInSolution)}/${sum(p => p.entities)} = ${pct(sum(p => p.entitiesInSolution), sum(p => p.entities))}`);
  L.push(`- spans per label: ${['event', 'state', 'condition', 'rule', 'constraint', 'assumption'].map(l => `${l} ${sum(p => p.parts?.[l] ?? 0)}`).join(', ')}; relations ${sum(p => p.relations)}`);
  L.push('', '| book | n | goal found | quantity recall |', '|---|---|---|---|');
  for (const [k, e] of Object.entries(byBook)) L.push(`| ${k} | ${e.n} | ${e.goal} | ${e.qrec[0]}/${e.qrec[1]} |`);
  for (const [name, x] of [['LFM on the clean problem text (sentence by sentence, 3 candidates, the first that parses and converts)', a], ['LFM on the PSM-based sketch (1 candidate)', b]]) {
    L.push('', `## ${name}`, '');
    L.push(`- units: ${x.units}; a candidate parses: ${x.parsedUnits} (${pct(x.parsedUnits, x.units)}); converts to SOP-IR: ${x.convertedUnits} (${pct(x.convertedUnits, x.units)}); question units converted: ${x.qConverted}/${x.qUnits}`);
    L.push(`- problems with a compiled circuit: ${x.circuits}/${x.n}; executed: ${x.executed}; answered: ${x.answered}; correct: ${x.correct}; wrong: ${x.wrong}`);
    L.push(`- FOL constants linked to a PSM entity: ${x.linked}, unlinked: ${x.unlinked}`);
    L.push(`- first reasons a unit is not converted: ${x.whys.map(([k, v]) => `${k} (${v})`).join('; ')}`);
  }
  return L.join('\n') + '\n';
}
