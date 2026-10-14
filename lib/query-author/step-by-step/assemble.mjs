/**
 * Circuit assembly of LocalLLMStepByStep (DS022 "LocalLLMStepByStep"): the plan gathered from the oracle's answers becomes model-surface
 * SOP through fixed per-form templates, and a deterministic English paraphrase of the same plan is shown back for confirmation. The
 * templates are the only writer of SOP in this strategy; the model never writes it.
 *
 * plan = {form, polarity, matches: [{predicate, roles: [{name, value: {kind: 'entity'|'number'|'var', value}}]}], select, rank, time,
 *         constraint: {unknowns: [{name, min, max}], requirements: [{left, comparator, right}], goal, objective, claim}}
 */
const term = v => v.kind === 'entity' ? JSON.stringify(v.value) : v.kind === 'number' ? String(v.value) : v.value;

/** The words of a predicate: its English label when the memory has one, else its id with spaces. */
export function phraseOf(predicate) {
  const label = predicate?.labels?.en ?? Object.values(predicate?.labels ?? {})[0];
  return String(label ?? predicate?.id ?? '').replace(/_/g, ' ').trim();
}

export const LETTERS = ['A', 'B', 'C', 'D'];

const MODALS = new Set(['may', 'can', 'must', 'should', 'will', 'might', 'could', 'has', 'have', 'is', 'are', 'was', 'were']);
/** The copula a bare predicate phrase needs in an English sentence: "A is blocked", "A has compensation B", "A may work". */
function verbal(phrase, arity) {
  const first = phrase.split(' ')[0].toLowerCase();
  if (MODALS.has(first) || (/[^s]s$/.test(first) && phrase.includes(' '))) return phrase;
  if (/([^e]ed|en|ible|able|ive|ful|ous)$/.test(first)) return `is ${phrase}`;
  if (arity === 1) return `is ${/^[aeiou]/.test(first) ? 'an' : 'a'} ${phrase}`;
  return `has ${phrase}`;
}

/** "A is assigned to B" with letters (or the given values) in declared role order; roles past the second are appended by name. */
export function statementText(predicate, values = null) {
  const roles = predicate.roles?.length ? predicate.roles : [{name: 'subject'}];
  const shown = roles.map((r, i) => values ? values[i] : LETTERS[i]);
  const phrase = predicate.labels?.en || Object.values(predicate.labels ?? {})[0] ? phraseOf(predicate) : verbal(phraseOf(predicate), roles.length);
  const head = roles.length === 1 ? `${shown[0]} ${phrase}` : `${shown[0]} ${phrase} ${shown[1]}`;
  const extra = roles.slice(2).map((r, i) => `${r.name} ${shown[i + 2]}`);
  return extra.length ? `${head} (${extra.join(', ')})` : head;
}

const MATCH = (m, polarity, indent) => [
  'match', `  relation ${JSON.stringify(m.predicate)}`, ...m.roles.map(r => `  role ${r.name} ${term(r.value)}`), `  polarity ${polarity}`, 'end',
].map(line => indent + line);

/** The SOP text of a plan. */
export function assemble(plan) {
  if (plan.form === 'none') return '@q unclear\n  kind no_request\n';
  if (plan.form === 'missing') return '@q unclear\n  kind relation_not_in_memory\n';
  if (plan.form === 'puzzle') {
    const c = plan.constraint;
    const lines = ['@q constraint', ...c.unknowns.map(u => `  var ?${u.name} int ${u.min} ${u.max}`), ...c.requirements.map(r => `  require ${r.left} ${r.comparator} ${r.right}`)];
    if (c.goal === 'prove') lines.push(`  claim ${c.claim.left} ${c.claim.comparator} ${c.claim.right}`, '  task prove');
    else if (c.goal === 'min' || c.goal === 'max') lines.push(`  objective ${c.objective}`, `  direction ${c.goal}`, '  task optimize', `  select ${c.unknowns.map(u => '?' + u.name).join(' ')}`);
    else lines.push('  task possible', `  select ${c.unknowns.map(u => '?' + u.name).join(' ')}`);
    return lines.join('\n') + '\n';
  }
  if (plan.form === 'reach') {
    // Session definitions (labelled, validated like any definition): one allowed step, and the recursive chain of allowed steps.
    const r = plan.reach;
    return [`@${r.stepName} predicate`, '  args subject:entity object:entity',
      `@${r.stepName}_from_${r.step} ${r.avoid ? 'default' : 'rule'}`, `  when ${r.step} ?from ?to`, `  then ${r.stepName} ?from ?to`, ...(r.avoid ? [`  except ${r.avoid} ?to`] : []),
      `@${r.reachName} predicate`, '  args subject:entity object:entity',
      `@${r.reachName}_first rule`, `  when ${r.stepName} ?from ?to`, `  then ${r.reachName} ?from ?to`,
      `@${r.reachName}_next rule`, `  when ${r.reachName} ?from ?via`, `  when ${r.stepName} ?via ?to`, `  then ${r.reachName} ?from ?to`,
      '@q query', '  where match', `    relation ${JSON.stringify(r.reachName)}`, `    role subject ${JSON.stringify(r.start)}`, `    role object ${JSON.stringify(r.goal)}`, '    polarity affirmed', '  end'].join('\n') + '\n';
  }
  const lines = ['@q query'];
  if (plan.form === 'count') lines.push('  mode count');
  if (plan.select) lines.push(`  select ${plan.select}`);
  const polarity = plan.form === 'yesno' ? plan.polarity ?? 'affirmed' : 'affirmed';
  if (plan.matches.length === 1) {
    const [first, ...rest] = MATCH(plan.matches[0], polarity, '  ');
    lines.push(`  where ${first.trim()}`, ...rest.slice(0, -1), '  end');
  } else {
    lines.push('  where all');
    for (const m of plan.matches) lines.push(...MATCH(m, 'affirmed', '    '));
    lines.push('  end');
  }
  if (plan.rank) lines.push(`  rank ${plan.rank.direction} ${plan.rank.value}`);
  if (plan.time?.kind === 'at') lines.push(`  at ${JSON.stringify(plan.time.dates[0])}`);
  else if (plan.time) lines.push(`  ${plan.time.kind} ${JSON.stringify(`${plan.time.dates[0]} to ${plan.time.dates[1]}`)}`);
  return lines.join('\n') + '\n';
}

const shownValue = v => v.kind === 'var' ? ({'?x': 'X', '?v': 'V'}[v.value] ?? 'something') : String(v.value);

/** A deterministic English paraphrase of the plan (the confirmation step); it names exactly what the circuit asks. */
export function paraphrase(plan, lexicon) {
  if (plan.form === 'none') return 'There is nothing to look up in the request.';
  if (plan.form === 'missing') return 'The knowledge has no statement that fits the request.';
  if (plan.form === 'puzzle') {
    const c = plan.constraint;
    const unknowns = c.unknowns.map(u => `${u.name} (a whole number from ${u.min} to ${u.max})`).join(', ');
    const words = s => s.replace(/\?/g, '').replace(/ plus /g, ' + ').replace(/ minus /g, ' - ').replace(/ times /g, ' * ').replace(/ divided_by /g, ' / ');
    const cmp = {equal: '=', not_equal: '!=', below: '<', above: '>', at_most: '<=', at_least: '>='};
    const conditions = c.requirements.map(r => `${words(r.left)} ${cmp[r.comparator]} ${words(r.right)}`).join(', ');
    const goal = c.goal === 'prove' ? `check that ${words(c.claim.left)} ${cmp[c.claim.comparator]} ${words(c.claim.right)} always holds`
      : c.goal === 'min' || c.goal === 'max' ? `find the ${c.goal === 'min' ? 'smallest' : 'largest'} value of ${words(c.objective)}` : 'find values that satisfy every condition';
    return `For ${unknowns} with ${conditions || 'no conditions'}: ${goal}.`;
  }
  if (plan.form === 'reach') {
    const r = plan.reach, step = lexicon?.predicates?.[r.step] ?? {id: r.step, roles: [{name: 'subject'}, {name: 'object'}]};
    const avoid = r.avoid ? `, never entering a thing that ${statementText(lexicon?.predicates?.[r.avoid] ?? {id: r.avoid, roles: [{name: 'subject'}]}, ['']).trim()}` : '';
    return `Can ${r.goal} be reached from ${r.start} through a chain of steps "${statementText(step)}"${avoid}?`;
  }
  const statements = plan.matches.map(m => {
    const predicate = lexicon?.predicates?.[m.predicate] ?? {id: m.predicate, roles: m.roles.map(r => ({name: r.name}))};
    const ordered = (predicate.roles ?? []).map(r => m.roles.find(x => x.name === r.name)).filter(Boolean);
    return statementText({...predicate, roles: ordered.map(r => ({name: r.name}))}, ordered.map(r => shownValue(r.value)));
  }).join(' and ');
  const time = !plan.time ? '' : plan.time.kind === 'at' ? ` on ${plan.time.dates[0]}` : plan.time.kind === 'during'
    ? ` throughout ${plan.time.dates[0]} to ${plan.time.dates[1]}` : ` at some time between ${plan.time.dates[0]} and ${plan.time.dates[1]}`;
  switch (plan.form) {
    case 'yesno': return plan.polarity === 'absent' ? `Is it absent (not recorded) that ${statements}${time}?`
      : plan.polarity === 'negated' ? `Is it recorded as false that ${statements}${time}?` : `Is it true that ${statements}${time}?`;
    case 'count': return `How many different X are there such that ${statements}${time}?`;
    case 'value': return `What is X such that ${statements}${time}?`;
    case 'highest': case 'lowest': return `Which X has the ${plan.form} V such that ${statements}${time}?`;
    default: return `Which X are there such that ${statements}${time}?`;
  }
}
