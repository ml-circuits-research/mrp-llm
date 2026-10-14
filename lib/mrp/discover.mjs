/**
 * The discover slot (DS028 "Discovery strategies"): value-schema proposals from a corpus. The server strategy here is `llm-consolidate`:
 * the passages go in batches to a strong tier, which names the recurring relations (predicate name, roles, role kinds, a description
 * and the English phrases that express it); the candidates of all batches are merged by name, a unifying call groups synonyms, and each
 * surviving candidate becomes a `predicate` wire with its `lexeme` wire. The result is a proposal, never knowledge: every candidate is
 * checked by the knowledge validator against the Model's base memory, and the valid ones go to the Model's review queue, where an
 * administrator approves them into the base memory. A candidate whose name or phrase the memory already has is reported as known, and
 * the memory's predicates no candidate matched are reported as unused (the schema difference; nothing is overwritten).
 */
import {jsonOf, stripThinking} from '../pworker.mjs';
import {phraseKey} from '../../sop/text-keys.mjs';

/** The Ploinky purpose of discovery calls: a background job (an allowed purpose family of Ploinky). */
export const DISCOVER_PURPOSE = 'job:discover';
const NAME = /^[a-z][a-z0-9_]{1,47}$/;
const ROLE = /^[a-z][a-z0-9_]{0,23}$/;

// The prompts are the Ploinky tasks config/tasks/mrp-discover-extract.md (batchable) and mrp-discover-unify.md (lib/mrp/tasks.mjs).
const snake = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
const phrase = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}' -]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const quote = s => JSON.stringify(String(s));

/** The passages of a corpus in batches of at most `batchChars` characters (a passage longer than that is cut). */
export function batches(passages, batchChars = 12000) {
  const out = [];
  let current = [], size = 0;
  for (const raw of passages) {
    const text = String(raw).slice(0, batchChars);
    if (current.length && size + text.length > batchChars) { out.push(current); current = []; size = 0; }
    current.push(text); size += text.length;
  }
  if (current.length) out.push(current);
  return out;
}

/** One candidate of a model reply, normalized; null when it has no usable name or roles. */
function candidate(raw) {
  const name = snake(raw?.name);
  const roles = Array.isArray(raw?.roles) ? raw.roles.map(snake).filter(r => ROLE.test(r)) : [];
  if (!NAME.test(name) || roles.length < 1 || roles.length > 4 || new Set(roles).size !== roles.length) return null;
  const kinds = Array.isArray(raw?.kinds) ? raw.kinds.map(snake) : [];
  return {name, roles, kinds: roles.map((_, i) => kinds[i] || null), description: String(raw?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    forms: [...new Set((Array.isArray(raw?.forms) ? raw.forms : []).map(phrase).filter(f => f.length > 1))].slice(0, 8), batches: 1};
}

/** Merges candidates by name: the roles of the first, phrases united, `batches` counts how many batches named it. */
export function mergeCandidates(list) {
  const byName = new Map();
  for (const c of list) {
    const old = byName.get(c.name);
    if (!old) { byName.set(c.name, {...c}); continue; }
    old.batches += c.batches;
    old.forms = [...new Set([...old.forms, ...c.forms])].slice(0, 12);
    if (!old.description && c.description) old.description = c.description;
    old.kinds = old.kinds.map((k, i) => k ?? c.kinds[i] ?? null);
  }
  return [...byName.values()].sort((a, b) => b.batches - a.batches || a.name.localeCompare(b.name));
}

/** Applies synonym groups: every group is merged into its most frequent member (same arity only). */
export function unify(candidates, groups = []) {
  const byName = new Map(candidates.map(c => [c.name, c]));
  const merged = new Set();
  for (const group of groups) {
    const members = [...new Set((Array.isArray(group) ? group : []).map(snake))].map(n => byName.get(n)).filter(Boolean).filter(c => !merged.has(c.name));
    if (members.length < 2) continue;
    const [keep, ...rest] = members.sort((a, b) => b.batches - a.batches);
    for (const c of rest) {
      if (c.roles.length !== keep.roles.length) continue;
      keep.batches += c.batches;
      keep.forms = [...new Set([...keep.forms, ...c.forms, phrase(c.name.replace(/_/g, ' '))])].slice(0, 12);
      (keep.synonyms ??= []).push(c.name);
      merged.add(c.name);
    }
  }
  return candidates.filter(c => !merged.has(c.name));
}

/** The SOP wires of one candidate: a `predicate` and its English `lexeme` (role kinds only when the memory has that class). */
export function candidateWires(c, {isClass = () => false, strategy = 'llm-consolidate'} = {}) {
  const lines = [`@${c.name} predicate`, `  args ${c.roles.map(r => `${r}:entity`).join(' ')}`];
  c.roles.forEach((r, i) => { if (c.kinds[i] && isClass(c.kinds[i])) lines.push(`  role ${r} ${c.kinds[i]}`); });
  lines.push(`  label en ${quote(c.name.replace(/_/g, ' '))}`);
  if (c.description) lines.push(`  description ${quote(c.description)}`);
  const forms = c.forms.length ? c.forms : [c.name.replace(/_/g, ' ')];
  lines.push('', `@lx_${c.name}_en lexeme`, `  of ${c.name}`, '  language en', '  pos verb', ...forms.map(f => `  form ${quote(f)}`), `  frame ${c.roles.join(' ')}`, `  source ${quote(`discover ${strategy}`)}`);
  return lines.join('\n') + '\n';
}

/**
 * Runs `llm-consolidate` on `passages`. `run(name, inputs, {tier, batch})` runs a Ploinky task on inputs (lib/mrp/tasks.mjs `runTasks`
 * bound to a client: `[{ok, value, error, calls, requests}]`); `lexicon`
 * the Model's base-memory lexicon; `own` the ids of the predicates its base memory declares itself (without imports); `validate(circuits)` the knowledge validator against that memory (`{ok, problems}`). Returns
 * `{strategy, batches, calls, proposed: [{name, text, batches, synonyms?}], known: [...], invalid: [...], unused: [...], failures: [...]}`.
 */
const replyJson = value => value && typeof value === 'object' ? value : jsonOf(stripThinking(String(value ?? '')));

export async function llmConsolidate({passages, params = {}, run, lexicon, own = null, validate}) {
  const tier = params.tier ?? 'good', batchChars = params.batchChars ?? 12000;
  const groups = batches(passages, batchChars);
  const found = [], failures = [];
  // Every batch is one input of the extract task; Ploinky may send several batches in one request (prompt batching).
  const extracted = await run('mrp-discover-extract', groups.map(group => ({passages: group.map((p, j) => `PASSAGE ${j + 1}:\n${p}`).join('\n\n')})), {tier, batch: true});
  let calls = extracted[0]?.requests ?? 0;
  extracted.forEach((r, i) => {
    const j = r.ok ? replyJson(r.value) : null;
    if (!j || !Array.isArray(j.predicates)) { failures.push({batch: i + 1, reason: r.ok ? 'the model returned no readable JSON' : r.error ?? 'the tier did not answer'}); return; }
    for (const raw of j.predicates.slice(0, 25)) { const c = candidate(raw); if (c) found.push(c); }
  });
  let merged = mergeCandidates(found);
  if (merged.length > 1) {
    calls++;
    const listing = merged.map(c => `${c.name}(${c.roles.join(', ')}): ${c.description} [${c.forms.join('; ')}]`).join('\n');
    const [r] = await run('mrp-discover-unify', [{candidates: listing}], {tier});
    const j = r.ok ? replyJson(r.value) : null;
    if (j && Array.isArray(j.groups)) merged = unify(merged, j.groups);
    else failures.push({step: 'unify', reason: r.ok ? 'the model returned no readable JSON' : r.error ?? 'the tier did not answer'});
  }
  const existing = new Set(Object.keys(lexicon?.predicates ?? {}));
  const formOwner = form => (lexicon?.formsByKey?.get(phraseKey(form)) ?? [])[0]?.predicate ?? null;
  const proposed = [], known = [], invalid = [], matched = new Set();
  for (const c of merged) {
    const owner = existing.has(c.name) ? c.name : c.forms.map(formOwner).find(Boolean) ?? null;
    if (owner) { known.push({name: c.name, predicate: owner}); matched.add(owner); continue; }
    const text = candidateWires(c, {isClass: id => Boolean(lexicon?.isClass?.(id))});
    const check = validate([{name: `discover-${c.name}`, text}]);
    if (!check.ok) { invalid.push({name: c.name, problems: (check.problems ?? []).slice(0, 4).map(p => p.code ?? String(p))}); continue; }
    proposed.push({name: `discover-${c.name}`, text, batches: c.batches, ...(c.synonyms ? {synonyms: c.synonyms} : {})});
  }
  // The difference is reported over the model's own predicates (its base memory without imports), when known.
  const unused = [...(own ?? existing)].filter(p => !matched.has(p) && !/^(cv_|core_)/.test(p)).sort().slice(0, 200);
  return {strategy: 'llm-consolidate', tier, batches: groups.length, calls, proposed, known, invalid, unused, failures};
}

/** The `schema` wire of a discovery run (DS028): the proposed predicates and their lexemes, `status proposed`, one version per run. */
export function schemaRecord(names, {strategy = 'llm-consolidate', model = 'model', now = new Date()} = {}) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const id = `s_${snake(model)}_${stamp}_${Date.now() % 100000}`;
  const lines = [`@${id} schema`, `  name ${quote(`${model} discovered ${now.toISOString().slice(0, 10)}`)}`, `  provenance ${strategy}`, '  version 1', '  status proposed',
    ...names.map(n => `  predicate ~${n}`), ...names.map(n => `  lexeme ~lx_${n}_en`), `  source ${quote(`discover ${strategy}`)}`];
  return {name: `discover-${id}`, text: lines.join('\n') + '\n'};
}
