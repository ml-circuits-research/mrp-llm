// The formalization regression set and its gate helpers (AGENTS.md "Formalization improvement"): inbox rows become deduplicated cases
// with references only, sealed suites are refused by provenance, failures are clustered from structure, runs are compared, and a
// learned-layer proposal is checked before any regression run (allowed predicates, placeholders, no copied text, protocol lint).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeInbox, detailCodes, sealedRef, caseIdOf} from '../../tools/eval/formalization/regression/cases.mjs';
import {clusterOf, compareRuns} from '../../tools/eval/formalization/regression/run.mjs';
import {checkProposal} from '../../jobs/formalization-improve/proposal.mjs';

const row = (id, kind, extra = {}) => ({t: `2026-10-02T00:00:0${kind.length % 9}Z`, source: 'problem-agent', kind, message: `Problem ${id}: Ana has 3 apples.`, strategy: 'LocalLLMStepByStep', tier: 'tiny',
  expected: 'Three.', detail: 'wrong | supported | the judge said "3 is not 4"', ref: {run: 'r1', id, book: 'math', arm: 'steps'}, ...extra});

test('inbox rows merge into cases by problem id: references and structural codes only, no text, sealed suites refused', () => {
  const items = new Map([['math:1', {answer_kind: 'number', area: 'A', grade: 1}]]);
  const {cases, added, refused} = mergeInbox({cases: [], inbox: [row('math:1', 'wrong'), row('math:1', 'unclear'), {...row('x', 'invalid'), ref: 'eval/suites/kbqa-x/test.jsonl#3'}], items});
  assert.deepEqual(added, ['books/math:1']);
  assert.equal(refused.length, 1);
  assert.equal(cases[0].observations.length, 2);
  assert.equal(cases[0].gold_kind, 'number');
  assert.ok(!JSON.stringify(cases).includes('Ana has'), 'no message text in a case');
  assert.deepEqual(detailCodes('wrong | supported | the judge said "3 is not 4" | parse_failed: x'), ['wrong', 'supported', 'parse_failed']);
  assert.ok(sealedRef('eval/suites/a/test.jsonl') && !sealedRef({run: 'r', id: 'math:1'}));
  assert.equal(caseIdOf({source: 'ingestion-agent', message: 'Q?', ref: 'eval/reports/x.jsonl#e1'}).split('/')[0], 'ingestion-agent');
});

test('failure clusters come from the protocol report and the dialog; runs compare by fixed and lost cases', () => {
  assert.equal(clusterOf({outcome: 'correct'}), null);
  assert.equal(clusterOf({outcome: 'unknown', report: {form: 'value'}, dialog: [{name: 'problem_kind'}]}), 'problem_unreadable');
  assert.equal(clusterOf({outcome: 'unknown', report: {form: 'list'}, dialog: []}), 'not_problem:list');
  assert.equal(clusterOf({outcome: 'wrong', report: {form: 'problem', problem: {kind: 'compute'}}}), 'formula_wrong');
  assert.equal(clusterOf({outcome: 'unknown', report: {form: 'problem', problem: {kind: 'deduce'}}}), 'deduce_unknown');
  assert.deepEqual(compareRuns([{id: 'a', outcome: 'correct'}, {id: 'b', outcome: 'wrong'}], [{id: 'a', outcome: 'wrong'}, {id: 'b', outcome: 'correct'}]), {fixed: ['a'], lost: ['b'], compared: 2});
});

test('a learned-layer proposal: allowed predicates over data-read questions, the same placeholders, no copied case text, a protocol that lints', () => {
  assert.ok(checkProposal('```sop\n@a fact\n  holds fp_hint problem_formulas "Write the line of the value the question asks for last."\n```').ok);
  assert.match(checkProposal('@a fact\n  holds fp_hint ask_kind "x y"').problems[0], /not a question the step-by-step code reads/);
  assert.match(checkProposal('@a rule\n  when fp_kind ?k\n  then fp_needed x none').problems[0], /only "@id fact"/);
  assert.match(checkProposal('@a fact\n  holds fp_question_text problem_formulas "no placeholders here"').problems[0], /placeholders/);
  assert.match(checkProposal('@a fact\n  holds fp_hint problem_values "copy every price of the green tickets now"', {messages: ['She buys every price of the green tickets now and then']}).problems[0], /copies words/);
  assert.match(checkProposal('@a fact\n  holds fp_problem_step riddle 1 problem_values').problems.join(' '), /not a problem kind/);
});
