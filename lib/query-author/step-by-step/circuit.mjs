/**
 * Circuit writer of the generic question protocol (DS022 "LocalLLMStepByStep", methods B, C and D). The program gathered from the
 * oracle's answers becomes model-surface SOP through fixed templates, and a deterministic English paraphrase of the same program is
 * shown back for the forced-contrast confirmation. The templates are the only writer of SOP in this strategy; the model never writes it.
 *
 * program = {
 *   unclear: null | 'no_request' | 'relation_not_in_memory',
 *   constraint: null | {unknowns, requirements, goal, objective, claim}        (a numeric puzzle, as in method A)
 *   reach: null | {step, avoid, stepName, reachName, start, goal}            (a chain of links, as in method A)
 *   definitions: [sop text]                                                  (session definitions: aggregates, rules)
 *   stated: [{id, certainty, match}]                                        (the user's facts and suppositions)
 *   queries: [{id, form, matches, polarity, select, rank, compares, any, excepts, time, measure, every, links, sample}]
 *   unparsed: [{span, near}]
 *   pragmatic: [kind | {kind, span}]                                         (the message acts: courtesy, emotion, small talk; DS023)
 *   instructions: [{do, kind, text}]                                          (how to answer from now on; DS023 "Behaviour layer")
 * }
 * match = {predicate, roles: [{name, value: {kind: 'entity'|'number'|'var', value}}], polarity}
 */
import {statementText} from './assemble.mjs';
import {assemble as assembleA} from './assemble.mjs';

const term = v => v.kind === 'entity' ? JSON.stringify(v.value) : v.kind === 'number' ? String(v.value) : v.value;
const MATCH = (m, indent) => ['match', `  relation ${JSON.stringify(m.predicate)}`, ...m.roles.map(r => `  role ${r.name} ${term(r.value)}`),
  `  polarity ${m.polarity ?? 'affirmed'}`, 'end'].map(line => indent + line);

/** `where …` (or `scope …`) lines of a list of matches: one block, or an `all` group. */
function condition(keyword, matches) {
  if (matches.length === 1) {
    const [first, ...rest] = MATCH(matches[0], '  ');
    return [`  ${keyword} ${first.trim()}`, ...rest.slice(0, -1), '  end'];
  }
  return [`  ${keyword} all`, ...matches.flatMap(m => MATCH(m, '    ')), '  end'];
}

function queryLines(q) {
  const lines = [`@${q.id} query`];
  if (q.form === 'count') lines.push('  mode count');
  if (q.form === 'every') lines.push('  mode every');
  if (q.form === 'why') lines.push('  mode explain');
  if (q.form === 'every' && q.every?.quantifier && q.every.quantifier !== 'all') lines.push(`  quantifier ${q.every.quantifier}`);
  if (q.select) lines.push(`  select ${q.select}`);
  if (q.form === 'every') {
    lines.push(...condition('where', q.every.restriction), ...condition('scope', q.every.scope));
  } else lines.push(...condition('where', q.matches));
  for (const c of q.compares ?? []) lines.push(`  compare ${c}`);
  if (q.any?.values?.length >= 2) lines.push('  compare any', ...q.any.values.map(v => `    ${q.any.variable} equal ${JSON.stringify(v)}`), '  end');
  for (const e of q.excepts ?? []) lines.push(`  except ${e.variable} ${JSON.stringify(e.value)}`);
  if (q.rank) lines.push(`  rank ${q.rank.direction} ${q.rank.value}`);
  if (q.measure) lines.push(`  measure ${q.measure}`);
  if (q.time?.kind === 'at') lines.push(`  at ${JSON.stringify(q.time.dates[0])}`);
  else if (q.time) lines.push(`  ${q.time.kind} ${JSON.stringify(`${q.time.dates[0]} to ${q.time.dates[1]}`)}`);
  for (const l of q.links ?? []) lines.push(`  ${l.keyword} $${l.target}`);
  // A sample ("a random fact", "some examples"): the answers in random order, the first `limit` kept (DS004 "Sampling").
  if (q.sample) lines.push('  order random', ...(q.sample.limit ? [`  limit ${q.sample.limit}`] : []));
  return lines;
}

function statedLines(s) {
  const m = s.match;
  return [`@${s.id} stated`, `  relation ${JSON.stringify(m.predicate)}`, ...m.roles.map(r => `  role ${r.name} ${term(r.value)}`),
    `  polarity ${m.polarity ?? 'affirmed'}`, `  certainty ${s.certainty}`];
}

/** The `pragmatic` wires of the message acts the oracle named; an act that copies a part of the message (the user's name) has its span. */
const pragmaticLines = p => (p.pragmatic ?? []).map((a, i) => {
  const {kind, span} = typeof a === 'string' ? {kind: a, span: null} : a;
  return `@p${i + 1} pragmatic\n  kind ${kind}\n${span ? `  span ${JSON.stringify(span)}\n` : ''}  source local_llm_step_by_step\n  basis llm\n`;
}).join('');

/** The SOP text of a program. */
export function assembleProgram(p) {
  if (p.unclear) return `@q unclear\n  kind ${p.unclear}\n${pragmaticLines(p)}`;
  if (p.constraint) return assembleA({form: 'puzzle', constraint: p.constraint}) + pragmaticLines(p);
  const parts = [...(p.definitions ?? [])];
  if (p.reach) parts.push(assembleA({form: 'reach', reach: p.reach}).replace(/@q query[\s\S]*$/, '').trimEnd());
  for (const s of p.stated ?? []) parts.push(statedLines(s).join('\n'));
  for (const q of p.queries ?? []) parts.push(queryLines(q).join('\n'));
  for (const [i, u] of (p.unparsed ?? []).entries()) parts.push([`@u${i + 1} unparsed`, `  span ${JSON.stringify(u.span)}`, ...(u.near ? [`  near $${u.near}`] : [])].join('\n'));
  parts.push(pragmaticLines(p));
  // The instructions about the answers (behaviour layer): the words of a prefix or suffix were copied from the message.
  for (const [i, ins] of (p.instructions ?? []).entries()) parts.push([`@i${i + 1} instruction`, `  do ${ins.do}`, ...(ins.kind ? [`  kind ${ins.kind}`] : []), ...(ins.text ? [`  text ${JSON.stringify(ins.text)}`] : []), '  source local_llm_step_by_step'].join('\n'));
  return parts.filter(s => s && s.trim()).map(s => s.trimEnd()).join('\n') + '\n';
}

const NAMED = {'?x': 'X', '?v': 'V', '?w': 'W', '?p': 'P', '?q': 'Q', '?m': 'M', '?t': 'T', '?n': 'N', '?d': 'D', '?a': 'V1', '?b': 'V2'};
const shown = v => v.kind === 'var' ? NAMED[v.value] ?? (/^\?[wn]\d+$/.test(v.value) ? v.value.slice(1).toUpperCase() : /^\?a\d+$/.test(v.value) ? `Y${v.value.slice(2)}` : 'something') : String(v.value);
const WORD = {above: 'above', below: 'below', at_least: 'at least', at_most: 'at most', equal: 'equal to', not_equal: 'not equal to'};

/** "Ana works at Acme" for a filled match, in declared role order, with letters for unknowns. */
export function matchText(m, lexicon) {
  const predicate = lexicon?.predicates?.[m.predicate] ?? {id: m.predicate, roles: m.roles.map(r => ({name: r.name}))};
  const ordered = (predicate.roles ?? []).map(r => m.roles.find(x => x.name === r.name)).filter(Boolean);
  const text = statementText({...predicate, roles: ordered.map(r => ({name: r.name}))}, ordered.map(r => shown(r.value)));
  return m.polarity === 'absent' ? `it is not recorded that ${text}` : m.polarity === 'negated' ? `it is false that ${text}` : text;
}

const compareText = c => c.replace(/\?(\w+)/g, (_, v) => shown({kind: 'var', value: `?${v}`})).replace(/\b(above|below|at_least|at_most|not_equal|equal)\b/, w => WORD[w]);

function queryText(q, lexicon) {
  const facts = q.form === 'every' ? '' : q.matches.map(m => matchText(m, lexicon)).join(' and ');
  const extra = [...(q.compares ?? []).map(compareText), ...(q.any?.values?.length ? [`${shown({kind: 'var', value: q.any.variable})} is one of ${q.any.values.join(', ')}`] : []),
    ...(q.excepts ?? []).map(e => `${shown({kind: 'var', value: e.variable})} is not ${e.value}`)];
  const where = extra.length ? `${facts}, where ${extra.join(' and ')}` : facts;
  const time = !q.time ? '' : q.time.kind === 'at' ? ` on ${q.time.dates[0]}` : q.time.kind === 'during' ? ` throughout ${q.time.dates[0]} to ${q.time.dates[1]}` : ` at some time between ${q.time.dates[0]} and ${q.time.dates[1]}`;
  const asked = q.select ? shown({kind: 'var', value: q.select.split(' ')[0]}) : 'X';
  switch (q.form) {
    case 'yesno': return q.polarity === 'absent' ? `Is it absent (not recorded) that ${where}${time}?` : q.polarity === 'negated' ? `Is it recorded as false that ${where}${time}?` : `Is it true that ${where}${time}?`;
    case 'why': return `Why is it ${q.polarity === 'negated' ? 'false' : 'true'} that ${where}${time}?`;
    case 'count': return `How many different ${asked} are there such that ${where}${time}?`;
    case 'value': return `What is ${asked} such that ${where}${time}?`;
    case 'when': return `${q.measure === 'start' ? 'Since when' : q.measure === 'end' ? 'Until when' : q.measure === 'duration' ? 'For how long' : 'When'} is it true that ${where}?`;
    case 'highest': case 'lowest': return `Which ${asked} has the ${q.form} ${shown({kind: 'var', value: q.rank?.value ?? '?v'})} such that ${where}${time}?`;
    case 'every': {
      const quantifier = {all: 'all', none: 'none', most: 'most', not_all: 'not all', half: 'exactly half'}[q.every.quantifier ?? 'all'] ?? q.every.quantifier.replace('at_least', 'at least');
      return `Of the M such that ${q.every.restriction.map(m => matchText(m, lexicon)).join(' and ')}, do ${quantifier} have ${q.every.scope.map(m => matchText(m, lexicon)).join(' and ')}${time}?`;
    }
    default: return `Which ${asked} are there such that ${where}${time}?`;
  }
}

/** A deterministic English paraphrase of the program (the confirmation step); it names exactly what the circuit asks. */
export function paraphraseProgram(p, lexicon, {definitionsText = null} = {}) {
  if (p.unclear === 'no_request' || (!p.queries?.length && !p.stated?.length && !p.constraint && !p.reach && p.pragmatic?.length)) return 'There is nothing to look up in the request.';
  if (p.unclear) return 'The knowledge has no statement that fits the request.';
  const parts = [];
  for (const s of p.stated ?? []) parts.push(s.certainty === 'supposed' ? `Supposing that ${matchText(s.match, lexicon)}:` : `The user states that ${matchText(s.match, lexicon)}.`);
  if (definitionsText) parts.push(`(${definitionsText})`);
  for (const q of p.queries ?? []) parts.push(queryText(q, lexicon));
  for (const u of p.unparsed ?? []) parts.push(`Not understood: "${u.span}".`);
  return parts.join(' ');
}
