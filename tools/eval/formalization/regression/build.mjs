#!/usr/bin/env node
/**
 * Builds or extends the formalization regression set from the inbox (tools/eval/formalization/regression/cases.mjs):
 *   node tools/eval/formalization/regression/build.mjs [--dry-run]
 * Appends new cases and new observations to eval/formalization-regression/cases.jsonl; never removes a case.
 */
import {mergeInbox, mergeChat, writeCases, CASES} from './cases.mjs';
import path from 'node:path';
import {ROOT} from './cases.mjs';
import {pathToFileURL} from 'node:url';

// Runs only as a command: importing this module (e.g. to check it loads) must not rewrite the case file.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const {cases, added, updated, refused} = mergeInbox();
  const chat = mergeChat(cases);
  if (!process.argv.includes('--dry-run')) writeCases(cases);
  console.log(JSON.stringify({file: path.relative(ROOT, CASES), cases: cases.length, runnable: cases.filter(c => c.runnable).length, added: added.length, chat_added: chat.length, updated: updated.length, refused: refused.length}));
}
