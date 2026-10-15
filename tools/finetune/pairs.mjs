#!/usr/bin/env node
/**
 * Training pairs of FineTunedSOP (DS028 "Routed formalizers"): (prompt, circuit) built from the facts of a base memory, with exact gold.
 * For every binary fact and every phrase of its predicate (label and lexeme forms, converse lexemes with their roles swapped) the
 * templates write questions (who/what, the reverse, yes/no) and their circuit (one `match` block naming the predicate id); the prompt is
 * the compact one the strategy sends at inference (lib/formalize/finetuned.mjs `finetunedPrompt`): the candidate predicates of the
 * question with their roles, then the question. A tenth of the pairs ask about a phrase no candidate expresses and teach the answer
 * `unclear kind relation_not_in_memory`. Counts (`mode count`), chains of two facts through a shared entity (`where all`, two `match`
 * blocks) and requests that are no question (`unclear kind no_request`) complete the shapes. Every circuit passes the validator of the
 * request parser.
 *
 *   node tools/finetune/pairs.mjs --memory commonsense-v1 --out state/finetune/train.jsonl [--per-predicate 8] [--max 4000]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openSession} from '../eval/lib/session.mjs';
import {CHAT_ROOT, prepareRoot} from '../eval/mrp/formalize.mjs';
import {factsOf} from '../../lib/mrp/retrieve.mjs';
import {validateQuery} from '../../lib/query-author/validate.mjs';
import {finetunedPrompt, finetunedCandidates} from '../../lib/formalize/finetuned.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The third person of a lemma phrase: leading adverbs kept as they are, the first verb conjugated (work at -> works at).
const conj = form => form.replace(/^((?:\S+ly )*)(\S+)/, (_, adv, v) => adv + (/(s|sh|ch|x|z)$/.test(v) ? v + 'es' : /[^aeiou]y$/.test(v) ? v.slice(0, -1) + 'ies' : v === 'have' ? 'has' : v === 'can' ? 'can' : v + 's'));
const PARTICIPLE = /^(?:\S+ly )*(found|made|built|known|seen|born|used|located|owned|led|run|written|held|based|named|called|married|employed|related)\b/;
/** Invented names for the synthetic questions (none of them names an entity of the acme-demo test memory). */
const NAMES = ['Mira Holt', 'Teo Varga', 'Lina Sato', 'Omar Reyes', 'Ines Falk', 'Paul Dorn'], PLACES = ['Zentrix', 'Norvale', 'Kestrel Labs', 'Brightmoor', 'Ostrava Works', 'Lumen Corp'];
const quote = s => JSON.stringify(String(s));
const circuit = (id, roles, a, b, asked) => ['@q query', ...(asked ? ['  select ?x'] : []), '  where match', `    relation ${quote(id)}`,
  `    role ${roles[0]} ${a === '?x' ? '?x' : quote(a)}`, `    role ${roles[1]} ${b === '?x' ? '?x' : quote(b)}`, '    polarity affirmed', '  end'].join('\n') + '\n';

/** A `match` block (indented by `pad`) of `id` with the two roles bound to a constant or a variable. */
const match = (id, roles, a, b, pad) => [`${pad}match`, `${pad}  relation ${quote(id)}`, `${pad}  role ${roles[0]} ${a.startsWith('?') ? a : quote(a)}`,
  `${pad}  role ${roles[1]} ${b.startsWith('?') ? b : quote(b)}`, `${pad}  polarity affirmed`, `${pad}end`];
/** The relative clause of a phrase ("works at" -> "works at", "be located in" -> "is located in"). */
const clause = ({form, pos}) => /^(be|is|are) /.test(form) || pos === 'copula' || pos === 'noun' || PARTICIPLE.test(form) ? `is ${form.replace(/^(be|is|are) /, '')}` : conj(form);

/** A count: how many subjects stand in the relation to the object ("How many things work at X?", "How many things are located in X?"). */
export function countOf({id, roles, form, pos, b}) {
  const c = clause({form, pos}), q = c.startsWith('is ') ? `How many things are ${c.slice(3)} ${b}?` : `How many things ${form} ${b}?`;
  return {question: q, circuit: ['@q query', '  mode count', '  select ?x', '  where match', `    relation ${quote(id)}`, `    role ${roles[0]} ?x`, `    role ${roles[1]} ${quote(b)}`, '    polarity affirmed', '  end'].join('\n') + '\n'};
}

/** A chain of two facts p1(x, m), p2(m, c): "Who <p1> something that <p2> c?" asks x. */
export function chainOf(first, second, c) {
  return {question: `Who ${clause(first)} something that ${clause(second)} ${c}?`,
    circuit: ['@q query', '  select ?x', '  where all', ...match(first.id, first.roles, '?x', '?m', '    '), ...match(second.id, second.roles, '?m', c, '    '), '  end'].join('\n') + '\n'};
}

/** Requests that are no question about the memory. */
const NO_REQUEST = ['Write me a poem about {x}.', 'Tell me a joke about {x}.', 'Hello there!', 'Thanks, that was useful.', 'Can you sing a song about {x}?', 'Draw a picture of {x}.', 'Translate {x} into French.', 'Good morning!'];

/** The questions and circuits of one fact under one phrase. */
export function questionsOf({id, roles, form, pos, converse, a, b}) {
  const [s, o] = converse ? [b, a] : [a, b];
  const [rs, ro] = converse ? [roles[1], roles[0]] : roles;
  const cop = /^(be|is|are) /.test(form) || pos === 'copula' || pos === 'noun' || PARTICIPLE.test(form);
  const rest = form.replace(/^(be|is|are) /, '');
  const make = (q, subj, obj, asked) => ({question: q, circuit: circuit(id, [rs, ro], subj, obj, asked)});
  if (cop) return [make(`Who is ${rest} ${o}?`, '?x', o, true), make(`Is ${s} ${rest} ${o}?`, s, o, false)];
  const [verb, ...tail] = form.split(' ');
  return [make(`Who ${conj(form)} ${o}?`, '?x', o, true), make(`What does ${s} ${verb}${tail.length ? ' ' + tail.join(' ') : ''}?`, s, '?x', true), make(`Does ${s} ${form} ${o}?`, s, o, false)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const memory = opt('--memory', 'commonsense-v1'), out = path.resolve(ROOT, opt('--out', 'state/finetune/train.jsonl'));
  const perPredicate = Number(opt('--per-predicate', 8)), max = Number(opt('--max', 4000));
  prepareRoot();
  const session = openSession({base: memory, root: CHAT_ROOT, id: `pairs-${memory}`});
  const circuits = session.sessions.baseCircuits(session.id), lexicon = session.lexicon;
  // An entity without an English label is named by its id in words (dog, musical_instrument -> musical instrument).
  const label = id => lexicon.entities?.[id]?.labels?.en ?? (/^[a-z][a-z0-9_]*$/.test(id) ? id.replace(/_/g, ' ') : null);
  const byPredicate = new Map();
  for (const f of factsOf(circuits)) if (f.args.length === 2 && label(f.args[0]) && label(f.args[1])) { const l = byPredicate.get(f.p) ?? byPredicate.set(f.p, []).get(f.p); if (l.length < perPredicate) l.push(f); }
  const rows = [];
  let refused = 0;
  for (const [id, facts] of byPredicate) {
    const p = lexicon.predicates[id], roles = (p?.roles ?? []).map(r => r.name);
    if (!p || roles.length !== 2) continue;
    // Lexeme forms are lemma phrases (the convention of the linker); the label is used only when the predicate has no lexeme.
    const labelForm = p.labels?.en ?? id.replace(/_/g, ' ');
    const lexemePhrases = (p.lexemes ?? []).filter(l => l.language === 'en').flatMap(l => l.forms.map(form => ({form, pos: l.pos, converse: l.converse})));
    const phrases = lexemePhrases.length ? lexemePhrases : [{form: labelForm, pos: /^(is|are|be) /.test(labelForm) || / of$/.test(labelForm) ? 'copula' : 'verb', converse: false}];
    for (const f of facts) for (const ph of phrases.slice(0, 4)) for (const qa of questionsOf({id, roles, ...ph, a: label(f.args[0]), b: label(f.args[1])})) {
      const v = validateQuery({sop: qa.circuit, message: qa.question, lexicon, circuits});
      if (!v.ok) { refused++; continue; }
      rows.push({prompt: finetunedPrompt(qa.question, finetunedCandidates(qa.question, lexicon, {must: id})), completion: qa.circuit, predicate: id});
    }
  }
  // Synthetic questions: every binary predicate with English lexemes, with invented names, so the model sees the whole vocabulary.
  const synthetic = Number(opt('--synthetic', 4));
  for (const p of Object.values(lexicon.predicates)) {
    const roles = (p.roles ?? []).map(r => r.name);
    const phrases = (p.lexemes ?? []).filter(l => l.language === 'en').flatMap(l => l.forms.map(form => ({form, pos: l.pos, converse: l.converse})));
    if (roles.length !== 2 || !phrases.length) continue;
    for (let i = 0; i < synthetic; i++) {
      const ph = phrases[i % phrases.length], a = NAMES[(i + p.id.length) % NAMES.length], b = PLACES[(i * 3 + p.id.length) % PLACES.length];
      const qa = questionsOf({id: p.id, roles, ...ph, a, b})[i % 2];
      const v = validateQuery({sop: qa.circuit, message: qa.question, lexicon, circuits});
      if (!v.ok) { refused++; continue; }
      rows.push({prompt: finetunedPrompt(qa.question, finetunedCandidates(qa.question, lexicon, {must: p.id})), completion: qa.circuit, predicate: p.id});
    }
  }
  // Counts and chains over the facts of the memory (lemma phrases, not converse ones, so the subject role stays first).
  const phrasesOf = p => (p.lexemes ?? []).filter(l => l.language === 'en' && !l.converse).flatMap(l => l.forms.map(form => ({form, pos: l.pos})));
  const binary = id => { const p = lexicon.predicates[id]; return p && (p.roles ?? []).length === 2 && phrasesOf(p).length ? p : null; };
  // One predicate per phrase, the one with the shortest id (arrives_at, not arrives_at_with_object_without_destination).
  const owner = new Map();
  for (const p of Object.values(lexicon.predicates).filter(p => binary(p.id))) { const f = phrasesOf(p)[0].form, o = owner.get(f); if (!o || p.id.length < o.id.length) owner.set(f, p); }
  const extra = [], binaries = [...new Set(owner.values())].sort((x, y) => x.id.localeCompare(y.id));
  binaries.forEach((p, i) => extra.push(countOf({id: p.id, roles: p.roles.map(r => r.name), ...phrasesOf(p)[0], b: PLACES[i % PLACES.length]})));
  // Chains pair every predicate with two others (deterministic strides) and an invented end entity.
  let chains = 0;
  binaries.forEach((p1, i) => { for (const stride of [7, 31]) {
    const p2 = binaries[(i + stride) % binaries.length];
    if (p2.id === p1.id) continue;
    extra.push(chainOf({id: p1.id, roles: p1.roles.map(r => r.name), ...phrasesOf(p1)[0]}, {id: p2.id, roles: p2.roles.map(r => r.name), ...phrasesOf(p2)[0]}, PLACES[(i + stride) % PLACES.length]));
    chains++;
  } });
  for (const qa of extra) {
    const v = validateQuery({sop: qa.circuit, message: qa.question, lexicon, circuits});
    if (!v.ok) { refused++; continue; }
    const must = [...qa.circuit.matchAll(/relation "([^"]+)"/g)].map(m => m[1]);
    const cands = finetunedCandidates(qa.question, lexicon, {must: must[0]});
    for (const id of must.slice(1)) if (!cands.some(c => c.id === id)) cands.splice(1, 0, {id, roles: lexicon.predicates[id].roles.map(r => r.name), label: lexicon.predicates[id].labels?.en ?? id.replace(/_/g, ' ')});
    rows.push({prompt: finetunedPrompt(qa.question, cands), completion: qa.circuit, predicate: must[0]});
  }
  NO_REQUEST.forEach((t, i) => { for (const x of [...NAMES, ...PLACES].slice(i % 3, i % 3 + 4)) { const q = t.replace('{x}', x); rows.push({prompt: finetunedPrompt(q, finetunedCandidates(q, lexicon)), completion: '@u unclear\n  kind no_request\n', predicate: null}); if (!t.includes('{x}')) break; } });
  // Abstention: a question whose relation no candidate expresses (the candidates of a different question) answers unclear.
  const negatives = Math.round(rows.length / 9);
  for (let i = 0; i < negatives; i++) {
    const r = rows[(i * 7919) % rows.length], other = rows[(i * 104729 + 13) % rows.length];
    if (r.predicate === other.predicate) continue;
    const question = r.prompt.split('QUESTION: ')[1].split('\n')[0];
    rows.push({prompt: finetunedPrompt(question, finetunedCandidates(other.prompt.split('QUESTION: ')[1].split('\n')[0], lexicon, {must: other.predicate, exclude: r.predicate})), completion: '@c unclear\n  kind relation_not_in_memory\n', predicate: null});
  }
  session.close();
  const picked = rows.slice(0, max);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, picked.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(JSON.stringify({memory, predicates: byPredicate.size, pairs: picked.length, chains, negatives, refused, out: path.relative(ROOT, out)}));
}
