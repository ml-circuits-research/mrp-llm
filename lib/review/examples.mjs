/**
 * Effect, not syntax (DS022 "Knowledge browser"): what a vocabulary item does, shown as sentences.
 *
 *   formSentence   a generated English sentence for one lexeme form ("Ana works at Alfa Corp") and the atom it maps to
 *                  (`works_at ana alfa_corp`), with the predicates the memory's lexicon links the phrase to (more than one is a
 *                  shared form the KnowledgeLinker must disambiguate by the classes of the entities)
 *   sayAtom        a fact in words, through the first English lexeme of its predicate ("Heidelberg is located in Germany")
 *   ruleExample    a derivation of a rule over the memory's own facts (a bounded join of keyed lookups), or, when the memory holds no
 *                  matching facts, over placeholder names, labelled hypothetical
 *
 * Generated sentences are illustrations of the vocabulary, never knowledge. Fillers are real facts of the memory when it has some
 * for the predicate, else placeholder names chosen by the class of each role.
 */
import {tokens} from '../../sop/knowledge/lexical.mjs';
import {parseCondition} from '../../sop/knowledge/index.mjs';
import {phraseKey} from '../../sop/text-keys.mjs';
import {termValue} from '../../reasoning/slice/index.mjs';

const PLACEHOLDERS = {
  person: ['Ana', 'Mihai'], organization: ['Alfa Corp', 'Beta Labs'], company: ['Alfa Corp', 'Beta Labs'], university: ['Northfield University', 'Lakeside College'],
  place: ['Cluj', 'Lyon'], city: ['Cluj', 'Lyon'], country: ['Norway', 'Chile'], continent: ['Europe', 'Asia'], occupation: ['teacher', 'nurse'],
  language: ['Spanish', 'Finnish'], currency: ['the euro', 'the yen'], time: ['2020', '2021'], integer: ['42', '7'], text: ['blue', 'Fe'], value: ['10', '3'],
};
const placeholder = (type, i) => (PLACEHOLDERS[type] ?? (!type || type === 'entity' ? ['X', 'Y'] : [`the ${String(type).replace(/_/g, ' ')} A`, `the ${String(type).replace(/_/g, ' ')} B`]))[i % 2];
const symbolOf = text => String(text).toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

/** Third person singular of the first word of a verb phrase. */
export function inflect(phrase) {
  const [head, ...rest] = String(phrase).split(' ');
  const irregular = {be: 'is', have: 'has', do: 'does', go: 'goes'};
  const third = irregular[head] ?? (/(s|sh|ch|x|z|o)$/.test(head) ? head + 'es' : /[^aeiou]y$/.test(head) ? head.slice(0, -1) + 'ies' : head + 's');
  return [third, ...rest].join(' ');
}

/** The sentence pattern of a lexeme form: subject, verb phrase, object, then any further role as a trailing "(role value)". */
function sentence(pos, form, names) {
  const [first, second, ...more] = names;
  const verb = pos === 'noun' ? `is the ${form}` : pos === 'adj' || pos === 'prep' ? `is ${form}` : inflect(form);
  const tail = more.map(m => `(${m.role} ${m.text})`).join(' ');
  return [first?.text ?? '?', verb, second?.text ?? '', tail].filter(Boolean).join(' ').replace(/\s+/g, ' ').replace(/\b(is|be) a (?=[aeiou])/gi, '$1 an ');
}

/** The label of an entity symbol in the lexicon (or the value as it is). */
export function labelOf(lexicon, value) {
  if (typeof value !== 'string') return String(value);
  return lexicon?.entities?.[value]?.labels?.en ?? value;
}

/**
 * A generated sentence for one form. `fillers` (optional) maps role name -> {symbol, text} from a real fact; otherwise placeholders
 * by role class are used. Returns {sentence, atom, links, real}.
 */
export function formSentence({lexicon, predicate, lexeme, form, fillers = null}) {
  const roles = predicate.roles?.length ? predicate.roles : (predicate.args ?? []).map((type, i) => ({name: ['subject', 'object'][i] ?? `arg${i}`, type}));
  const frame = lexeme.frame?.length ? lexeme.frame : roles.map(r => r.name);
  const filled = new Map(roles.map((r, i) => {
    const real = fillers?.[r.name];
    const text = real?.text ?? placeholder(r.type, i);
    return [r.name, {role: r.name, text, symbol: real?.symbol ?? (['integer', 'time', 'value'].includes(r.type) ? text : r.type === 'text' ? JSON.stringify(text) : symbolOf(text))}];
  }));
  const names = frame.map(name => filled.get(name) ?? {role: name, text: '?'});
  const text = sentence(lexeme.pos, form, names);
  const atom = `${predicate.id} ${roles.map(r => filled.get(r.name)?.symbol ?? '?').join(' ')}`;
  const links = [...new Set((lexicon?.formsByKey?.get(phraseKey(form)) ?? []).map(x => x.predicate))];
  return {sentence: text, atom, links, real: Boolean(fillers)};
}

/** Fillers for a predicate from one real fact of the memory: {role: {symbol, text}}. */
export function fillersFromFact(lexicon, predicate, atom) {
  const roles = predicate.roles?.length ? predicate.roles : (predicate.args ?? []).map((type, i) => ({name: ['subject', 'object'][i] ?? `arg${i}`, type}));
  return Object.fromEntries(roles.map((r, i) => [r.name, {symbol: typeof atom.a[i] === 'string' && !/\s/.test(atom.a[i]) ? atom.a[i] : JSON.stringify(atom.a[i]), text: labelOf(lexicon, atom.a[i])}]));
}

/** A fact in words through the first English, non-converse lexeme of its predicate; falls back to `p(a, b)` with labels. */
export function sayAtom(lexicon, atom) {
  const predicate = lexicon?.predicates?.[atom.p];
  const args = atom.a.map(v => labelOf(lexicon, v));
  const lexeme = predicate?.lexemes?.find(l => l.language === 'en' && !l.converse && l.forms.length) ?? predicate?.lexemes?.find(l => l.language === 'en' && l.forms.length);
  if (!predicate || !lexeme) return `${atom.neg ? 'not ' : ''}${atom.p}(${args.join(', ')})`;
  const roles = predicate.roles?.length ? predicate.roles.map(r => r.name) : args.map((_, i) => ['subject', 'object'][i] ?? `arg${i}`);
  const byRole = new Map(roles.map((name, i) => [name, {role: name, text: args[i] ?? '?'}]));
  const frame = lexeme.frame?.length ? lexeme.frame : roles;
  const text = sentence(lexeme.pos, lexeme.forms[0], frame.map(n => byRole.get(n) ?? {role: n, text: '?'}));
  return atom.neg ? `It is not the case that ${text}` : text;
}

/** The positive atoms of a rule body and its head ({p, a}); `extra` counts the conditions a preview join does not evaluate. */
export function ruleShape(wire) {
  const body = [];
  let extra = 0;
  const visit = node => {
    if (!node) return;
    if (node.children) return node.children.forEach(visit);
    if (node.kind === 'atom' && node.neg === 'none') body.push({p: node.p, a: node.terms.map(termValue)});
    else extra++;
  };
  for (const key of ['when', 'over', 'never']) for (const f of wire.fields.filter(x => x.key === key)) visit(parseCondition(f, []));
  extra += wire.fields.filter(x => x.key === 'except').length;
  const headText = wire.fields.find(f => ['then', 'yields'].includes(f.key))?.value;
  const t = headText ? tokens(headText) : [];
  const neg = t[0] === 'not';
  const head = t.length ? {p: t[neg ? 1 : 0], a: t.slice(neg ? 2 : 1).map(termValue), neg} : null;
  return {body, head, extra};
}

const isVar = v => typeof v === 'string' && v.startsWith('?');
const subst = (atom, b) => ({...atom, a: atom.a.map(v => (isVar(v) && b[v] !== undefined ? b[v] : v))});

/**
 * An example derivation of a rule. With `recall(atom, limit)` (keyed lookups of the memory) it joins the body atoms in order and
 * returns up to `max` real derivations; otherwise (or when none is found) one hypothetical derivation over placeholder names.
 * Returns {real: [{facts: [atom], head: atom}], hypothetical: {facts, head} | null, partial: bool, note}.
 */
export function ruleExample(wire, {lexicon = null, recall = null, max = 2, maxLookups = 60} = {}) {
  const {body, head, extra} = ruleShape(wire);
  const out = {real: [], hypothetical: null, partial: extra > 0, note: extra ? `${extra} condition(s) other than plain relations (comparisons, negations, exceptions) are not checked by this preview; the oracle's derive applies them.` : null};
  if (!head || !body.length) return out;
  let lookups = 0;
  const join = (i, binding, used) => {
    if (out.real.length >= max || lookups >= maxLookups) return;
    if (i === body.length) { out.real.push({facts: used, head: subst(head, binding)}); return; }
    const pattern = subst(body[i], binding);
    lookups++;
    const rows = recall(pattern, 8);
    for (const row of rows) {
      const b = {...binding};
      let ok = true;
      pattern.a.forEach((v, j) => { if (isVar(v)) { if (b[v] !== undefined && b[v] !== row.a[j]) ok = false; else b[v] = row.a[j]; } });
      if (ok) join(i + 1, b, [...used, {p: pattern.p, a: row.a, neg: false}]);
      if (out.real.length >= max) return;
    }
  };
  if (recall) join(0, {}, []);
  if (!out.real.length) {
    const types = new Map();
    for (const atom of [...body, head]) {
      const roles = lexicon?.predicates?.[atom.p]?.roles ?? [];
      atom.a.forEach((v, j) => { if (isVar(v) && !types.has(v)) types.set(v, roles[j]?.type ?? 'entity'); });
    }
    const seen = new Map();
    const binding = {};
    for (const [v, type] of types) { const n = seen.get(type) ?? 0; seen.set(type, n + 1); binding[v] = symbolOf(placeholder(type, n)); }
    out.hypothetical = {facts: body.map(a => subst(a, binding)), head: subst(head, binding)};
  }
  return out;
}
