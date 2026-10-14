/**
 * Session definitions the generic protocol writes when no statement of the memory gives the asked quantity directly (DS022
 * "LocalLLMStepByStep", Q10): a count per group (aggregate), the difference of two such counts (a rule with `compute … minus`),
 * the chain of links (recursive rule) and the fewest links between two things (bounded layers). They are ordinary labelled session
 * definitions, validated like any author's definitions (DS014 "Where the model and the knowledge meet").
 */
export const MAX_LAYERS = 8;

/** A predicate id that the memory and this request's definitions do not use yet. */
export function freeName(ctx, base) {
  const taken = id => Boolean(ctx.lexicon.predicates?.[id]) || ctx.definitions.some(d => d.includes(`@${id} `));
  let name = base, k = 1;
  while (taken(name)) name = `${base}_${++k}`;
  return name;
}

/** How many `counted` each `group` has in `predicate` (a binary statement): `name group n`. */
export function groupCount(ctx, predicate, group, counted) {
  const name = freeName(ctx, `${counted}_count_per_${group}_of_${predicate.id}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase());
  const args = predicate.roles.map(r => r.name === group ? '?g' : r.name === counted ? '?m' : `?o_${r.name}`).join(' ');
  return {name, sop: [`@${name} predicate`, '  args subject:entity object:integer', `@${name}_count aggregate`, `  over ${predicate.id} ${args}`, '  group ?g', '  count ?m as ?n', `  yields ${name} ?g ?n`].join('\n')};
}

/** The difference of two per-group counts: `name a b d` with d = count(a) - count(b). */
export function countGap(ctx, size) {
  const name = freeName(ctx, `${size}_difference`);
  return {name, sop: [`@${name} predicate`, '  args subject:entity object:entity topic:integer', `@${name}_rule rule`, `  when ${size} ?a ?x`, `  when ${size} ?b ?y`,
    '  when compute ?d ?x minus ?y', `  then ${name} ?a ?b ?d`].join('\n')};
}

/** Everything reachable through a chain of `step` links: `name from to`. */
export function chainDefinitions(ctx, step) {
  const name = freeName(ctx, `reachable_by_${step}`);
  const closed = ctx.lexicon.predicates?.[step]?.closed === true;
  return {name, sop: [`@${name} predicate`, '  args subject:entity object:entity', ...(closed ? ['  closed true'] : []), `@${name}_first rule`, `  when ${step} ?from ?to`, `  then ${name} ?from ?to`,
    `@${name}_next rule`, `  when ${name} ?from ?via`, `  when ${step} ?via ?to`, `  then ${name} ?from ?to`].join('\n')};
}

/** The number of `step` links on the paths of at most MAX_LAYERS links: `name from to n` (the query ranks the lowest n). */
export function fewestLinks(ctx, step) {
  const name = freeName(ctx, `links_needed_by_${step}`);
  const layer = k => `${name}_layer_${k}`;
  const lines = [];
  for (let k = 1; k <= MAX_LAYERS; k++) {
    lines.push(`@${layer(k)} predicate`, '  args subject:entity object:entity', `@${layer(k)}_rule rule`);
    if (k === 1) lines.push(`  when ${step} ?a ?b`);
    else lines.push(`  when ${layer(k - 1)} ?a ?m`, `  when ${step} ?m ?b`);
    lines.push(`  then ${layer(k)} ?a ?b`, `@${name}_${k} rule`, `  when ${layer(k)} ?a ?b`, `  then ${name} ?a ?b ${k}`);
  }
  lines.push(`@${name} predicate`, '  args subject:entity object:entity topic:integer');
  return {name, sop: lines.join('\n')};
}
