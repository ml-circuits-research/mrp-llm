/**
 * The `lexicon` strategy of the affect slot (DS025 "The catalog"): emotion and urgency read from an English cue list
 * (config/affect/lexicon-en.tsv: cue, label, intensity), with no model call. A cue is a sequence of whole words of the normalized English
 * message. The label is the one with the strongest cue; each further cue of the same label adds 0.1, capped at 1. The cue list is data
 * the owner edits; this module only matches word sequences and interprets nothing else.
 */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

export const LEXICON_FILE = fileURLToPath(new URL('../../config/affect/lexicon-en.tsv', import.meta.url));

const cache = new Map();
const words = text => String(text ?? '').toLowerCase().replace(/[‘’]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];

/** The cues of a lexicon file: `[{cue: [word...], label, intensity}]`. Comment lines start with #. */
export function loadLexicon(file = LEXICON_FILE) {
  if (cache.has(file)) return cache.get(file);
  const cues = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [cue, label, intensity] = line.split('\t');
    const value = Number(intensity);
    if (!cue || !label || !Number.isFinite(value)) continue;
    cues.push({cue: words(cue), label: label.trim(), intensity: Math.max(0, Math.min(1, value))});
  }
  cache.set(file, cues);
  return cues;
}

/** `{label, intensity, cues}` of an English text; `neutral` with intensity 0 when no cue occurs. */
export function readAffect(text, cues = loadLexicon()) {
  const tokens = words(text);
  const found = new Map();
  for (const c of cues) {
    if (!c.cue.length) continue;
    for (let i = 0; i + c.cue.length <= tokens.length; i++) {
      if (!c.cue.every((w, j) => tokens[i + j] === w)) continue;
      (found.get(c.label) ?? found.set(c.label, []).get(c.label)).push(c);
      break;
    }
  }
  let best = null;
  for (const [label, list] of found) {
    const intensity = Math.min(1, Math.max(...list.map(c => c.intensity)) + 0.1 * (list.length - 1));
    if (!best || intensity > best.intensity) best = {label, intensity: Math.round(intensity * 100) / 100, cues: list.map(c => c.cue.join(' '))};
  }
  return best ?? {label: 'neutral', intensity: 0, cues: []};
}
