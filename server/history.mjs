/** Project history data for the `/experiments` pages (DS009): the task and
 * experiment index, one page per task or experiment, the topic note stacks,
 * the read-only report viewer and the owner's open questions.
 *
 * Everything is computed from files on each request: `status/tasks.json`
 * (lib/tasks.mjs), `status/experiments.json` and `status/journal.jsonl`
 * (lib/journal.mjs), `status/topics.json` and `status/notes/*.jsonl`
 * (lib/notes.mjs), `questions.md` and the reports under `eval/reports/current`
 * and `eval/reports/history`. Lists are newest first. Reading never writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJournal, readExperiments, journalFile, experimentsFile, statusDir} from '../lib/journal.mjs';
import {readTopics, readAllNotes, topicsFile, newestFirst, supersededBy} from '../lib/notes.mjs';
import {readTaskRegistry, tasksFile, mentions} from '../lib/tasks.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BASE = '/experiments';
export const REPORT_ROOTS = Object.freeze(['eval/reports/current', 'eval/reports/history']);
/** Viewable report types; anything else is listed but not served. */
export const REPORT_TYPES = Object.freeze({'.md': 'markdown', '.json': 'json', '.jsonl': 'text', '.log': 'text', '.txt': 'text'});
/** Directories of per-call caches and test leftovers, listed as hidden rather than expanded. */
const HIDDEN_DIR = /^(cache|registry-test-complete-)/;
/** Reports larger than this are shown as a head preview, never parsed whole. */
export const RENDER_LIMIT = 2 * 1024 * 1024;
const PREVIEW_BYTES = 96 * 1024;
/** Repository Markdown the server serves read-only as text (a subset of server/http.mjs REPO_MARKDOWN whose relative links resolve on the site). */
const SERVED_MARKDOWN = /^(?:skills\/(?:README\.md|[A-Za-z0-9-]+\/SKILL\.md)|eval\/README\.md)$/;

/** The current file of a specification, following docs/specs/aliases.json for former ids (renamed or merged). */
function currentSpec(root, name) {
  const dir = path.join(root, 'docs/specs');
  if (fs.existsSync(path.join(dir, name))) return name;
  let aliases;
  try {
    aliases = JSON.parse(fs.readFileSync(path.join(dir, 'aliases.json'), 'utf8')).ids ?? {};
  } catch {
    return null;
  }
  const alias = Object.values(aliases).find(entry => entry.was === name);
  const target = alias?.file ?? (alias?.merged ? fs.readdirSync(dir).find(file => file.startsWith(alias.merged + '-') && file.endsWith('.md')) : null);
  return target && fs.existsSync(path.join(dir, target)) ? target : null;
}

const fail = (message, status = 400, code = 'invalid_request') => Object.assign(new Error(message), {status, code});
const byTsDesc = (a, b) => Date.parse(b.ts) - Date.parse(a.ts);
const safe = fn => {
  try {
    return {value: fn(), error: null};
  } catch (error) {
    return {value: null, error: error.message};
  }
};

/**
 * Resolves a repository-relative report path inside one of REPORT_ROOTS.
 * Refuses absolute paths, `..`, NUL, backslashes and any path whose real
 * location (after symlinks) leaves the root. Returns `{abs, rel}`.
 */
export function resolveReportPath(root, relative, {directory = false} = {}) {
  if (typeof relative !== 'string' || !relative || relative.length > 400 || /[\0\\]/.test(relative) || relative.startsWith('/')) throw fail('Invalid report path');
  const rel = path.posix.normalize(relative).replace(/\/+$/, '');
  if (rel.split('/').includes('..')) throw fail('Invalid report path');
  const base = REPORT_ROOTS.find(prefix => rel === prefix || rel.startsWith(prefix + '/'));
  if (!base) throw fail('Reports are served only from eval/reports/current and eval/reports/history');
  const abs = path.resolve(root, rel);
  let real, realBase;
  try {
    real = fs.realpathSync(abs);
    realBase = fs.realpathSync(path.resolve(root, base));
  } catch {
    throw fail('No such report', 404, 'not_found');
  }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) throw fail('Invalid report path');
  const stat = fs.statSync(real);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw fail(directory ? 'Not a report directory' : 'Not a report file', 404, 'not_found');
  if (!directory && !REPORT_TYPES[path.extname(rel).toLowerCase()]) throw fail('Only Markdown, JSON, JSONL, log and text reports are viewable');
  return {abs: real, rel};
}

/** A directory listing, newest first: sub-directories and files with type, size and time. */
export function listReports(root = projectRoot, dir = null) {
  if (!dir) {
    const roots = REPORT_ROOTS.filter(prefix => fs.existsSync(path.join(root, prefix))).map(prefix => {
      const stat = fs.statSync(path.join(root, prefix));
      return {path: prefix, name: prefix, entries: fs.readdirSync(path.join(root, prefix)).length, mtime: stat.mtime.toISOString(), historical: prefix.endsWith('history')};
    });
    return {dir: null, parent: null, dirs: roots, files: [], hidden: []};
  }
  const {abs, rel} = resolveReportPath(root, dir, {directory: true});
  const dirs = [], files = [], hidden = [];
  for (const entry of fs.readdirSync(abs, {withFileTypes: true})) {
    const child = path.posix.join(rel, entry.name);
    let stat;
    try {
      stat = fs.statSync(path.join(abs, entry.name));
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const item = {path: child, name: entry.name, entries: fs.readdirSync(path.join(abs, entry.name)).length, mtime: stat.mtime.toISOString()};
      (HIDDEN_DIR.test(entry.name) ? hidden : dirs).push(item);
    } else if (stat.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      files.push({path: child, name: entry.name, size: stat.size, mtime: stat.mtime.toISOString(), type: REPORT_TYPES[ext] ?? null});
    }
  }
  const newest = (a, b) => Date.parse(b.mtime) - Date.parse(a.mtime) || a.name.localeCompare(b.name);
  const parent = REPORT_ROOTS.includes(rel) ? null : path.posix.dirname(rel);
  return {dir: rel, parent, historical: rel.startsWith('eval/reports/history'), dirs: dirs.sort(newest), files: files.sort(newest), hidden: hidden.sort(newest)};
}

/** Reads one report for display: Markdown text, parsed JSON (small files) or a text preview. */
export function readReport(root = projectRoot, relative) {
  const {abs, rel} = resolveReportPath(root, relative);
  const stat = fs.statSync(abs);
  const type = REPORT_TYPES[path.extname(rel).toLowerCase()];
  const meta = {path: rel, size: stat.size, mtime: stat.mtime.toISOString(), type, historical: rel.startsWith('eval/reports/history')};
  if (stat.size > RENDER_LIMIT) {
    const fd = fs.openSync(abs, 'r');
    try {
      const buffer = Buffer.alloc(PREVIEW_BYTES);
      const read = fs.readSync(fd, buffer, 0, PREVIEW_BYTES, 0);
      return {...meta, truncated: true, text: buffer.toString('utf8', 0, read)};
    } finally {
      fs.closeSync(fd);
    }
  }
  const text = fs.readFileSync(abs, 'utf8');
  if (type === 'json') {
    try {
      return {...meta, truncated: false, json: JSON.parse(text), text};
    } catch {
      return {...meta, truncated: false, type: 'text', text};
    }
  }
  return {...meta, truncated: false, text};
}

/**
 * Maps a link target from a note, task, journal event or experiment to a
 * served URL, or null when the site has no page for it (then it is shown as
 * code). Report files and directories must exist to be linked.
 */
export function repoLink(target, root = projectRoot) {
  const value = String(target ?? '').trim();
  if (/^https?:\/\//.test(value)) return value;
  if (value.startsWith(BASE + '/') || value === BASE) return value;
  const [pathPart, fragment = ''] = value.split('#');
  const clean = pathPart.replace(/^\.\//, '');
  const spec = /^docs\/specs\/(DS\d+[^/]*\.md|matrix\.md)$/.exec(clean);
  if (spec) {
    const file = currentSpec(root, spec[1]);
    return file ? '/docs/specsLoader.html?spec=' + encodeURIComponent(file) : null;
  }
  if (/^docs\/.+\.html$/.test(clean) && fs.existsSync(path.join(root, clean))) return '/' + clean + (fragment ? '#' + fragment : '');
  if (clean === 'questions.md') return BASE + '/questions';
  if (SERVED_MARKDOWN.test(clean) && fs.existsSync(path.join(root, clean))) return '/' + clean;
  if (REPORT_ROOTS.some(prefix => clean === prefix || clean.startsWith(prefix + '/'))) {
    try {
      const stat = fs.statSync(path.join(root, clean));
      if (stat.isDirectory()) return resolveReportPath(root, clean, {directory: true}) && BASE + '/reports?dir=' + encodeURIComponent(clean.replace(/\/+$/, ''));
      if (stat.isFile() && REPORT_TYPES[path.extname(clean).toLowerCase()]) return resolveReportPath(root, clean) && BASE + '/report?path=' + encodeURIComponent(clean);
    } catch {
      return null;
    }
  }
  return null;
}

/** Top-level headings of questions.md (the open owner questions). */
export function questions(root = projectRoot) {
  const file = path.join(root, 'questions.md');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  return {file: 'questions.md', path: file, text, mtime: fs.statSync(file).mtime.toISOString(), open: [...text.matchAll(/^##\s+(.+)$/gm)].map(match => match[1].trim())};
}

/** Every source of the history, read once; errors are reported, not thrown. */
export function loadHistory({root = projectRoot, dir = statusDir()} = {}) {
  const topics = safe(() => readTopics({file: topicsFile(dir)}));
  const notes = safe(() => readAllNotes({dir}));
  const tasks = safe(() => readTaskRegistry({file: tasksFile(dir)}));
  const journal = safe(() => readJournal({file: journalFile(dir)}));
  const registry = safe(() => readExperiments({file: experimentsFile(dir)}));
  return {
    root, dir,
    topics: topics.value ?? [], notes: newestFirst(notes.value ?? []), tasks: tasks.value?.tasks ?? [], phase: tasks.value?.phase ?? null,
    journal: (journal.value ?? []).map((event, index) => ({...event, index: index + 1})).sort((a, b) => byTsDesc(a, b) || b.index - a.index),
    experiments: registry.value?.experiments ?? [],
    errors: Object.fromEntries(Object.entries({topics, notes, tasks, journal, experiments: registry}).filter(([, result]) => result.error).map(([key, result]) => [key, result.error])),
  };
}

const experimentTime = entry => entry.registered_at ?? entry.date ?? null;

/**
 * The index entries, newest first: every task record, and every experiment
 * record that has no task of the same id (it still gets its own page).
 */
export function entries(history) {
  const taskIds = new Set(history.tasks.map(task => task.id));
  const list = history.tasks.map(task => ({
    id: task.id, kind: task.kind, title: task.title, status: task.status, started_at: task.started_at, summary: task.summary,
    updated_at: task.updated_at ?? null, experiments: task.experiments ?? [], topics: task.topics ?? [],
  }));
  for (const entry of history.experiments) {
    if (taskIds.has(entry.id)) continue;
    const parent = history.tasks.find(task => (task.experiments ?? []).includes(entry.id));
    list.push({id: entry.id, kind: 'experiment', title: entry.name ?? entry.id, status: entry.status, started_at: experimentTime(entry) ?? '1970-01-01T00:00:00Z',
      summary: entry.results_summary ?? entry.hypothesis, updated_at: null, experiments: [entry.id], topics: [], category: entry.category ?? 'preregistered', parent: parent?.id ?? null});
  }
  return list.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || a.id.localeCompare(b.id));
}

/** Topics with note counts and their latest note, in registry order. */
export function topicSummaries(history) {
  return history.topics.map(topic => {
    const notes = history.notes.filter(note => note.topic === topic.id);
    const kinds = {};
    for (const note of notes) kinds[note.kind] = (kinds[note.kind] ?? 0) + 1;
    return {...topic, count: notes.length, kinds, latest: notes[0] ?? null};
  });
}

const isOwnerEvent = event => event.state === 'decision' || /^owner/.test(event.actor);
const isOwnerNote = note => note.kind === 'decision' || /^owner/i.test(note.author);

/** One task or experiment page: the record(s), and the related notes and journal events split into owner and agent sides. */
export function entryPage(history, id) {
  const task = history.tasks.find(item => item.id === id) ?? null;
  const ids = task ? (task.experiments ?? []) : [id];
  const records = ids.map(experimentId => history.experiments.find(entry => entry.id === experimentId)).filter(Boolean);
  if (!task && !records.length) return null;
  const subject = task ?? {id, match: [id], experiments: [id], topics: []};
  const related = item => mentions(subject, item);
  const notes = history.notes.filter(note => related([note.title, note.body, note.links.join(' ')]) || (task && !(task.match ?? []).length && (task.topics ?? []).includes(note.topic)));
  const events = history.journal.filter(event => related([event.title, event.detail, event.links.join(' ')]));
  const supers = supersededBy(history.notes);
  return {
    task, records, parent: task ? null : history.tasks.find(item => (item.experiments ?? []).includes(id)) ?? null,
    owner: {notes: notes.filter(isOwnerNote), events: events.filter(isOwnerEvent)},
    agents: {notes: notes.filter(note => !isOwnerNote(note)), events: events.filter(event => !isOwnerEvent(event))},
    supersededBy: supers,
  };
}

/** One topic's full stack, newest first, with the supersede map and the distinct kinds and authors. */
export function topicPage(history, id) {
  const topic = history.topics.find(item => item.id === id);
  if (!topic) return null;
  const notes = history.notes.filter(note => note.topic === id);
  const byId = new Map(history.notes.map(note => [note.id, note]));
  const tasks = history.tasks.filter(task => (task.topics ?? []).includes(id));
  return {topic, notes, byId, supersededBy: supersededBy(history.notes), kinds: [...new Set(notes.map(note => note.kind))].sort(), authors: [...new Set(notes.map(note => note.author))].sort(), tasks};
}

/**
 * The current-status header of the index: running tasks and experiments, the
 * latest owner decisions about training, and the recent journal activity.
 * It reports what the files say; it never opens a gate.
 */
export function currentStatus(history) {
  const running = [...history.tasks.filter(task => ['running', 'open', 'paused', 'blocked'].includes(task.status)).map(task => ({id: task.id, title: task.title, status: task.status})),
    ...history.experiments.filter(entry => ['running', 'approved'].includes(entry.status) && !history.tasks.some(task => task.id === entry.id)).map(entry => ({id: entry.id, title: entry.name ?? entry.id, status: entry.status}))];
  const trainingDecisions = history.journal.filter(event => event.state === 'decision' && (event.area === 'training' || /train/i.test(event.title))).slice(0, 4);
  const latest = history.journal[0]?.ts ? Date.parse(history.journal[0].ts) : Date.now();
  const recent = history.journal.filter(event => latest - Date.parse(event.ts) <= 12 * 3600 * 1000).slice(0, 8);
  return {running, trainingDecisions, recent};
}

/** Preregistration record of an experiment, when its first token is a JSON file under status/preregistrations/. */
export function preregistrationRecord(entry, root = projectRoot) {
  const first = String(entry.preregistration ?? '').split(/\s+/)[0];
  if (!/^status\/preregistrations\/[A-Za-z0-9_.-]+\.json$/.test(first)) return null;
  const file = path.join(root, first);
  if (!fs.existsSync(file)) return {path: first, missing: true};
  try {
    return {path: first, json: JSON.parse(fs.readFileSync(file, 'utf8'))};
  } catch (error) {
    return {path: first, error: error.message};
  }
}
