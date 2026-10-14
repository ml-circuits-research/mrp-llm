/**
 * Compiled lexicons of base memories and sessions (DS022 "Lexicon of a memory"). The lexicon of a memory is compiled from its
 * layered circuits (imports first, then its own) by `Lexicon.fromCircuits` and cached twice: in this process by the hash of the
 * circuit texts, and on disk under `<chat data>/cache/lexicon/<sha256>.json` (the compiled format version is part of the key), so a
 * restart or a second session on the same memory does not recompile it.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Lexicon, LEXICON_FORMAT} from '../../sop/lexicon.mjs';

export const hashCircuits = circuits => createHash('sha256').update(`lexicon-format ${LEXICON_FORMAT}\0` + circuits.map(c => c.name + '\0' + c.text).join('\0')).digest('hex');

export class LexiconCache {
  constructor(dir = null, {memo = 16} = {}) {
    this.dir = dir;
    this.memo = new Map();
    this.limit = memo;
    this.stats = {compiled: 0, disk: 0, memory: 0};
  }

  /** The compiled lexicon of `circuits` ([{name, text}] in layer order); `provenance` names it in reports. */
  get(circuits, {provenance = 'base-memory'} = {}) {
    const key = hashCircuits(circuits);
    if (this.memo.has(key)) { this.stats.memory++; const hit = this.memo.get(key); this.memo.delete(key); this.memo.set(key, hit); return hit; }
    const file = this.dir ? path.join(this.dir, key + '.json') : null;
    let lexicon = null;
    if (file && fs.existsSync(file)) {
      try { lexicon = Lexicon.revive(JSON.parse(fs.readFileSync(file, 'utf8'))); this.stats.disk++; } catch { lexicon = null; }
    }
    if (!lexicon) {
      lexicon = Lexicon.fromCircuits(circuits, {provenance});
      this.stats.compiled++;
      if (file) {
        try { fs.mkdirSync(this.dir, {recursive: true}); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(lexicon.serialize())); fs.renameSync(tmp, file); } catch { /* a cache that cannot be written is only slower */ }
      }
    }
    lexicon.circuitsSha256 = key;
    this.memo.set(key, lexicon);
    if (this.memo.size > this.limit) this.memo.delete(this.memo.keys().next().value);
    return lexicon;
  }
}
