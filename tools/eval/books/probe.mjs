#!/usr/bin/env node
/** Probe: one book item through the product chat turn with LocalLLMStepByStep (Qwen3-4B), printing the raw turn. node tools/eval/books/probe.mjs <item-id>... */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openChatTurn} from './system.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const items = fs.readFileSync(path.join(ROOT, 'datasets_sources/books/eval/items.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const system = await openChatTurn({});
try {
  for (const id of process.argv.slice(2)) {
    const item = items.find(i => i.id === id) ?? {question: id, answer: '?'};
    console.log('###', id, '\nQ:', item.question, '\nGOLD:', item.answer);
    const r = await system.ask(item.question);
    console.log(JSON.stringify({error: r.error, sop: r.sop, text: r.text, packet: r.packet, status: r.packet?.status, kind: r.packet?.kind, ms: r.ms, parse: {strategy: r.parse?.strategy, steps: r.parse?.steps, unclear: r.parse?.unclear, failed: r.parse?.failed, ms: r.parse?.ms}}, null, 1).slice(0, 5000));
  }
} finally { await system.close(); }
