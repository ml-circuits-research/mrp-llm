/**
 * DependencyScaffold (DS028 "Routed formalizers"): a dependency parse gives the skeleton of the question and a small model only names
 * the predicate. The English message is parsed by spaCy in the strategy service (`parse/spacy`); the skeleton is the relation phrase
 * (the verb lemma with its preposition, a copular noun with its preposition, a passive turned active), its subject and object, the asked
 * slot (a wh-word, `how many`) and the polarity. It becomes one `match` block with the relation written as a phrase, which the
 * KnowledgeLinker binds when the memory has that phrase (no model call). When the phrase does not link, the Ploinky task
 * `mrp-scaffold-label` chooses the predicate id from the lexical candidates (and the retrieve slot's), and the circuit is written with
 * that id. The same validator admits both; a question whose skeleton cannot be read, or that no candidate expresses, is one `unparsed`
 * wire. Scope: questions over one unary or binary relation (who/what/which/where, yes/no, how many); joins are out of scope.
 */
import {serviceCall} from '../mrp/strategy-service.mjs';
import {runTask} from '../mrp/tasks.mjs';
import {jsonOf, stripThinking} from '../pworker.mjs';
import {validateQuery, unclearKind} from '../query-author/validate.mjs';
import {candidatePredicates} from '../query-author/retrieval.mjs';
import {phraseKey} from '../../sop/text-keys.mjs';

const WH = new Set(['who', 'whom', 'what', 'which', 'where', 'when']);
const quote = s => JSON.stringify(String(s));

/** The words of the subtree of token `i` that name an argument (determiners, punctuation and wh-words dropped). */
function phraseOf(tokens, i) {
  const inside = new Set([i]);
  for (let grew = true; grew;) { grew = false; for (const t of tokens) if (!inside.has(t.i) && inside.has(t.head) && t.i !== t.head && !['relcl', 'acl', 'punct', 'prep', 'cc', 'conj', 'case'].includes(t.dep)) { inside.add(t.i); grew = true; } }
  const words = tokens.filter(t => inside.has(t.i) && !['DET', 'PUNCT'].includes(t.pos) && t.tag !== 'POS' && !(t.dep === 'poss' && t.i !== i));
  // "project Apollo", "the city of Cluj": a name after lowercase class words is the name.
  const name = words.findIndex(t => t.pos === 'PROPN');
  return (name > 0 && words.slice(0, name).every(t => t.pos === 'NOUN') ? words.slice(name) : words).map(t => t.text).join(' ').trim();
}

/** The skeleton of a parsed question: `{phrase, subject, object, asked, count, negated}` or null when it is not one relation. */
export function skeletonOf(tokens) {
  const root = tokens.find(t => t.dep === 'ROOT');
  if (!root) return null;
  const kids = (h, ...deps) => tokens.filter(t => t.head === h.i && t.i !== h.i && (!deps.length || deps.includes(t.dep)));
  const whTok = tokens.find(t => WH.has(t.lower ?? t.text.toLowerCase()) || ['WP', 'WDT', 'WRB'].includes(t.tag));
  const many = whTok && whTok.text.toLowerCase() === 'how' && /^(many|much)$/i.test(tokens[whTok.i + 1]?.text ?? '');
  const isWh = t => t && (WH.has(t.text.toLowerCase()) || ['WP', 'WDT', 'WRB'].includes(t.tag) || (many && t.i === whTok.i + 2) || kids(t, 'det').some(d => d.tag === 'WDT'));
  const arg = t => t ? (isWh(t) || (many && tokens[whTok.i + 2]?.i === t.i) ? '?x' : phraseOf(tokens, t.i)) : null;
  const negated = tokens.some(t => t.dep === 'neg');
  // Two coordinated predicates or a relative clause are a join: out of scope, so the question is not read (never half read).
  if (tokens.some(t => (t.dep === 'conj' && tokens[t.head]?.pos === 'VERB' || t.dep === 'conj' && t.head === root.i) || t.dep === 'relcl')) return null;
  let phrase, subj, obj;
  const preps = kids(root, 'prep', 'agent');
  if (root.lemma === 'be') {
    const attr = kids(root, 'attr', 'acomp')[0], nsubj = kids(root, 'nsubj')[0], prepR = kids(root, 'prep')[0];
    if (attr && nsubj) {
      // "Who is the parent of Carina?", "Is Ana a grandparent of Carina?": the noun that is not the wh-word carries the relation;
      // "Who is Elena's parent?": a possessive is the object of "<noun> of".
      const noun = isWh(attr) ? nsubj : attr, other = noun === attr ? nsubj : attr;
      const poss = kids(noun, 'poss')[0];
      const prep = kids(noun, 'prep')[0] ?? prepR, pobj = prep ? kids(prep, 'pobj')[0] : null;
      phrase = `${noun.lemma}${prep ? ' ' + prep.text.toLowerCase() : poss ? ' of' : ''}`;
      subj = arg(other);
      obj = pobj ? arg(pobj) : poss ? arg(poss) : null;
    } else if (prepR) {
      // "Who is on project Apollo?", "Which project is Bogdan on?" (a stranded preposition asks for its object)
      const pobj = kids(prepR, 'pobj')[0];
      const asker = [attr, nsubj, ...kids(root, 'dobj', 'npadvmod')].find(t => t && isWh(t));
      phrase = `be ${prepR.text.toLowerCase()}`;
      if (pobj) { subj = arg(nsubj ?? attr); obj = arg(pobj); }
      else { subj = arg([nsubj, attr].find(t => t && !isWh(t))); obj = asker ? '?x' : null; }
    } else return null;
  } else {
    const nsubj = kids(root, 'nsubj')[0], pass = kids(root, 'nsubjpass')[0], agent = kids(root, 'agent')[0];
    const other = preps.find(p => p.dep === 'prep');
    const pobj = other ? kids(other, 'pobj')[0] : null;
    const dobj = kids(root, 'dobj')[0];
    phrase = `${root.lemma}${other ? ' ' + other.text.toLowerCase() : ''}`;
    if (pass) {
      const by = agent ? kids(agent, 'pobj')[0] : null;
      subj = by ? arg(by) : (pobj ? arg(pobj) : null);
      obj = arg(pass);
      if (!by && other) { phrase = `be ${root.text.toLowerCase()} ${other.text.toLowerCase()}`; subj = arg(pass); obj = arg(pobj); }
      // "Where is Globex located?": the wh-adverb asks for the place.
      if (!by && !other && whTok?.text.toLowerCase() === 'where') { phrase = `${root.text.toLowerCase()} in`; subj = arg(pass); obj = '?x'; }
    } else {
      subj = arg(nsubj);
      obj = pobj ? arg(pobj) : arg(dobj);
      const where = whTok && whTok.text.toLowerCase() === 'where' && !obj;
      if (where) { obj = '?x'; phrase = `${root.lemma} in`; }
    }
  }
  if (!phrase || !subj) return null;
  const asked = [subj, obj].includes('?x');
  return {phrase, subject: subj, object: obj, asked, count: Boolean(many), negated};
}

/** The circuit of a skeleton with `relation` (a phrase or a predicate id) and the two role names. */
export function circuitOf(s, relation, roles = ['subject', 'object']) {
  const term = v => v === '?x' ? '?x' : quote(v);
  const lines = ['@q query'];
  if (s.count) lines.push('  mode count', '  select ?x');
  else if (s.asked) lines.push('  select ?x');
  lines.push('  where match', `    relation ${quote(relation)}`, `    role ${roles[0]} ${term(s.subject)}`);
  if (s.object != null) lines.push(`    role ${roles[1]} ${term(s.object)}`);
  lines.push(`    polarity ${s.negated ? 'negated' : 'affirmed'}`, '  end');
  return lines.join('\n') + '\n';
}

// What the scaffold cannot read is said, never filled in: the request is unclear (relation_not_in_memory), the only wire of the circuit.
const unparsed = () => `@c unclear\n  kind relation_not_in_memory\n`;

/**
 * A skeleton to a validated circuit, shared by DependencyScaffold and CNL-ACE: the phrase circuit when the KnowledgeLinker binds the
 * phrase, else the predicate a tiny tier names from the closed candidate list (task mrp-scaffold-label), else unclear. Returns the result
 * shape of the request parser's strategies.
 */
export async function skeletonCircuit(s, {message, lexicon, circuits = [], repo = null, session = null, retrieval = null, link = null, client, tier, steps = [], t0 = Date.now(), extra = {}}) {
  const validate = (sop, mode) => validateQuery({sop, message, lexicon, circuits, repo, session, mode});
  const done = (sop, validation, more = {}) => ({ok: validation.ok, status: validation.ok ? 'validated' : 'invalid', sop, validation, program: validation.program, unclear: validation.ok ? unclearKind(validation.program) : null, steps, ms: Date.now() - t0, model: tier, ...extra, ...more});
  // A skeleton with one argument would ask for every pair of a binary relation: unclear, never an underspecified query.
  if (!s || s.subject == null || s.object == null) { const sop = unparsed(message); return done(sop, validate(sop, 'id'), {skeleton: s ?? null}); }
  // The link slot's schema-linker: a phrase that exactly one predicate of the reviewed schemas carries (its label or a lexeme form) is
  // written with that predicate's id, before the KnowledgeLinker could weigh other predicates of the memory.
  if (link === 'schema-linker') {
    const key = phraseKey(s.phrase);
    const owners = (lexicon.reviewedSchemaPredicates?.() ?? []).filter(id => { const p = lexicon.predicates[id]; return [p.labels?.en, ...(p.lexemes ?? []).flatMap(l => l.forms)].filter(Boolean).some(f => phraseKey(f) === key); });
    if (owners.length === 1) {
      const roles = (lexicon.predicates[owners[0]].roles ?? []).map(x => x.name);
      const lexeme = (lexicon.predicates[owners[0]].lexemes ?? []).find(l => l.forms.some(f => phraseKey(f) === key));
      const ordered = lexeme?.converse ? {...s, subject: s.object, object: s.subject} : s;
      const sop = circuitOf(ordered, owners[0], roles.length >= 2 ? roles : ['subject', 'object']);
      steps.push({name: 'schema-linker', answer: owners[0]});
      const v = validate(sop, 'id');
      if (v.ok) return done(sop, v, {skeleton: s, linked: 'schema'});
    }
  }
  const phrased = circuitOf(s, s.phrase);
  const byPhrase = validate(phrased, 'phrase');
  // The phrase links when the validator reports no problem and no advice that the phrase matches nothing.
  if (byPhrase.ok && !byPhrase.advice.some(a => a.code === 'relation_not_in_vocabulary')) return done(phrased, byPhrase, {skeleton: s, linked: 'phrase'});
  const ids = [...new Map([...(retrieval?.predicates ?? []), ...candidatePredicates(message, lexicon, {k: 12})].filter(p => lexicon.predicates?.[p.id]).map(p => [p.id, p])).keys()].slice(0, 16);
  const listed = ids.map(id => `- ${id}(${(lexicon.predicates[id].roles ?? []).map(r => r.name).join(', ')}): ${lexicon.predicates[id].labels?.en ?? ''}`).join('\n');
  const r = await runTask('mrp-scaffold-label', {message, phrase: s.phrase, subject: s.subject, object: s.object ?? '(none)', candidates: listed}, {client, tier});
  const j = r.ok ? jsonOf(stripThinking(String(r.value ?? ''))) : null;
  steps.push({name: 'label', answer: j ? JSON.stringify(j) : (r.error ?? 'unreadable'), tier, ...(r.ok ? {} : {ok: false, reason: r.error})});
  if (!r.ok) return {ok: false, status: 'failed', reason: r.error, steps, ms: Date.now() - t0};
  const id = j && typeof j.predicate === 'string' && ids.includes(j.predicate) ? j.predicate : null;
  if (!id) { const sop = unparsed(message); return done(sop, validate(sop, 'id'), {skeleton: s}); }
  const roles = (lexicon.predicates[id].roles ?? []).map(x => x.name);
  // A binary predicate with one argument would ask for every pair: the skeleton missed an argument, so the question stays unclear.
  if (roles.length >= 2 && (s.object == null || s.subject == null)) { const sop = unparsed(message); return done(sop, validate(sop, 'id'), {skeleton: s}); }
  const ordered = j.subject_first === false ? {...s, subject: s.object, object: s.subject} : s;
  const sop = circuitOf(ordered, id, roles.length >= 2 ? roles : ['subject', 'object']);
  return done(sop, validate(sop, 'id'), {skeleton: s, linked: 'model'});
}

/** The strategy object of the request parser (lib/formalize/strategies.mjs `localStrategy`). */
export function dependencyScaffold({tier, client, parse = text => serviceCall('parse', 'spacy', {text}), tierReadiness = null}) {
  return {
    name: 'DependencyScaffold', tier, ladder: [tier], tag: `tier:${tier}@pworker#DependencyScaffold`, server: {stop: async () => {}},
    availability: async firstTier => tierReadiness ? tierReadiness(firstTier ?? tier) : {available: true, models: [tier], skipped: []},
    async run({message, lexicon, circuits = [], repo = null, session = null, firstTier = null, retrieval = null, link = null}) {
      const t0 = Date.now(), steps = [];
      let tokens;
      try { tokens = (await parse(message)).tokens; } catch (e) { return {ok: false, status: 'failed', reason: e.message, steps, ms: Date.now() - t0}; }
      const s = skeletonOf(tokens);
      steps.push({name: 'skeleton', answer: s ? JSON.stringify(s) : 'none'});
      return skeletonCircuit(s, {message, lexicon, circuits, repo, session, retrieval, link, client, tier: firstTier ?? tier, steps, t0});
    },
  };
}
