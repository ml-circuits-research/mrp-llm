/**
 * LocalLLMStepByStep (DS022 "LocalLLMStepByStep", owner decision 2026-10-02): the symbolic system asks a small local model short
 * questions, one at a time, and writes the SOP circuit itself from the answers. The model is an oracle that classifies and points: the
 * kind of answer (numbered choice), the statements of the memory the request needs (numbers from the schema neighbourhood rendered as
 * English sentences), which name or which unknown fills each place (lettered numbered choices), truth or absence, the period, and for a
 * puzzle its unknowns and arithmetic lines. It never writes SOP or JSON. The system decides the next question, assembles the circuit
 * from per-form templates (assemble.mjs), validates it with the same validator as every author, shows a deterministic paraphrase and
 * asks for confirmation; on "no" the doubtful step is asked again once.
 *
 * The result has the shape of `authorQuery` (status validated | invalid | failed, sop, validation, unclear, usage, runs), plus `steps`.
 */
import {createHash} from 'node:crypto';
import {entityHints} from '../retrieval.mjs';
import {collectNeighbourhood} from '../neighbourhood.mjs';
import {validateQuery, unclearKind} from '../validate.mjs';
import {splitCircuits} from '../session.mjs';
import {readChoice, readChoices, readYesNo, readLetters, readDates, mentionsTime, readComparison, readExpression, readUnknowns} from './answers.mjs';
import {SYSTEM, FORMS, POLARITIES, PERIODS, GOALS, ask} from './prompts.mjs';
import {assemble, paraphrase, statementText, phraseOf, LETTERS} from './assemble.mjs';

export {SYSTEM as STEP_BY_STEP_SYSTEM} from './prompts.mjs';
export const MAX_STATEMENTS = 12;

export class Unreadable extends Error {}

/**
 * The growing conversation with the oracle. `chat(messages, maxTokens)` → {ok, text, ms, usage, cached, evaluated, reason}.
 *
 * `ladder` (owner decision 2026-10-02, per-question escalation): `[{tier, chat}]` in order, the smallest tier first. Every question goes
 * to the first rung; when its answer cannot be read twice (`read`) or the rung does not answer at all, the failed exchange is taken out
 * of the conversation and the SAME question goes to the next rung, with the same history. The next question starts again at the first
 * rung. Every call stays in `steps` (with its `tier`; a superseded one is marked `escalated`), so cost and escalations are visible.
 * Without a ladder `chat` is the only rung.
 */
export function createOracle({chat, system = SYSTEM, ladder = null}) {
  const rungs = ladder?.length ? ladder : [{tier: null, chat}];
  const messages = [{role: 'system', content: system}];
  const steps = [];
  const escalations = [];
  const exchange = async (rung, name, text, maxTokens) => {
    messages.push({role: 'user', content: text});
    const reply = await rung.chat(messages, maxTokens);
    steps.push({name, ok: reply.ok, ms: reply.ms ?? 0, input_tokens: reply.usage?.input_tokens ?? 0, output_tokens: reply.usage?.output_tokens ?? 0,
      cached: reply.cached ?? null, evaluated: reply.evaluated ?? null, answer: String(reply.text ?? '').slice(0, 4000), qsha: createHash('sha256').update(text).digest('hex').slice(0, 12), finish: reply.finish ?? null, reasoning_tokens: reply.usage?.reasoning_tokens ?? 0, ...(rung.tier ? {tier: rung.tier} : {}), ...(reply.ok ? {} : {reason: String(reply.reason ?? '').slice(0, 200)})});
    if (!reply.ok) { messages.pop(); throw Object.assign(new Error(reply.reason ?? 'the local model did not answer'), {code: 'oracle_failed'}); }
    messages.push({role: 'assistant', content: reply.text});
    return reply.text;
  };
  /** Run `attempt(rung)` on each rung in turn until one succeeds; a failed rung's exchanges leave the conversation. */
  const climb = async (name, attempt) => {
    let last = null;
    for (let i = 0; i < rungs.length; i++) {
      const mark = messages.length, stepMark = steps.length;
      try { return await attempt(rungs[i]); }
      catch (error) {
        if (!(error instanceof Unreadable) && error.code !== 'oracle_failed') throw error;
        last = error;
        messages.length = mark;
        if (i + 1 < rungs.length) {
          for (let s = stepMark; s < steps.length; s++) steps[s].escalated = true;
          escalations.push({question: name, from: rungs[i].tier, to: rungs[i + 1].tier, reason: error instanceof Unreadable ? 'unreadable' : 'no_answer'});
        }
      }
    }
    throw last;
  };
  const oracle = {
    messages, steps, escalations,
    ask: (name, text, maxTokens = 24) => climb(name, rung => exchange(rung, name, text, maxTokens)),
    /** Ask, read; when unreadable ask once more with the expected format; `null` read twice escalates, and on the last rung is an Unreadable stop. */
    read: (name, text, reader, again, maxTokens = 24) => climb(name, async rung => {
      const first = reader(await exchange(rung, name, text, maxTokens));
      if (first !== null) return first;
      const second = reader(await exchange(rung, `${name}_again`, ask.again(again), maxTokens));
      if (second !== null) return second;
      throw new Unreadable(`the answer to the ${name} question could not be read`);
    }),
  };
  return oracle;
}

export const isNumberRole = role => ['integer', 'number', 'int'].includes(String(role.type ?? '').toLowerCase());
export const standaloneNumbers = message => [...new Set([...String(message).matchAll(/(?<![\w.-])-?\d+(?![\w.-])/g)].map(m => Number(m[0])).filter(Number.isSafeInteger))];

/** Linked names: unambiguous hints directly, ambiguous ones by a numbered choice, none at all by asking the model to list them. */
export async function linkNames(oracle, message, lexicon, mentions) {
  const ids = [];
  const pick = async m => {
    if (m.candidates.length === 1 && !m.partial) return m.candidates[0].id;
    const options = m.candidates.map(c => `${c.id}${c.description ? ' (' + c.description + ')' : ''}`);
    const n = await oracle.read('entity', ask.pickEntity(m.surface, options), t => readChoice(t, options.length, {zero: true}), 'Reply with one number.');
    return n ? m.candidates[n - 1].id : null;
  };
  for (const m of mentions) { const id = await pick(m); if (id && !ids.includes(id)) ids.push(id); }
  if (!ids.length) {
    const listed = (await oracle.ask('names', ask.names(), 64)).split('\n').map(s => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(s => s && !/^none\b/i.test(s));
    for (const name of listed.slice(0, 6)) for (const m of entityHints(name, lexicon, {classes: true})) { const id = await pick(m); if (id && !ids.includes(id)) ids.push(id); }
  }
  return ids;
}

/** Fill the places of one chosen statement: automatic when only one reading is possible, otherwise a lettered numbered choice. */
async function fillRoles(oracle, predicate, plan, names, numbers, fresh, note = '') {
  const roles = predicate.roles?.length ? predicate.roles : [{name: 'subject', type: 'entity'}];
  const asking = plan.form !== 'yesno';
  if (roles.length === 1 && plan.matches.length === 0 && plan.chosen.length === 1) {
    if (plan.form === 'yesno' && names.length === 1) return [{name: roles[0].name, value: {kind: 'entity', value: names[0]}}];
    if (asking && !names.length) return [{name: roles[0].name, value: {kind: 'var', value: '?x'}}];
  }
  const options = [...names.map(id => ({text: id, value: {kind: 'entity', value: id}})),
    ...(roles.some(isNumberRole) ? numbers.map(n => ({text: String(n), value: {kind: 'number', value: n}})) : []),
    ...(asking ? [{text: 'the thing the request asks for', value: {kind: 'var', value: '?x'}}] : []),
    ...(plan.form === 'highest' || plan.form === 'lowest' ? [{text: 'the value to compare', value: {kind: 'var', value: '?v'}}] : []),
    {text: 'anything (not limited by the request)', value: {kind: 'any'}}];
  const letters = LETTERS.slice(0, roles.length);
  const picked = await oracle.read('roles', note + ask.roles(statementText(predicate), letters, options.map(o => o.text)),
    // "B: none" / "B: 0" / "B: anything" mean the free place: the last option.
    t => readLetters(String(t).replace(/\b([A-D])\s*[:=]\s*(?:0|none|nothing|anything|any)\b/gi, `$1: ${options.length}`), letters, options.length), `Reply with one line per letter, like "${letters[0]}: 1".`, 48);
  return roles.map((role, i) => {
    const value = options[picked[letters[i]] - 1].value;
    return {name: role.name, value: value.kind === 'any' ? {kind: 'var', value: fresh()} : value};
  });
}

/** The place a known name takes in a statement (a name of the request that no chosen place used): one letter, other places free. */
export async function placeName(oracle, predicate, id, fresh) {
  const roles = predicate.roles?.length ? predicate.roles : [{name: 'subject', type: 'entity'}];
  const letters = LETTERS.slice(0, roles.length);
  const at = roles.length === 1 ? 0 : letters.indexOf(await oracle.read('name_place', `In the statement "${statementText(predicate)}", which letter is ${id}? Reply with the letter only.`,
    t => /\b([A-D])\b/.exec(t)?.[1] && letters.includes(/\b([A-D])\b/.exec(t)[1]) ? /\b([A-D])\b/.exec(t)[1] : null, `Reply with one of ${letters.join(', ')}.`, 4));
  return roles.map((role, i) => ({name: role.name, value: i === at ? {kind: 'entity', value: id} : {kind: 'var', value: fresh()}}));
}

/** Why a filled statement cannot be right (types, the asked unknown), or null. */
function roleProblem(predicate, roles, plan) {
  for (const r of roles) {
    const declared = predicate.roles?.find(x => x.name === r.name) ?? {};
    if (r.value.kind === 'entity' && isNumberRole(declared)) return `${r.name} holds a number, not the name ${r.value.value}`;
    if (r.value.kind === 'number' && !isNumberRole(declared) && declared.type) return `${r.name} holds a name, not the number ${r.value.value}`;
  }
  return null;
}

async function relationalPlan(oracle, ctx, plan, from) {
  const {lexicon, statements} = ctx;
  if (from <= 1) {
    if (!statements.length) return {...plan, form: 'missing'};
    const words = new Set(ctx.message.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const named = p => phraseOf(p).toLowerCase().split(/\s+/).every(w => words.has(w) || words.has(w.replace(/(ed|s)$/, '')));
    const notes = p => [named(p) ? 'its words are in the request' : '', p.derived ? 'worked out by the rules of the knowledge' : p.example ? `example: ${p.example}` : ''].filter(Boolean).join('; ');
    const lines = statements.map((p, i) => `${i + 1}. ${statementText(p)}${notes(p) ? `   (${notes(p)})` : ''}`);
    const picked = await oracle.read('statements', ask.statements(lines, plan.form), t => readChoices(t, statements.length), 'Reply with the statement numbers, separated by commas, or 0.', 32);
    if (picked[0] === 0) return {...plan, form: 'missing'};
    plan = {...plan, picked: picked.map(n => statements[n - 1])};
  }
  if (from <= 2) {
    let counter = 0;
    const fresh = () => `?a${++counter}`;
    // Statements added later for an unused name are not part of the oracle's pick: a redo starts from the pick again.
    plan = {...plan, chosen: [...plan.picked], matches: []};
    for (const predicate of plan.chosen) {
      let roles = await fillRoles(oracle, predicate, plan, ctx.names, ctx.numbers, fresh);
      const problem = roleProblem(predicate, roles, plan);
      if (problem) roles = await fillRoles(oracle, predicate, plan, ctx.names, ctx.numbers, fresh, `Not possible: ${problem}. `);
      plan.matches.push({predicate: predicate.id, roles});
    }
    const variables = () => new Set(plan.matches.flatMap(m => m.roles.filter(r => r.value.kind === 'var').map(r => r.value.value)));
    // The asked thing must have a place: when no place holds it, the places of the first statement are asked once more.
    if (plan.form !== 'yesno' && !variables().has('?x') && plan.chosen.length) {
      const roles = await fillRoles(oracle, plan.chosen[0], plan, ctx.names, ctx.numbers, fresh, 'Not possible: one place must be the thing the request asks for. ');
      plan.matches[0] = {predicate: plan.chosen[0].id, roles};
    }
    // Every place holds a name: the request can only be a yes/no question about these statements. The oracle confirms the switch.
    if (plan.form !== 'yesno' && !variables().has('?x') && plan.matches.every(m => m.roles.every(r => r.value.kind !== 'var'))) {
      const statement = plan.matches.map(m => statementText(lexicon.predicates[m.predicate] ?? {id: m.predicate}, m.roles.map(r => String(r.value.value)))).join(' and ');
      if (await oracle.read('yes_no_switch', `Every place is a name of the request. Does the request ask\n1. whether ${statement} is true\n2. for something else that is not named in the request\nReply with the number only.`, t => readChoice(t, 2), 'Reply with 1 or 2.', 4) === 1) {
        plan.form = 'yesno';
        plan.select = null;
      }
    }
    // The compared value must have a place: the statement with a number place is asked once more.
    if ((plan.form === 'highest' || plan.form === 'lowest') && !variables().has('?v')) {
      const at = plan.chosen.findIndex(p => (p.roles ?? []).some(isNumberRole));
      if (at >= 0) plan.matches[at] = {predicate: plan.chosen[at].id, roles: await fillRoles(oracle, plan.chosen[at], plan, ctx.names, ctx.numbers, fresh, 'Not possible: one place must be the value to compare. ')};
    }
    const vars = variables();
    const asked = vars.has('?x');
    // A stored number read for a fixed name is a value, not a count of rows: "the count of compensation" with a derived count relation.
    const askedNumeric = plan.matches.some(m => m.roles.some(r => r.value.value === '?x' && isNumberRole(lexicon.predicates[m.predicate]?.roles?.find(x => x.name === r.name) ?? {})));
    if (plan.form === 'count' && askedNumeric) plan.form = 'value';
    if (plan.form !== 'yesno' && !asked) plan.problem = 'no place of the chosen statements holds the thing asked for';
    if ((plan.form === 'highest' || plan.form === 'lowest') && !vars.has('?v')) plan.problem = 'no place holds the value to compare';
    plan.select = plan.form === 'yesno' ? null : '?x';
    plan.rank = plan.form === 'highest' || plan.form === 'lowest' ? {direction: plan.form, value: '?v'} : null;
  }
  if (from <= 3) {
    // Absence is a question only about a statement the memory declares complete (closed); otherwise it is not offered.
    const closed = plan.matches.length === 1 && lexicon.predicates[plan.matches[0].predicate]?.closed === true;
    const options = POLARITIES.filter(([kind]) => kind !== 'absent' || closed);
    plan.polarity = plan.form === 'yesno'
      ? options[await oracle.read('truth', ask.truth(options), t => readChoice(t, options.length), `Reply with a number from 1 to ${options.length}.`) - 1][0] : 'affirmed';
    plan.time = null;
    if (mentionsTime(ctx.message)) {
      let dates = readDates(ctx.message);
      if (!dates.length) dates = readDates(await oracle.ask('dates', ask.dates(), 48));
      if (dates.length === 1) plan.time = {kind: 'at', dates};
      else if (dates.length >= 2) {
        const n = await oracle.read('period', ask.period(dates[0], dates[1]), t => readChoice(t, PERIODS.length), 'Reply with 1 or 2.');
        plan.time = {kind: PERIODS[n - 1][0], dates: dates.slice(0, 2)};
      }
    }
  }
  return plan;
}

/** Reachability: the step statement, the statement the chain avoids, start and goal; the system writes the recursive definition. */
export async function reachPlan(oracle, ctx, plan, from) {
  const {statements} = ctx;
  const binary = statements.filter(p => (p.roles ?? []).length === 2 && !(p.roles ?? []).some(isNumberRole));
  const unary = statements.filter(p => (p.roles ?? []).length === 1);
  if (!binary.length || ctx.names.length < 2) return {...plan, form: 'missing', impossible: !binary.length ? 'the knowledge has no statement that links two things' : 'the request names fewer than two things'};
  if (from <= 1) {
    const lines = binary.map((p, i) => `${i + 1}. ${statementText(p)}${p.example ? `   (example: ${p.example})` : ''}`);
    const step = binary.length === 1 ? 1 : await oracle.read('step', ask.step(lines), t => readChoice(t, binary.length), 'Reply with one number.');
    const avoid = unary.length ? await oracle.read('avoid', ask.avoid(unary.map((p, i) => `${i + 1}. ${statementText(p)}`)), t => readChoice(t, unary.length, {zero: true}), 'Reply with one number, or 0.') : 0;
    const free = base => { let name = base, k = 1; while (ctx.lexicon.predicates?.[name]) name = `${base}_${++k}`; return name; };
    const stepId = binary[step - 1].id;
    plan = {...plan, reach: {...plan.reach, step: stepId, avoid: avoid ? unary[avoid - 1].id : null, stepName: free(`allowed_${stepId}`), reachName: free(`reachable_by_${stepId}`)}};
  }
  if (from <= 2) {
    const names = ctx.names;
    const start = names[await oracle.read('start', ask.start(names), t => readChoice(t, names.length), 'Reply with one number.') - 1];
    const rest = names.filter(n => n !== start);
    const goal = rest.length === 1 ? rest[0] : rest[await oracle.read('goal', ask.goal(rest), t => readChoice(t, rest.length), 'Reply with one number.') - 1];
    plan = {...plan, reach: {...plan.reach, start, goal}};
  }
  return plan;
}

export async function puzzlePlan(oracle, plan, from) {
  const c = {...(plan.constraint ?? {})};
  if (from <= 1) c.unknowns = await oracle.read('unknowns', ask.unknowns(), readUnknowns, 'Reply one line per unknown, like "x: 0 to 10".', 64);
  const names = c.unknowns.map(u => u.name);
  if (from <= 2) {
    const lines = text => {
      const parsed = String(text).split('\n').map(s => s.trim()).filter(s => /[=<>≤≥≠]/.test(s)).map(s => readComparison(s, names));
      return parsed.length && parsed.every(Boolean) ? parsed : null;
    };
    c.requirements = await oracle.read('conditions', ask.conditions(names), lines, 'One condition per line, like "x + y = 4".', 128);
  }
  if (from <= 3) {
    c.goal = GOALS[await oracle.read('goal', ask.aim(), t => readChoice(t, GOALS.length), 'Reply with 1, 2, 3 or 4.') - 1][0];
    if (c.goal === 'min' || c.goal === 'max') c.objective = await oracle.read('objective', ask.objective(c.goal, names), t => readExpression(t.split('\n')[0].replace(/^.*?[:=]\s*/, ''), names), 'One line of arithmetic only.', 48);
    if (c.goal === 'prove') c.claim = await oracle.read('claim', ask.claim(names), t => readComparison(t.split('\n')[0], names), 'One line, like "x + y > 3".', 48);
  }
  return {...plan, constraint: c};
}

const RELATIONAL_PARTS = ['the kind of answer', 'the statements used', 'the names and their places in the statements', 'true, false or absent, or the time'];
const PUZZLE_PARTS = ['the kind of answer', 'the unknowns and their ranges', 'the conditions', 'what is wanted'];
const REACH_PARTS = ['the kind of answer', 'the step and what the chain avoids', 'the start and the end point'];

/**
 * Formalize one message step by step. `oracle`: createOracle({chat}); the remaining arguments are those of `authorQuery`.
 */
export async function stepByStepQuery({message, lexicon, circuits = [], repo = null, session = null, derived = null, oracle, validate = validateQuery, maxRetries = 1, model = null, onProgress = () => {}}) {
  const started = Date.now();
  const text = String(message ?? '').trim();
  const mentions = entityHints(text, lexicon);
  const neighbourhood = collectNeighbourhood({message: text, lexicon, circuits, repo, session});
  const statements = neighbourhood.predicates.slice(0, MAX_STATEMENTS).map(p => {
    const predicate = {...lexicon.predicates[p.id], id: p.id, roles: p.roles?.length ? p.roles : lexicon.predicates[p.id]?.roles};
    const atom = p.examples?.find(e => e.atom && !e.atom.neg)?.atom;
    const isDerived = derived?.has(p.id) || (p.rules ?? []).some(rule => new RegExp(`\\bthen\\s+${p.id}\\b`).test(rule.sop));
    return {...predicate, derived: Boolean(isDerived), ...(atom ? {example: statementText(predicate, atom.a.map(String))} : {})};
  }).sort((a, b) => Number(b.derived) - Number(a.derived)); // the memory's own derived relations first (prefer them over rebuilding a rule)
  const retrieval = {mode: 'id', predicates: statements.map(p => p.id), neighbourhood,
    entities: mentions.map(m => ({surface: m.surface, candidates: m.candidates.map(c => c.id), strong: /\s/.test(m.surface) || /^\p{Lu}/u.test(m.surface)}))};
  let plan = null, sop = '', validation = null, reason = null, confirmed = null, retried = null;
  const ctx = {message: text, lexicon, statements, names: [], numbers: standaloneNumbers(text)};
  const build = async from => {
    if (from <= 0) {
      onProgress({phase: 'kind'});
      const n = await oracle.read('kind', ask.kind(text), t => readChoice(t, FORMS.length), `Reply with one number from 1 to ${FORMS.length}.`, 8);
      plan = {form: FORMS[n - 1][0], chosen: [], matches: []};
      if (plan.form !== 'none' && plan.form !== 'puzzle') ctx.names = await linkNames(oracle, text, lexicon, mentions);
    }
    if (plan.form === 'none') return;
    onProgress({phase: 'details'});
    if (plan.form === 'reach') {
      plan = await reachPlan(oracle, ctx, plan, Math.max(1, from));
      if (!plan.impossible) return;
      // The chosen kind cannot be built from this memory and request: the kind is asked once more without it.
      const n = await oracle.read('kind_again', `A chain of steps is not possible here (${plan.impossible}). Which other kind of answer from the list does the request want? Reply with the number only.`,
        t => { const c = readChoice(t, FORMS.length); return c && FORMS[c - 1][0] !== 'reach' ? c : null; }, `Reply with one number from 1 to ${FORMS.length}, not ${FORMS.findIndex(f => f[0] === 'reach') + 1}.`, 8);
      plan = {form: FORMS[n - 1][0], chosen: [], matches: []};
      if (plan.form === 'none') return;
    }
    plan = plan.form === 'puzzle' ? await puzzlePlan(oracle, plan, Math.max(1, from)) : await relationalPlan(oracle, ctx, plan, Math.max(1, from));
  };
  const check = async () => {
    sop = assemble(plan);
    validation = validate({sop, message: text, lexicon, circuits, repo, session, mode: 'id', hints: new Set(mentions.flatMap(m => m.candidates.map(c => c.id))), mentions: retrieval.entities});
    // A name of the request that no chosen place uses: ask which statement it belongs to, and add that statement.
    const unused = !['puzzle', 'reach'].includes(plan.form) && !plan.problem ? validation.problems.filter(p => p.code === 'mention_not_used') : [];
    const added = [];
    let unusedCounter = 0;
    const freshUnused = () => `?u${++unusedCounter}`;
    for (const problem of unused.slice(0, 2)) {
      const surface = JSON.parse(/"((?:\\.|[^"\\])*)"/.exec(problem.message)?.[0] ?? '""');
      const lines = statements.map((p, i) => `${i + 1}. ${statementText(p)}`);
      const n = await oracle.read('unused_name', `The request also names "${surface}". Which statement says something about it?\n${lines.join('\n')}\n0. none\nReply with the number only.`,
        t => readChoice(t, statements.length, {zero: true}), 'Reply with one number.');
      if (!n) break;
      const predicate = statements[n - 1];
      const id = mentions.find(m => m.surface === surface)?.candidates.map(c => c.id).find(c => ctx.names.includes(c)) ?? mentions.find(m => m.surface === surface)?.candidates[0]?.id;
      if (!id) break;
      const roles = await placeName(oracle, predicate, id, freshUnused);
      // A second name of the same statement goes into the free place of the statement added for the first one.
      const at = roles.findIndex(r => r.value.kind === 'entity');
      const previous = added.find(m => m.predicate === predicate.id && /^\?u\d+$/.test(String(m.roles[at]?.value.value)));
      if (previous) previous.roles[at] = roles[at];
      else {
        const match = {predicate: predicate.id, roles};
        added.push(match);
        plan.chosen = [...plan.chosen, predicate];
        plan.matches = [...plan.matches, match];
      }
      sop = assemble(plan);
      validation = validate({sop, message: text, lexicon, circuits, repo, session, mode: 'id', hints: new Set(mentions.flatMap(m => m.candidates.map(c => c.id))), mentions: retrieval.entities});
    }
  };
  try {
    await build(0);
    await check();
    if (validation.ok && plan.form !== 'none') {
      confirmed = readYesNo(await oracle.ask('confirm', ask.confirm(paraphrase(plan, lexicon)), 8));
      if (confirmed === false && maxRetries > 0) {
        const parts = plan.form === 'puzzle' ? PUZZLE_PARTS : plan.form === 'reach' ? REACH_PARTS : RELATIONAL_PARTS;
        const part = readChoice(await oracle.ask('wrong_part', ask.wrongPart(parts), 8), parts.length);
        if (part) {
          retried = parts[part - 1];
          const before = {plan, sop, validation};
          await build(part - 1);
          await check();
          if (!validation.ok) ({plan, sop, validation} = before);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof Unreadable) && error.code !== 'oracle_failed') throw error;
    reason = error.message;
  }
  const usage = {turns: oracle.steps.length, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0};
  for (const s of oracle.steps) { usage.input_tokens += s.input_tokens; usage.output_tokens += s.output_tokens; usage.cache_read_tokens += s.cached ?? 0; }
  const ok = !reason && validation?.ok === true && !plan?.problem;
  if (!reason && !ok && plan?.problem) reason = null;
  const status = ok ? 'validated' : reason ? 'failed' : 'invalid';
  const unclear = ok ? unclearKind(validation.program) : null;
  return {
    circuits: ok ? splitCircuits(sop).parts.map(p => ({file: 'query.sop', role: 'query', text: p.text, origin: 'local_llm_step_by_step'})) : [],
    ok, status, sop, validation, program: validation?.program ?? null, unclear,
    rounds: 1, runs: [{round: 0, phase: 'step_by_step', ok: !reason, duration_ms: Date.now() - started, usage}], usage,
    duration_ms: Date.now() - started, backend: 'step-by-step', model, report: JSON.stringify({plan: plan && {...plan, chosen: plan.chosen?.map(p => p.id), picked: plan.picked?.map(p => p.id)}, confirmed, retried}),
    context_version: 'step-by-step-v1', mode: 'id', retrieval, vocabulary_dialog: {max_rounds: 0, rounds: 0, expansions: []},
    steps: oracle.steps, confirmed, retried, ...(plan?.problem ? {problem: plan.problem} : {}), ...(reason ? {reason} : {}),
    unlinked: (validation?.advice ?? []).map(a => ({code: a.code, message: a.message})),
  };
}
