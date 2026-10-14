import {entityHints, candidatePredicates} from './retrieval.mjs';
import {TheoryCache, termValue} from '../../reasoning/slice/wire.mjs';
import {renderEnglish} from '../../reasoning/slice/render-english.mjs';
import {Lowering, factWire} from '../../reasoning/bridge/lower.mjs';
import {tokens} from '../../sop/knowledge/lexical.mjs';

const theories = new TheoryCache(8);
const indexes = new WeakMap();
const lower = new Lowering();
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const field = (wire, key) => wire.fields.find(f => f.key === key)?.value?.trim();
const wireSOP = wire => `@${wire.id} ${wire.type}\n${wire.fields.map(f => `  ${f.key} ${f.value}\n${(f.block ?? []).map(b => `    ${b.text}\n`).join('')}`).join('')}`.trimEnd();
const key = value => JSON.stringify(value);
const factKey = atom => JSON.stringify([atom.p, atom.a, !!atom.neg]);
const positive = (n, defaultValue) => Number.isSafeInteger(n) && n > 0 ? n : defaultValue;

// The accepted circuits are parsed and reverse-indexed only once per cached Theory. This also
// serves development memories that have circuits but no repository session yet.
function indexOf(theory) {
  let index = indexes.get(theory);
  if (index) return index;
  const byEntity = new Map(), byPredicate = new Map(), byRule = new Map();
  for (const wire of theory.byId.values()) {
    if (wire.type !== 'fact') continue;
    const parts = tokens(field(wire, 'holds') ?? '');
    const neg = parts[0] === 'not';
    const atom = {p: parts[neg ? 1 : 0], a: parts.slice(neg ? 2 : 1).map(termValue), neg};
    if (!atom.p) continue;
    const row = {id: wire.id, wire, atom};
    if (!byPredicate.has(atom.p)) byPredicate.set(atom.p, []);
    byPredicate.get(atom.p).push(row);
    for (const value of new Set(atom.a.filter(x => typeof x === 'string'))) {
      if (!byEntity.has(value)) byEntity.set(value, []);
      byEntity.get(value).push(row);
    }
  }
  for (const rec of theory.recs) {
    // Theory already indexed head rules; the reverse body index is built once.
    for (const p of new Set([rec.head.p, ...rec.body.map(a => a.p)])) {
      if (!byRule.has(p)) byRule.set(p, []);
      byRule.get(p).push(rec);
    }
  }
  index = {byEntity, byPredicate, byRule};
  indexes.set(theory, index);
  return index;
}

/**
 * Read-only schema around unambiguous linked entities. Limits apply to predicate/role
 * lookups, returned facts, SQL probes, output bytes and rule/example counts. `factCount`
 * is exact only for a circuits-only world; repository counts are explicitly lower bounds
 * of the bounded observed sample, never claimed to be a global count.
 */
export function collectNeighbourhood({message = '', lexicon, circuits = [], repo = null, session = null, hops = 1, terms = [], entities = [],
  maxEntities = 12, maxPredicates = 20, maxLookups = 160, maxProbes = 2000, maxFactsPerLookup = 16,
  maxExamples = 2, maxRules = 2, maxBytes = 16_000} = {}) {
  if (!!repo !== !!session) throw new TypeError('repo and session must be supplied together');
  const bounds = {
    entities: positive(maxEntities, 12), predicates: positive(maxPredicates, 20), lookups: positive(maxLookups, 160),
    probes: positive(maxProbes, 2000), factsPerLookup: positive(maxFactsPerLookup, 16),
    examples: Math.min(2, positive(maxExamples, 2)), rules: positive(maxRules, 2), bytes: positive(maxBytes, 16_000),
  };
  const depth = hops === 2 ? 2 : 1;
  const diagnostics = {lookups: 0, probes: 0, factsVisited: 0, bounds, reasons: [], ambiguous: []};
  const reason = r => { if (!diagnostics.reasons.includes(r)) diagnostics.reasons.push(r); };
  const hints = entityHints(String(message), lexicon, {max: bounds.entities + 1, perMention: 3});
  if (hints.length > bounds.entities) reason('entity_limit');
  const seeds = [];
  for (const mention of hints.slice(0, bounds.entities)) {
    // A partial surname or several surface claimants must NEVER silently pick the
    // best-ranked identity, even when only one candidate survived the hint cap.
    if (mention.partial || mention.total !== 1 || mention.candidates.length !== 1) {
      if (diagnostics.ambiguous.length < 6) diagnostics.ambiguous.push({surface: mention.surface.slice(0, 80), candidates: mention.candidates.map(c => c.id)});
      continue;
    }
    if (!seeds.includes(mention.candidates[0].id)) seeds.push(mention.candidates[0].id);
  }
  // Entities the turn always concerns (the addressee of the message, the assistant of the self layer) seed the neighbourhood too.
  for (const id of entities) if (lexicon?.entities?.[id] && !seeds.includes(id) && seeds.length < bounds.entities) seeds.push(id);
  const theory = circuits?.length ? theories.get(circuits) : null;
  const index = theory ? indexOf(theory) : null;
  const schemas = lexicon?.predicates ?? {};
  const lexical = new Map();
  const supplied = Array.isArray(terms) ? terms.slice(0, bounds.predicates * 2) : [];
  if (Array.isArray(terms) && terms.length > supplied.length) reason('term_limit');
  for (const t of supplied) {
    const id = typeof t === 'string' ? t : t?.id;
    if (schemas[id]) lexical.set(id, Math.max(lexical.get(id) ?? 0, typeof t === 'object' ? t.score ?? 1 : 1));
    else if (typeof t === 'string') for (const c of candidatePredicates(t, lexicon, {k: 3, core: []})) lexical.set(c.id, Math.max(lexical.get(c.id) ?? 0, c.score));
  }
  if (!supplied.length) for (const c of candidatePredicates(message, lexicon, {k: 8, core: []})) lexical.set(c.id, c.score);
  const scores = new Map(), found = new Map(), frontier = [...seeds], seen = new Set(seeds);
  const add = (p, score, row) => {
    if (!schemas[p]) return;
    scores.set(p, Math.max(score, scores.get(p) ?? 0));
    if (!row) return;
    if (!found.has(p)) found.set(p, new Map());
    found.get(p).set(factKey(row.atom), row);
  };
  for (const [p, score] of lexical) add(p, Math.min(35, 10 + score));
  // An indexed reverse fact lookup finds relations that lexical matching missed.
  // With a repository, enumerate only the declared signatures and use its indexed
  // keyed recall, never scan all facts or the claim journal for an entity.
  const candidates = repo ? Object.values(schemas).sort((a, b) =>
    (lexical.has(b.id) ? 1 : 0) - (lexical.has(a.id) ? 1 : 0) || (b.factCount ?? 0) - (a.factCount ?? 0) || a.id.localeCompare(b.id)) : [];
  for (let step = 1; step <= depth && frontier.length; step++) {
    const next = [];
    for (const entity of frontier) {
      const indexed = !repo ? index?.byEntity.get(entity) ?? [] : [];
      for (const row of indexed) {
        if (diagnostics.factsVisited >= bounds.lookups * bounds.factsPerLookup) { reason('fact_limit'); break; }
        diagnostics.factsVisited++;
        add(row.atom.p, step === 1 ? 100 : 65, row);
        for (const neighbour of row.atom.a) if (step < depth && typeof neighbour === 'string' && schemas && lexicon?.entities?.[neighbour] && !seen.has(neighbour)) {
          if (seen.size >= bounds.entities) { reason('entity_limit'); continue; }
          seen.add(neighbour); next.push(neighbour);
        }
      }
      if (!repo) continue;
      outer: for (const schema of candidates) for (let i = 0; i < (schema.roles?.length ?? schema.arity ?? 0); i++) for (const neg of [false, true]) {
        if (diagnostics.lookups >= bounds.lookups) { reason('lookup_limit'); break outer; }
        if (diagnostics.probes >= bounds.probes) { reason('probe_limit'); break outer; }
        const arity = schema.roles?.length || schema.arity;
        if (!arity || arity > 4) continue;
        const pattern = {p: schema.id, a: Array.from({length: arity}, (_, j) => j === i ? entity : `?v${j}`), neg};
        const result = repo.recall(session, pattern, {asof: Infinity}, {limit: bounds.factsPerLookup, maxProbes: bounds.probes - diagnostics.probes});
        diagnostics.lookups++;
        diagnostics.probes += result.probes;
        if (!result.complete) reason('fact_lookup_limit');
        for (const row of result.rows) {
          diagnostics.factsVisited++;
          add(schema.id, step === 1 ? 100 : 65, row);
          for (const neighbour of row.atom.a) if (step < depth && typeof neighbour === 'string' && lexicon?.entities?.[neighbour] && !seen.has(neighbour)) {
            if (seen.size >= bounds.entities) { reason('entity_limit'); continue; }
            seen.add(neighbour); next.push(neighbour);
          }
        }
      }
    }
    frontier.splice(0, frontier.length, ...next);
  }
  // When there is no linked entity, lexical candidates still need examples.
  // Both the circuit index and the SQL predicate index support bounded reads.
  for (const id of lexical.keys()) {
    if (!repo) {
      for (const row of (index?.byPredicate.get(id) ?? []).slice(0, bounds.examples)) add(id, scores.get(id), row);
    } else if (!found.has(id)) {
      const schema = schemas[id], arity = schema.roles?.length || schema.arity;
      if (!arity || arity > 4) continue;
      for (const neg of [false, true]) {
        if (diagnostics.lookups >= bounds.lookups) { reason('lookup_limit'); break; }
        if (diagnostics.probes >= bounds.probes) { reason('probe_limit'); break; }
        const pattern = {p: id, a: Array.from({length: arity}, (_, i) => `?v${i}`), neg};
        const result = repo.recall(session, pattern, {asof: Infinity}, {limit: bounds.examples, maxProbes: bounds.probes - diagnostics.probes});
        diagnostics.lookups++;
        diagnostics.probes += result.probes;
        if (!result.complete) reason('fact_lookup_limit');
        for (const row of result.rows) { diagnostics.factsVisited++; add(id, scores.get(id), row); }
      }
    }
  }
  // Derived predicates with no stored instances are discoverable through rules
  // whose bodies use the retrieved relations (including integrity -> violation).
  for (const p of [...scores.keys()]) {
    const related = index?.byRule.get(p) ?? [];
    if (related.length > bounds.rules * bounds.predicates) reason('rule_limit');
    for (const rec of related.slice(0, bounds.rules * bounds.predicates)) {
      if (schemas[rec.head.p] && rec.body.some(a => a.p === p)) add(rec.head.p, Math.max(40, (scores.get(p) ?? 0) - 35));
    }
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length > bounds.predicates) reason('predicate_limit');
  const predicates = [];
  let usedBytes = bytes({predicates: [], entities: seeds, hops: depth, truncated: true, diagnostics});
  for (const [id, score] of ranked.slice(0, bounds.predicates)) {
    const schema = schemas[id];
    const rows = found.get(id) ?? new Map();
    // Circuits alone are the complete accepted development world. When a
    // repository exists, examples come only from its visible live facts.
    const exact = !repo && !!index;
    const factCount = exact ? index.byPredicate.get(id)?.length ?? 0 : rows.size;
    const examples = [];
    for (const row of rows.values()) {
      if (examples.length >= bounds.examples) break;
      const wire = row.wire ?? factWire(lower, `example_${examples.length + 1}`, row);
      examples.push({sop: wireSOP(wire), english: renderEnglish({wires: [wire]}), atom: row.atom});
    }
    const related = index?.byRule.get(id) ?? [];
    if (related.length > bounds.rules) reason('rule_limit');
    const rules = related.slice(0, bounds.rules).map(rec => ({id: rec.id, sop: wireSOP(rec.wire), english: renderEnglish({wires: [rec.wire]})}));
    const base = {id, score, roles: schema.roles ?? [], closed: schema.closed === true, factCount, factCountExact: exact,
      factCountBound: exact ? 'exact' : 'at_least', examples, rules};
    // Do not cut a quoted example or a rule. Drop lower priority details before
    // the whole predicate; the byte budget covers the actual returned JSON.
    let cost = bytes(base);
    while (usedBytes + cost > bounds.bytes && (base.rules.length || base.examples.length)) {
      if (base.rules.length) base.rules.pop(); else base.examples.pop();
      reason('byte_limit'); cost = bytes(base);
    }
    if (usedBytes + cost > bounds.bytes) { reason('byte_limit'); continue; }
    usedBytes += cost;
    predicates.push(base);
  }
  const packet = {predicates, entities: seeds, hops: depth, truncated: diagnostics.reasons.length > 0, diagnostics};
  while (bytes(packet) > bounds.bytes && predicates.length) {
    predicates.pop();
    reason('byte_limit');
    packet.truncated = true;
  }
  while (bytes(packet) > bounds.bytes && (diagnostics.ambiguous.length || seeds.length)) {
    if (diagnostics.ambiguous.length) { diagnostics.ambiguous.pop(); reason('ambiguous_metadata_limit'); }
    else { seeds.pop(); reason('entity_metadata_limit'); }
    packet.truncated = true;
  }
  if (bytes(packet) > bounds.bytes) throw new RangeError('maxBytes cannot fit neighbourhood metadata');
  return packet;
}
