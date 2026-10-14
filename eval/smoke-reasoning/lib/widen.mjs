/**
 * Retrieval plus iterative widening around any strategy adapter.
 *
 * Loop (every step is traced; the retrieval budget `maxProbes` is separate from the strategy budget):
 *   1. retrieve a small symbol-driven slice (rule dependency radius, constant hops, per-predicate cap);
 *   2. run the strategy on the slice;
 *   3. accept only if the answer is valid for the slice: a complete slice, or a monotone positive answer;
 *   4. otherwise widen: `targeted` names the missing predicates (body predicates with no facts and no producing rule in
 *      the slice) and retrieves their whole support at once; `blind` just increases radius, hops and cap;
 *   5. stop when nothing new was retrieved, the probe budget is spent or maxSteps is reached, and answer
 *      `clarify` with the missing premises (the host would ask the user).
 * Rule of the proposal: negation as failure, aggregates, counts and `every` are valid only over predicates that are
 * declared closed AND fully retrieved. With a partial slice they would read a missing fact as false, so such an answer
 * is never accepted (`unsafeNaf: true` disables the guard to measure how many answers would have been wrong).
 */
import {parse, leaves, parseCondition, tokens, validateProgram} from '../validator.mjs';
import {MemoryStore, addDistractors, relevantSlice, sliceText, queryAtoms} from './memory.mjs';

/** Predicates whose answers depend on completeness of retrieval. */
function sensitivePreds(slice, store, queryText) {
  const out = new Set();
  const scan = fields => { for (const f of fields) for (const l of leaves(parseCondition(f, []))) if (l.kind === 'atom' && l.neg === 'absent') out.add(l.p); };
  for (const r of slice.rules) for (const w of parse(r.text).wires) scan(w.fields.filter(f => ['when', 'except', 'never'].includes(f.key)));
  for (const o of store.other) {
    const w = parse(o.text).wires[0];
    if (w.type === 'aggregate') for (const f of w.fields.filter(x => x.key === 'over')) for (const l of leaves(parseCondition(f, []))) if (l.kind === 'atom') out.add(l.p);
    if (w.type === 'default') { scan(w.fields.filter(f => ['when', 'except'].includes(f.key))); }
  }
  // round 3 (MUST-FIX 1): a DEFAULT conclusion is completeness-sensitive. A newly retrieved strict contrary (`not flies a`) or exception
  // atom retracts it, so the head predicate and every exception predicate of a default in the slice need RETRIEVAL completeness for the
  // keys (a keyed lookup of `not p a` and of each exception atom per candidate a), not world closedness. Widening treats a truncated
  // head or exception predicate like a truncated closed predicate and switches to keyed retrieval.
  for (const r of slice.rules) if (r.isDefault) { out.add(r.head.p); for (const p of r.except ?? []) out.add(p); }
  const q = parse(queryText).wires.find(w => w.type === 'query');
  const mode = q?.fields.find(f => f.key === 'mode')?.value.trim() ?? 'select';
  scan(q?.fields.filter(f => f.key === 'where') ?? []);
  if (['count', 'every'].includes(mode)) for (const a of queryAtoms(queryText)) out.add(a.p);
  return out;
}

export function buildStore(c) {
  const store = new MemoryStore();
  const wires = parse(c.knowledge).wires;
  // distractors first: the needed wires are the LAST ones stored, so a truncated scan misses them
  addDistractors(store, c.memory.distractors);
  store.addWires(wires, {tag: 'needed'});
  return store;
}

export async function runWithRetrieval(adapter, c, ctx, {policy = 'targeted', unsafeNaf = false, maxSteps = 6} = {}) {
  const store = buildStore(c);
  const needed = new Set([...store.facts, ...store.rules].filter(w => w.tag === 'needed').map(w => w.id));
  const qa = queryAtoms(c.query);
  const maxProbes = c.memory.maxProbes ?? 200000;
  let cur = {radius: c.memory.start?.radius ?? 1, hops: c.memory.start?.hops ?? 1, cap: c.memory.start?.cap ?? 1000, ruleCap: c.memory.start?.ruleCap ?? Infinity}, deep = new Set(), keyed = new Set(), uncapped = new Set();
  const qConsts = [...new Set(qa.flatMap(a => a.terms.filter(t => !t.startsWith('?') && !t.startsWith('$'))))];
  if (policy === 'whole') cur = {radius: Infinity, hops: Infinity, cap: Infinity, ruleCap: Infinity};
  const trace = [];
  let last = null, prevIds = '', final = null;
  for (let step = 1; step <= maxSteps; step++) {
    const slice = relevantSlice(store, qa, {...cur, extraPreds: [...deep], seedConsts: qConsts, keyed, uncappedRules: uncapped});
    // deep predicates pull their whole rule closure
    if (deep.size) { const more = relevantSlice(store, [...deep].map(p => ({p, terms: []})), {radius: Infinity, hops: cur.hops, cap: cur.cap, seedConsts: qConsts, keyed, ruleCap: Infinity}); for (const r of more.rules) if (!slice.rules.some(x => x.id === r.id)) slice.rules.push(r); for (const f of more.facts) if (!slice.facts.some(x => x.id === f.id)) slice.facts.push(f); for (const p of more.preds) slice.preds.add(p); for (const t of more.truncated) slice.truncated.add(t); slice.complete = slice.complete && more.complete; slice.probes += more.probes; }
    const ids = [...slice.facts.map(f => f.id), ...slice.rules.map(r => r.id)].sort().join(',');
    const text = sliceText(slice, store);
    // the validator, given the retrieval manifest (which predicates have ALL their rules in the slice), flags absent over a derived predicate
    const inSlice = new Set(slice.rules.map(r => r.id));
    const manifest = Object.fromEntries([...slice.preds].map(p => [p, (store.byHead.get(p) ?? []).every(r => inSlice.has(r.id))]));
    const flags = [...new Set(validateProgram([{name: 'slice', text, role: 'knowledge'}, {name: 'query', text: c.query, role: 'query'}], {ruleSetComplete: manifest}).problems.filter(p => p.code === 'absent_over_incomplete_rules').map(p => p.code))];
    const result = await adapter.run({...c, knowledge: text}, ctx);
    const sensitive = sensitivePreds(slice, store, c.query);
    const unsafe = sensitive.size > 0 && !slice.complete;
    const monotonePositive = !sensitive.size && result.status === 'supported' && (c.query.includes('mode exists') || c.query.includes('mode explain'));
    const valid = slice.complete || monotonePositive;
    const uncertain = ['unknown', 'budget_exhausted', 'no_plan'].includes(result.status) || result.complete === false;
    const accept = unsafeNaf ? true : valid && !(uncertain && !slice.complete);
    const retrieved = slice.facts.length + slice.rules.length;
    const gotNeeded = [...needed].filter(id => slice.facts.some(f => f.id === id) || slice.rules.some(r => r.id === id)).length;
    trace.push({step, radius: cur.radius, hops: cur.hops === Infinity ? 'all' : cur.hops, cap: cur.cap, deep: [...deep], keyed: [...keyed], wires: retrieved, probes: slice.probes, sliceComplete: slice.complete, truncated: [...slice.truncated], status: result.status, unsafeAnswerWithheld: unsafe && !unsafeNaf && !accept, accepted: accept, neededRecall: needed.size ? gotNeeded / needed.size : 1, ruleTruncated: [...slice.ruleTruncated], validatorFlags: flags});
    last = {result, slice, retrieved, gotNeeded};
    if (accept) { final = result; break; }
    if (ids === prevIds && step > 1) break;
    prevIds = ids;
    const spent = trace.reduce((s, t) => s + t.probes, 0);
    if (spent > maxProbes) { final = {status: 'budget_exhausted', complete: false, retrieval: 'probe budget spent'}; break; }
    // widen
    const nextCap = slice.truncated.size && policy !== 'targeted' ? cur.cap * 4 : cur.cap;
    if (policy === 'targeted') {
      // a truncated predicate that matters for completeness is fetched per known key, not scanned further
      for (const p of slice.truncated) if (sensitive.has(p)) keyed.add(p);
      if ([...slice.truncated].some(p => !sensitive.has(p))) cur = {...cur, cap: cur.cap * 4};
      const withProducers = new Set(slice.rules.map(r => r.head.p));
      const withFacts = new Set(slice.facts.map(f => f.p));
      const missing = [...slice.preds].filter(p => !withProducers.has(p) && !withFacts.has(p) && (store.byHead.has(p) || store.byPred.has(p)));
      for (const p of missing) deep.add(p);
      for (const p of slice.ruleTruncated) uncapped.add(p); // rulesFor was cut: ask for the whole rule set of that head
      cur = {radius: cur.radius + 1, hops: cur.hops === Infinity ? Infinity : cur.hops * 2, cap: cur.cap, ruleCap: cur.ruleCap};
    } else if (policy !== 'whole') cur = {radius: cur.radius + 1, hops: cur.hops === Infinity ? Infinity : cur.hops * 2, cap: nextCap, ruleCap: cur.ruleCap === Infinity ? Infinity : cur.ruleCap * 4};
  }
  const {result, slice} = last;
  const lastAccepted = trace.at(-1).accepted;
  if (!final) {
    // nothing accepted: an incomplete memory view cannot support a negative or counting answer
    final = slice.complete ? result : {status: 'clarify', complete: false, missing: [...slice.preds].filter(p => !slice.facts.some(f => f.p === p) && !slice.rules.some(r => r.head.p === p)).map(p => [p])};
  }
  return {...final, retrieval: {policy, steps: trace.length, trace, wires: trace.at(-1).wires, probes: trace.reduce((s, t) => s + t.probes, 0), storeWires: store.size(), neededRecall: trace.at(-1).neededRecall, accepted: lastAccepted}};
}
