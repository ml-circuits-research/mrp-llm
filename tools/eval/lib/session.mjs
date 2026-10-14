/**
 * A private chat session for an evaluation harness: the chat data root (the product's, or a private one with QF_CHAT_ROOT), a session on
 * a base memory and the session store whose agents run the chat turns (server/session-store.mjs), planned with the rules of the memory's
 * circuits like the product (server/session-runtime.mjs). Reads never reinforce (policy.reinforce false), so the questions of a run
 * cannot influence each other. The session is deleted by `close()`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SessionStore} from '../../../server/session-store.mjs';
import {ChatData} from '../../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../../lib/chat-data/memories.mjs';
import {Sessions} from '../../../lib/chat-data/sessions.mjs';
import {TheoryCache} from '../../../reasoning/slice/index.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const runtimeConfig = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'runtime.json'), 'utf8'));

/** The private chat data root with the world-v1 rebuilt on the current core-en (`QF_CHAT_ROOT`), else the product root. */
export const defaultRoot = () => process.env.QF_CHAT_ROOT ?? ['chat_data2', 'chat_data'].map(d => path.join(ROOT, 'datasets_sources/query-forms', d)).find(d => fs.existsSync(path.join(d, 'base_memories/world-v1'))) ?? path.join(ROOT, 'chat_data');

/** The runtime configuration with the chat data root `root`, and the sessions of that root. */
export function openWorld({root = defaultRoot()} = {}) {
  const config = runtimeConfig();
  config.chatData = {...config.chatData, root};
  const chatData = ChatData.open(config, {}, ROOT);
  const memories = new BaseMemories({chatData, memory: config.memory});
  const sessions = new Sessions({chatData, memories, memory: config.memory});
  return {config, sessions};
}

/** A fresh session `id` on base memory `base`; `limits` (QF_LIMITS by default) go into the policy of the turns. */
export function openSession({base = 'world-v1', id = 'qf-probe', user = 'qf-probe', root = defaultRoot(), limits = JSON.parse(process.env.QF_LIMITS ?? '{}')} = {}) {
  const {config, sessions} = openWorld({root});
  fs.rmSync(sessions.dir(id), {recursive: true, force: true});
  sessions.create({base, user, id, name: 'evaluation session'});
  const repo = sessions.repository(id);
  const theories = new TheoryCache();
  const store = new SessionStore({repo, lexicon: sessions.lexicon(id), config: {...config, policy: {...(config.policy ?? {}), reinforce: false, ...limits}}, root: path.join(sessions.dir(id), 'agent'),
    circuitRules: () => theories.get([...sessions.baseCircuits(id), ...sessions.circuits(id)]).chatRules()});
  return {store, sessions, id, theories, config, lexicon: sessions.lexicon(id), close: () => fs.rmSync(sessions.dir(id), {recursive: true, force: true})};
}
