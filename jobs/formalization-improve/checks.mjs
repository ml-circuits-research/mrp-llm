/**
 * Job-runner checks of jobs/formalization-improve: the proposal check (proposal.mjs) with the regression case messages for the no-copy
 * rule. Pure functions; the regression gate runs in the sink (sink.mjs), after the checks.
 */
import {checkProposal, stripFences} from './proposal.mjs';
import {loadCases, loadItems, resolveCase} from '../../tools/eval/formalization/regression/cases.mjs';

let messages = null;
const caseMessages = () => (messages ??= (() => { const items = loadItems(); return loadCases().map(c => resolveCase(c, {items})?.message).filter(Boolean); })());

export function parse(text) {
  return {sop: stripFences(text)};
}

export function check(item, output) {
  // The proposer may decline: the failures need a language construct or knowledge, not a protocol change (an escalation).
  const escalate = /^\s*ESCALATE:\s*(.+)$/m.exec(String(output.text ?? output.sop ?? ''));
  if (escalate && !/```/.test(String(output.text ?? ''))) return {ok: true, value: {escalate: escalate[1].trim()}};
  const r = checkProposal(output.sop ?? output.text, {messages: caseMessages()});
  return r.ok ? {ok: true, value: {sop: r.sop}} : {ok: false, problems: r.problems, hint: 'Reply with at most 6 fact wires, each "@id fact" and one "holds fp_..." line, over the listed questions only; generic text, no words copied from the cases.'};
}
