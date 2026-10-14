/** Topic notes: the project's living, append-only history (DS007 "Topic notes").
 *
 *   status/topics.json          the topic registry: stable id, title and scope per topic
 *   status/notes/<topic>.jsonl  one note per line, never rewritten
 *
 * A note records what the owner asked or decided, what an agent analysed,
 * suggested or observed, what an experiment obtained, a plan or an open
 * question, with links to its evidence. Notes accumulate across project
 * phases: nothing is replaced or deleted. A later note that corrects or
 * replaces an earlier one names it in `supersedes`; both stay visible and the
 * server's `/experiments/topic/<id>` page shows the chain.
 *
 * The journal (lib/journal.mjs) says *when* work happened; notes say *what was
 * learned or decided*, grouped by subject. Agents write through `appendNote`
 * or the CLI `tools/notes.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {statusDir} from './journal.mjs';

export const NOTE_KINDS = Object.freeze(['decision', 'suggestion', 'analysis', 'observation', 'experiment', 'result', 'plan', 'question', 'correction']);
const NOTE_KEYS = ['id', 'ts', 'topic', 'kind', 'author', 'title', 'body', 'links', 'supersedes'];
const REQUIRED = ['id', 'ts', 'topic', 'kind', 'author', 'title', 'body', 'links'];
const LIMITS = {id: 120, author: 80, title: 240, body: 20000, link: 500, links: 30};
const ID = /^[a-z0-9][a-z0-9-]{0,119}$/;
const TOPIC_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;

export const topicsFile = (dir = statusDir()) => path.join(dir, 'topics.json');
export const notesDir = (dir = statusDir()) => path.join(dir, 'notes');
export const notesFile = (topic, dir = statusDir()) => {
  if (!TOPIC_ID.test(String(topic))) fail(`Invalid topic id ${JSON.stringify(topic)}`);
  return path.join(notesDir(dir), `${topic}.jsonl`);
};

function fail(message) {
  const error = new Error(message);
  error.code = 'invalid_note';
  throw error;
}
const text = (value, name, max, {empty = false} = {}) => {
  if (typeof value !== 'string') fail(`${name} must be a string`);
  if (!empty && !value.trim()) fail(`${name} must not be empty`);
  if (value.length > max) fail(`${name} is longer than ${max} characters`);
};

/** Throws unless `note` is exactly one well-formed note. `topics`, when given, is the set of known topic ids. */
export function validateNote(note, {topics = null} = {}) {
  if (!note || typeof note !== 'object' || Array.isArray(note)) fail('A note is an object');
  const extra = Object.keys(note).filter(key => !NOTE_KEYS.includes(key));
  if (extra.length) fail(`Unknown note field(s): ${extra.join(', ')}`);
  for (const key of REQUIRED) if (!Object.hasOwn(note, key)) fail(`Missing note field: ${key}`);
  text(note.id, 'id', LIMITS.id);
  if (!ID.test(note.id)) fail('id uses lower-case letters, digits and hyphens');
  text(note.ts, 'ts', 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(note.ts) || !Number.isFinite(Date.parse(note.ts))) fail('ts must be an ISO 8601 timestamp with a time zone');
  text(note.topic, 'topic', 60);
  if (!TOPIC_ID.test(note.topic)) fail('topic uses lower-case letters, digits and hyphens');
  if (topics && !topics.has(note.topic)) fail(`Unknown topic ${note.topic}; add it to status/topics.json first`);
  if (!NOTE_KINDS.includes(note.kind)) fail(`kind must be one of ${NOTE_KINDS.join('|')}`);
  text(note.author, 'author', LIMITS.author);
  text(note.title, 'title', LIMITS.title);
  text(note.body, 'body', LIMITS.body);
  if (!Array.isArray(note.links) || note.links.length > LIMITS.links) fail(`links must be an array of at most ${LIMITS.links} strings`);
  for (const link of note.links) text(link, 'link', LIMITS.link);
  if (note.supersedes !== undefined && note.supersedes !== null) {
    text(note.supersedes, 'supersedes', LIMITS.id);
    if (note.supersedes === note.id) fail('A note cannot supersede itself');
  }
  return note;
}

/** The topic registry `{format, topics: [{id, title, scope}]}`; a missing file has no topics. */
export function readTopics({file = topicsFile()} = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const registry = JSON.parse(raw);
  if (registry.format !== 'chatsop-topics-v1' || !Array.isArray(registry.topics)) fail(`${file} is not a chatsop-topics-v1 registry`);
  const seen = new Set();
  for (const topic of registry.topics) {
    if (!topic || typeof topic !== 'object') fail('A topic is an object');
    text(topic.id, 'topic id', 60);
    if (!TOPIC_ID.test(topic.id)) fail(`topic id ${topic.id} uses lower-case letters, digits and hyphens`);
    if (seen.has(topic.id)) fail(`Duplicate topic id ${topic.id}`);
    seen.add(topic.id);
    text(topic.title, `${topic.id} title`, 120);
    text(topic.scope, `${topic.id} scope`, 2000);
  }
  return registry.topics;
}

/** Notes of one topic file in file order; throws with the line number on an invalid line. A missing file is empty. */
export function readTopicNotes(topic, {dir = statusDir()} = {}) {
  const file = notesFile(topic, dir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return raw.split('\n').map((line, index) => [line, index + 1]).filter(([line]) => line.trim()).map(([line, number]) => {
    try {
      const note = validateNote(JSON.parse(line));
      if (note.topic !== topic) fail(`note ${note.id} has topic ${note.topic} but is stored in ${topic}.jsonl`);
      return note;
    } catch (error) {
      throw new Error(`${file}:${number}: ${error.message}`);
    }
  });
}

/** Every note of every topic file under `status/notes/`, in file order per topic. */
export function readAllNotes({dir = statusDir()} = {}) {
  const folder = notesDir(dir);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(name => name.endsWith('.jsonl')).sort().flatMap(name => readTopicNotes(name.slice(0, -6), {dir}));
}

/** Newest first: by timestamp, then by later position in the file. */
export const newestFirst = notes => notes.map((note, index) => ({note, index}))
  .sort((a, b) => Date.parse(b.note.ts) - Date.parse(a.note.ts) || b.index - a.index).map(({note}) => note);

/**
 * Checks the whole store: every line valid, every topic known, ids unique
 * across topics and every `supersedes` naming an existing note. Returns
 * `{topics, notes, problems}`; `problems` is empty when the store is valid.
 */
export function validateStore({dir = statusDir()} = {}) {
  const problems = [];
  let topics = [], notes = [];
  try {
    topics = readTopics({file: topicsFile(dir)});
  } catch (error) {
    problems.push(error.message);
  }
  try {
    notes = readAllNotes({dir});
  } catch (error) {
    problems.push(error.message);
  }
  const known = new Set(topics.map(topic => topic.id));
  const ids = new Map();
  for (const note of notes) {
    if (!known.has(note.topic)) problems.push(`${note.id}: unknown topic ${note.topic}`);
    if (ids.has(note.id)) problems.push(`duplicate note id ${note.id}`);
    ids.set(note.id, note);
  }
  for (const note of notes) if (note.supersedes && !ids.has(note.supersedes)) problems.push(`${note.id}: supersedes unknown note ${note.supersedes}`);
  return {topics, notes, problems};
}

/** A readable, stable id: `<topic>-<yyyymmdd-hhmmss>-<6 hex of the title>`. */
export function noteId({topic, ts, title}) {
  const stamp = new Date(ts).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15).toLowerCase();
  return `${topic}-${stamp}-${createHash('sha256').update(String(title)).digest('hex').slice(0, 6)}`;
}

/** Fills defaults (time now, `CHATSOP_ACTOR` or `agent`, no links, generated id) and validates. */
export function makeNote({id, ts = new Date().toISOString(), topic, kind, author = process.env.CHATSOP_ACTOR || 'agent', title, body, links = [], supersedes} = {}, {topics = null} = {}) {
  const note = {id: id ?? 'pending', ts, topic, kind, author, title, body, links: Array.isArray(links) ? [...links] : links};
  if (supersedes) note.supersedes = supersedes;
  validateNote(note, {topics});
  if (id === undefined) note.id = noteId({topic, ts, title});
  return validateNote(note, {topics});
}

/**
 * Appends one validated note to `status/notes/<topic>.jsonl`. The topic must
 * be registered, the id must be new across the whole store, and `supersedes`
 * must name an existing note. The file is only opened for appending; a file
 * whose last byte is not a newline is refused rather than repaired.
 */
export function appendNote(input, {dir = statusDir()} = {}) {
  const topics = new Set(readTopics({file: topicsFile(dir)}).map(topic => topic.id));
  const note = makeNote(input, {topics});
  // A `decision` note records an owner decision; an agent records its own technical choice as a `plan` (or `analysis`).
  if (note.kind === 'decision' && note.author !== 'owner') fail(`kind decision is reserved for the owner's decisions (author owner); record an agent's own choice with --kind plan`);
  const existing = readAllNotes({dir});
  if (existing.some(other => other.id === note.id)) fail(`A note with id ${note.id} already exists; notes are never replaced, use supersedes`);
  if (note.supersedes && !existing.some(other => other.id === note.supersedes)) fail(`supersedes names unknown note ${note.supersedes}`);
  const file = notesFile(note.topic, dir);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const size = fs.statSync(file, {throwIfNoEntry: false})?.size ?? 0;
  if (size > 0) {
    const fd = fs.openSync(file, 'r');
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) fail(`${file} does not end with a newline; refusing to append to a damaged notes file`);
    } finally {
      fs.closeSync(fd);
    }
  }
  fs.appendFileSync(file, JSON.stringify(note) + '\n', {flag: 'a'});
  return note;
}

/** Maps each note id to the ids of the notes that supersede it. */
export function supersededBy(notes) {
  const map = new Map();
  for (const note of notes) if (note.supersedes) map.set(note.supersedes, [...(map.get(note.supersedes) ?? []), note.id]);
  return map;
}
