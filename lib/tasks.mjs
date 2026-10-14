/** Task registry: one record per major piece of project work, shown as its own
 * page under `/experiments/<id>` (DS007 "Tasks and topic notes", DS009).
 *
 *   status/tasks.json   {format: 'chatsop-tasks-v1', tasks: [...]}
 *
 * A task record keeps the two sides of a piece of work apart: `owner` (what the
 * owner asked, why, and the owner's decisions and corrections) and `agents`
 * (what was analysed, tried and run, including failed attempts, what was
 * obtained, the conclusions). Both are Markdown. The detailed, append-only
 * stack behind a page is the topic notes (lib/notes.mjs) and the journal
 * (lib/journal.mjs), related to the task through `topics`, `experiments` and
 * the `match` phrases. Preregistered experiments, baselines and data studies
 * keep their frozen records in `status/experiments.json`; a task names them in
 * `experiments`. Several agents may write this file: re-read it immediately
 * before writing, change only your own records, never drop fields you do not own.
 */
import fs from 'node:fs';
import path from 'node:path';
import {statusDir} from './journal.mjs';

export const TASK_KINDS = Object.freeze(['task', 'experiment']);
export const TASK_STATUSES = Object.freeze(['open', 'running', 'paused', 'blocked', 'done', 'abandoned']);
/** Path segments under /experiments/ that are pages, never task ids. */
export const RESERVED_IDS = Object.freeze(['api', 'topics', 'topic', 'reports', 'report', 'timeline', 'questions', 'tasks']);
const KEYS = ['id', 'kind', 'title', 'status', 'started_at', 'updated_at', 'summary', 'topics', 'experiments', 'match', 'owner', 'agents', 'follow_ups', 'links'];
const REQUIRED = ['id', 'kind', 'title', 'status', 'started_at', 'summary', 'owner', 'agents'];

export const tasksFile = (dir = statusDir()) => path.join(dir, 'tasks.json');

function fail(message) {
  const error = new Error(message);
  error.code = 'invalid_task';
  throw error;
}
const text = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a non-empty string`);
  if (value.length > max) fail(`${name} is longer than ${max} characters`);
};
const time = (value, name) => {
  text(value, name, 40);
  if (!Number.isFinite(Date.parse(value))) fail(`${name} must be an ISO 8601 timestamp`);
};
const list = (value, name, max = 400) => {
  if (value === undefined) return;
  if (!Array.isArray(value)) fail(`${name} must be a list`);
  for (const item of value) text(item, `${name} item`, max);
};

/** Throws unless `task` is a well-formed task record. */
export function validateTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('A task is an object');
  const extra = Object.keys(task).filter(key => !KEYS.includes(key));
  if (extra.length) fail(`${task.id ?? 'task'}: unknown field(s) ${extra.join(', ')}`);
  for (const key of REQUIRED) if (!Object.hasOwn(task, key)) fail(`${task.id ?? 'task'}: missing field ${key}`);
  text(task.id, 'id', 80);
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(task.id)) fail(`task id ${task.id} uses lower-case letters, digits, . or -`);
  if (RESERVED_IDS.includes(task.id)) fail(`task id ${task.id} is reserved for a page`);
  if (!TASK_KINDS.includes(task.kind)) fail(`${task.id}: kind must be one of ${TASK_KINDS.join('|')}`);
  if (!TASK_STATUSES.includes(task.status)) fail(`${task.id}: status must be one of ${TASK_STATUSES.join('|')}`);
  text(task.title, `${task.id} title`, 200);
  time(task.started_at, `${task.id} started_at`);
  if (task.updated_at !== undefined) time(task.updated_at, `${task.id} updated_at`);
  text(task.summary, `${task.id} summary`, 2000);
  text(task.owner, `${task.id} owner`, 20000);
  text(task.agents, `${task.id} agents`, 30000);
  for (const key of ['topics', 'experiments', 'match', 'links']) list(task[key], `${task.id} ${key}`);
  list(task.follow_ups, `${task.id} follow_ups`, 2000);
  return task;
}

/** The task records; a missing file has no tasks. Ids are unique. */
export const readTasks = ({file = tasksFile()} = {}) => readTaskRegistry({file}).tasks;

/** The whole registry: `phase` (the current project phase as last written by an agent: name, since, detail) and `tasks`. */
export function readTaskRegistry({file = tasksFile()} = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {phase: null, tasks: []};
    throw error;
  }
  const registry = JSON.parse(raw);
  if (registry.format !== 'chatsop-tasks-v1' || !Array.isArray(registry.tasks)) fail(`${file} is not a chatsop-tasks-v1 registry`);
  const ids = new Set();
  for (const task of registry.tasks) {
    validateTask(task);
    if (ids.has(task.id)) fail(`Duplicate task id ${task.id}`);
    ids.add(task.id);
  }
  const phase = registry.phase ?? null;
  if (phase !== null) {
    text(phase?.name, 'phase name', 300);
    time(phase.since, 'phase since');
    if (phase.detail !== undefined) text(phase.detail, 'phase detail', 4000);
  }
  return {phase, tasks: registry.tasks};
}

/** True when a journal event or note mentions one of the task's match phrases (case-insensitive) or experiment ids. */
export function mentions(task, ...texts) {
  const phrases = [...(task.match ?? []), ...(task.experiments ?? [])].map(phrase => phrase.toLowerCase());
  if (!phrases.length) return false;
  const haystack = texts.flat().filter(Boolean).join('\n').toLowerCase();
  return phrases.some(phrase => haystack.includes(phrase));
}
