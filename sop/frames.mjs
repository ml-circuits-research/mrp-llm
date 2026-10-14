/**
 * Host frame and synonym normalization of formalizer output (owner answer to Q-SYM-2, 2026-09-29): a large,
 * reviewable list of relation frames plays the host's role after the model or the rules and normalizes what they
 * produced, without changing the model language (DS014) or any gold. Each frame names a canonical relation, the
 * role names it declares and its surfaces (synonyms and paraphrases, English and Romanian). Normalizing one
 * proposition:
 *
 *   1. `synonym`   the relation phrase is looked up among the surfaces (after folding, article dropping and light
 *                  stemming, `sop/linking.mjs` phraseKey), directly or through the English synonyms of the
 *                  dictionary view (`sop/dictionary.mjs` `englishDictionary`); a hit rewrites it to the frame's canonical relation;
 *   2. `role`      a role name the frame does not declare is renamed when exactly one declared non-subject role is
 *                  still free (single-oblique relabeling; never on a proposition with two unknown roles);
 *   3. `boundary`  an unknown relation joined with its object value ("get" + "the flu shot" → "get the flu shot")
 *                  or split before its last noun ("borrow soups of" + "Transylvania") that names a frame is moved
 *                  across the relation/object boundary;
 *   4. `time`      a quoted `role time` on a relation without a time role becomes the statement's `valid on` or the
 *                  query's `at` (DS014 "Time of a clause");
 *   5. `generic`   (ablation only, not in the default levels) an unknown relation's single non-subject role is
 *                  named `object`.
 *
 * Every change is reported (`changes`: [{kind, from, to}]). Strict scoring never uses this module (owner answer to
 * Q-SYM-1); evaluations report a host-normalized score beside the strict one. The data are TSV files listed in
 * config/dictionary/manifest.json under `frames` (columns `id  relation  roles  surfaces  source  note`), built by
 * `node tools/frames.mjs build` from sources whose rights are recorded in DS011.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {phraseKey} from './linking.mjs';
import {englishDictionary} from './dictionary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FRAME_COLUMNS = Object.freeze(['id', 'relation', 'roles', 'surfaces', 'source', 'note']);
export const NORMALIZATION_LEVELS = Object.freeze(['synonym', 'role', 'boundary', 'time']);
const ROLES = new Set(['subject', 'object', 'recipient', 'location', 'source', 'destination', 'instrument', 'time', 'topic']);

/** Parse a frames TSV source; blank and `#` lines are ignored; the header is required. */
export function parseFrames(text, file = 'frames.tsv') {
  const out = [];
  let header = null;
  String(text).split('\n').forEach((line, index) => {
    if (!line.trim() || line.startsWith('#')) return;
    const cells = line.split('\t');
    if (!header) {
      header = cells.map(c => c.trim());
      if (FRAME_COLUMNS.some((c, i) => header[i] !== c)) throw Error(`${file}:${index + 1}: header must be ${FRAME_COLUMNS.join(' ')}`);
      return;
    }
    const [id, relation, roles, surfaces = '', source = '', note = ''] = cells;
    const list = v => String(v ?? '').split('|').map(x => x.trim()).filter(Boolean);
    if (!/^[a-z][a-z0-9_:.-]*$/.test(id ?? '')) throw Error(`${file}:${index + 1}: invalid id ${JSON.stringify(id)}`);
    if (!relation?.trim()) throw Error(`${file}:${index + 1}: a frame needs a relation`);
    const roleList = list(roles);
    if (!roleList.length || roleList.some(r => !ROLES.has(r))) throw Error(`${file}:${index + 1}: roles must come from the DS014 inventory`);
    out.push({id, relation: relation.trim(), roles: roleList, surfaces: list(surfaces), source: source.trim(), note: note.trim()});
  });
  return out;
}

/** Serialize frames as TSV (the build tool writes files through this). */
export function formatFrames(frames, comment = '') {
  const head = comment ? comment.split('\n').map(l => '# ' + l).join('\n') + '\n' : '';
  return head + FRAME_COLUMNS.join('\t') + '\n' + frames.map(f => [f.id, f.relation, f.roles.join('|'), f.surfaces.join('|'), f.source ?? '', f.note ?? ''].join('\t')).join('\n') + (frames.length ? '\n' : '');
}

/** The frame files of the dictionary manifest (`frames: [{path, source, licence}]`). */
export function frameFiles(dir = path.join(ROOT, 'config', 'dictionary')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  return (manifest.frames ?? []).map(item => ({...item, file: path.join(dir, item.path)}));
}

/**
 * A loaded frame list: `bySurface` maps a phrase key to frame indexes; a surface shared by frames with different
 * role sets is ambiguous and kept only for relation canonicalization when every frame agrees on the relation.
 * `sources` restricts the list (for the ablation of the Q-SYM-2 analysis).
 */
export class Frames {
  constructor(frames, {digest = 'inline', dictionary = null} = {}) {
    this.frames = frames;
    this.digest = digest;
    this.dictionary = dictionary;
    this.bySurface = new Map();
    frames.forEach((frame, index) => {
      for (const surface of [frame.relation, ...frame.surfaces]) {
        const key = phraseKey(surface);
        if (!key) continue;
        if (!this.bySurface.has(key)) this.bySurface.set(key, new Set());
        this.bySurface.get(key).add(index);
      }
    });
  }

  static load({dir, sources = null, dictionary = true} = {}) {
    const files = frameFiles(dir);
    const hash = crypto.createHash('sha256');
    const frames = [];
    for (const item of files) {
      if (!fs.existsSync(item.file)) continue;
      const text = fs.readFileSync(item.file, 'utf8');
      hash.update(item.path + '\0' + text);
      for (const frame of parseFrames(text, item.file)) if (!sources || sources.includes(frame.source)) frames.push(frame);
    }
    return new Frames(frames, {digest: hash.digest('hex').slice(0, 16) + (sources ? ':' + sources.join('+') : ''), dictionary: dictionary ? englishDictionary() : null});
  }

  /** The single frame a relation phrase names (directly or through the dictionary), or null. */
  lookup(relation) {
    const direct = this.bySurface.get(phraseKey(relation));
    const pick = set => {
      if (!set?.size) return null;
      const list = [...set].map(i => this.frames[i]);
      const relations = new Set(list.map(f => f.relation));
      if (relations.size === 1) return list[0];
      // Frames that share one role set still fix the role names, though not the relation ("go to": study at, attend).
      const roleSets = new Set(list.map(f => f.roles.join('|')));
      return {ambiguous: list, roles: roleSets.size === 1 ? list[0].roles : null};
    };
    const hit = pick(direct);
    if (hit) return hit;
    if (!this.dictionary) return null;
    for (const candidate of [relation, ...this.dictionary.synonyms(relation, 'relation')]) {
      const found = pick(this.bySurface.get(phraseKey(candidate)));
      if (found) return found;
    }
    return null;
  }
}

let loaded = null;
/** The configured frame list (memoized). */
export function loadFrames(options = {}) {
  if (Object.keys(options).length) return Frames.load(options);
  if (!loaded) loaded = Frames.load();
  return loaded;
}

const stripArticle = text => String(text).replace(/^(?:the|a|an)\s+/i, '');
const isVariable = value => /^[?$]/.test(value);

/**
 * Normalize one proposition {relation, roles: [{name, value}]} (values as SOP terms: quoted strings, ?vars, $ids).
 * Returns {relation, roles, changes}.
 */
export function normalizeProposition(p, frames, {levels = NORMALIZATION_LEVELS} = {}) {
  const changes = [];
  let relation = p.relation, roles = p.roles.map((r, orig) => ({...r, orig}));
  if (!relation) return {relation, roles, changes};
  let frame = frames.lookup(relation);
  // 5. Time (DS014 "Proposition form"): a quoted `role time` on a relation that declares no time role is the
  // clause's validity (statement) or the query's period; the caller moves it (`movedTime`).
  let movedTime = null;
  if (levels.includes('time')) {
    const time = roles.find(r => r.name === 'time' && r.value.startsWith('"'));
    if (time && !(frame && !frame.ambiguous && frame.roles.includes('time'))) { movedTime = JSON.parse(time.value); roles = roles.filter(r => r !== time); changes.push({kind: 'time', from: 'role time', to: movedTime}); }
  }
  const result = normalizeFramed(relation, roles, frame, frames, levels, changes);
  return {...result, movedTime};
}

function normalizeFramed(relation, roles, frame, frames, levels, changes) {
  // 3. Boundary shift: the relation with its object value, or without its trailing words, names a frame.
  const objectRole = roles.find(r => r.name === 'object' && r.value.startsWith('"'));
  const misfit = frame && !frame.ambiguous && objectRole && !frame.roles.includes('object');
  if ((!frame || frame.ambiguous || misfit) && levels.includes('boundary')) {
    const object = objectRole;
    if (object) {
      const value = JSON.parse(object.value);
      for (const joined of [relation + ' ' + value, relation + ' ' + stripArticle(value)]) {
        const f = frames.lookup(joined);
        if (f && !f.ambiguous && !f.roles.includes('object')) { changes.push({kind: 'boundary', from: `${relation} + ${value}`, to: f.relation}); relation = joined; roles = roles.filter(r => r !== object); frame = f; break; }
      }
    }
    if (!frame || frame.ambiguous) {
      const words = relation.split(' ');
      let split = null;
      for (let cut = words.length - 1; cut >= 1 && !split; cut--) {
        const head = words.slice(0, cut).join(' '), tail = words.slice(cut).join(' ');
        // Only a noun can move into the object: never a bare preposition or a participle ("be" + "based in").
        if (/^(to|at|in|on|of|for|from|with|by|about|la|de|în|in|pe|cu|din)$/.test(tail) || /^(be|fi|have|avea|do|get)$/.test(head) || /(ed|en|ing)(\s|$)/.test(tail.split(' ')[0] + ' ')) continue;
        const f = frames.lookup(head);
        if (!f || f.ambiguous || !f.roles.includes('object')) continue;
        const obj = roles.find(r => r.name === 'object');
        if (obj && isVariable(obj.value)) continue;
        const moved = obj ? tail + ' ' + JSON.parse(obj.value) : tail;
        changes.push({kind: 'boundary', from: `${relation}${obj ? ' + ' + JSON.parse(obj.value) : ''}`, to: `${head} + ${moved}`});
        roles = [...roles.filter(r => r !== obj), {name: 'object', value: JSON.stringify(moved)}];
        relation = head;
        split = f;
      }
      if (split) frame = split;
    }
  }
  if (frame?.ambiguous && frame.roles && levels.includes('role')) {
    relabel(roles, frame.roles, changes);
    return {relation, roles, changes};
  }
  if (!frame || frame.ambiguous) {
    // 4. Generic (list-free, reported separately): an unknown relation with exactly one non-subject role names it
    // `object`, so two formalizations that differ only in that role's name compare equal.
    if (levels.includes('generic')) {
      const obliques = roles.filter(r => !['subject', 'time'].includes(r.name));
      if (obliques.length === 1 && obliques[0].name !== 'object') { changes.push({kind: 'generic', from: obliques[0].name, to: 'object'}); obliques[0].name = 'object'; }
    }
    return {relation, roles, changes};
  }
  // 1. Synonym: the canonical relation of the frame.
  if (levels.includes('synonym') && relation !== frame.relation) { changes.push({kind: 'synonym', from: relation, to: frame.relation}); relation = frame.relation; }
  // 2. Role: single-oblique relabeling against the frame's declared roles.
  if (levels.includes('role')) relabel(roles, frame.roles, changes);
  return {relation, roles, changes};
}

/** Single-oblique relabeling: one undeclared role and one free declared non-subject role. */
function relabel(roles, declared, changes) {
  const unknown = roles.filter(r => !declared.includes(r.name) && r.name !== 'time');
  const free = declared.filter(name => name !== 'subject' && !roles.some(r => r.name === name));
  if (unknown.length === 1 && free.length === 1) { changes.push({kind: 'role', from: unknown[0].name, to: free[0]}); unknown[0].name = free[0]; }
}

/**
 * Normalize every proposition of an SOP program text (stated/assumed wires and query match/scope blocks) by
 * rewriting its relation and role lines in place; every other line is kept. Returns {sop, changes}.
 */
export function normalizeProgram(sop, frames, options = {}) {
  const lines = String(sop ?? '').split('\n');
  const changes = [];
  const groups = [];
  let current = null, wire = null;
  const wires = [];
  const close = () => { if (current && (current.relation !== null || current.roles.length)) groups.push(current); current = null; };
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^@/.test(trimmed)) { wire = {start: index, end: index, statement: /^@\S+\s+(stated|assumed)\b/.test(trimmed), period: false}; wires.push(wire); } else if (wire && trimmed) { wire.end = index; if (/^(at|during)\s/.test(trimmed)) wire.period = true; }
    if (/^@\S+\s+(stated|assumed)\b/.test(trimmed)) { close(); current = {relation: null, relationLine: -1, roles: [], wire}; return; }
    if (/^@/.test(trimmed)) { close(); return; }
    if (/^(where|scope)?\s*match$/.test(trimmed) || trimmed === 'match') { close(); current = {relation: null, relationLine: -1, roles: [], wire}; return; }
    if (trimmed === 'end') { close(); return; }
    if (!current) return;
    const rel = /^relation\s+("(?:\\.|[^"\\])*")$/.exec(trimmed);
    if (rel) { current.relation = JSON.parse(rel[1]); current.relationLine = index; return; }
    const role = /^role\s+([a-z]+)\s+(.+)$/.exec(trimmed);
    if (role) current.roles.push({name: role[1], value: role[2], line: index});
  });
  close();
  const drop = new Set();
  for (const g of groups) {
    if (g.relation === null) continue;
    const result = normalizeProposition({relation: g.relation, roles: g.roles.map(({name, value}) => ({name, value}))}, frames, options);
    if (!result.changes.length) continue;
    changes.push(...result.changes);
    const pad = lines[g.relationLine].match(/^\s*/)[0];
    lines[g.relationLine] = pad + 'relation ' + JSON.stringify(result.relation);
    // Roles: rewrite in place; removed roles are dropped; a new object role takes the first removed or appended line.
    g.roles.forEach((r, i) => {
      const replacement = result.roles.find(x => x.orig === i);
      if (replacement) lines[r.line] = lines[r.line].match(/^\s*/)[0] + 'role ' + replacement.name + ' ' + replacement.value;
      else drop.add(r.line);
    });
    const added = result.roles.filter(x => x.orig === undefined);
    if (added.length) lines[g.relationLine] += '\n' + added.map(r => pad + 'role ' + r.name + ' ' + r.value).join('\n');
    if (result.movedTime !== null && g.wire) {
      if (g.wire.statement && !lines.slice(g.wire.start, g.wire.end + 1).some(l => /^\s*valid\s/.test(l))) lines[g.relationLine] += '\n' + pad + 'valid on ' + JSON.stringify(result.movedTime);
      else if (!g.wire.statement && !g.wire.period) { lines[g.wire.end] += '\n  at ' + JSON.stringify(result.movedTime); g.wire.period = true; }
    }
  }
  return {sop: lines.filter((_, i) => !drop.has(i)).join('\n'), changes};
}
