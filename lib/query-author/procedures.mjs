/**
 * The procedure library of a memory (DS022 "Procedure library"; owner request of 2026-10-02: procedures written by a coding agent become
 * reusable, also by small models). A procedure is a `procedure` bundle wire (DS004 "Procedures") stored in a base memory: `members` names
 * the rules, defaults and predicates that solve one question form and `description` states that form in words ("Answers: how many days of
 * annual leave does <person> get?"). The query author's context offers the procedures whose description matches the message: their head
 * predicates join the candidate predicates and their member wires are shown as SOP, so the author queries the derived predicate instead of
 * re-deriving the rule. Nothing is executed or approved here; the bundle was accepted into the memory like any knowledge.
 *
 *   procedureLibrary(circuits)          [{id, description, members, heads, text}] from accepted circuits (cached by their text)
 *   matchProcedures(message, library)   [{id, score, heads, description, text}] ranked by IDF-weighted stem overlap with the description
 *   renderProcedures(matches)           the "Procedures in memory" section of the author's candidates file
 *   procedureCircuit({id, description, definitions})   a circuit text: the definitions plus their bundle wire (for addKnowledge)
 */
import {createHash} from 'node:crypto';
import {parse, tokens, wireText} from '../../sop/knowledge/index.mjs';
import {fold} from '../../sop/text-keys.mjs';
import {stem} from './retrieval.mjs';

const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'has', 'have', 'had', 'of', 'in', 'on', 'at', 'to', 'by', 'for', 'with', 'from', 'and', 'or',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how', 'that', 'this', 'it', 'its', 'there', 'as', 'about', 'any', 'all', 'me', 'i', 'you', 'we', 'they', 'he', 'she', 'his', 'her',
  'answers', 'answer', 'question', 'questions', 'form', 'whether', 'person', 'given', 'can', 'may', 'many', 'much']);
const stems = text => [...new Set((fold(String(text).replaceAll('_', ' ')).match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => !STOP.has(w) && !/^\d+$/.test(w)).map(stem))];
const field = (w, key) => w.fields.find(f => f.key === key)?.value ?? null;
const decode = v => { try { return JSON.parse(v); } catch { return String(v ?? ''); } };

const cache = new Map();
export function procedureLibrary(circuits = []) {
  const key = createHash('sha256').update(circuits.map(c => c.text).join('\0')).digest('hex');
  if (cache.has(key)) return cache.get(key);
  const wires = new Map();
  for (const c of circuits) for (const w of parse(c.text).wires) wires.set(w.id, w);
  const library = [];
  for (const w of wires.values()) {
    if (w.type !== 'procedure') continue;
    const members = tokens(field(w, 'members') ?? '').map(t => t.replace(/^[$~]/, ''));
    const heads = new Set();
    for (const id of members) {
      const m = wires.get(id);
      if (!m) continue;
      if (m.type === 'rule' || m.type === 'default') { const then = tokens(field(m, 'then') ?? ''); heads.add(then[0] === 'not' ? then[1] : then[0]); }
    }
    const text = members.map(id => wires.get(id)).filter(Boolean).map(wireText).join('\n\n');
    const description = decode(field(w, 'description'));
    const headList = [...heads].filter(Boolean);
    library.push({id: w.id, description, members, heads: headList, text, stems: stems(description + ' ' + headList.join(' ')), headStems: stems(headList.join(' '))});
  }
  const df = new Map();
  for (const p of library) for (const s of p.stems) df.set(s, (df.get(s) ?? 0) + 1);
  const out = {procedures: library, df, n: Math.max(1, library.length)};
  if (cache.size > 64) cache.clear();
  cache.set(key, out);
  return out;
}

/**
 * Procedures whose description shares at least `minShared` content stems with the message, one of them a stem of a head predicate (the
 * message asks what the procedure concludes), best first, at most `k`.
 */
export function matchProcedures(message, library, {k = 3, minShared = 2} = {}) {
  if (!library?.procedures?.length) return [];
  const query = new Set(stems(message));
  return library.procedures.map(p => {
    const shared = p.stems.filter(s => query.has(s));
    const score = shared.reduce((n, s) => n + Math.log(1 + library.n / (library.df.get(s) ?? 1)) + 1, 0) / Math.sqrt(p.stems.length || 1);
    return {id: p.id, score: Math.round(score * 100) / 100, shared, onHead: p.headStems.some(s => query.has(s)), heads: p.heads, description: p.description, text: p.text};
  }).filter(m => m.shared.length >= minShared && m.onHead).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
}

export function renderProcedures(matches) {
  if (!matches.length) return '';
  return `\n## Procedures in memory\n\nAccepted procedures whose description matches the request. Each solves one question form; prefer querying its head predicate (already defined, do not redefine it) to writing a new rule.\n\n${matches.map(m => `### ${m.id}: ${m.description}\n\nHead predicate(s): ${m.heads.map(h => `\`${h}\``).join(', ') || '(none)'}\n\n\`\`\`sop\n${m.text}\n\`\`\`\n`).join('\n')}`;
}

/** A circuit that stores `definitions` (predicate, rule and default wires) as one procedure bundle with the description of its form. */
export function procedureCircuit({id, description, definitions}) {
  if (!/^[a-z][a-z0-9_]*$/.test(id ?? '')) throw Object.assign(new Error('procedure id must be a lowercase symbol'), {code: 'invalid_parameter', status: 400});
  if (typeof description !== 'string' || description.trim().length < 8) throw Object.assign(new Error('describe the question form the procedure answers'), {code: 'invalid_parameter', status: 400});
  const wires = parse(definitions).wires.filter(w => ['predicate', 'rule', 'default', 'aggregate'].includes(w.type));
  if (!wires.length) throw Object.assign(new Error('a procedure needs at least one predicate, rule, default or aggregate wire'), {code: 'invalid_parameter', status: 400});
  return `${definitions.trimEnd()}\n\n@${id} procedure\n  members ${wires.map(w => '$' + w.id).join(' ')}\n  description ${JSON.stringify(description.trim())}\n`;
}
