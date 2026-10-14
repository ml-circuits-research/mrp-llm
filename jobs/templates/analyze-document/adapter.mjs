/**
 * Adapter of the analyze-document template (DS022 "Analysis procedures"): ingest, then analyse, then report, through the product's own
 * functions and nothing else.
 *   1. ingest   lib/ingest/v2 ingestV2 into the target (a base memory, a session, or, with target none, a new session on `params.base`,
 *               default analysis-core-v1, created in the chat data root when missing); the model calls go through the runner's tagged
 *               fetch with the template's tiers
 *   2. analyse  lib/analysis analyzeSession over the circuits the ingestion stored for each document (selected by the document's name
 *               in the provenance), with the template's procedures and engine
 *   3. report   <taskDir>/analysis/<document>/analysis.json (the packet, with proofs) and report.md (the text rendered from the
 *               conversation layer's line_* replies); the summary returns at most 10 lines
 */
import fs from 'node:fs';
import path from 'node:path';
import {ChatData, chatDataSettings} from '../../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../../lib/chat-data/memories.mjs';
import {Sessions} from '../../../lib/chat-data/sessions.mjs';
import {analyzeSession} from '../../../lib/analysis/index.mjs';
import {ensureAnalysisMemory, ANALYSIS_LIBRARY} from '../../../lib/analysis/memory.mjs';

const slug = name => String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'document';

export async function run({params, attachments, target, taskDir, ta, log = () => {}, context = {}}) {
  const [{ingestV2}, {tierChat}] = await Promise.all([import('../../../lib/ingest/v2/index.mjs'), import('../../../lib/ingest/v2/client.mjs')]);
  const dir = taskDir ?? fs.mkdtempSync('analyze-document-');
  const chatData = context.chatData ?? new ChatData(chatDataSettings({}));
  const memories = context.memories ?? new BaseMemories({chatData});
  const sessions = context.sessions ?? new Sessions({chatData, memories});
  let goal = target?.kind && target.kind !== 'none' ? {kind: target.kind, id: target.id} : null;
  if (!goal) {
    const base = params.base ?? ANALYSIS_LIBRARY;
    if (base === ANALYSIS_LIBRARY) ensureAnalysisMemory(memories);
    goal = {kind: 'session', id: sessions.create({base, user: 'llm-jobs', name: `analyze-document ${path.basename(dir)}`}).id};
  }
  if (!['memory', 'session'].includes(goal.kind) || !goal.id) throw new Error('analyze-document writes into a base memory or a session (or a new session with target none)');
  const documents = attachments.map(a => ({name: a.name, text: fs.readFileSync(a.path, 'utf8'), source: {rights: params.rights}}));
  const record = await ingestV2({documents, target: goal, memories, sessions: goal.kind === 'session' ? sessions : null, dir: path.join(dir, 'ingest-v2'), purpose: params.purpose ?? '', user: 'llm-jobs',
    tiers: {structure: params.tier ?? 'small', fol: params.fol_tier ?? 'medium', repair: params.fol_tier ?? 'medium', merge: params.merge_tier ?? 'medium'},
    maxChunkBytes: params.max_chunk_bytes ?? 3000, chat: tierChat({ta}), onProgress: p => log(`ingest-v2 ${p.phase} ${p.document ?? ''}`)});
  const source = goal.kind === 'session' ? {sessions, id: goal.id} : {memories, id: goal.id};
  const lines = [`# analyze-document into ${goal.kind}:${goal.id}: ingestion ${record.status}`];
  const results = [];
  for (const doc of record.documents) {
    const out = path.join(dir, 'analysis', slug(doc.name));
    fs.mkdirSync(out, {recursive: true});
    try {
      const result = analyzeSession(source, params.procedures?.length ? params.procedures : null, {documents: [doc.name], reasoning: params.reasoning ?? 'auto'});
      fs.writeFileSync(path.join(out, 'analysis.json'), JSON.stringify(result, null, 1) + '\n');
      fs.writeFileSync(path.join(out, 'report.md'), result.text + '\n');
      results.push({document: doc.name, counts: result.counts});
      lines.push(`- ${doc.name}: ${result.counts.findings} findings (${result.counts.errors} errors, ${result.counts.warnings} warnings), ${result.counts.measures} measures; ${path.relative(dir, out)}/report.md`);
    } catch (error) {
      results.push({document: doc.name, error: error.code ?? error.message});
      fs.writeFileSync(path.join(out, 'error.json'), JSON.stringify({code: error.code ?? null, message: error.message}, null, 1) + '\n');
      lines.push(`- ${doc.name}: not analysed (${error.code ?? 'error'}: ${error.message.slice(0, 120)})`);
    }
  }
  const failed = results.every(r => r.error);
  return {status: failed ? 'failed' : 'finished', target: goal, ingestion: record.status, usage: record.usage, results, summary: lines.slice(0, 10).join('\n')};
}
