/**
 * Writes eval/reports/current/world-kb/summary.md from chat-results.json (tools/eval/chat/world-kb-chat.mjs) and the reviewed failure attribution
 * eval/world-kb/attribution.json ({id: {layer, note}}; layers: circuit author, KnowledgeLinker, core-en, world-v1, engine).
 *   node tools/eval/chat/world-kb-report.mjs
 * Outcomes: correct (an expected value is in the answer), wrong (the chat answered "supported" and no expected value is there),
 * honest-unknown (the chat asked for a clarification or said that the memory does not decide the question).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = path.join(project, 'eval/reports/current/world-kb');
const data = JSON.parse(fs.readFileSync(path.join(dir, 'chat-results.json'), 'utf8'));
const attribution = JSON.parse(fs.readFileSync(path.join(project, 'eval/world-kb/attribution.json'), 'utf8'));
const stats = JSON.parse(fs.readFileSync(path.join(project, 'datasets_sources/world-kb/build-stats.json'), 'utf8'));
const outcome = r => (r.pass ? 'correct' : r.status === 'supported' ? 'wrong' : 'honest-unknown');
const rows = data.results.map(r => ({...r, outcome: outcome(r)}));
const count = (f, key = 'outcome') => Object.fromEntries(['correct', 'wrong', 'honest-unknown'].map(o => [o, rows.filter(r => f(r) && r[key] === o).length]));
const all = count(() => true), en = count(r => r.lang === 'en'), ro = count(r => r.lang === 'ro');
const layers = {};
for (const r of rows.filter(r => r.outcome !== 'correct')) { const l = attribution[r.id]?.layer ?? 'unattributed'; layers[l] = (layers[l] ?? 0) + 1; }
const ms = rows.map(r => r.ms).sort((a, b) => a - b);
let md = `# world-v1: 30-question chat check\n\nObserved ${data.ran_at} through the HTTP chat of a private server (127.0.0.1:${data.port}, never 9999), one session per question on the base memory \`${data.base}\` (sqlite; imports core-min and core-en). Command: \`node tools/eval/chat/world-kb-chat.mjs --chat-data <root>\`, report: \`node tools/eval/chat/world-kb-report.mjs\`.\n\n`;
md += `Memory: ${stats.facts} facts, ${stats.entities} entities, ${stats.predicates} mapped predicates (${stats.predicates_declared} declared by world-v1, ${stats.predicates_from_imports} owned by core-min and core-en), ${stats.circuits} circuits (${(stats.bytes / 1e6).toFixed(1)} MB), built by \`node tools/world-kb/build.mjs\`.\n\n`;
md += `| | correct | wrong (answered, not matching) | honest unknown (asked or "not decided") | total |\n| --- | --- | --- | --- | --- |\n`;
for (const [name, c] of [['all', all], ['English', en], ['Romanian', ro]]) md += `| ${name} | ${c.correct} | ${c.wrong} | ${c['honest-unknown']} | ${c.correct + c.wrong + c['honest-unknown']} |\n`;
md += `\nLatency per question (warm server): median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms[ms.length - 1]} ms (the first question includes the model warm-up).\n\n`;
md += `Failures by layer: ${Object.entries(layers).map(([l, n]) => `${l} ${n}`).join(', ') || 'none'}.\n\n## Questions\n\n| id | question | outcome | answer (start) | layer | cause |\n| --- | --- | --- | --- | --- | --- |\n`;
for (const r of rows) {
  const a = attribution[r.id];
  md += `| ${r.id} | ${r.question.replace(/\|/g, '/')} | ${r.outcome} | ${r.answer.replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 90)} | ${r.outcome === 'correct' ? '' : a?.layer ?? 'unattributed'} | ${r.outcome === 'correct' ? '' : (a?.note ?? '').replace(/\|/g, '/')} |\n`;
}
fs.writeFileSync(path.join(dir, 'summary.md'), md);
console.log(JSON.stringify({all, en, ro, layers}));
