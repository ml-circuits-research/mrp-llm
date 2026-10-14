/**
 * Sharded JSONL storage. No repository file may exceed 50 MB, so a large JSONL artifact is stored either as the
 * single file `<name>.jsonl` (when it fits) or as consecutive parts `<name>.part-000.jsonl`, `<name>.part-001.jsonl`, …
 * Every reader addresses the logical base path `<name>.jsonl`; the parts concatenated in order are the logical file.
 * A line is never split across parts.
 *
 * If both a single file and parts exist (a write in progress, or a writer that is not shard-aware), the newer set by
 * modification time is the logical file: both shard-aware writers here create the new files before removing the old
 * ones, so the newer set is always the completed write.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

export const DEFAULT_MAX_BYTES = 45e6;
export const REPOSITORY_FILE_LIMIT = 50e6;

const PART = /^(.*)\.part-(\d{3,})\.jsonl$/;
const stemOf = basePath => {
  if (!basePath.endsWith('.jsonl')) throw Error(`JSONL base path must end in .jsonl: ${basePath}`);
  return basePath.slice(0, -'.jsonl'.length);
};
const partName = (stem, index) => `${stem}.part-${String(index).padStart(3, '0')}.jsonl`;
const isFile = file => {
  try { return fs.statSync(file).isFile(); } catch { return false; }
};
const mtime = file => fs.statSync(file).mtimeMs;

/** Existing part files of `basePath`, sorted by index, without deciding which set is current. */
function partsOf(basePath) {
  const stem = stemOf(basePath), dir = path.dirname(stem), name = path.basename(stem);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries.map(entry => PART.exec(entry)).filter(match => match && match[1] === name)
    .map(match => ({index: Number(match[2]), file: path.join(dir, match[0])}))
    .sort((a, b) => a.index - b.index);
}

/** The physical files that make up the logical JSONL file, in read order; [] when it does not exist. */
export function shardPaths(basePath) {
  const parts = partsOf(basePath), single = isFile(basePath);
  if (!parts.length) return single ? [basePath] : [];
  if (single && mtime(basePath) >= Math.max(...parts.map(part => mtime(part.file)))) return [basePath];
  parts.forEach((part, position) => {
    if (part.index !== position) throw Error(`${basePath}: shard sequence has a gap before ${path.basename(part.file)}`);
  });
  return parts.map(part => part.file);
}

export const jsonlExists = basePath => shardPaths(basePath).length > 0;

/** Total bytes of the logical file. */
export const jsonlBytes = basePath => shardPaths(basePath).reduce((sum, file) => sum + fs.statSync(file).size, 0);

function missing(basePath) {
  const error = Error(`ENOENT: no such JSONL file or shards: ${basePath}`);
  error.code = 'ENOENT';
  return error;
}

function parseLine(line, file, number) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw Error(`${file}:${number}: ${error.message}`);
  }
}

/** Stream the raw non-empty lines with their physical file and line number. */
export async function* readJsonlShardedLines(basePath) {
  const files = shardPaths(basePath);
  if (!files.length) throw missing(basePath);
  for (const file of files) {
    const lines = readline.createInterface({input: fs.createReadStream(file, {encoding: 'utf8'}), crlfDelay: Infinity});
    let number = 0;
    for await (const line of lines) {
      number++;
      if (line.trim()) yield {line, file, number};
    }
  }
}

/** Stream parsed rows of the single file or of every part in order. A malformed line throws with file:line. */
export async function* readJsonlSharded(basePath) {
  for await (const {line, file, number} of readJsonlShardedLines(basePath)) yield parseLine(line, file, number);
}

/** Read every row of the single file or of all parts into an array. */
export function readJsonlShardedSync(basePath) {
  const files = shardPaths(basePath);
  if (!files.length) throw missing(basePath);
  const rows = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => { if (line.trim()) rows.push(parseLine(line, file, index + 1)); });
  }
  return rows;
}

/** sha256 of the logical byte stream (the concatenated parts), equal to the unsplit file's hash. */
export async function hashJsonlSharded(basePath) {
  const files = shardPaths(basePath);
  if (!files.length) throw missing(basePath);
  const hash = crypto.createHash('sha256');
  for (const file of files) for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Rolling part writer shared by the sync and async entry points. */
class ShardWriter {
  constructor(basePath, maxBytes) {
    if (!(maxBytes > 0)) throw Error('maxBytes must be positive');
    this.basePath = basePath;
    this.stem = stemOf(basePath);
    this.maxBytes = maxBytes;
    this.token = `${process.pid}.${Date.now()}`;
    this.temps = [];
    this.fd = null;
    this.size = 0;
    this.buffer = [];
    this.buffered = 0;
    this.rows = 0;
    this.bytes = 0;
    fs.mkdirSync(path.dirname(basePath), {recursive: true});
  }
  temp(index) {
    return path.join(path.dirname(this.stem), `.${path.basename(this.stem)}.part-${index}.${this.token}.tmp`);
  }
  flush() {
    if (this.buffered) fs.writeSync(this.fd, Buffer.concat(this.buffer));
    this.buffer = [];
    this.buffered = 0;
  }
  open() {
    if (this.fd !== null) {
      this.flush();
      fs.closeSync(this.fd);
    }
    const file = this.temp(this.temps.length);
    this.temps.push(file);
    this.fd = fs.openSync(file, 'w');
    this.size = 0;
  }
  add(row) {
    const text = (typeof row === 'string' ? row : JSON.stringify(row));
    if (text.includes('\n')) throw Error(`${this.basePath}: a JSONL row must not contain a newline`);
    const line = Buffer.from(text + '\n', 'utf8');
    if (line.length > this.maxBytes) throw Error(`${this.basePath}: row ${this.rows + 1} is ${line.length} bytes, larger than the ${this.maxBytes}-byte shard limit`);
    if (this.fd === null || this.size + line.length > this.maxBytes) this.open();
    this.buffer.push(line);
    this.buffered += line.length;
    this.size += line.length;
    this.rows++;
    this.bytes += line.length;
    if (this.buffered >= 1 << 20) this.flush();
  }
  abort() {
    if (this.fd !== null) fs.closeSync(this.fd);
    for (const file of this.temps) fs.rmSync(file, {force: true});
  }
  finish() {
    if (this.fd === null) this.open();
    this.flush();
    fs.closeSync(this.fd);
    this.fd = null;
    const previous = partsOf(this.basePath).map(part => part.file);
    let paths;
    if (this.temps.length === 1) {
      paths = [this.basePath];
      fs.renameSync(this.temps[0], this.basePath);
      for (const file of previous) fs.rmSync(file, {force: true});
    } else {
      paths = this.temps.map((temp, index) => {
        const target = partName(this.stem, index);
        fs.renameSync(temp, target);
        return target;
      });
      const keep = new Set(paths);
      for (const file of previous) if (!keep.has(file)) fs.rmSync(file, {force: true});
      fs.rmSync(this.basePath, {force: true});
    }
    return {paths, rows: this.rows, bytes: this.bytes};
  }
}

/**
 * Write rows (objects, or strings that are already one JSON line each) to `<name>.jsonl` if they fit in `maxBytes`,
 * otherwise to `<name>.part-NNN.jsonl`. Stale parts or a stale single file from a previous write are removed.
 * Accepts sync or async iterables. Returns {paths, rows, bytes}.
 */
export async function writeJsonlSharded(basePath, rowsIterable, {maxBytes = DEFAULT_MAX_BYTES} = {}) {
  const writer = new ShardWriter(basePath, maxBytes);
  try {
    for await (const row of rowsIterable) writer.add(row);
    return writer.finish();
  } catch (error) {
    writer.abort();
    throw error;
  }
}

/** Synchronous variant of writeJsonlSharded for sync iterables (arrays, generators). */
export function writeJsonlShardedSync(basePath, rowsIterable, {maxBytes = DEFAULT_MAX_BYTES} = {}) {
  const writer = new ShardWriter(basePath, maxBytes);
  try {
    for (const row of rowsIterable) writer.add(row);
    return writer.finish();
  } catch (error) {
    writer.abort();
    throw error;
  }
}

/** Byte offset just past the last newline in [start, end) of an open file, or -1. */
function lastNewline(fd, start, end) {
  const window = 1 << 20, buffer = Buffer.alloc(window);
  for (let hi = end; hi > start;) {
    const lo = Math.max(start, hi - window), length = hi - lo;
    fs.readSync(fd, buffer, 0, length, lo);
    const at = buffer.subarray(0, length).lastIndexOf(0x0a);
    if (at >= 0) return lo + at + 1;
    hi = lo;
  }
  return -1;
}

function copyRange(fdIn, fdOut, start, end, hash) {
  const buffer = Buffer.alloc(8 << 20);
  for (let position = start; position < end;) {
    const read = fs.readSync(fdIn, buffer, 0, Math.min(buffer.length, end - position), position);
    if (!read) throw Error('Unexpected end of file while sharding');
    fs.writeSync(fdOut, buffer, 0, read);
    hash.update(buffer.subarray(0, read));
    position += read;
  }
}

/** Feed a file into `hash` in fixed-size chunks without loading it whole. */
function hashFileSync(file, hash) {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(8 << 20);
  try {
    for (let read; (read = fs.readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash;
}

/**
 * Split an existing JSONL file in place into byte-exact parts cut at newlines. The parts are written under temporary
 * names, their concatenation is re-read and compared by sha256 with the original, and only then are they renamed and
 * the original removed. Returns {paths, sha256, bytes}; a file that already fits is left untouched.
 */
export function splitJsonlFile(file, {maxBytes = DEFAULT_MAX_BYTES} = {}) {
  const total = fs.statSync(file).size;
  if (total <= maxBytes) return {paths: [file], sha256: null, bytes: total, split: false};
  const stem = stemOf(file), token = `${process.pid}.${Date.now()}`, temps = [];
  const original = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    for (let start = 0; start < total;) {
      let end = total;
      if (total - start > maxBytes) {
        end = lastNewline(fd, start, start + maxBytes);
        if (end <= start) throw Error(`${file}: a line starting at byte ${start} is longer than ${maxBytes} bytes`);
      }
      const temp = path.join(path.dirname(stem), `.${path.basename(stem)}.part-${temps.length}.${token}.tmp`);
      temps.push(temp);
      const out = fs.openSync(temp, 'w');
      try { copyRange(fd, out, start, end, original); } finally { fs.closeSync(out); }
      start = end;
    }
  } catch (error) {
    fs.closeSync(fd);
    for (const temp of temps) fs.rmSync(temp, {force: true});
    throw error;
  }
  fs.closeSync(fd);
  const expected = original.digest('hex');
  const check = crypto.createHash('sha256');
  for (const temp of temps) hashFileSync(temp, check);
  const fresh = hashFileSync(file, crypto.createHash('sha256')).digest('hex');
  if (check.digest('hex') !== expected || fresh !== expected) {
    for (const temp of temps) fs.rmSync(temp, {force: true});
    throw Error(`${file}: shard verification failed (file changed while sharding?); original kept`);
  }
  const previous = partsOf(file).map(part => part.file);
  const paths = temps.map((temp, index) => {
    const target = partName(stem, index);
    fs.renameSync(temp, target);
    return target;
  });
  const keep = new Set(paths);
  for (const stale of previous) if (!keep.has(stale)) fs.rmSync(stale, {force: true});
  fs.rmSync(file);
  return {paths, sha256: expected, bytes: total, split: true};
}
