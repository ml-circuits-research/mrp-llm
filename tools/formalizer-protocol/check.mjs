#!/usr/bin/env node
/**
 * Lint of the InternalReasoningStepByStep protocol memory (DS022 "InternalReasoningStepByStep"; config/knowledge/formalizer-protocol-v1):
 *   - the wires pass the knowledge validator and the JS oracle compiles them (stratified negation, safe rules and actions);
 *   - every planned question (an `action`) has a text, an answer format with a handler, the slot it establishes and an `askable` rule;
 *     every question text belongs to an action or is a `follow_up` of one; a numbered question has at least two choices or names an
 *     option source; every established slot is read by a rule, and every asserted value by a rule or by the assembly;
 *   - a dry run from each kind of answer, without a model, reaches the goal `formalized`: the planner's plan from the start, then
 *     executed with abstract answers until the goal holds.
 *   node tools/formalizer-protocol/check.mjs [--json]
 */
import {fileURLToPath} from 'node:url';
import {validateProgram} from '../../sop/knowledge/validate.mjs';
import {loadProtocol, decide} from '../../lib/formalize/internal-reasoning/reasoner.mjs';
import {Facts} from '../../lib/formalize/internal-reasoning/state.mjs';
import {ANSWER_FORMATS} from '../../lib/formalize/internal-reasoning/render.mjs';
import {HANDLERS, AFTER} from '../../lib/formalize/internal-reasoning/handlers.mjs';
import {ASSEMBLY_READS} from '../../lib/formalize/internal-reasoning/program.mjs';
import {seedCircuits} from '../../lib/knowledge-seeds.mjs';
import {protocolCircuits} from '../../lib/formalize/protocol-data.mjs';
import {PROTOCOL_ID} from '../../lib/formalize/internal-reasoning/reasoner.mjs';

const NUMBERED = new Set(['number', 'numbers']);

/** Generic observations for a dry run: one statement of two things, one of a thing and a number, one name, one number. */
export function dryRunFacts(kind) {
  const f = new Facts();
  for (const a of ['start', 'candidate_statement st1', 'statement_role st1 subject entity', 'statement_role st1 object entity', 'statement_arity st1 2', 'statement_shape st1 binary_entity',
    'candidate_statement st2', 'statement_role st2 subject entity', 'statement_role st2 object number', 'statement_arity st2 2', 'statement_shape st2 entity_number',
    'mention m1', 'name n1', 'mention_candidate m1 n1', 'single_candidate m1', 'mention m2', 'name n2', 'mention_candidate m2 n2', 'single_candidate m2',
    'number num1', 'limit_candidate num1', 'date_count 0', 'budget_left', 'budget_ample', 'repairs_left']) f.add(...a.split(' '));
  if (kind) { f.add('answered', 'ask_kind', 'none'); f.add('kind', kind); }
  return f;
}

/** Executes decisions with abstract answers (the action's `answered` fact, and `assembled` for the system's step) until the goal. */
export function dryRun(protocol, kind, {control = 'plan', max = 40} = {}) {
  const facts = dryRunFacts(kind);
  const path = [];
  for (let step = 0; step < max; step++) {
    const d = decide(protocol, facts, {control});
    if (d.kind === 'done') return {ok: true, path};
    if (d.kind === 'stuck') return {ok: false, path, reason: d.reason, open: d.open};
    path.push(`${d.action} ${d.arg}`);
    facts.add('answered', d.action, d.arg);
    if (d.action === 'assemble') facts.add('assembled');
  }
  return {ok: false, path, reason: 'too many steps'};
}

export function checkProtocol(protocol = loadProtocol()) {
  const problems = [];
  // The protocol layer and the learned-rules layer are validated together (the learned layer uses the protocol's vocabulary).
  const files = (protocol.circuits ?? (protocol.id === PROTOCOL_ID ? protocolCircuits() : seedCircuits(protocol.id))).map(c => ({name: c.name ?? c.file, text: c.text, role: 'knowledge'}));
  const validated = validateProgram(files, {});
  for (const p of validated.problems.filter(p => p.severity !== 'warning')) problems.push({code: 'validator', message: `${p.file}:${p.line} ${p.code} ${p.message}`});
  const rules = protocol.handle.wires.filter(w => ['rule', 'default', 'integrity'].includes(w.type));
  const bodies = rules.map(w => w.fields.filter(f => ['when', 'except', 'never'].includes(f.key)).map(f => `${f.value} ${(f.block ?? []).map(b => b.value ?? b.text ?? '').join(' ')}`).join('\n')).join('\n');
  const askableRules = new Set(rules.filter(w => /^(?:fp_)?askable\s/.test(w.fields.find(f => f.key === 'then')?.value.trim() ?? '')).map(w => w.fields.find(f => f.key === 'then').value.trim().split(/\s+/)[1]));
  for (const action of protocol.actions) {
    const q = protocol.questions.get(action);
    if (!q) { problems.push({code: 'action_without_text', message: `${action} has no question_text`}); continue; }
    if (!q.format || !ANSWER_FORMATS.includes(q.format)) problems.push({code: 'unknown_format', message: `${action}: answer format ${q.format}`});
    else if (q.format !== 'code' && !HANDLERS[q.format] && !AFTER[action]) problems.push({code: 'no_handler', message: `${action}: no handler for ${q.format}`});
    if (!q.establishes) problems.push({code: 'no_slot', message: `${action} establishes no slot`});
    if (!askableRules.has(action)) problems.push({code: 'never_askable', message: `${action} has no askable rule`});
    if (NUMBERED.has(q.format) && !q.from && q.choices.length < 2) problems.push({code: 'too_few_choices', message: `${action} has fewer than two choices and no option source`});
  }
  for (const [q, def] of protocol.questions) {
    if (!protocol.actions.includes(q) && !def.followUp) problems.push({code: 'orphan_question', message: `${q} is neither an action nor a follow_up`});
    if (def.followUp && !protocol.actions.includes(def.followUp)) problems.push({code: 'orphan_follow_up', message: `${q} follows ${def.followUp}, which is not an action`});
  }
  // A slot is read when a rule needs, settles or opens it, when the prelude lists it, or when a rule reads the answer itself; the
  // system's own step (format code) settles nothing the model answers.
  for (const [q, slot] of protocol.rows('establishes')) if (protocol.questions.get(q)?.format !== 'code' && !new RegExp(`\\b(?:fp_)?(?:settled|open_slot|needed) ${slot}\\b|\\b(?:fp_)?answered ${q}\\b`).test(bodies) && !protocol.rows('prelude_slot').some(r => r[0] === slot))
    problems.push({code: 'slot_not_read', message: `the slot ${slot} of ${q} is read by no rule`});
  for (const [q, p] of protocol.rows('asserts')) if (!new RegExp(`(?:^|\\s)(?:fp_)?${p}\\s`).test(bodies) && !ASSEMBLY_READS.includes(p)) problems.push({code: 'value_not_read', message: `the value ${p} of ${q} is read by no rule and not by the assembly`});
  const kinds = protocol.questions.get('ask_kind').choices.map(c => c.value);
  const dryRuns = {};
  for (const kind of kinds) {
    const run = dryRun(protocol, kind);
    dryRuns[kind] = run;
    if (!run.ok) problems.push({code: 'dry_run', message: `kind ${kind}: no path to formalized (${run.reason}; open ${JSON.stringify(run.open ?? [])})`});
  }
  return {ok: !problems.length, version: protocol.version, questions: protocol.questions.size, actions: protocol.actions.length, rules: rules.length, problems, dryRuns};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = checkProtocol();
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    for (const p of r.problems) console.log(`${p.code} ${p.message}`);
    for (const [kind, run] of Object.entries(r.dryRuns)) console.log(`dry run ${kind}: ${run.ok ? 'formalized' : 'STUCK'} via ${run.path.join(' → ')}`);
    console.log(r.ok ? `OK (${r.actions} actions, ${r.questions} questions, ${r.rules} rules; version ${r.version})` : `${r.problems.length} problem(s)`);
  }
  process.exit(r.ok ? 0 : 1);
}
