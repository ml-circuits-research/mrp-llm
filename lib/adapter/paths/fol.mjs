/**
 * The FOL path of ChatSOPAdapter (FOL v2, experiments/proposal/structure-and-formalizer-models.md §10): the formalizer tier (the
 * role prompt the proxy names for it, today fol-v2) writes FOL for the problem sentence by sentence (lib/formalize/fol/input.mjs); the
 * converters read it (lib/formalize/fol: parse, clausification to SOP-IR, lowering to SOP) and the engines execute every query circuit.
 *
 * Soundness is the converters' (lib/formalize/fol/to-sop.mjs): a closed-world "no" is withheld when the asked predicate is defined
 * nowhere in the problem or rests on an open, unparsed or rejected predicate; a quantity with two values and two value rules that
 * both apply give no answer; a circuit whose answer does not reach the problem's numbers through its dataflow is refused.
 *
 * Candidate choice per sentence: the first candidate whose every line parses and converts; when none does, the candidate with the
 * most converted lines gives those lines and its failed lines are passed on as rejected units (their predicates then lose
 * closed-world trust). A line starting with "? " is a query; otherwise a formula of a question sentence is its query when no line of
 * the candidate marks one.
 */
import {parseFol} from '../../formalize/fol/parse.mjs';
import {folToIr} from '../../formalize/fol/to-ir.mjs';
import {compileIr} from '../../formalize/fol/to-sop.mjs';
import {sentencesOf} from '../../formalize/fol/input.mjs';
import {linkConstants} from '../../formalize/structure/to-ir.mjs';
import {registryOf} from '../../formalize/expression-program.mjs';
import {pathResult} from './result.mjs';

/** The chosen units of a formalizer reply (`results`: [{candidates: [text]}] per sentence): {chosen, failed, unitStats}. */
export function chooseUnits(units, results) {
  const chosen = [], failed = [], unitStats = [];
  for (const [i, u] of units.entries()) {
    const cands = results[i]?.candidates ?? [];
    let pick = null, best = null, parsed = 0, converted = 0, why = null;
    for (const c of cands) {
      const lines = String(c).split('\n').map(x => x.trim()).filter(Boolean);
      const marked = lines.some(l => l.startsWith('?'));
      const ok = [], bad = [];
      let parseError = null, convertError = null;
      for (const l of lines) {
        const q = l.startsWith('?'), text = l.replace(/^\?\s*/, '');
        const p = parseFol(text);
        if (!p.ok) { parseError ??= `parse: ${p.why}`; bad.push({unparsed: text, question: q || (!marked && u.question), source: text}); continue; }
        const unit = {ast: p.ast, question: q || (!marked && u.question), source: text};
        const one = folToIr([unit]);
        if (one.rejected.length) { convertError ??= one.rejected[0].why; bad.push(unit); continue; }
        ok.push(unit);
      }
      if (!parseError) parsed++;
      if (!bad.length) { converted++; pick ??= ok; continue; }
      why ??= parseError ?? convertError;
      if (!best || ok.length > best.ok.length) best = {ok, bad};
    }
    unitStats.push({unit: u.text.slice(0, 120), question: u.question, candidates: cands.length, parsed, converted, why: pick ? null : why, chosen: (pick ?? best?.ok)?.map(x => `${x.question ? '? ' : ''}${x.source}`).join(' | ') || null});
    if (pick) chosen.push(...pick);
    else if (best) { chosen.push(...best.ok); failed.push(...best.bad); }
  }
  return {chosen, failed, unitStats};
}

/** The circuits of a formalizer reply: {ir, link, circuits, rejected, unitStats}. `names`: Map slug → text (the structure role's entities). */
export function compileFol(units, results, {registry, names = new Map()}) {
  const {chosen, failed, unitStats} = chooseUnits(units, results);
  const ir = folToIr([...chosen, ...failed]);
  const link = linkConstants(ir, names);
  const {circuits, rejected} = compileIr(ir, {registry, names});
  return {ir, link, circuits, rejected, unitStats};
}

/** Executes the query circuits: {answers: [{kind, status, value, error}], packets}. */
export async function executeFol(circuits, executor) {
  const answers = [], packets = [];
  for (const c of circuits) {
    const p = await executor.run(c.sop, c.literals);
    packets.push(p);
    // The metacognitive questions (effect, abduce, why_not, explain) carry their answer's rest in `detail`: effects, missing facts, rules used.
    const detail = p.status !== 'error' && c.detail ? c.detail(p) : undefined;
    answers.push({kind: c.kind, status: p.status, value: p.status === 'error' ? null : c.decode(p), error: p.error ?? null, ...(detail ? {detail} : {})});
  }
  return {answers, packets};
}

/**
 * The FOL path on a message: one call of the formalizer tier (`fol`, ./clients.mjs folClient) on the problem's sentences, the
 * converters, the engines. `names` links the FOL's constants to the problem's own names (the structure role's entity spans).
 */
export async function pathFol({message, fol, executor, names = new Map(), registry = null, candidates = 1, tier = null}) {
  const t0 = performance.now();
  registry ??= registryOf(message);
  const units = sentencesOf(message);
  const r = await fol({inputs: units.map(u => u.text), candidates});
  if (!r.ok) return pathResult('fol', {status: 'unavailable', tier, calls: 1, cached: false, ms: Math.round(performance.now() - t0), detail: {reason: r.reason}});
  const compiled = compileFol(units, r.body.results, {registry, names});
  const x = await executeFol(compiled.circuits, executor);
  const detail = {units: compiled.unitStats, queries: compiled.ir.queries.length, rejected: [...compiled.ir.rejected, ...compiled.rejected].map(z => z.why ?? String(z)),
    link: {linked: compiled.link.linked.length, unlinked: compiled.link.unlinked.length}, answers: x.answers, reasks: r.body.reasks ?? null};
  return pathResult('fol', {status: compiled.circuits.length ? 'ok' : 'no_answer', answers: x.answers, circuits: compiled.circuits.map(c => c.sop), packets: x.packets,
    tier, calls: 1, cached: r.cached ?? null, ms: Math.round(performance.now() - t0), detail});
}
