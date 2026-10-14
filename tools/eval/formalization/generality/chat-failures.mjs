#!/usr/bin/env node
/**
 * Replays the real chat failures of 2026-10-02 (product-agent, private server, CodingAgent zai/glm-5.3, world-v1) through the chat turn
 * of ChatSOPAdapter (tools/eval/lib/chat-turn.mjs, the same glue as the chat) with the configured query parser (step by step since
 * 2026-10-02; `--tier T` asks its questions on one tier): one conversation per group, turns in order, so a statement of an earlier turn is
 * carried as turn-local evidence. Part of level c (free natural questions) of eval-generality-v1.
 *   node tools/eval/formalization/generality/chat-failures.mjs --out eval/reports/current/generality/chat-failures/<tag>.jsonl [--only g1,g3] [--tier T]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openSession} from '../../lib/session.mjs';
import {harnessChat} from '../../lib/chat-turn.mjs';
import {BASE_NAME} from '../../../../lib/chat-data/memories.mjs';

export const GROUPS = [
  {id: 'g1-statement', turns: ['My friend Zork lives in Lisbon.', 'Is Zork in Portugal?'], gold: 'second turn: yes, from the user statement (turn-local) and located_in lisbon portugal'},
  {id: 'g2-romanian', turns: ['Care este capitala Franței?'], gold: 'Paris'},
  {id: 'g3-most-populous', turns: ['Which is the most populous country?'], gold: 'the country with the highest population_of among is_a country (Peoples Republic of China or India by the world-v1 values)'},
  {id: 'g3b-most-populous-europe', turns: ['Which is the most populous country in Europe?'], gold: 'the European country with the highest population_of in world-v1'},
  {id: 'g4-mother', turns: ["Who was Napoleon's mother?"], gold: 'world-v1 has no parent relation: an honest relation-not-in-memory, quickly, without a namesake clarification loop'},
  {id: 'g5-borders', turns: ['Which countries border Germany?'], gold: '9 countries (is_a country): Austria, Belgium, Czech Republic, France, Kingdom of Denmark, Kingdom of the Netherlands, Luxembourg, Poland, Switzerland; not Denmark/Netherlands twice'}
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const out = path.resolve(opt('--out', 'eval/reports/current/generality/chat-failures/run.jsonl'));
  const only = opt('--only', null)?.split(',');
  fs.mkdirSync(path.dirname(out), {recursive: true});
  const s = openSession({base: 'world-v1', id: `generality-chat-${process.pid}`});
  const chat = harnessChat({config: s.config, tier: opt('--tier', null), source: 'eval:generality'});
  try {
    // --natural: the free natural questions (tools/eval/formalization/generality/natural-v1.jsonl), one conversation each, through the product turn.
    const groups = args.includes('--natural')
      ? fs.readFileSync(new URL('./natural-v1.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map(JSON.parse).map(r => ({id: r.id, turns: [r.question], gold: r.expected.gold_note}))
      : GROUPS;
    for (const group of groups.filter(g => !only || only.some(o => g.id.startsWith(o)))) {
      const entry = s.store.get('qf', group.id + '-' + Date.now().toString(36), BASE_NAME);
      for (const [i, turn] of group.turns.entries()) {
        const started = Date.now();
        let line;
        try {
          const {result: res, parse} = await chat.turn(entry, turn, {lexicon: s.lexicon});
          const p = res.packet ?? {};
          line = {group: group.id, turn: i + 1, text_in: turn, sop: res.sop, status: p.status, count: p.count, bound: p.bound, answers: (p.answers ?? []).slice(0, 15).map(a => a.binding), unclear: res.unclear, text: String(res.text).slice(0, 600),
            user_statements: res.userStatements?.length ?? 0, carried: res.carriedStatements?.length ?? 0, parse: parse ? {rounds: parse.rounds, codes: parse.problems ?? parse.repairs ?? null} : null};
        } catch (error) { line = {group: group.id, turn: i + 1, text_in: turn, error: String(error.message).slice(0, 400), sop: error.modelSop}; }
        line.ms = Date.now() - started; line.gold = group.gold;
        fs.appendFileSync(out, JSON.stringify(line) + '\n');
        console.log(JSON.stringify({group: line.group, turn: line.turn, status: line.status, unclear: line.unclear, ms: line.ms, text: line.text?.slice(0, 160), error: line.error}));
      }
    }
  } finally { s.close(); await chat.close(); }
  process.exit(0);
}
