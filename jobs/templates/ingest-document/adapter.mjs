/**
 * Adapter of the ingest-document template: wraps the product's document ingestion without rewriting it.
 *   v1  lib/ingest Ingestions.draft (one authoring conversation per chunk; base memory only)
 *   v2  lib/ingest/v2 ingestV2 (structure pass, canonical vocabulary, FOL per sentence, converter, checks; base memory or session)
 * The models are the template's Ploinky Workers tier names; every call goes through the task's Ploinky Workers client `ta` (tagged with the task's
 * purpose and run id, so the task's budget applies). v2 writes its run files (summary.md, escalations.jsonl, ingestion.json, ...) into
 * `<taskDir>/ingest-v2/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {Ingestions, openaiChat} from '../../../lib/ingest/index.mjs';
import {ingestV2} from '../../../lib/ingest/v2/index.mjs';
import {tierChat} from '../../../lib/ingest/v2/client.mjs';
import {ChatData, chatDataSettings} from '../../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../../lib/chat-data/memories.mjs';
import {Sessions} from '../../../lib/chat-data/sessions.mjs';

export async function run({params, attachments, target, taskDir, ta, log = () => {}, context = {}}) {
  const version = params.version ?? 'v1';
  if (!['memory', 'session'].includes(target?.kind) || !target.id) throw new Error('ingest-document writes into a base memory or a session: give a memory or session target');
  if (target.kind === 'session' && version !== 'v2') throw new Error('ingest-document v1 writes only into a base memory; use version v2 for a session');
  const chatData = context.chatData ?? new ChatData(chatDataSettings({}));
  const memories = context.memories ?? new BaseMemories({chatData});
  const documents = attachments.map(a => ({name: a.name, text: fs.readFileSync(a.path, 'utf8'), source: {rights: params.rights, ...(params.source_url ? {url: params.source_url} : {})}}));
  if (version === 'v2') {
    const sessions = target.kind === 'session' ? (context.sessions ?? new Sessions({chatData, memories})) : null;
    const dir = path.join(taskDir ?? fs.mkdtempSync('ingest-v2-'), 'ingest-v2');
    const record = await ingestV2({documents, target, memories, sessions, dir, purpose: params.purpose ?? '', user: 'llm-jobs',
      tiers: {structure: params.tier ?? 'small', fol: params.fol_tier ?? 'medium', repair: params.fol_tier ?? 'medium', merge: params.merge_tier ?? 'medium'},
      maxChunkBytes: params.max_chunk_bytes ?? 3000, chat: tierChat({ta}), onProgress: p => log(`ingest-v2 ${p.phase} ${p.document ?? ''}`)});
    return {status: record.status === 'failed' ? 'failed' : 'finished', version, dir: path.relative(taskDir ?? '.', dir), usage: record.usage, summary: record.summary};
  }
  if (target.kind !== 'memory') throw new Error('ingest-document v1 writes into a base memory');
  const chat = openaiChat({ta});
  const record = await new Ingestions({memories}).draft(target.id, {documents, model: params.tier, purpose: params.purpose ?? '', maxChunkBytes: params.max_chunk_bytes ?? 7000, user: 'llm-jobs', author: 'direct', chat,
    onProgress: p => log(`ingest ${p.phase ?? ''} ${p.chunk ?? ''}`)});
  const t = record.totals ?? {};
  return {status: record.status === 'failed' ? 'failed' : 'finished', version, ingestion: record.id,
    summary: `ingestion ${record.id} into ${target.id}: ${record.status}; chunks ${record.chunks.length}; ${Object.entries(t).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${v}`).join(', ')}`};
}
