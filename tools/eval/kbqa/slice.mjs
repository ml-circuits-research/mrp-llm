/**
 * The Wikidata knowledge slice of a KBQA suite stage (tools/eval/kbqa/cli.mjs `build`). For the questions of the stage:
 *   E  the question entities (benchmark annotation: Mintaka questionEntity, the wd: items of the gold SPARQL, the SimpleQuestions subject),
 *   A  the gold answer entities (at most 20 per question),
 *   P  the properties of the gold SPARQL (none for Mintaka, which ships no query) plus P31.
 * Fetched (all cached under datasets_sources/kbqa/raw/):
 *   1. out(E ∪ A): every truthy statement of these items whose property is an item, quantity, time, string or monolingual-text property
 *      (external identifiers, media and URLs are left out): the 1-hop neighbourhood, distractors included;
 *   2. in(e, p) for e in E and p in P of the same question: incoming statements, at most 300 per pair (class membership, inverse questions, counts);
 *   3. hop 2: the item neighbours N of E (values of out(E)), their statements towards A (paths E -> N -> A), and, for p in P, their statements
 *      with p (at most 150 neighbours per question);
 *   4. labels, descriptions and Wikipedia-edition counts (notability) of every item, English aliases of E ∪ A ∪ classes, P31 of every item,
 *      labels and aliases of every property.
 * The slice is gold-guided by construction (it is "the facts about the gold entities"): it measures the chain given the knowledge, and the
 * scorer's knowledge check reports when even this slice does not connect a question entity to its answer.
 */
import {sparql, hash, qidOf, values} from './wikidata.mjs';

const TYPES = 'wikibase:WikibaseItem wikibase:Quantity wikibase:Time wikibase:String wikibase:Monolingualtext';
const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const isQ = id => /^Q\d+$/.test(id ?? '');

function triple(r, extra = {}) {
  const o = qidOf(r.o);
  return {s: qidOf(r.s), p: r.p, o: o ?? r.o, item: Boolean(o), type: r.t ? r.t.replace('http://wikiba.se/ontology#', '') : (o ? 'WikibaseItem' : null), ...extra};
}

async function outgoing(ids, {log}) {
  const triples = [];
  // Hub items (countries, big cities) carry thousands of statements: small batches keep each query inside the WDQS time limit.
  for (const [i, batch] of chunks(ids, 8).entries()) {
    const q = `SELECT ?s ?p ?o ?t WHERE { VALUES ?s { ${values(batch)} } ?s ?pd ?o . ?prop wikibase:directClaim ?pd ; wikibase:propertyType ?t . VALUES ?t { ${TYPES} } FILTER(!isLiteral(?o) || lang(?o) = "" || langMatches(lang(?o), "en")) BIND(STRAFTER(STR(?prop), "entity/") AS ?p) }`;
    try { for (const r of await sparql(`out-${hash(q)}`, q)) triples.push(triple(r)); }
    catch (error) { log(`[slice] out batch ${i} failed: ${error.message}`); }
  }
  return triples;
}

async function incoming(pairs, {log}) {
  const triples = [];
  for (const batch of chunks(pairs, 6)) {
    const parts = batch.map(([e, p]) => `{ SELECT ?s ?o ?p WHERE { ?s wdt:${p} wd:${e} . BIND(wd:${e} AS ?o) BIND("${p}" AS ?p) } LIMIT 300 }`);
    const q = `SELECT ?s ?p ?o WHERE { ${parts.join(' UNION ')} }`;
    try { for (const r of await sparql(`in-${hash(q)}`, q, {timeoutMs: 80000, retries: 2})) triples.push(triple(r, {type: 'WikibaseItem'})); }
    catch (error) { log(`[slice] incoming batch failed: ${error.message}`); }
  }
  return triples;
}

async function hop2(neighbours, answers, props, {log}) {
  const triples = [];
  for (const batch of chunks(neighbours, 60)) {
    if (answers.length) for (const ab of chunks(answers, 200)) {
      const q = `SELECT ?s ?p ?o WHERE { VALUES ?s { ${values(batch)} } VALUES ?o { ${values(ab)} } ?s ?pd ?o . ?prop wikibase:directClaim ?pd . BIND(STRAFTER(STR(?prop), "entity/") AS ?p) }`;
      try { for (const r of await sparql(`hopA-${hash(q)}`, q)) triples.push(triple(r, {type: 'WikibaseItem'})); } catch (error) { log(`[slice] hop2 answers failed: ${error.message}`); }
    }
    if (props.length) {
      const q = `SELECT ?s ?p ?o ?t WHERE { VALUES ?s { ${values(batch)} } VALUES ?pd { ${props.map(p => `wdt:${p}`).join(' ')} } ?s ?pd ?o . ?prop wikibase:directClaim ?pd ; wikibase:propertyType ?t . FILTER(!isLiteral(?o) || lang(?o) = "" || langMatches(lang(?o), "en")) BIND(STRAFTER(STR(?prop), "entity/") AS ?p) }`;
      try { for (const r of await sparql(`hopP-${hash(q)}`, q)) triples.push(triple(r)); } catch (error) { log(`[slice] hop2 props failed: ${error.message}`); }
    }
  }
  return triples;
}

async function itemInfo(ids, withAliases, {log}) {
  const info = new Map();
  for (const batch of chunks(ids, 300)) {
    const q = `SELECT ?i ?l ?d ?n WHERE { VALUES ?i { ${values(batch)} } OPTIONAL { ?i rdfs:label ?l FILTER(lang(?l) = "en") } OPTIONAL { ?i schema:description ?d FILTER(lang(?d) = "en") } OPTIONAL { ?i wikibase:sitelinks ?n } }`;
    try { for (const r of await sparql(`label-${hash(q)}`, q)) { const id = qidOf(r.i); const cur = info.get(id) ?? {aliases: []}; cur.label ??= r.l ?? null; cur.description ??= r.d ?? null; cur.sitelinks = Number(r.n ?? cur.sitelinks ?? 0); info.set(id, cur); } }
    catch (error) { log(`[slice] labels failed: ${error.message}`); }
  }
  for (const batch of chunks(withAliases, 300)) {
    const q = `SELECT ?i ?a WHERE { VALUES ?i { ${values(batch)} } ?i skos:altLabel ?a FILTER(lang(?a) = "en") }`;
    try { for (const r of await sparql(`alias-${hash(q)}`, q)) { const cur = info.get(qidOf(r.i)); if (cur && cur.aliases.length < 25) cur.aliases.push(r.a); } }
    catch (error) { log(`[slice] aliases failed: ${error.message}`); }
  }
  return info;
}

async function instanceOf(ids, {log}) {
  const triples = [];
  for (const batch of chunks(ids, 400)) {
    const q = `SELECT ?s ?o WHERE { VALUES ?s { ${values(batch)} } ?s wdt:P31 ?o . }`;
    try { for (const r of await sparql(`p31-${hash(q)}`, q)) triples.push({s: qidOf(r.s), p: 'P31', o: qidOf(r.o), item: true, type: 'WikibaseItem'}); }
    catch (error) { log(`[slice] P31 failed: ${error.message}`); }
  }
  return triples;
}

async function propertyInfo(pids, {log}) {
  const info = new Map();
  for (const batch of chunks(pids, 200)) {
    const q = `SELECT ?p ?l ?a ?t WHERE { VALUES ?p { ${batch.map(p => `wd:${p}`).join(' ')} } ?p wikibase:propertyType ?t . OPTIONAL { ?p rdfs:label ?l FILTER(lang(?l) = "en") } OPTIONAL { ?p skos:altLabel ?a FILTER(lang(?a) = "en") } }`;
    try {
      for (const r of await sparql(`prop-${hash(q)}`, q)) {
        const id = qidOf(r.p);
        const cur = info.get(id) ?? {label: null, aliases: [], type: r.t.replace('http://wikiba.se/ontology#', '')};
        cur.label ??= r.l ?? null;
        if (r.a && !cur.aliases.includes(r.a)) cur.aliases.push(r.a);
        info.set(id, cur);
      }
    } catch (error) { log(`[slice] property labels failed: ${error.message}`); }
  }
  return info;
}

/** Fetches the slice of `rows` (suite rows of one stage); returns {triples, items, properties, perQuestion}. */
export async function fetchSlice(rows, {log = console.error} = {}) {
  const E = new Set(), A = new Set(), pairs = new Map();
  const perQuestion = new Map();
  for (const r of rows) {
    const answers = (r.gold?.answers ?? []).filter(a => a.kind === 'entity').map(a => a.qid).slice(0, 20);
    for (const e of r.entities) E.add(e);
    for (const a of answers) A.add(a);
    const props = [...new Set([...(r.properties ?? []), 'P31'])];
    for (const e of r.entities) for (const p of r.properties ?? []) pairs.set(`${e} ${p}`, [e, p]);
    perQuestion.set(r.id, {entities: r.entities, answers, props});
  }
  log(`[slice] ${rows.length} questions: ${E.size} question entities, ${A.size} answer entities, ${pairs.size} incoming pairs`);
  const core = [...new Set([...E, ...A])];
  const out = await outgoing(core, {log});
  log(`[slice] out: ${out.length} statements`);
  const inc = await incoming([...pairs.values()], {log});
  log(`[slice] in: ${inc.length} statements`);
  // Hop 2: per question, the item neighbours of its entities (at most 150), their statements towards the question's answers and with its properties.
  const outBy = new Map();
  for (const t of out) (outBy.get(t.s) ?? outBy.set(t.s, []).get(t.s)).push(t);
  const nb = new Set(), nbProps = new Set();
  for (const q of perQuestion.values()) {
    const list = [...new Set(q.entities.flatMap(e => (outBy.get(e) ?? []).filter(t => t.item && t.p !== 'P31').map(t => t.o)))].slice(0, 150);
    for (const n of list) if (!E.has(n) && !A.has(n)) nb.add(n);
    for (const p of q.props) if (p !== 'P31') nbProps.add(p);
  }
  const h2 = await hop2([...nb], [...A], [...nbProps], {log});
  log(`[slice] hop 2: ${nb.size} neighbours, ${h2.length} statements`);
  const triples = [...out, ...inc, ...h2];
  const items = new Set(core);
  for (const t of triples) { if (isQ(t.s)) items.add(t.s); if (t.item && isQ(t.o)) items.add(t.o); }
  const types = await instanceOf([...items].filter(id => !core.includes(id)), {log});
  for (const t of types) { triples.push(t); items.add(t.o); }
  const classes = new Set(triples.filter(t => t.p === 'P31').map(t => t.o));
  const info = await itemInfo([...items], [...new Set([...core, ...classes])].filter(isQ), {log});
  const properties = await propertyInfo([...new Set(triples.map(t => t.p))].filter(p => /^P\d+$/.test(p)), {log});
  log(`[slice] ${triples.length} statements, ${items.size} items, ${properties.size} properties`);
  return {triples, items: info, properties, perQuestion: Object.fromEntries(perQuestion)};
}
