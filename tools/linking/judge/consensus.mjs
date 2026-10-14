#!/usr/bin/env node
/**
 * Consensus of the linking judges (parts 2 and 3). Independent judges (Grok, Codex GPT-5.5, DeepSeek; whichever had credits) must agree on a
 * row for it to be scored: the gold is the (relation, ask) label that at least two independent judges gave (a tie or a single label is contested). Disagreements are not dropped silently:
 * they are counted as `contested` and listed. Pairwise agreement of every judge pair is reported (relation, ask, entity ids).
 *
 *   node tools/linking/judge/consensus.mjs --part 2 [--judges grok,glma,glmb,glmc] [--out eval/suites/linking-v1/part2.jsonl]
 *
 * Part 2 reads questions-part2.json and the author's intended seed (a fourth, independent opinion: `author_agrees`); part 3 reads
 * questions-part3.json and the author's intended readings. Output rows are labels, data under review (`review_status: judged`).
 */
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from './memory.mjs';
import {fold} from '../../../sop/text-keys.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const part = Number(opt('--part', 2));
const DIR = path.join(ROOT, 'eval/reports/current/linking/judge');
const judges = opt('--judges', 'grok,grokb,cdx,dsk').split(',');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const questions = read(path.join(DIR, `questions-part${part}.json`));
// Labels of part 3 live under a tag suffix (labels-<judge>-p3.json) so the two parts never overwrite each other.
const suffix = part === 3 ? '-p3' : '';
const byJudge = {};
for (const j of judges) {
  const file = path.join(DIR, `labels-${j}${suffix}.json`);
  if (fs.existsSync(file)) byJudge[j] = new Map(read(file).labels.map(l => [l.i, l]));
}
const have = Object.keys(byJudge);
const entityIds = l => new Set((l.entities ?? []).map(e => e.id).filter(id => id && !['none', 'ambiguous'].includes(id)));
const same = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
const author = part === 2 ? read(path.join(DIR, 'author-part2.json')).seeds : null;

const pairs = [];
for (let a = 0; a < have.length; a++) for (let b = a + 1; b < have.length; b++) {
  let n = 0, rel = 0, ask = 0, ent = 0;
  for (const q of questions) {
    const x = byJudge[have[a]].get(q.i), y = byJudge[have[b]].get(q.i);
    if (!x || !y) continue;
    n++; if (x.relation === y.relation) rel++; if (x.ask === y.ask) ask++; if (same(entityIds(x), entityIds(y))) ent++;
  }
  pairs.push({a: have[a], b: have[b], rows: n, relation: +(rel / n).toFixed(3), ask: +(ask / n).toFixed(3), entities: +(ent / n).toFixed(3)});
}

const rows = [], contested = [];
for (const q of questions) {
  // Votes of the judges that labelled the row; the gold is the (relation, ask) label that at least two judges gave and no other label matches in count.
  const votes = have.map(j => [j, byJudge[j].get(q.i)]).filter(([, l]) => l);
  const tally = new Map();
  for (const [j, l] of votes) { const key = l.relation + '|' + l.ask; (tally.get(key) ?? tally.set(key, []).get(key)).push(j); }
  const ranked = [...tally].sort((a, b) => b[1].length - a[1].length);
  if (!ranked.length || ranked[0][1].length < 2 || (ranked[1] && ranked[1][1].length === ranked[0][1].length)) {
    contested.push({i: q.i, question: q.question, why: votes.length < 2 ? 'fewer than two labels' : 'no label with two votes', labels: votes.map(([j, l]) => `${j}:${l.relation}`)});
    continue;
  }
  const [relation, askText] = ranked[0][0].split('|'), agreeing = ranked[0][1];
  const m = byJudge[agreeing[0]].get(q.i), supporters = agreeing.map(j => byJudge[j].get(q.i));
  // An entity is gold when at least two judges give the same id.
  const idVotes = new Map();
  for (const l of votes.map(([, x]) => x)) for (const id of entityIds(l)) idVotes.set(id, (idVotes.get(id) ?? 0) + 1);
  const entities = (m.entities ?? []).filter(e => e.id && !['none', 'ambiguous'].includes(e.id) && (idVotes.get(e.id) ?? 0) >= 2).map(e => ({surface: e.surface, id: e.id}));
  const entityGaps = (m.entities ?? []).filter(e => !entities.some(g => g.id === e.id)).map(e => ({surface: e.surface, id: e.id}));
  const seed = author?.[q.i];
  rows.push({
    id: `linking-v1::part${part}::${String(q.i).padStart(3, '0')}`, part, i: q.i, question: q.question, language: seed?.language ?? 'en',
    gold: {relation, converse: Boolean(m.converse), alternatives: [...new Set(supporters.flatMap(l => l.alternatives ?? []))], ask: askText === 'true', entities}, unconfirmed_entities: entityGaps,
    judges: Object.fromEntries(votes.map(([j, l]) => [j, {relation: l.relation, ask: l.ask}])), votes: agreeing.length, of: votes.length,
    ...(q.intended ? {author_intended: q.intended, kind: q.kind} : seed ? {author_intended: seed.predicate, author_agrees: relation === seed.predicate} : {}), review_status: 'judged',
  });
}
const summary = {part, judges: have, questions: questions.length, scored: rows.length, contested: contested.length, pairwise: pairs,
  ...(author ? {author_agrees: rows.filter(r => r.author_agrees).length} : {}), gold_ask: rows.filter(r => r.gold.ask).length, gold_none: rows.filter(r => r.gold.relation === 'none').length};
const out = path.resolve(ROOT, opt('--out', `eval/suites/linking-v1/part${part}.jsonl`));
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(DIR, `consensus-part${part}.json`), JSON.stringify({summary, contested}, null, 1));
console.log(JSON.stringify(summary));
