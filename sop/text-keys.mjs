/**
 * Comparison keys of surface text, shared by the host lexicon, the linker and the knowledge validator:
 * `normalize` (case, whitespace, Romanian cedilla), `fold` (also accents), `tokens`, and `phraseKey`, the key of a relation
 * phrase (folded tokens, auxiliaries and articles dropped, light stemming). Language data only: no knowledge of any memory.
 */
export const normalize = s => String(s).normalize('NFC').toLocaleLowerCase('ro').replace(/[şţ]/g, c => c === 'ş' ? 'ș' : 'ț').replace(/\s+/g, ' ').trim();
export const fold = s => normalize(s).normalize('NFD').replace(/\p{M}/gu, '');
export const tokens = s => s.match(/[\p{L}\p{N}_]+/gu) ?? [];

const STOPWORDS = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being', 'a', 'an', 'the', 'does', 'do', 'did', 'has', 'have', 'had', 'este', 'e', 'sunt', 'era', 'fost', 'un', 'o', 'al', 'ale']);
// Light, deterministic token normalization: plural/third-person -s and a final -e.
const stem = token => token.length > 3 ? token.replace(/([^s])s$/, '$1').replace(/e$/, '') : token;
/** Comparison key of a relation phrase: folded tokens, auxiliaries and articles dropped, light stemming. */
export function phraseKey(text) {
  const parts = fold(String(text).replaceAll('_', ' ')).match(/[\p{L}\p{N}]+/gu) ?? [];
  const content = parts.filter(token => !STOPWORDS.has(token));
  return (content.length ? content : parts).map(stem).join(' ');
}
