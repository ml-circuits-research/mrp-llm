/**
 * The proposal check of jobs/formalization-improve (pure, synchronous): a reply of the proposer is a few `fact` wires for the learned
 * layer (config/knowledge/formalizer-learned-v1). The check renames the wire ids apart, admits only the allowed predicates over
 * questions the step-by-step code reads from data, keeps the placeholders of a replaced text, compiles and lints the protocol with
 * the proposal (tools/formalizer-protocol/check.mjs), renders every problem question with it, and refuses text copied from a
 * regression case (any run of five words of a case message): a learned rule is generic, never a test case.
 */
import {createHash} from 'node:crypto';
import {words, unquote} from '../../sop/parser.mjs';
import {protocolCircuits, dataOf} from '../../lib/formalize/protocol-data.mjs';
import {problemText} from '../../lib/query-author/step-by-step/problem.mjs';
import {loadProtocol, PROTOCOL_ID} from '../../lib/formalize/internal-reasoning/reasoner.mjs';
import {checkProtocol} from '../../tools/formalizer-protocol/check.mjs';

/** Predicates a proposal may assert, with the place of the question they are about (null: not about one question). */
export const ALLOWED = Object.freeze({
  fp_hint: 0, fp_example: 0, fp_question_text: 0, fp_choice_text: 0, fp_problem_step: 2, fp_problem_step_when: 0, fp_problem_required: 0,
  fp_problem_exit_kind: null, fp_own_data_kind: null, fp_problem_kind_note: 1,
});
export const MAX_WIRES = 6;

const fold = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
const grams = (text, n = 5) => { const w = fold(text), out = new Set(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' ')); return out; };
export const stripFences = t => String(t ?? '').replace(/^[\s\S]*?```[a-z]*\s*\n/i, m => (/```/.test(m) ? '' : m)).replace(/\n?```[\s\S]*$/, '').trim();
const placeholders = t => [...String(t).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join(',');

/** Parses the wires of a reply: [{id, predicate, args}] or a problem string. Ids are renamed apart: fp_l<hash>_<n>. */
export function parseProposal(text) {
  const sop = stripFences(text);
  const blocks = sop.split(/\n(?=@)/).map(b => b.trim()).filter(b => b && !/^#/.test(b));
  const hash = createHash('sha256').update(sop).digest('hex').slice(0, 8);
  const wires = [], problems = [];
  blocks.forEach((b, k) => {
    const lines = b.split('\n').filter(l => l.trim() && !/^\s*#/.test(l));
    const head = /^@(\S+)\s+fact\s*$/.exec(lines[0] ?? '');
    const holds = lines.length === 2 ? /^\s+holds\s+(.+)$/.exec(lines[1]) : null;
    if (!head || !holds) { problems.push(`wire ${k + 1}: only "@id fact" with one "holds ..." line is allowed`); return; }
    const [predicate, ...args] = words(holds[1].trim());
    wires.push({id: `fp_l${hash}_${k + 1}`, predicate, args: args.map(a => a.startsWith('"') ? unquote(a) : /^-?\d+$/.test(a) ? Number(a) : a), raw: holds[1].trim()});
  });
  return {wires, problems, sop: wires.map(w => `@${w.id} fact\n  holds ${w.raw}`).join('\n')};
}

/** Checks a proposal; `messages` are the regression case messages (the no-copy check). Returns {ok, problems, sop}. */
export function checkProposal(text, {messages = []} = {}) {
  const {wires, problems, sop} = parseProposal(text);
  if (!wires.length && !problems.length) problems.push('the reply holds no wire');
  if (wires.length > MAX_WIRES) problems.push(`at most ${MAX_WIRES} wires per proposal (got ${wires.length})`);
  const base = dataOf(protocolCircuits());
  const questions = new Set([...base.rows('follow_up').filter(r => r[1] === 'ask_problem').map(r => r[0]), 'ask_own_data']);
  const kinds = new Set(base.rows('choice').filter(r => r[0] === 'problem_kind').map(r => r[2]));
  for (const w of wires) {
    if (!(w.predicate in ALLOWED)) { problems.push(`${w.predicate}: not an allowed predicate (${Object.keys(ALLOWED).join(', ')})`); continue; }
    const at = ALLOWED[w.predicate];
    if (at !== null && !questions.has(w.args[at])) problems.push(`${w.predicate}: ${w.args[at]} is not a question the step-by-step code reads from data (${[...questions].join(', ')})`);
    if (['fp_problem_step', 'fp_problem_kind_note'].includes(w.predicate) && !kinds.has(w.args[0])) problems.push(`${w.predicate}: ${w.args[0]} is not a problem kind`);
    if (w.predicate === 'fp_question_text') {
      const old = base.rows('question_text').filter(r => r[0] === w.args[0]).at(-1)?.[1];
      if (old != null && placeholders(old) !== placeholders(w.args[1])) problems.push(`fp_question_text ${w.args[0]}: keep exactly the placeholders ${placeholders(old) || '(none)'} of the current text`);
    }
    for (const t of w.args.filter(a => typeof a === 'string' && /\s/.test(a))) {
      const g = grams(t);
      const copied = messages.find(m => [...grams(m)].some(x => g.has(x)));
      if (copied) problems.push(`${w.predicate}: the text copies words of a regression case; a learned rule must be generic (an invented example, never a case)`);
    }
  }
  if (problems.length) return {ok: false, problems: [...new Set(problems)], sop};
  const circuits = [...protocolCircuits(), {name: '9999-candidate.sop', file: '9999-candidate.sop', layer: 'candidate', text: sop + '\n'}];
  try {
    const lint = checkProtocol(loadProtocol({id: PROTOCOL_ID, circuits: circuits.map(c => ({name: c.file, text: c.text}))}));
    if (!lint.ok) return {ok: false, problems: lint.problems.slice(0, 6).map(p => `protocol lint ${p.code}: ${p.message}`), sop};
  } catch (e) { return {ok: false, problems: [`the protocol does not compile with the proposal: ${String(e.message).slice(0, 300)}`], sop}; }
  try {
    const data = dataOf(circuits);
    for (const q of questions) if (data.rows('question_text').some(r => r[0] === q)) problemText(data, q, {names: 'a, b', numbered_names: '1. a', kind_note: '', what: 'x'});
  } catch (e) { return {ok: false, problems: [`a question does not render: ${e.message}`], sop}; }
  return {ok: true, problems: [], sop};
}
