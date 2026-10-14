#!/usr/bin/env node
/**
 * Renews the seed base memories (core-min, core-en, demo) of a chat data root when config/knowledge changed. Import layers are
 * snapshots, so a stale seed is re-created together with every memory built on it; those memories must hold no circuits of
 * their own (an empty default base is re-created by the server; a loaded knowledge memory such as world-v1 is rebuilt by its
 * loader, tools/world-kb/load.mjs). The default is a dry run that lists what would be deleted and re-created.
 * `--only <id>` renews one seed (and its dependents) only, e.g. the conversation layer, which no memory imports.
 *   node tools/refresh-seed-memories.mjs [--apply] [--only <seed id>] [--root <chat data root>]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ChatData} from '../lib/chat-data/index.mjs';
import {BaseMemories} from '../lib/chat-data/memories.mjs';
import {ensureSeedMemories, seedIsCurrent, seedOrder} from '../lib/knowledge-seeds.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const config = JSON.parse(fs.readFileSync(path.join(project, 'config/runtime.json'), 'utf8'));
if (opt('--root', null)) config.chatData.root = path.resolve(opt('--root'));
const memories = new BaseMemories({chatData: ChatData.open(config), memory: config.memory});
const seeds = seedOrder();
const only = opt('--only', null);
const stale = seeds.filter(id => (!only || id === only) && memories.list().some(m => m.id === id) && !seedIsCurrent(memories, id));
const dependents = (id, seen = new Set()) => { for (const m of memories.list()) if ((m.imports ?? []).some(l => l.id === id) && !seen.has(m.id)) { seen.add(m.id); dependents(m.id, seen); } return seen; };
const doomed = new Set(stale.flatMap(id => [id, ...dependents(id)]));
const blocked = [...doomed].filter(id => !seeds.includes(id) && memories.manifest(id).circuits > 0);
console.log(JSON.stringify({stale, delete: [...doomed], blocked_by_own_circuits: blocked}, null, 1));
if (blocked.length) { console.error('refusing: these memories hold circuits of their own; remove them explicitly first'); process.exit(2); }
if (!args.includes('--apply')) process.exit(0);
for (const id of doomed) memories.delete(id);
console.log(JSON.stringify({recreated: ensureSeedMemories(memories, {strategy: config.memory?.engine})}));
