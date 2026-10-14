/**
 * The chat data root (DS022 "Chat data root"): the one gitignored folder that holds everything a chat produces.
 *
 *   chat_data/base_memories/<id>/   a base memory: manifest.json, repo/ (the memory store of one strategy), circuits/, provenance.jsonl
 *   chat_data/sessions/<id>/        a chat session: session.json, repo/ (clone of its base), circuits/, drafts/, requests/, transcript.jsonl
 *   chat_data/cache/lexicon/        compiled lexicons by circuit hash (a cache: safe to delete)
 *   chat_data/tmp/                  temporary folders (one per authoring request that has no session), removed by the cleanup policy
 *
 * The root is `chatData.root` of config/runtime.json (relative to the project), overridden by CHATSOP_CHAT_DATA. This module
 * knows paths, temporary folders, the cleanup policy and the legacy storage that earlier versions kept under `state/`; the
 * base memories and the sessions have their own modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {LexiconCache} from './lexicons.mjs';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_CHAT_DATA = Object.freeze({root: 'chat_data', tmpTtlHours: 24, sessionTtlDays: 14, cleanupIntervalMinutes: 60});
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Identifiers of folders on disk: lowercase letters, digits, `_` and `-`, so a user value can never name a path. */
export const FOLDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertFolderId(id, what = 'identifier') {
  if (typeof id !== 'string' || !FOLDER_ID.test(id)) throw Object.assign(new Error(`Invalid ${what}: use 1 to 64 lowercase letters, digits, _ or -`), {status: 400, code: 'invalid_id'});
  return id;
}

/** A fresh identifier: `<prefix>-<base36 time>-<random>`. */
export const newId = (prefix, now = Date.now()) => `${prefix}-${now.toString(36)}-${randomBytes(3).toString('hex')}`;

/** The resolved settings of the chat data root from the runtime configuration and the environment. */
export function chatDataSettings(config = {}, env = process.env, project = PROJECT) {
  const merged = {...DEFAULT_CHAT_DATA, ...(config.chatData ?? {})};
  const root = path.resolve(project, env.CHATSOP_CHAT_DATA || merged.root);
  for (const key of ['tmpTtlHours', 'sessionTtlDays', 'cleanupIntervalMinutes']) {
    if (!(Number(merged[key]) > 0)) throw new Error(`chatData.${key} must be a positive number`);
  }
  return {...merged, root};
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

export class ChatData {
  constructor(settings) {
    this.settings = settings;
    this.root = settings.root;
    this.baseMemoriesDir = path.join(this.root, 'base_memories');
    this.sessionsDir = path.join(this.root, 'sessions');
    this.tmpDir = path.join(this.root, 'tmp');
    this.cacheDir = path.join(this.root, 'cache');
    this.modelsDir = path.join(this.root, 'models');
    /** Compiled lexicons of base memories and sessions, shared by every memory and session of this chat data root. */
    this.lexicons = new LexiconCache(path.join(this.cacheDir, 'lexicon'));
    for (const dir of [this.baseMemoriesDir, this.sessionsDir, this.tmpDir]) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  }

  static open(config, env, project) { return new ChatData(chatDataSettings(config, env, project)); }

  /** A new temporary folder under `tmp/`; the caller removes it or leaves it to the cleanup policy. */
  tmpFolder(prefix = 'tmp') {
    assertFolderId(prefix, 'temporary folder prefix');
    const dir = path.join(this.tmpDir, newId(prefix));
    fs.mkdirSync(dir, {mode: 0o700});
    return dir;
  }

  /** Newest modification time of a folder tree (a folder of an active session changes as its files do). */
  newestMtime(dir) {
    let newest = fs.statSync(dir).mtimeMs;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      newest = Math.max(newest, entry.isDirectory() ? this.newestMtime(full) : fs.lstatSync(full).mtimeMs);
    }
    return newest;
  }

  /**
   * The cleanup policy. Temporary folders older than `tmpTtlHours` go. A session whose `last_active_at` (or, without one, its newest
   * file) is older than `sessionTtlDays` is abandoned and goes, unless it is `kept` in session.json. Base memories are never removed
   * here. `dryRun` reports without deleting.
   */
  cleanup({now = Date.now(), dryRun = false} = {}) {
    const tmpMs = this.settings.tmpTtlHours * HOUR;
    const sessionMs = this.settings.sessionTtlDays * DAY;
    const report = {dryRun, tmp: [], sessions: [], kept: []};
    for (const name of fs.readdirSync(this.tmpDir)) {
      const dir = path.join(this.tmpDir, name);
      if (now - this.newestMtime(dir) > tmpMs) report.tmp.push(name);
    }
    for (const name of fs.readdirSync(this.sessionsDir)) {
      const dir = path.join(this.sessionsDir, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const info = readJson(path.join(dir, 'session.json'), {});
      if (info.kept) { report.kept.push(name); continue; }
      const last = Date.parse(info.last_active_at ?? '') || this.newestMtime(dir);
      if (now - last > sessionMs) report.sessions.push(name);
    }
    if (!dryRun) {
      for (const name of report.tmp) fs.rmSync(path.join(this.tmpDir, name), {recursive: true, force: true});
      for (const name of report.sessions) fs.rmSync(path.join(this.sessionsDir, name), {recursive: true, force: true});
    }
    return report;
  }

  /** Runs the cleanup now and then every `cleanupIntervalMinutes`; the returned function stops the timer. */
  scheduleCleanup(onReport = () => {}) {
    const run = () => { try { onReport(this.cleanup()); } catch (error) { onReport({error: error.message}); } };
    run();
    const timer = setInterval(run, this.settings.cleanupIntervalMinutes * 60_000);
    timer.unref();
    return () => clearInterval(timer);
  }

  stats() {
    const count = dir => fs.readdirSync(dir).length;
    return {root: this.root, base_memories: count(this.baseMemoriesDir), sessions: count(this.sessionsDir), tmp: count(this.tmpDir), ttl: {tmp_hours: this.settings.tmpTtlHours, session_days: this.settings.sessionTtlDays}};
  }
}

/** The storage earlier versions kept under `state/` (repository snapshots and shards, per-session JSON, HTTP conversations). */
export const LEGACY_CHAT_PATHS = Object.freeze(['index.json', 'snapshots', 'shards', 'sessions', 'http-conversations', 'maintenance.json', '.write.lock']);

export function legacyStorage(stateRoot) {
  return LEGACY_CHAT_PATHS.map(name => path.join(stateRoot, name)).filter(p => fs.existsSync(p));
}

/**
 * Drops the legacy chat storage (owner decision of 2026-10-01: old chats and databases may be dropped). `state/auth.json`,
 * `state/cache/` and `state/formalizer-logs/` are not chat data and stay. Returns the removed paths.
 */
export function dropLegacyStorage(stateRoot, {dryRun = false} = {}) {
  const found = legacyStorage(stateRoot);
  const bytes = found.reduce((sum, p) => sum + sizeOf(p), 0);
  if (!dryRun) for (const p of found) fs.rmSync(p, {recursive: true, force: true});
  return {dryRun, removed: found.map(p => path.relative(stateRoot, p)), bytes};
}

function sizeOf(p) {
  const stat = fs.lstatSync(p);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(p).reduce((sum, name) => sum + sizeOf(path.join(p, name)), 0);
}
