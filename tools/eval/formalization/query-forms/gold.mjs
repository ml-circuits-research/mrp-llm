#!/usr/bin/env node
/**
 * Gold answers of the query-forms dev set (experiment eval-query-forms-v1): every row written by the omp model carries a knowledge
 * query over predicate and entity symbols; the oracle answers it on the base memory world-v1 (reasoning/slice askMemory, the product
 * path of POST /v1/sessions/{id}/query), and the row is kept only when the answer is definite (not incomplete or unknown) and equals
 * the answer the model expected from its own knowledge. The LLM never decides the gold: two independent sources must agree.
 *   node tools/eval/formalization/query-forms/gold.mjs --in rows.jsonl --out dev.jsonl [--rejected rejected.jsonl]
 */
import fs from 'node:fs';
import {openSession} from '../../lib/session.mjs';
import {askMemory} from '../../../../reasoning/slice/index.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const rows = fs.readFileSync(opt('--in'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !opt('--forms') || opt('--forms').split(',').includes(r.form));
const SID = 'qf-gold-' + process.pid;
const s = openSession({base: 'world-v1', id: SID});
const entry = s.store.get('qf', 'gold', 'main');
const theory = s.theories.get([...s.sessions.baseCircuits(SID), ...s.sessions.circuits(SID)]);
const norm = v => (typeof v === 'number' ? v : String(v).toLowerCase());
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// the same slice budget as the dev run of the chain (the product defaults make a transitive located_in question incomplete)
const LIMITS = {maxLookups: 300000, maxProbes: 600000, maxFacts: 60000, retrievalMs: 60000, ...JSON.parse(process.env.QF_LIMITS ?? '{}')};
const kept = [], rejected = [];
for (const row of rows) {
  let out;
  try {
    const packet = askMemory({theory, repo: s.sessions.repository(SID), session: entry.agent.session, query: row.kb_query, reasoning: 'auto', verify: 'auto', limits: LIMITS, budget: {timeoutMs: 120000}});
    const definite = ['supported', 'refuted'].includes(packet.status) && packet.complete !== false && packet.retrieval?.complete !== false;
    let gold;
    const mode = /^\s*mode\s+(\w+)/m.exec(row.kb_query)?.[1] ?? 'select';
    if (mode === 'exists') gold = packet.status === 'supported';
    else if (mode === 'count') gold = packet.count;
    else gold = (packet.rows ?? []).map(r => Object.values(r)[0]).map(norm);
    out = {definite, status: packet.status, complete: packet.complete, gold};
  } catch (error) { out = {error: String(error.message).slice(0, 200)}; }
  // a single value expected from a select query (an age) is a one-element answer
  const expected = Array.isArray(row.expected) ? row.expected.map(norm) : Array.isArray(out.gold) ? [norm(row.expected)] : row.expected;
  const agree = out.definite && (Array.isArray(out.gold) ? Array.isArray(expected) && sameSet(out.gold, expected) : out.gold === expected);
  (agree ? kept : rejected).push({...row, oracle: out});
}
fs.writeFileSync(opt('--out'), kept.map(r => JSON.stringify({id: r.id, form: r.form, question: r.question, kb_query: r.kb_query, gold: r.oracle.gold})).join('\n') + '\n');
if (opt('--rejected')) fs.writeFileSync(opt('--rejected'), rejected.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(JSON.stringify({rows: rows.length, kept: kept.length, rejected: rejected.length, byForm: Object.fromEntries([...new Set(rows.map(r => r.form))].map(f => [f, [kept.filter(r => r.form === f).length, rows.filter(r => r.form === f).length]]))}));
s.close();
process.exit(0);
