#!/usr/bin/env node
/** Project journal CLI: agents log meaningful work and owner decisions from the
 * shell; the owner sees them live on the server's `/experiments` pages.
 *
 *   node tools/journal.mjs add --area data --title "Pilot regenerated" --detail "…" \
 *        [--state started|progress|done|blocked|decision] [--actor name] [--link path]… [--ts ISO]
 *   node tools/journal.mjs list [--area data] [--limit 20]
 *   node tools/journal.mjs validate
 *
 * `--link` may repeat. The actor defaults to `CHATSOP_ACTOR`, else `agent`;
 * `CHATSOP_STATUS_DIR` points at another status directory (tests, scratch).
 * The journal is append-only: this tool never edits or removes a line.
 */
import {appendJournal, readJournal, readExperiments, recentEvents, journalFile, JOURNAL_AREAS, JOURNAL_STATES} from '../lib/journal.mjs';

const USAGE = `usage:
  node tools/journal.mjs add --area <${JOURNAL_AREAS.join('|')}> --title <text> [--detail <text>]
                             [--state <${JOURNAL_STATES.join('|')}>] [--actor <name>] [--link <path or URL>]... [--ts <ISO time>]
  node tools/journal.mjs list [--area <area>] [--limit <n>]
  node tools/journal.mjs validate`;

/** Parses `--flag value` pairs; `--link` may repeat. */
function options(argv) {
  const out = {links: []};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}\n${USAGE}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    index++;
    if (flag === '--link') out.links.push(value);
    else if (['--area', '--title', '--detail', '--state', '--actor', '--ts', '--limit'].includes(flag)) {
      if (Object.hasOwn(out, flag.slice(2))) throw new Error(`Duplicate option ${flag}`);
      out[flag.slice(2)] = value;
    } else throw new Error(`Unknown option ${flag}\n${USAGE}`);
  }
  return out;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === 'help') return console.log(USAGE);
  if (command === 'add') {
    const {area, title, detail = '', state = 'done', actor, ts, links} = options(rest);
    const event = appendJournal({area, title, detail, state, links, ...(actor ? {actor} : {}), ...(ts ? {ts} : {})});
    return console.log(JSON.stringify(event));
  }
  if (command === 'list') {
    const {area = null, limit = '20'} = options(rest);
    for (const event of recentEvents({area, limit: Math.max(1, Number(limit) || 20)})) console.log(`${event.ts}  [${event.area}/${event.state}] ${event.title}  (${event.actor})`);
    return;
  }
  if (command === 'validate') {
    const events = readJournal();
    const {experiments} = readExperiments();
    return console.log(JSON.stringify({journal: journalFile(), events: events.length, experiments: experiments.length, valid: true}));
  }
  throw new Error(`Unknown command ${command}\n${USAGE}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
