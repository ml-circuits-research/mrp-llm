#!/usr/bin/env node
/**
 * Ingest documents into a base memory from the command line (DS022 "Ingesting documents into a base memory"; library lib/ingest/).
 *
 *   node tools/ingest-documents.mjs create-memory --id ID --name NAME [--imports core-min,...] [--description TEXT]
 *   node tools/ingest-documents.mjs ingest --memory ID (--file PATH ... --rights cleared|permissive-attribution|owner-provided [--url U] [--licence L] [--title T]
 *                                          | --manifest FILE.json) [--model M] [--reasoning off|low|medium|xhigh] [--concurrency N]
 *                                          [--purpose TEXT] [--max-chunk-bytes N] [--thinking LEVEL] [--timeout-seconds S] [--user NAME]
 *   node tools/ingest-documents.mjs label-entities --memory ID (--file PATH --rights R | --manifest F) [--model M]
 *                                          entity wires for unlabelled symbols only
 *   node tools/ingest-documents.mjs report --memory ID --ingestion ING
 *   node tools/ingest-documents.mjs list   --memory ID
 *
 * The manifest is `[{file, title?, source: {rights, url?, licence?, attribution?}}]`. `--chat-data DIR` (or CHATSOP_CHAT_DATA) selects the
 * chat data root. `ingest` compiles the document chunk by chunk and stores every validated chunk in the memory with its provenance (no
 * manual acceptance, owner 2026-10-02); `draft` is accepted as an older name of `ingest`. The author is direct (no omp, owner order 2026-10-02):
 * one chat-completion conversation per chunk through Ploinky (lib/pworker.mjs; `--model` is a Ploinky tier,
 * default `ingest.tier` of config/runtime.json, `small`; `--reasoning off` by default, 3 chunks at once).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ChatData} from '../lib/chat-data/index.mjs';
import {BaseMemories} from '../lib/chat-data/memories.mjs';
import {Ingestions} from '../lib/ingest/index.mjs';
import {providerSettings} from '../lib/llm-providers.mjs';
import {openaiChat} from '../lib/ingest/direct-author.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args[0];
const opt = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const all = name => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

export function open({chatDataRoot = opt('--chat-data', process.env.CHATSOP_CHAT_DATA ?? null)} = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'runtime.json'), 'utf8'));
  if (chatDataRoot) config.chatData = {...config.chatData, root: path.resolve(chatDataRoot)};
  const chatData = ChatData.open(config, {}, ROOT);
  const memories = new BaseMemories({chatData, memory: config.memory});
  return {config, memories, ingestions: new Ingestions({memories})};
}

function documentsFromArgs() {
  const manifest = opt('--manifest');
  if (manifest) {
    const base = path.dirname(path.resolve(manifest));
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).map(d => ({name: path.basename(d.file), title: d.title, text: fs.readFileSync(path.resolve(base, d.file), 'utf8'), source: d.source}));
  }
  const source = {rights: opt('--rights'), url: opt('--url'), licence: opt('--licence'), attribution: opt('--attribution')};
  return all('--file').map(file => ({name: path.basename(file), title: opt('--title') ?? undefined, text: fs.readFileSync(file, 'utf8'), source}));
}

async function main() {
  const {config, memories, ingestions} = open();
  const memory = opt('--memory');
  if (command === 'create-memory') {
    const imports = (opt('--imports', '') ?? '').split(',').filter(Boolean);
    console.log(JSON.stringify(memories.create({id: opt('--id'), name: opt('--name'), description: opt('--description', ''), imports}), null, 2));
  } else if (command === 'ingest' || command === 'draft' || command === 'label-entities') {
    const author = 'direct';
    const provider = providerSettings(config).openference;
    // The direct author names a Ploinky tier (`ingest.tier` of the configuration, default `small`), never a concrete model.
    const settings = {author: 'direct', tier: 'small', reasoning: 'off', ...(config.ingest ?? {})};
    const common = {documents: documentsFromArgs(), author, user: opt('--user', process.env.CHATSOP_ACTOR ?? null),
      model: opt('--model', provider?.model ?? null),
      maxFixRounds: Number(opt('--max-fix-rounds', 3)), thinking: opt('--thinking', null), timeoutMs: Number(opt('--timeout-seconds', 900)) * 1000,
      reasoning: opt('--reasoning', settings.reasoning), chat: openaiChat({purpose: 'ingest'})};
    const record = command === 'label-entities' ? await ingestions.labelEntities(memory, common)
      : await ingestions.draft(memory, {...common, purpose: opt('--purpose', ''), maxChunkBytes: Number(opt('--max-chunk-bytes', 7000)), ...(opt('--concurrency') || settings.concurrency ? {concurrency: Number(opt('--concurrency') ?? settings.concurrency)} : {}),
        onProgress: p => process.stderr.write(`[ingest] ${new Date().toISOString()} ${p.document} chunk ${p.chunk}/${p.of}\n`)});
    console.log(JSON.stringify({id: record.id, status: record.status, author: record.author, model: record.model, totals: record.totals,
      chunks: record.chunks.map(c => ({key: c.key, status: c.status, rounds: c.rounds, seconds: Math.round((c.ms ?? 0) / 1000), wires: c.wires})), report: path.join(ingestions.dir(memory, record.id), 'report.md')}, null, 2));
  } else if (command === 'report') {
    process.stdout.write(fs.readFileSync(path.join(ingestions.dir(memory, opt('--ingestion')), 'report.md'), 'utf8'));
  } else if (command === 'list') {
    console.log(JSON.stringify(ingestions.list(memory), null, 2));
  } else {
    console.error('usage: node tools/ingest-documents.mjs create-memory|ingest|label-entities|report|list ... (see the header of this file)');
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.problems ? JSON.stringify({error: error.message, problems: error.problems}, null, 2) : error.stack); process.exit(1); });
