/**
 * Checks of books-direct-calibration (pure functions). parse: the "Final answer:" line. check: the line exists and is not empty.
 * score: the books evaluation's deterministic rules (tools/eval/books/score.mjs); `undecided` when only a judge could decide.
 * Gold fields (answer, answer_value, answer_kind) are read here only, never rendered into the prompt.
 */
import {finalLine} from '../../tools/eval/books/attribution.mjs';
import {responseOf, deterministic} from '../../tools/eval/books/score.mjs';

export function parse(text) {
  return {final: finalLine(text)};
}

export function check(item, output) {
  if (output.final && output.final.trim()) return {ok: true, value: output.final.trim()};
  return {ok: false, problems: ['the reply has no line starting with "Final answer:"'], hint: 'End with exactly one line: Final answer: <answer>.'};
}

export function score(item, output) {
  const rec = {arm: 'direct', ok: true, text: output.text, final: output.final ?? null, gold_kind: item.answer_kind, gold_value: item.answer_value};
  const verdict = deterministic(rec, responseOf(rec));
  return verdict ? {label: verdict.outcome, reason: verdict.reason} : {label: 'undecided', reason: 'only a judge can decide (free-text gold)'};
}
