/**
 * The English answer of a query result packet, written from the packet by fixed templates (no model, DS014 "Answer rendering"):
 *   wh-question   the answer values with readable labels ("Answer: Paris."; several values as a list; a count with "at least" when incomplete),
 *   yes/no        "Yes." / "No." / "I don't know." with the reason,
 *   evidence      a short justification: each supporting fact as a sentence with its source, the rule that derived it, and an origin label
 *                 (stated in this conversation / assumed / definition / memory),
 *   incomplete    one line saying the search was not exhaustive.
 * Every sentence comes from the `line` replies of the conversation layer (sop/replies.mjs, config/knowledge/conversation-v1/0040-answer-lines.sop):
 * this module chooses the line from the structure of the packet and fills its slots; the English inflection of relation phrases
 * (conjugate) stays here as grammar, not phrasing. The structured packet is never changed; `renderAnswer` returns null for a packet it does not cover (the caller keeps its generic lines).
 * Labels and relation phrases come from the lexicon when it is given (entity labels; the English lexemes of the predicate), otherwise
 * from the identifier ("computer_scientist" becomes "computer scientist"; entities are capitalized, classes are not).
 */
import {formatTime} from '../lib/time.mjs';
import {line, joinList} from './replies.mjs';

const CLASS_RELATIONS = new Set(['is_a', 'has_occupation', 'instance_of', 'subclass_of', 'type_of']);
const COVERED = new Set(['supported', 'refuted', 'both', 'unknown', 'incomplete', 'mixed_temporal']);
const SHOWN = 8, ROOTS = 4;
const CONNECTIVES = new Set(['of', 'the', 'and', 'de', 'la', 'von', 'van', 'in', 'on', 'for', 'del', 'da', 'di']);
const ident = value => typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value);
const capital = text => text.charAt(0).toUpperCase() + text.slice(1);

/** The reasoning modes a model query may ask on the product path (DS006 R1), answered from their own packet fields. */
const WORK_MODES = new Set(['why_not', 'abduce', 'effect']);
const workPacket = packet => WORK_MODES.has(packet?.query?.mode) && (Array.isArray(packet.missing) || Array.isArray(packet.explanations) || Array.isArray(packet.effects));
/** An explanation (mode explain) of the chat path: the packet names the rules it used (`rules_used`), so the renderer covers it. */
const explainPacket = packet => packet?.query?.mode === 'explain' && Array.isArray(packet.rules_used) && Array.isArray(packet.used);

/** Whether `renderAnswer` covers this packet. */
export function renderable(packet) {
  if (!packet || packet.status === 'clarify') return Boolean(packet?.text);
  if (workPacket(packet)) return ['supported', 'refuted', 'both', 'unknown', 'hypotheses'].includes(packet.status);
  const knowledge = Array.isArray(packet.rows) || packet.count !== undefined || packet.at_least !== undefined || packet.bound === 'at_least' || Array.isArray(packet.used);
  return Boolean(COVERED.has(packet.status) && (knowledge || packet.query && Array.isArray(packet.answers))
    && !['every', 'explain', 'constraint'].includes(packet.kind)
    && (packet.query?.mode !== 'every' && (packet.query?.mode !== 'explain' || explainPacket(packet)))
    && !packet.patterns && !packet.mappings && !packet.explanations && !packet.plan && !packet.candidates && !packet.whatif && packet.objective === undefined);
}

function labeller(packet, lexicon) {
  const classes = new Set();
  for (const p of Array.isArray(packet.proof) ? packet.proof : []) if (CLASS_RELATIONS.has(p.atom?.p)) for (const t of p.atom.a.slice(1)) classes.add(t);
  return value => {
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string') return JSON.stringify(value);
    if (!ident(value)) return value;
    const known = lexicon?.entities?.[value]?.labels?.en;
    if (known) return known;
    // A conversation entity (`local_maria`, introduced by a user statement) is shown as the user wrote the name.
    const local = value.startsWith('local_');
    const words = value.replace(/^local_/, '').split('_').join(' ');
    if (local) return words.replace(/(^|\s)(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
    return classes.has(value) || lexicon?.classes?.[value] ? words : words.replace(/(^|\s)(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
  };
}

/** Present-tense forms of a relation phrase ("be the capital of" -> "is the capital of"; "live in" -> "lives in"; negated: "is not ...", "does not live in"). */
function conjugate(base, negative) {
  const [first, ...rest] = base.split(/\s+/);
  const tail = rest.join(' ');
  if (first === 'be') {
    const past = rest[0] === 'born';
    return `${past ? 'was' : 'is'}${negative ? ' not' : ''}${tail ? ' ' + tail : ''}`;
  }
  // A modal verb ("can do") does not inflect; its negation is "cannot".
  if (/^(?:can|could|may|might|must|shall|should|will|would)$/.test(first)) return negative ? `${first === 'can' ? 'cannot' : first + ' not'}${tail ? ' ' + tail : ''}` : base;
  // A lexeme may be written as a participle ("located in") or in the third person ("works at"): both are recognised.
  if (/(?:ed|wn)$/.test(first) && first.length > 4) return `${negative ? 'is not' : 'is'} ${base}`;
  if (/[^s]s$/.test(first) && !['has', 'does', 'is'].includes(first)) return negative ? `does not ${first.replace(/ies$/, 'y').replace(/(?:sh|ch|x|z|o)es$/, m => m.slice(0, -2)).replace(/s$/, '')}${tail ? ' ' + tail : ''}` : base;
  if (negative) return `does not ${base}`;
  const third = first === 'have' ? 'has' : /(?:s|sh|ch|x|z|o)$/.test(first) ? first + 'es' : /[^aeiou]y$/.test(first) ? first.slice(0, -1) + 'ies' : first + 's';
  return `${third}${tail ? ' ' + tail : ''}`;
}

function phraseOf(predicate, lexicon) {
  const p = lexicon?.predicates?.[predicate];
  const lexemes = (p?.lexemes ?? []).filter(l => l.language === 'en' && !l.converse && l.pos !== 'noun');
  const lexeme = lexemes.find(l => l.pos === 'copula') ?? lexemes[0];
  if (lexeme?.forms?.[0]) return lexeme.forms[0];
  const label = p?.labels?.en ?? predicate.split('_').join(' ');
  // Without a lexeme the phrase is read from the identifier: a noun before a preposition ("capital of") takes "is the"; a participle ("born in") takes "is".
  const words = label.split(/\s+/);
  if (/^(?:of|in|at|to|by|from|on|for|with)$/.test(words.at(-1)) && words.length > 1 && !/(?:s|ed|wn|rn)$/.test(words[0])) return `be the ${label}`;
  if (/(?:ed|wn|rn)$/.test(words[0]) && words.length > 1) return `be ${label}`;
  return label;
}
/** The origin label of a supporting fact (a `line_origin_*` reply). */
const originOf = proof => line('origin_' + originKey(proof));
function originKey(proof) {
  if (proof.origin === 'conversation') return proof.kind === 'assumption' || proof.kind === 'assumed' ? 'supposed' : 'stated';
  if (proof.origin === 'coding_agent') return proof.kind === 'assumption' || proof.kind === 'assumed' ? 'agent_assumption' : 'agent_definition';
  if (proof.origin === 'memory') return 'memory';
  if (proof.source === 'user' || /^user\b/.test(String(proof.source ?? ''))) return 'stated';
  if (proof.kind === 'assumed' || proof.assumed) return 'assumed';
  if (/class hierarchy|definition|^core-/i.test(String(proof.source ?? ''))) return 'definition';
  return 'memory';
}

/** One fact as a sentence without the final stop: "Paris is the capital of France". */
function factText(atom, label, lexicon) {
  const [subject, ...others] = atom.a;
  const predicate = lexicon?.predicates?.[atom.p];
  if (!atom.a.length) return line(atom.neg ? 'proposition_not_holds' : 'proposition_holds', {relation: predicate?.labels?.en ?? atom.p.split('_').join(' ')});
  if (!others.length && !(predicate?.lexemes ?? []).some(l => l.language === 'en' && !l.converse && l.pos !== 'noun')) {
    const name = predicate?.labels?.en ?? atom.p.split('_').join(' ');
    return line(atom.neg ? 'relation_not_holds' : 'relation_holds', {relation: name, subject: label(subject)});
  }
  const objects = others.map(label);
  let phrase = conjugate(phraseOf(atom.p, lexicon), Boolean(atom.neg));
  // An indefinite article closing the lexeme ("be a") agrees with the next word: "is an entity", "is a person".
  if (/ an?$/.test(phrase) && objects[0]) phrase = phrase.replace(/ an?$/, /^[aeiou]/i.test(objects[0]) ? ' an' : ' a');
  return [label(subject), phrase, ...objects].join(' ');
}

function justification(packet, shown, label, lexicon) {
  const proofs = packet.proof ?? [];
  const origins = new Map((packet.origins ?? []).map(o => [o.id, o]));
  if (!proofs.length) return [];
  const byId = new Map(proofs.map(p => [p.id, p]));
  const referenced = new Set(proofs.flatMap(p => p.from ?? []));
  const wanted = new Set(shown.map(String));
  let roots = proofs.filter(p => !referenced.has(p.id));
  if (wanted.size) {
    const matching = roots.filter(p => p.atom.a.some(t => wanted.has(String(t))));
    if (matching.length) roots = matching;
  }
  const during = Boolean(packet.query?.during);
  const when = p => (during && p.valid ? line('valid_period', {from: formatTime(p.valid.from), until: p.valid.until == null ? line('valid_now') : formatTime(p.valid.until)}) : '');
  const sourced = p => {
    const tagged = origins.get(p.id) ?? origins.get(p.source?.id);
    const origin = tagged ? originOf(tagged) : originOf(p);
    const source = p.source && p.source !== 'user' && typeof p.source === 'string' ? p.source : null;
    return line(source ? 'fact_sourced_source' : 'fact_sourced', {fact: factText(p.atom, label, lexicon), origin, source, valid: when(p)});
  };
  const lines = [];
  for (const root of roots.slice(0, ROOTS)) {
    if (root.kind === 'derived') {
      const parts = (root.from ?? []).map(id => byId.get(id)).filter(Boolean).map(sourced);
      const rule = String(root.rule ?? '').replace(/^r_/, '').split('_').join(' ');
      lines.push(line('derived_because', {fact: capital(factText(root.atom, label, lexicon)), premises: parts.length ? joinPremises(parts) : line('derived_support'), rule: rule ? line('derived_by_rule', {rule}) : ''}));
    } else lines.push(line('fact_line', {fact: capital(sourced(root))}));
  }
  if (roots.length > ROOTS) lines.push(line('more_facts', {count: roots.length - ROOTS}));
  return lines;
}

/** A ground or open atom written in the oracle's text form (`not p a "b" 3`): structure only, the SOP term syntax. */
function textAtom(text) {
  const tokens = String(text).match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
  const neg = tokens[0] === 'not';
  const [p, ...terms] = neg ? tokens.slice(1) : tokens;
  return {p, a: terms.map(t => t.startsWith('"') ? JSON.parse(t) : /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : t), neg};
}

const orList = items => items.length < 2 ? items[0] ?? '' : line('list_or', {first: items.slice(0, -1).join(line('list_separator')), last: items.at(-1)});

/** The rules an explanation used (`rules_used`, DS006 "Result packet"): one line each, with its conditions and its conclusion. */
function rulesUsed(packet, label, lexicon) {
  const part = c => c.atom ? factText(c.atom, label, lexicon) : c.text;
  return (packet.rules_used ?? []).map(r => {
    const slots = {rule: r.id, conditions: joinPremises((r.conditions ?? []).map(part).concat(r.conditions?.length ? [] : [line('derived_support')])), conclusion: factText(r.conclusion, label, lexicon)};
    return r.exceptions?.length ? line('default_used', {...slots, exceptions: orList(r.exceptions.map(part))}) : line('rule_used', slots);
  });
}

/**
 * A candidate of mode effect or abduce (Q-LANG-10) as the packet describes it (`lib/query-author/runtime.mjs`): a supposed statement is its
 * fact, a session rule is named with its conditions and conclusion.
 */
function candidateText(d, label, lexicon) {
  if (d?.kind === 'fact' && d.atom) return factText(d.atom, label, lexicon);
  const r = d?.rule;
  if (!r) return d?.id ?? '';
  const part = c => c.atom ? factText(c.atom, label, lexicon) : c.text;
  return line('candidate_rule', {rule: r.id, conditions: joinPremises((r.conditions ?? []).map(part)), conclusion: factText(r.conclusion, label, lexicon)});
}

/**
 * why_not, abduce and effect (DS006 R1, the oracle's packet fields): why_not names the minimal sets of missing base facts that would make the
 * claim follow and the facts that block it; abduce names the minimal consistent explanations and the candidates rejected because they
 * contradict an admitted fact (over the query's candidates also those every explanation needs); effect says what the claim is without the
 * candidates and what each candidate does to it.
 */
function workAnswer(packet, label, lexicon) {
  const facts = atoms => joinPremises(atoms.map(text => factText(textAtom(text), label, lexicon)));
  const lines = [];
  const described = list => joinPremises(list.map(d => candidateText(d, label, lexicon)));
  if (packet.query.mode === 'effect') {
    lines.push(line('effect_baseline_' + (['supported', 'refuted', 'both'].includes(packet.status) ? packet.status : 'unknown')));
    for (const e of packet.effects.slice(0, SHOWN)) {
      const candidate = candidateText(e.described ?? {id: e.candidate}, label, lexicon);
      if (!e.effect) lines.push(line('effect_unfinished', {candidate}));
      else if (e.effect === 'inconsistent') lines.push(line('effect_inconsistent', {candidate, contradicts: joinList((e.contradicts ?? []).map(text => factText(textAtom(text), label, lexicon)))}));
      else lines.push(line('effect_' + e.effect, {candidate}));
    }
  } else if (packet.query.mode === 'why_not') {
    if (packet.status === 'supported' || packet.status === 'both') lines.push(line('why_not_holds'));
    else if (packet.missing.length) for (const set of packet.missing.slice(0, ROOTS)) lines.push(line('why_not_missing', {facts: facts(set)}));
    else lines.push(line('why_not_nothing'));
    for (const b of (packet.blockers ?? []).slice(0, ROOTS)) lines.push(line('why_not_blocked', {fact: factText(textAtom(b.atom), label, lexicon)}));
  } else {
    const explanations = packet.explanations ?? [];
    // over the query's candidates an explanation is a set of candidates (statements or rules), described by the packet
    const over = e => (e.candidates ? described(e.candidates) : facts(e.atoms));
    if (explanations.length === 1 && !(explanations[0].candidates ?? explanations[0].atoms).length) lines.push(line('abduce_already'));
    else if (explanations.length) for (const e of explanations.slice(0, ROOTS)) lines.push(line('abduce_explanation', {facts: over(e)}));
    else lines.push(line(packet.inconsistent?.length ? 'abduce_none_consistent' : 'abduce_none'));
    for (const e of (packet.inconsistent ?? []).slice(0, ROOTS)) lines.push(line('abduce_inconsistent', {facts: over(e), contradicts: joinList(e.contradicts.map(text => factText(textAtom(text), label, lexicon)))}));
    const necessary = (packet.necessary ?? []).map(id => (packet.candidates ?? []).find(d => d.id === id) ?? {id});
    if (necessary.length && explanations.length && (explanations[0].candidates ?? explanations[0].atoms).length) lines.push(line('abduce_necessary', {candidates: described(necessary)}));
  }
  if (packet.complete === false) lines.push(line('not_exhaustive'));
  return lines.join('\n');
}

/** Remove a class that another listed class already implies (the answers "person" and "entity" give only "person"). */
function mostSpecific(values, packet) {
  const names = new Set(values.filter(ident));
  const implied = new Set();
  const byId = new Map((packet.proof ?? []).map(p => [p.id, p]));
  for (const p of packet.proof ?? []) {
    if (p.kind !== 'derived' || !CLASS_RELATIONS.has(p.atom?.p) || !names.has(p.atom.a[1])) continue;
    for (const id of p.from ?? []) {
      const parent = byId.get(id);
      if (parent && CLASS_RELATIONS.has(parent.atom?.p) && parent.atom.a.length === 2 && names.has(parent.atom.a[0]) && parent.atom.a[1] === p.atom.a[1]) implied.add(p.atom.a[1]);
    }
  }
  return values.filter(v => !implied.has(v));
}

const list = items => joinList(items);
/** Premises are joined by the conjunction alone ("a and b and c"), as the derivation reads. */
const joinPremises = parts => parts.reduce((left, right) => line('list_and', {first: left, last: right}));

/** The answer values: one, a list, or the first SHOWN and how many more. */
const answerLine = (items, shown) => items.length === 1 ? line('answer_one', {items: items[0]})
  : items.length > SHOWN ? line('answer_many_more', {items: shown.join(line('list_separator')), more: items.length - SHOWN}) : line('answer_many', {items: list(shown)});

/** Wire packets carry a sufficient support set, not the typed runtime's prose-ready fact proof. */
function wireSources(packet) {
  const byId = new Map((packet.origins ?? []).map(o => [o.id, o]));
  const nodes = packet.proof?.nodes ?? [];
  const byNode = new Map(nodes.map(n => [n.id, n]));
  const bySource = new Map(nodes.filter(n => n.source?.id).map(n => [n.source.id, n]));
  const evidence = [];
  if (!Array.isArray(packet.used)) {
    const visited = new Set();
    const visit = id => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = byNode.get(id);
      if (!node) return;
      if (node.source?.id) evidence.push(node.source);
      for (const premise of node.premises ?? []) visit(premise);
    };
    for (const root of packet.proof?.roots ?? []) visit(root);
  }
  const steps = Array.isArray(packet.used) ? packet.used : evidence;
  const seen = new Set();
  const labels = [];
  for (const step of steps) {
    const id = step?.id;
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const entry = byId.get(id) ?? bySource.get(id) ?? {};
    const origin = originOf(entry);
    labels.push(line('source_item', {origin, id}));
  }
  return labels.length ? [line('sources_used', {items: list(labels)})] : [];
}

/**
 * A sample of one relation ("a random fact", "some examples": `order random` over one match whose places are all selected): each answer
 * row is the fact itself, written as a sentence. Null for any other packet.
 */
function sampledFacts(packet, label, lexicon) {
  const where = packet.query?.where;
  if (!packet.sample || !Array.isArray(where) || where.length !== 1 || !where[0]?.p || !Array.isArray(packet.rows) || !packet.rows.length) return null;
  const atom = where[0];
  if (!atom.a.every(t => typeof t !== 'string' || !t.startsWith('?') || packet.rows.every(r => r[t.slice(1)] !== undefined))) return null;
  return packet.rows.map(row => line('fact_line', {fact: capital(factText({p: atom.p, a: atom.a.map(t => typeof t === 'string' && t.startsWith('?') ? row[t.slice(1)] : t), neg: Boolean(atom.neg)}, label, lexicon))}));
}

function wireAnswer(packet, label, lexicon) {
  const lines = [];
  const sampled = sampledFacts(packet, label, lexicon);
  // The sources of a sample are the sampled facts themselves (the packet's evidence covers the whole answer set): the line says how it was drawn.
  if (sampled) return [...sampled, line('sample_note', {count: sampled.length, of: packet.sample.of})].join('\n');
  const mode = packet.kind === 'count' || packet.query?.mode === 'count' || packet.count !== undefined || packet.at_least !== undefined || packet.bound === 'at_least'
    ? 'count' : packet.query?.mode ?? (Array.isArray(packet.rows) ? 'select' : 'exists');
  const incomplete = packet.complete === false || packet.status === 'incomplete';
  const supported = packet.status === 'supported' || packet.status === 'both';
  if (mode === 'count') {
    const lower = packet.at_least ?? packet.count;
    if (packet.at_least !== undefined || packet.bound === 'at_least' || incomplete) {
      if (lower !== undefined) lines.push(line(incomplete ? 'count_at_least_incomplete' : 'count_at_least_open', {count: lower}));
      else lines.push(line('count_unknown_incomplete'));
    } else if (packet.status === 'unknown') lines.push(line('count_undecided'));
    else if (packet.count !== undefined) lines.push(line('count', {count: packet.count}));
    else lines.push(line('count_undecided'));
  } else if (mode === 'select') {
    const rows = packet.rows ?? (packet.answers ?? []).map(a => a.binding).filter(Boolean);
    const seen = new Set();
    const items = rows.map(row => Object.values(row).map(label).join(' / ')).filter(text => text && !seen.has(text) && seen.add(text));
    const shown = items.slice(0, SHOWN);
    if (items.length) lines.push(answerLine(items, shown));
    else if (incomplete) lines.push(line('stopped'));
    else if (packet.status === 'unknown') lines.push(line('undecided'));
    else lines.push(line('no_answers'));
    if (packet.status === 'both' && items.length) lines.push(line('conflicting'));
    if (incomplete && items.length) lines.push(line('more_may_exist'));
  } else {
    if (packet.status === 'unknown') lines.push(line('undecided'));
    else if (packet.status === 'incomplete') lines.push(line('stopped'));
    else if (packet.status === 'refuted') lines.push(line('no'));
    else if (packet.status === 'both') lines.push(line('both'));
    else if (packet.status === 'mixed_temporal') lines.push(line('mixed_temporal'));
    else lines.push(line('yes'));
    if (incomplete && supported) lines.push(line('not_exhaustive'));
  }
  if (supported || packet.status === 'refuted') {
    if (Array.isArray(packet.proof)) lines.push(...justification(packet, [], label, lexicon));
    if (mode === 'explain') lines.push(...rulesUsed(packet, label, lexicon));
    lines.push(...wireSources(packet));
  }
  return lines.join('\n');
}

/** One fact as a sentence with its final stop ("Paris is the capital of France."), labels from the lexicon. */
export function factSentence(atom, {lexicon = null} = {}) {
  return line('fact_line', {fact: capital(factText(atom, labeller({}, lexicon), lexicon))});
}

/** The natural English answer for a covered packet, or null. `options.lexicon`: entity labels and relation phrases. */
export function renderAnswer(packet, {lexicon = null} = {}) {
  if (!renderable(packet)) return null;
  if (packet.status === 'clarify') return packet.text;
  const label = labeller(packet, lexicon);
  if (workPacket(packet)) return workAnswer(packet, label, lexicon);
  if (Array.isArray(packet.rows) || packet.count !== undefined || packet.at_least !== undefined || packet.bound === 'at_least' || (Array.isArray(packet.used) && !Array.isArray(packet.answers))) return wireAnswer(packet, label, lexicon);
  const lines = [];
  const incomplete = packet.complete === false;
  if (packet.hypothetical) lines.push(line('hypothetical'));
  if (packet.kind === 'count') {
    if (packet.at_least !== undefined || (incomplete && packet.count !== undefined)) lines.push(line('count_at_least_incomplete', {count: packet.at_least ?? packet.count}));
    else if (packet.count !== undefined && packet.status === 'supported') lines.push(line('count', {count: packet.count}));
    else lines.push(line('count_undecided'));
    if (packet.origins && packet.used) lines.push(...wireSources(packet));
    return lines.join('\n');
  }
  const rows = packet.answers.filter(r => r && r.binding);
  const valued = rows.filter(r => Object.keys(r.binding).length);
  const supported = packet.status === 'supported' || packet.status === 'both' || packet.status === 'mixed_temporal';
  if (!valued.length) {
    if (packet.query?.select?.length && !rows.some(r => Object.keys(r.binding).length === 0)) {
      if (incomplete || packet.status === 'incomplete') lines.push(line('stopped'));
      else if (packet.status === 'unknown') lines.push(line('undecided'));
      else lines.push(line('no_answers'));
      return lines.join('\n');
    }
    if (packet.status === 'unknown') lines.push(line('undecided'));
    else if (packet.status === 'incomplete') lines.push(line('stopped'));
    else if (packet.status === 'refuted') lines.push(line('no'));
    else if (packet.status === 'both') lines.push(line('both'));
    else if (packet.status === 'mixed_temporal') lines.push(line('mixed_temporal'));
    else lines.push(line('yes'));
    if (supported || packet.status === 'refuted') lines.push(...justification(packet, [], label, lexicon));
    if ((supported || packet.status === 'refuted') && explainPacket(packet)) lines.push(...rulesUsed(packet, label, lexicon));
    if ((supported || packet.status === 'refuted') && packet.origins && Array.isArray(packet.used)) lines.push(...wireSources(packet));
    if (incomplete && packet.status !== 'incomplete' && packet.status !== 'unknown' && packet.status !== 'refuted' && !supported) lines.push(line('not_exhaustive'));
    return lines.join('\n');
  }
  const single = valued.every(r => Object.keys(r.binding).length === 1);
  let items = valued.map(r => ({raw: single ? Object.values(r.binding)[0] : null, text: Object.values(r.binding).map(label).join(' / ')}));
  if (single) {
    const kept = new Set(mostSpecific(items.map(i => i.raw), packet));
    items = items.filter(i => kept.has(i.raw));
  }
  const seen = new Set();
  items = items.filter(i => !seen.has(i.text) && seen.add(i.text));
  // A value that is not an identifier (a description from the memory) is quoted as a description, not listed as a name.
  const isFree = i => typeof i.raw === 'string' && !ident(i.raw) && (/[()]/.test(i.raw) || i.raw.split(/\s+/).length >= 4 || i.raw.split(/\s+/).some(w => /^\p{Ll}/u.test(w) && !CONNECTIVES.has(w)));
  const free = items.filter(isFree).map(i => i.text);
  const names = items.filter(i => !isFree(i)).map(i => i.text);
  const shown = names.slice(0, SHOWN);
  if (names.length) lines.push(answerLine(names, shown));
  for (const text of free.slice(0, 2)) lines.push(line('described', {text}));
  if (packet.status === 'refuted') lines.push(line('contradicted'));
  const values = items.filter(i => i.raw !== null).map(i => i.raw);
  lines.push(...justification(packet, values.length ? values : valued.flatMap(r => Object.values(r.binding)), label, lexicon));
  if (packet.origins && Array.isArray(packet.used)) lines.push(...wireSources(packet));
  if (incomplete) lines.push(line('more_may_exist'));
  return lines.join('\n');
}
