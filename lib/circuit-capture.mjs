/**
 * Circuit capture for the capability coverage matrix (tools/capabilities/coverage.mjs): when the environment variable
 * CHATSOP_CIRCUIT_CAPTURE names a directory, every circuit text the two SOP parsers read (sop/knowledge/lexical.mjs `parse`,
 * sop/parser.mjs `parse`) is appended to `<dir>/<pid>.jsonl` as {surface, file, h, text}, in parse order, where `file` is the entry
 * script of the process (a test file under `node --test`) and `h` a hash of the text; the text itself is written only the first time
 * a process parses it, so the order of parses (a knowledge text, then its query) stays readable at little cost. Without the variable this is a no-op with no import of node:fs, so the
 * parsers stay usable outside Node. Texts above 64 KB (base memories, not test circuits) are skipped.
 */
const DIR = globalThis.process?.env?.CHATSOP_CIRCUIT_CAPTURE;
const MAX = 65536;
let state = null;

function open() {
  const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path'), crypto = process.getBuiltinModule('node:crypto');
  fs.mkdirSync(DIR, {recursive: true});
  const file = path.join(DIR, `${process.pid}.jsonl`);
  const entry = process.argv[1] ? path.relative(process.cwd(), process.argv[1]) : null;
  return {fs, crypto, file, entry, seen: new Set()};
}

/** Record one parsed circuit text (`surface` is `knowledge` or `model`). */
export function captureCircuit(text, surface) {
  if (!DIR || typeof text !== 'string' || !text.trim() || text.length > MAX) return;
  try {
    state ??= open();
    const h = state.crypto.createHash('sha1').update(surface + '\0' + text).digest('hex').slice(0, 16);
    const first = !state.seen.has(h);
    state.seen.add(h);
    state.fs.appendFileSync(state.file, JSON.stringify(first ? {surface, file: state.entry, h, text} : {surface, file: state.entry, h}) + '\n');
  } catch { /* capture is an observation aid; it never changes parsing */ }
}

export const captureEnabled = Boolean(DIR);
