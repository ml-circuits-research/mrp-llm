#!/usr/bin/env node
/**
 * Maintenance of the chat data root (DS022).
 *
 *   node tools/chat-data.mjs status                     the root, counts and TTLs
 *   node tools/chat-data.mjs cleanup [--dry-run]        remove expired tmp folders and abandoned sessions
 *   node tools/chat-data.mjs drop-legacy [--dry-run]    remove the chat storage earlier versions kept under state/
 *
 * `CHATSOP_CHAT_DATA` and `CHATSOP_CONFIG` select another root and configuration. Never run `drop-legacy` while a server that
 * uses the old state folder is running: stop it first.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ChatData, dropLegacyStorage, legacyStorage} from '../lib/chat-data/index.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(process.env.CHATSOP_CONFIG ?? path.join(project, 'config/runtime.json'), 'utf8'));
const [command = 'status', ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');
const stateRoot = path.resolve(project, config.root ?? 'state');
const data = ChatData.open(config);

if (command === 'status') console.log(JSON.stringify({...data.stats(), legacy: legacyStorage(stateRoot).map(p => path.relative(stateRoot, p))}, null, 2));
else if (command === 'cleanup') console.log(JSON.stringify(data.cleanup({dryRun}), null, 2));
else if (command === 'drop-legacy') console.log(JSON.stringify(dropLegacyStorage(stateRoot, {dryRun}), null, 2));
else { console.error('Usage: chat-data.mjs status | cleanup [--dry-run] | drop-legacy [--dry-run]'); process.exit(2); }
