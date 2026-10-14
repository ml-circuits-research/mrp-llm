/** Local authentication for the server: one administrator password, set on the
 * first visit, plus API tokens minted from the admin page.
 *
 * - The password is stored only as a scrypt hash with a per-install salt in
 *   `state/auth.json` (mode 0600); the plaintext is never written anywhere.
 * - A successful login returns a short-lived session token kept in memory and
 *   handed to the browser as an HttpOnly cookie.
 * - API tokens (for curl/SDK clients) are random, shown once when minted, and
 *   stored only as SHA-256 digests. `CHATSOP_API_KEY` keeps working as an
 *   environment-provided bearer token.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {assert} from '../lib/util.mjs';

const SCRYPT = {N: 16384, r: 8, p: 1, keylen: 32};
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD = 8;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const secret = bytes => crypto.randomBytes(bytes).toString('base64url');
const equal = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const derive = (password, salt) => crypto.scryptSync(password, salt, SCRYPT.keylen, {N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p}).toString('hex');

export class Auth {
  constructor({file, apiKey = null}) {
    this.file = file;
    this.apiKey = apiKey && apiKey.length >= 16 ? apiKey : null;
    this.sessions = new Map();
    this.attempts = new Map();
    this.state = this.#load();
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      assert(parsed && typeof parsed === 'object', 'invalid auth file');
      return {password: parsed.password ?? null, apiTokens: Array.isArray(parsed.apiTokens) ? parsed.apiTokens : []};
    } catch (error) {
      assert(error.code === 'ENOENT', `Cannot read ${this.file}: ${error.message}`);
      return {password: null, apiTokens: []};
    }
  }

  #save() {
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2) + '\n', {mode: 0o600});
    fs.renameSync(temporary, this.file);
  }

  /** True once an administrator password exists (env-only tokens do not count). */
  get configured() {
    return Boolean(this.state.password);
  }

  /** True when the server has any way to authenticate a request. */
  get usable() {
    return this.configured || Boolean(this.apiKey);
  }

  setup(password) {
    assert(!this.configured, 'An administrator password is already set');
    assert(typeof password === 'string' && password.length >= MIN_PASSWORD, `Password must be at least ${MIN_PASSWORD} characters`);
    const salt = secret(16);
    this.state.password = {salt, hash: derive(password, salt), created: new Date().toISOString()};
    this.#save();
    return this.login(password);
  }

  verifyPassword(password) {
    if (!this.state.password) return false;
    return equal(derive(String(password ?? ''), this.state.password.salt), this.state.password.hash);
  }

  login(password) {
    const now = Date.now();
    const recent = (this.attempts.get('admin') ?? []).filter(stamp => now - stamp < 60_000);
    if(recent.length >= 10) { const failure = new Error('Too many failed attempts; wait a minute and try again'); failure.code = 'too_many_attempts'; throw failure; }
    if (!this.verifyPassword(password)) {
      recent.push(now);
      this.attempts.set('admin', recent);
      return null;
    }
    this.attempts.delete('admin');
    const token = secret(32);
    this.sessions.set(digest(token), {user: 'admin', expires: now + SESSION_TTL_MS});
    return token;
  }

  session(token) {
    if (!token) return null;
    const entry = this.sessions.get(digest(token));
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
      this.sessions.delete(digest(token));
      return null;
    }
    return entry.user;
  }

  logout(token) {
    if (token) this.sessions.delete(digest(token));
  }

  /** Bearer authentication: the environment key, or a minted API token. */
  bearer(token) {
    if (!token) return null;
    if (this.apiKey && equal(token, this.apiKey)) return 'admin';
    if (this.state.apiTokens.some(record => equal(digest(token), record.hash))) return 'admin';
    return null;
  }

  mintToken(label = 'api') {
    assert(this.configured, 'Set the administrator password first');
    const token = secret(24), record = {id: secret(6), label: String(label).slice(0, 40), hash: digest(token), created: new Date().toISOString()};
    this.state.apiTokens.push(record);
    this.#save();
    return {token, id: record.id, created: record.created};
  }

  tokens() {
    return this.state.apiTokens.map(({id, label, created}) => ({id, label, created}));
  }

  revoke(id) {
    const before = this.state.apiTokens.length;
    this.state.apiTokens = this.state.apiTokens.filter(record => record.id !== id);
    if (this.state.apiTokens.length !== before) this.#save();
    return before - this.state.apiTokens.length;
  }
}

export const sessionCookie = token => `chatsop_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
export const readCookie = (header, name) => {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
};
