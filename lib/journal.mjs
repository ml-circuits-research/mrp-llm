/** Project journal: an append-only JSONL log of meaningful work and owner
 * decisions, plus the experiment registry. The owner reads both live on the
 * server's `/experiments` pages; agents write through `appendJournal` or the CLI
 * `tools/journal.mjs`.
 *
 *   status/journal.jsonl      one event per line, never rewritten
 *   status/experiments.json   registry of experiments, reference baselines and data studies (DS007)
 *
 * The journal is a record of what happened, not product documentation and not
 * evidence of a result by itself: a `done` event points at its evidence through
 * `links`. Appending never rewrites or reorders earlier lines.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const JOURNAL_AREAS = Object.freeze(['data', 'language', 'eval', 'training', 'server', 'docs', 'process']);
export const JOURNAL_STATES = Object.freeze(['started', 'progress', 'done', 'blocked', 'decision']);
export const EXPERIMENT_STATUSES = Object.freeze(['proposed', 'preregistered', 'approved', 'running', 'done', 'abandoned']);
/** DS007 "Experiments": a preregistered experiment has a frozen record; a reference baseline or a data study is
 * recorded with the same fields but its `preregistration` says `none: <why>`. A missing category is `preregistered`. */
export const EXPERIMENT_CATEGORIES = Object.freeze(['preregistered', 'reference-baseline', 'data-study']);
const EVENT_KEYS = ['ts', 'area', 'actor', 'title', 'detail', 'links', 'state'];
const LIMITS = {actor: 80, title: 200, detail: 8000, link: 500, links: 20};

/** The status directory: `CHATSOP_STATUS_DIR` when set, else `<repo>/status`. */
export const statusDir = () => (process.env.CHATSOP_STATUS_DIR ? path.resolve(process.env.CHATSOP_STATUS_DIR) : path.join(projectRoot, 'status'));
export const journalFile = (dir = statusDir()) => path.join(dir, 'journal.jsonl');
export const experimentsFile = (dir = statusDir()) => path.join(dir, 'experiments.json');

const fail = message => {
  const error = new Error(message);
  error.code = 'invalid_journal_event';
  throw error;
};
const text = (value, name, max, {empty = false} = {}) => {
  if (typeof value !== 'string') fail(`${name} must be a string`);
  if (!empty && !value.trim()) fail(`${name} must not be empty`);
  if (value.length > max) fail(`${name} is longer than ${max} characters`);
};

/** Throws unless `event` is exactly one well-formed journal event. Returns the event. */
export function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail('A journal event is an object');
  const extra = Object.keys(event).filter(key => !EVENT_KEYS.includes(key));
  if (extra.length) fail(`Unknown journal field(s): ${extra.join(', ')}`);
  for (const key of EVENT_KEYS) if (!Object.hasOwn(event, key)) fail(`Missing journal field: ${key}`);
  text(event.ts, 'ts', 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(event.ts) || !Number.isFinite(Date.parse(event.ts))) fail('ts must be an ISO 8601 timestamp with a time zone');
  if (!JOURNAL_AREAS.includes(event.area)) fail(`area must be one of ${JOURNAL_AREAS.join('|')}`);
  if (!JOURNAL_STATES.includes(event.state)) fail(`state must be one of ${JOURNAL_STATES.join('|')}`);
  text(event.actor, 'actor', LIMITS.actor);
  text(event.title, 'title', LIMITS.title);
  text(event.detail, 'detail', LIMITS.detail, {empty: true});
  if (!Array.isArray(event.links) || event.links.length > LIMITS.links) fail(`links must be an array of at most ${LIMITS.links} strings`);
  for (const link of event.links) text(link, 'link', LIMITS.link);
  return event;
}

/** Fills the defaults of a new event: current time, `CHATSOP_ACTOR` or `agent`, no links, `done`. */
export function makeEvent({ts = new Date().toISOString(), area, actor = process.env.CHATSOP_ACTOR || 'agent', title, detail = '', links = [], state = 'done'} = {}) {
  return validateEvent({ts, area, actor, title, detail, links: Array.isArray(links) ? [...links] : links, state});
}

/**
 * Appends one validated event as one line. The file is only ever opened for
 * appending, so earlier lines are never rewritten; a file whose last line is
 * not newline-terminated is refused rather than repaired.
 */
export function appendJournal(event, {file = journalFile()} = {}) {
  const record = makeEvent(event);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const size = fs.statSync(file, {throwIfNoEntry: false})?.size ?? 0;
  if (size > 0) {
    const fd = fs.openSync(file, 'r');
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) fail(`${file} does not end with a newline; refusing to append to a damaged journal`);
    } finally {
      fs.closeSync(fd);
    }
  }
  fs.appendFileSync(file, JSON.stringify(record) + '\n', {flag: 'a'});
  return record;
}

/** Every event in file order; throws with the line number on an invalid line. A missing file is an empty journal. */
export function readJournal({file = journalFile()} = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return raw.split('\n').map((line, index) => [line, index + 1]).filter(([line]) => line.trim()).map(([line, number]) => {
    try {
      return validateEvent(JSON.parse(line));
    } catch (error) {
      throw new Error(`${file}:${number}: ${error.message}`);
    }
  });
}

/** Events newest first, optionally filtered by area and state and limited. */
export function recentEvents({file = journalFile(), area = null, state = null, limit = Infinity} = {}) {
  return readJournal({file})
    .map((event, index) => ({event, index}))
    .filter(({event}) => (!area || event.area === area) && (!state || event.state === state))
    .sort((a, b) => Date.parse(b.event.ts) - Date.parse(a.event.ts) || b.index - a.index)
    .slice(0, limit)
    .map(({event}) => event);
}

/** Throws unless `experiment` is a well-formed registry entry. */
export function validateExperiment(experiment) {
  if (!experiment || typeof experiment !== 'object' || Array.isArray(experiment)) fail('An experiment is an object');
  text(experiment.id, 'experiment id', 80);
  if (!/^[A-Za-z0-9_.-]+$/.test(experiment.id)) fail('experiment id uses letters, digits, _ . or -');
  text(experiment.hypothesis, 'hypothesis', 2000);
  text(experiment.preregistration, 'preregistration', 500);
  text(experiment.data_version, 'data_version', 500);
  if (!EXPERIMENT_STATUSES.includes(experiment.status)) fail(`status must be one of ${EXPERIMENT_STATUSES.join('|')}`);
  if (experiment.category !== undefined && !EXPERIMENT_CATEGORIES.includes(experiment.category)) fail(`category must be one of ${EXPERIMENT_CATEGORIES.join('|')}`);
  for (const key of ['name', 'done', 'results_summary', 'owner']) if (experiment[key] !== undefined && experiment[key] !== null) text(experiment[key], key, 4000);
  for (const key of ['datasets', 'models', 'metrics', 'deviations', 'reports']) {
    if (experiment[key] !== undefined && !Array.isArray(experiment[key])) fail(`${key} must be a list`);
  }
  for (const key of ['results', 'conclusions']) if (experiment[key] !== undefined && experiment[key] !== null && typeof experiment[key] !== 'string' && typeof experiment[key] !== 'object') fail(`${key} must be text, an object or null`);
  return experiment;
}

/** The experiment registry; a missing file is an empty registry. */
export function readExperiments({file = experimentsFile()} = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {format: 'chatsop-experiments-v1', experiments: []};
    throw error;
  }
  const registry = JSON.parse(raw);
  if (registry.format !== 'chatsop-experiments-v1' || !Array.isArray(registry.experiments)) fail(`${file} is not a chatsop-experiments-v1 registry`);
  const ids = new Set();
  for (const experiment of registry.experiments) {
    validateExperiment(experiment);
    if (ids.has(experiment.id)) fail(`Duplicate experiment id ${experiment.id}`);
    ids.add(experiment.id);
  }
  return registry;
}
