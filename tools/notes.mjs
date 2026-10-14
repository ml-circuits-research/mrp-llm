#!/usr/bin/env node
/** Topic notes CLI: agents record decisions, suggestions, analyses,
 * observations, experiments, results, plans, questions and corrections under a
 * topic; the owner reads them on the server's `/experiments` pages.
 *
 *   node tools/notes.mjs add --topic evaluation --kind result --title "…" --body "…" \
 *        [--body-file notes.md] [--author name] [--link path]… [--supersedes <note id>] [--ts ISO] [--id <id>]
 *   node tools/notes.mjs list [--topic evaluation] [--kind result] [--limit 20]
 *   node tools/notes.mjs topics
 *   node tools/notes.mjs validate
 *
 * `--link` may repeat. The author defaults to `CHATSOP_ACTOR`, else `agent`;
 * `CHATSOP_STATUS_DIR` points at another status directory (tests, scratch).
 * Notes are append-only: this tool never edits or removes a line. A correction
 * is a new note whose `--supersedes` names the note it corrects.
 */
import fs from 'node:fs';
import {appendNote, readAllNotes, readTopics, validateStore, newestFirst, topicsFile, NOTE_KINDS} from '../lib/notes.mjs';

const USAGE = `usage:
  node tools/notes.mjs add --topic <id> --kind <${NOTE_KINDS.join('|')}> --title <text>
                           (--body <markdown> | --body-file <path>) [--author <name>] [--link <path or URL>]...
                           [--supersedes <note id>] [--ts <ISO time>] [--id <note id>]
  node tools/notes.mjs list [--topic <id>] [--kind <kind>] [--limit <n>]
  node tools/notes.mjs topics
  node tools/notes.mjs validate`;

const SINGLE = ['--topic', '--kind', '--title', '--body', '--body-file', '--author', '--supersedes', '--ts', '--id', '--limit'];

/** Parses `--flag value` pairs; `--link` may repeat. */
function options(argv) {
  const out = {links: []};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}\n${USAGE}`);
    const value = argv[index + 1];
    if (value === undefined || (value.startsWith('--') && flag !== '--body')) throw new Error(`Missing value for ${flag}`);
    index++;
    if (flag === '--link') out.links.push(value);
    else if (SINGLE.includes(flag)) {
      const key = flag.slice(2);
      if (Object.hasOwn(out, key)) throw new Error(`Duplicate option ${flag}`);
      out[key] = value;
    } else throw new Error(`Unknown option ${flag}\n${USAGE}`);
  }
  return out;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === 'help') return console.log(USAGE);
  if (command === 'add') {
    const opts = options(rest);
    if (opts.body !== undefined && opts['body-file'] !== undefined) throw new Error('Give --body or --body-file, not both');
    const body = opts['body-file'] !== undefined ? fs.readFileSync(opts['body-file'], 'utf8').trimEnd() : opts.body;
    const note = appendNote({
      topic: opts.topic, kind: opts.kind, title: opts.title, body, links: opts.links,
      ...(opts.author ? {author: opts.author} : {}), ...(opts.ts ? {ts: opts.ts} : {}), ...(opts.id ? {id: opts.id} : {}), ...(opts.supersedes ? {supersedes: opts.supersedes} : {}),
    });
    return console.log(JSON.stringify(note));
  }
  if (command === 'list') {
    const {topic = null, kind = null, limit = '20'} = options(rest);
    const notes = newestFirst(readAllNotes()).filter(note => (!topic || note.topic === topic) && (!kind || note.kind === kind));
    for (const note of notes.slice(0, Math.max(1, Number(limit) || 20)))
      console.log(`${note.ts}  [${note.topic}/${note.kind}] ${note.title}  (${note.author})  ${note.id}${note.supersedes ? `  supersedes ${note.supersedes}` : ''}`);
    return;
  }
  if (command === 'topics') {
    const notes = readAllNotes();
    for (const topic of readTopics()) console.log(`${topic.id.padEnd(24)} ${String(notes.filter(note => note.topic === topic.id).length).padStart(4)}  ${topic.title}`);
    return;
  }
  if (command === 'validate') {
    const {topics, notes, problems} = validateStore();
    console.log(JSON.stringify({topics_file: topicsFile(), topics: topics.length, notes: notes.length, valid: problems.length === 0, problems}));
    if (problems.length) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command ${command}\n${USAGE}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
