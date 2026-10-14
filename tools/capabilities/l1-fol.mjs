/**
 * The converter family of the capability battery (owner request 2026-10-03): the fol-v3 line forms and support questions read by the
 * FOL reader and lowered by the converters, with NO model. Each case (eval/capabilities/fol-cases.json) is a fixed list of FOL lines,
 * as the formalizer would write them ("? " marks a question), of an invented problem; the case runs
 *   parseFol (lib/formalize/fol/parse.mjs) → folToIr (to-ir.mjs) → compileIr (to-sop.mjs) → executeFol (lib/adapter/paths/fol.mjs)
 * on the scratch executor of ChatSOPAdapter (lib/adapter/executor.mjs: one Agent turn per circuit, the validator, the KnowledgeLinker,
 * the StrategyRouter and the oracle, exactly the route a chat turn takes), and compares what it gets with the case's expectation:
 *   rejected   substrings of the reader's and converters' refusals, in order (none when the field is absent)
 *   answers    one entry per circuit: `kind`, `status` (the packet's), `value` (the circuit's decoded answer), `detail` (effects,
 *              explanations, missing facts, rules used, Change's premise), `conditional` (the assumptions the answer rests on); a
 *              field left out is not compared
 *
 * The capabilities (`f.*`) are derived from the converters' own tables, so a new line form, support question or effect class
 * appears as a capability without a sample (`missing`) until a case covers it: the line forms SUPPOSE and ASSUME, every support
 * question of to-sop.mjs META_KINDS (Effect, Explain, Missing, Why, Change, Assumed) and every effect class of sop/enums.mjs
 * EFFECT_CLASSES. A case names its main capability (`capability`) and the others it also exercises (`also`).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {parseFol} from '../../lib/formalize/fol/parse.mjs';
import {folToIr} from '../../lib/formalize/fol/to-ir.mjs';
import {compileIr, META_KINDS} from '../../lib/formalize/fol/to-sop.mjs';
import {EFFECT_CLASSES} from '../../sop/enums.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const FOL_CASES = path.join(ROOT, 'eval/capabilities/fol-cases.json');

/** The line forms of fol-v3 that are not questions (lib/formalize/fol/parse.mjs: `{type: 'suppose'}`, `{type: 'assume'}`). */
export const FOL_LINE_FORMS = Object.freeze(['suppose', 'assume']);

/** The converter's capabilities: line forms, support questions, effect classes. */
export function folCapabilities() {
  return [...FOL_LINE_FORMS.map(f => 'f.line.' + f), ...META_KINDS.map(k => 'f.question.' + k), ...EFFECT_CLASSES.map(e => 'f.effect.' + e)];
}

/** One FOL line as the formalizer writes it: a parsed unit, or an unparsed one carrying the reader's reason. */
function unit(line) {
  const question = line.startsWith('?'), text = line.replace(/^\?\s*/, '');
  const p = parseFol(text);
  return p.ok ? {ast: p.ast, question, source: text} : {unparsed: text, question, source: text, why: p.why};
}

/** The circuits of a case's lines: {circuits, rejected: [why]} (the reader's refusals first, then the converters'). */
export function compileFolCase(c) {
  const units = c.fol.map(unit);
  const ir = folToIr(units);
  const out = compileIr(ir, {names: new Map()});
  const rejected = [...units.filter(u => u.why).map(u => u.why), ...ir.rejected.map(r => r.why), ...out.rejected.map(r => r.why)];
  return {circuits: out.circuits, rejected};
}

/** The hand-written converter cases: {cases, missing} (`missing`: capabilities no case covers). */
export function folCases(file = FOL_CASES) {
  const cases = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).cases : [];
  const covered = new Set(cases.flatMap(c => [c.capability, ...(c.also ?? [])]));
  return {cases, missing: folCapabilities().filter(id => !covered.has(id))};
}

/** Run one case on an executor ({run(sop, literals) → packet}): {pass, got}. */
export async function runFolCase(c, executor) {
  let compiled;
  try { compiled = compileFolCase(c); } catch (e) { return {pass: false, got: 'converter error: ' + e.message}; }
  const want = c.expect;
  const rejected = want.rejected ?? [];
  if (compiled.rejected.length !== rejected.length || rejected.some((s, i) => !compiled.rejected[i].includes(s))) return {pass: false, got: 'rejected ' + JSON.stringify(compiled.rejected)};
  const answers = want.answers ?? [];
  if (compiled.circuits.length !== answers.length) return {pass: false, got: `${compiled.circuits.length} circuits, expected ${answers.length}`};
  const got = [];
  for (const [i, circuit] of compiled.circuits.entries()) {
    const p = await executor.run(circuit.sop, circuit.literals);
    const a = {kind: circuit.kind, status: p.status, value: p.status === 'error' ? null : circuit.decode(p),
      ...(circuit.detail && p.status !== 'error' ? {detail: circuit.detail(p)} : {}), conditional: p.conditional ?? [], ...(p.error ? {error: p.error} : {})};
    got.push(a);
    const diff = Object.keys(answers[i]).find(k => !isDeepStrictEqual(a[k], answers[i][k]));
    if (diff) return {pass: false, got: `circuit ${i + 1} ${diff}: ${JSON.stringify(a[diff])}, expected ${JSON.stringify(answers[i][diff])}` + (a.error ? ` (${a.error})` : '')};
  }
  return {pass: true, got: JSON.stringify(got)};
}

/** Run every case on one scratch executor (the product's engines over a scratch memory): {[id]: {pass, got}}. */
export async function runFolCases(cases) {
  if (!cases.length) return {};
  const {scratchExecutor} = await import('../../lib/adapter/executor.mjs');
  const executor = await scratchExecutor();
  const out = {};
  try { for (const c of cases) out[c.id] = await runFolCase(c, executor); } finally { executor.dispose(); }
  return out;
}
