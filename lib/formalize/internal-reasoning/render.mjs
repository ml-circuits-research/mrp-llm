/**
 * Rendering of the protocol's questions (DS022 "InternalReasoningStepByStep"). The stable prefix (the system message and the first
 * user turn up to the request) is rendered from the protocol memory's facts (`protocol_text`, `prefix_section`, `prefix_title` and the
 * choice texts of the questions it lists): byte-identical for every request of a protocol version, so llama-server keeps it cached on
 * the strategy's own slot. A question's text is its `question_text` with {{name}} placeholders filled; {{choices}} is the numbered option
 * list and {{zero}} the "0." line. The answer formats are structural readers of the model's short answer (numbers, letters, a verbatim
 * copy, lines of arithmetic); they never interpret the request.
 */
import {readChoice, readChoices, readDates, readUnknowns, readComparison, readExpression} from '../../query-author/step-by-step/answers.mjs';

/** The system message and the byte-identical first-turn prefix of a protocol version. */
export function prefixOf(protocol) {
  const text = key => protocol.rows('protocol_text').find(r => r[0] === key)?.[1] ?? '';
  const sections = protocol.rows('prefix_section').sort((a, b) => a[0] - b[0]).map(([k, q, from]) => {
    const end = protocol.rows('prefix_section_end').find(r => r[0] === k)?.[1] ?? Infinity;
    const title = protocol.rows('prefix_title').find(r => r[0] === k)?.[1] ?? '';
    const lines = protocol.questions.get(q).choices.filter(c => c.n >= from && c.n <= end).map(c => `${c.n - from + 1}. ${c.text}`);
    return `${title}\n${lines.join('\n')}`;
  });
  return {system: text('system'), firstTurn: `${sections.join('\n\n')}\n\n${text('request_start')}`};
}

/** Fills {{name}} placeholders; a missing value is the empty string. */
export const fill = (template, vars) => String(template).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] === undefined || vars[k] === null ? '' : String(vars[k]));

/** A numbered option list. */
export const numberedLines = options => options.map((o, i) => `${i + 1}. ${o.text}`).join('\n');

/** The text of question `q` with its options (each {text}) and the other placeholder values. */
export function questionText(protocol, q, {options = [], ...vars} = {}) {
  const def = protocol.questions.get(q);
  if (!def) throw new Error(`the protocol has no question ${q}`);
  const text = fill(def.text, {...vars, choices: numberedLines(options), zero: def.zero ? `0. ${def.zero}` : ''});
  // A {{zero}} line without a zero option leaves an empty line: removed.
  return text.replace(/\n\n(?=\n)/g, '\n').replace(/^\n+|\n+$/g, '');
}

const strip = text => String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\*\*/g, '').trim();

/** The structural answer readers of the formats; each returns null when the answer does not hold what was asked. */
export const READERS = Object.freeze({
  number: (t, {max, zero}) => readChoice(t, max, {zero}),
  numbers: (t, {max}) => readChoices(t, max),
  letter: (t, {letters}) => { const m = /\b([A-D])\b/.exec(strip(t)); return m && letters.includes(m[1]) ? m[1] : null; },
  letters: (t, {letters, max, texts = []}) => {
    const text = strip(t).replace(/\b([A-D])\s*[:=]\s*(?:0|none|nothing|anything|any)\b/gi, `$1: ${max}`);
    const out = {};
    for (const m of text.matchAll(/\b([A-D])\b\s*(?:[:=\-–)]|is|->)\s*(\d{1,3})\b/g)) if (letters.includes(m[1]) && !(m[1] in out)) out[m[1]] = Number(m[2]);
    // An option written out instead of its number ("A: cedar_hut") is that option when the text is exactly one option's text.
    for (const m of text.matchAll(/\b([A-D])\b\s*[:=]\s*([^\n]+)/g)) {
      if (!letters.includes(m[1]) || m[1] in out) continue;
      const k = texts.findIndex(x => x.toLowerCase() === m[2].trim().replace(/[.,;]+$/, '').toLowerCase());
      if (k >= 0) out[m[1]] = k + 1;
    }
    return Object.keys(out).length ? out : null;
  },
  dates: t => { const d = readDates(t); return d.length ? d : null; },
  unknowns: t => readUnknowns(t),
  conditions: (t, {names}) => {
    const parsed = String(t).split('\n').map(s => s.trim()).filter(s => /[=<>≤≥≠]/.test(s)).map(s => readComparison(s, names));
    return parsed.length && parsed.every(Boolean) ? parsed : null;
  },
  expression: (t, {names}) => readExpression(String(t).split('\n')[0].replace(/^.*?[:=]\s*/, ''), names),
  comparison: (t, {names}) => readComparison(String(t).split('\n')[0], names),
  lines: t => strip(t).split('\n').map(s => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean),
  copy: t => strip(t).replace(/^["'`]+|["'`]+$/g, '').trim(),
});

/** The format a re-ask states when an answer could not be read. */
export const AGAIN = Object.freeze({
  number: ({max, zero}) => zero ? `Reply with one number from 0 to ${max}.` : `Reply with one number from 1 to ${max}.`,
  numbers: () => 'Reply with the numbers separated by commas, or 0.',
  letter: ({letters}) => `Reply with one of ${letters.join(', ')}.`,
  letters: ({letters, example}) => `Reply with one line per letter, like "${example ?? `${letters[0]}: 1`}".`,
  dates: () => 'Write each date as YYYY-MM-DD, one per line.',
  unknowns: () => 'Reply one line per unknown, like "x: 0 to 10".',
  conditions: () => 'One condition per line, like "x + y = 4".',
  expression: () => 'One line of arithmetic only.',
  comparison: () => 'One line, like "x + y > 3".',
});

/** The answer formats the protocol may name: every `answer_format` fact must be one of these (the protocol lint checks it). */
export const ANSWER_FORMATS = Object.freeze(['number', 'numbers', 'letter', 'letters', 'places', 'place', 'statements', 'statement_check', 'sided', 'sided_role', 'negated',
  'negated_statement', 'chain', 'scope', 'limit_target', 'options_target', 'exclusion_target', 'rank_value', 'connect', 'ends', 'names', 'copy', 'dates', 'unknowns',
  'conditions', 'expression', 'comparison', 'unused_name', 'contrast', 'kind_again', 'acts', 'coverage', 'own_data', 'problem', 'code']);
