#!/usr/bin/env node
/**
 * Prepares the SaeRouted benchmark (DS028 "Sparse autoencoder options"): a corpus is written from the facts of the acme-demo memory of
 * the private evaluation root (every fact once per phrase of its predicate's lexemes: "Ana Popescu works at Acme.", "Acme employs ..."),
 * an SAE discover strategy runs on it live (the features named on Ploinky tier `good`), and its proposals (schema and extractor wires with
 * feature triggers) are written as reviewed into that memory, as an administrator approving them would. Then
 * `node tools/eval/mrp/formalize.mjs --suites acme,acme-para --strategies SaeRouted` measures the routing.
 *
 *   node tools/eval/mrp/sae-setup.mjs [--strategy sae-sentence-embeddings|sae-llm-activations] [--top 30]
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openSession} from '../lib/session.mjs';
import {CHAT_ROOT, prepareRoot} from './formalize.mjs';
import {factsOf} from '../../../lib/mrp/retrieve.mjs';
import {saeDiscover} from '../../../lib/mrp/discover-sae.mjs';
import {runTasks} from '../../../lib/mrp/tasks.mjs';
import {pworker} from '../../../lib/pworker.mjs';
import {startStrategyService} from '../../../lib/mrp/strategy-service.mjs';
import {BaseMemories, validateCircuits} from '../../../lib/chat-data/memories.mjs';
import {ChatData} from '../../../lib/chat-data/index.mjs';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Sentences from facts: every phrase of the predicate (label and lexeme forms), subject first unless the lexeme is a converse. */
export function corpusOf(lexicon, facts) {
  const label = id => lexicon.entities?.[id]?.labels?.en ?? id;
  const out = [];
  for (const f of facts) {
    const p = lexicon.predicates?.[f.p];
    if (!p || f.args.length !== 2) continue;
    const ways = [{form: p.labels?.en ?? f.p.replace(/_/g, ' '), converse: false}, ...(p.lexemes ?? []).flatMap(l => l.forms.map(form => ({form, converse: l.converse})))];
    for (const w of ways) {
      const [a, b] = w.converse ? [f.args[1], f.args[0]] : f.args;
      out.push(`${label(a)} ${w.form.replace(/^be /, 'is ')} ${label(b)}.`);
    }
  }
  return [...new Set(out)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const strategy = opt('--strategy', 'sae-sentence-embeddings');
  prepareRoot();
  await startStrategyService();
  const session = openSession({base: 'acme-demo', root: CHAT_ROOT, id: 'sae-setup'});
  const circuits = session.sessions.baseCircuits(session.id);
  const passages = corpusOf(session.lexicon, factsOf(circuits));
  const run = (name, inputs, o) => runTasks(name, inputs, {client: pworker({purpose: 'job:discover', run: `mrp-sae-setup-${strategy}`, priority: 'background'}), ...o});
  const out = await saeDiscover({strategy, passages, params: {top: Number(opt('--top', 30)), ...(strategy === 'sae-sentence-embeddings' ? {latents: 256} : {})}, run, lexicon: session.lexicon, validate: c => validateCircuits(c, circuits), model: 'acme-bench'});
  session.close();
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtime.json'), 'utf8'));
  config.chatData = {...config.chatData, root: CHAT_ROOT};
  const memories = new BaseMemories({chatData: ChatData.open(config, {}, ROOT), memory: config.memory});
  const reviewed = out.proposed.map(p => ({name: p.name, text: p.text.replace(/^ {2}status proposed$/m, '  status reviewed')}));
  const written = reviewed.length ? memories.addKnowledge('acme-demo', {circuits: reviewed, approvedBy: 'sae-setup', reason: `benchmark setup ${strategy}`, source: `discover:${strategy}`}) : null;
  console.log(JSON.stringify({strategy, passages: passages.length, features: out.features, proposed: out.proposed.length, skipped: out.skipped.length, written: written?.added?.length ?? 0, source: out.source,
    examples: out.proposed.slice(0, 5).map(p => `${p.feature} -> ${p.predicates.join(',')}`)}, null, 1));
}
