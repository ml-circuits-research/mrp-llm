/** Deliberate, labelled noise: typos, informal spelling and EN/RO code-switching.
 * Operation weights default to the measured QQP typo distribution (inventory `typo_model_measured`) when it is
 * supplied; every applied operation is recorded on the row so evaluation can slice by it.
 */
import fs from 'node:fs';
import { foldDiacritics } from './text.mjs';

/**
 * Formatting-noise weights from the measured rates of real user text (inventory `noise_rates.qqp`, mined by
 * mine-sources.mjs; statistics only, DS011): each formatting operation gets a weight proportional to its measured
 * rate, rescaled to the same total as the authored menu and floored so a rare operation still occurs. Without the
 * inventory the authored weights apply.
 */
const INVENTORY = new URL('./inventory/inventory.json', import.meta.url);
const MEASURED = (() => { try { return JSON.parse(fs.readFileSync(INVENTORY, 'utf8')).noise_rates?.qqp ?? null; } catch { return null; } })();
const FORMAT_SOURCE = { space_before_punctuation: 'space_before_punctuation', chat_spelling: 'chat_spelling', no_space_after_comma: 'no_space_after_comma',
  drop_question_mark: 'no_terminal_punctuation', lowercase_i: 'lowercase_i', missing_apostrophe: 'missing_apostrophe', lowercase_start: 'lowercase_start', repeated_punctuation: 'repeated_punctuation' };
export function formattingWeights(authored, measured = MEASURED) {
  const ops = authored.filter(([name]) => FORMAT_SOURCE[name]);
  if (!measured || !ops.length) return authored;
  const total = ops.reduce((sum, [, weight]) => sum + weight, 0);
  const rates = ops.map(([name]) => measured[FORMAT_SOURCE[name]] ?? 0), rateTotal = rates.reduce((a, b) => a + b, 0) || 1;
  const scaled = new Map(ops.map(([name], i) => [name, Math.max(0.3, Number((total * rates[i] / rateTotal).toFixed(3)))]));
  return authored.map(([name, weight]) => [name, scaled.get(name) ?? weight]);
}

/**
 * Keyboard layouts for adjacent-key errors. `en` is US QWERTY. `ro_standard` is the Romanian standard layout
 * (SR 13392:2004): QWERTY with ă î â on the keys right of P and ș ț right of L. `ro_programmer` is US QWERTY with
 * the diacritics on AltGr (AltGr+a ă, AltGr+q â, AltGr+i î, AltGr+s ș, AltGr+t ț): a missed AltGr gives the base
 * letter and a wrong AltGr key gives the neighbouring diacritic.
 */
const LAYOUTS = {
  en: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  ro_standard: ['qwertyuiopăî', 'asdfghjklșțâ', 'zxcvbnm'],
  ro_programmer: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
};
const ALTGR = { ă: ['a', 'â'], â: ['a', 'ă'], î: ['i', 'â'], ș: ['s', 'ş'], ț: ['t', 'ţ'] };
function neighbours(char, layout = 'en') {
  const rows = LAYOUTS[layout] ?? LAYOUTS.en;
  const lower = char.toLowerCase();
  if (layout === 'ro_programmer' && ALTGR[lower]) return ALTGR[lower];
  for (let r = 0; r < rows.length; r++) {
    const c = [...rows[r]].indexOf(lower);
    if (c < 0) continue;
    const row = [...rows[r]], up = [...(rows[r - 1] ?? '')], down = [...(rows[r + 1] ?? '')];
    return [row[c - 1], row[c + 1], up[c], up[c + 1], down[c], down[c - 1]].filter(Boolean);
  }
  return [];
}

/** The typing-error taxonomy (Damerau 1964; Kukich 1992; Baba & Suzuki 2012 for keystroke logs): character
 * operations, space errors, diacritic errors, phonetic misspellings and autocorrect substitutions. */
export const TYPO_OPERATIONS = ['substitution', 'deletion', 'transposition', 'duplication', 'insertion'];
export const DEFAULT_TYPO_WEIGHTS = { substitution: 0.34, deletion: 0.28, transposition: 0.14, duplication: 0.16, insertion: 0.08 };
export const WORD_ERRORS = ['space_split', 'space_merge', 'phonetic', 'autocorrect', 'dictation', 'sms', 'regional', 'diacritic_drop', 'diacritic_cedilla', 'diacritic_wrong'];
/** Noise levels: how many operations a noisy row receives, and how often each level occurs among noisy rows. */
export const NOISE_LEVELS = { light: { ops: [1, 1], share: 0.55 }, medium: { ops: [2, 3], share: 0.33 }, heavy: { ops: [4, 6], share: 0.12 } };

/** Weights from the measured QQP hapax-typo operations, folded onto the generator's operation set. */
export function typoWeights(measured) {
  const ops = measured?.operations;
  if (!ops) return DEFAULT_TYPO_WEIGHTS;
  const w = { substitution: ops.substitution ?? 0, deletion: ops.deletion ?? 0, transposition: ops.transposition ?? 0,
    duplication: ops.duplication ?? 0, insertion: (ops.insertion ?? 0) + (ops.duplication_or_insertion_edge ?? 0) };
  const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Number((v / total).toFixed(4))]));
}

function typo(word, op, random, layout = 'en') {
  const letters = [...word];
  const i = 1 + random.int(Math.max(1, letters.length - 2));
  const keep = (original, replacement) => original === original.toUpperCase() && original !== original.toLowerCase() ? replacement.toUpperCase() : replacement;
  switch (op) {
    case 'substitution': { const n = neighbours(letters[i], layout); if (!n.length) return null; letters[i] = keep(letters[i], random.pick(n)); break; }
    case 'deletion': letters.splice(i, 1); break;
    case 'transposition': if (i + 1 >= letters.length || letters[i] === letters[i + 1]) return null; [letters[i], letters[i + 1]] = [letters[i + 1], letters[i]]; break;
    case 'duplication': letters.splice(i, 0, letters[i]); break;
    case 'insertion': { const n = neighbours(letters[i], layout); if (!n.length) return null; letters.splice(i, 0, random.pick(n)); break; }
    default: return null;
  }
  const out = letters.join('');
  return out === word ? null : out;
}

// Phonetic misspellings: how a word sounds, or an older or regional spelling (Romanian î/â, hyphen loss).
const PHONETIC_EN = [[/\btheir\b/, 'there'], [/\bthere\b/, 'their'], [/\bwhich\b/, 'wich'], [/\bwhether\b/, 'weather'], [/\bthan\b/, 'then'], [/\bdefinitely\b/, 'definately'], [/\breceive\b/, 'recieve'],
  [/\btomorrow\b/, 'tomorow'], [/\bbecause\b/, 'becuase'], [/\bwould\b/, 'wud'], [/\bbusiness\b/, 'buisness'], [/\bcolleague\b/, 'collegue'], [/\bexactly\b/, 'exactely'],
  [/\bphysics\b/, 'fysics'], [/\bschedule\b/, 'skedule'], [/\bsince\b/, 'sinse'], [/\bcertificate\b/, 'certificat'], [/\bvaccinated\b/, 'vacinated'], [/\bwriting\b/, 'writting'], [/\bplease\b/, 'plz']];
const PHONETIC_RO = [[/\bsunt\b/, 'sînt'], [/\bsunt\b/, 'sânt'], [/â(?=\p{L})/u, 'î'], [/\bs-a\b/, 'sa'], [/\bi-a\b/, 'ia'], [/\bîntr-o\b/, 'intro'], [/\bvreau\b/, 'vreu'],
  [/\bcopiii\b/, 'copii'], [/\bdeci\b/, 'deşi'], [/\bmâine\b/, 'mîine'], [/\bcâte\b/, 'cîte'], [/\bcând\b/, 'cînd'], [/\bînțeles\b/, 'intales'], [/\bcineva\b/, 'cineva'], [/\bniciun\b/, 'nici un'], [/\bdumneavoastră\b/, 'dvs']];
// Autocorrect-like wrong words: a keyboard dictionary replaces a real word with a nearby one (EN phones also
// "correct" Romanian words into English ones).
const AUTOCORRECT_EN = [[/\bwork\b/, 'word'], [/\blive\b/, 'love'], [/\bfrom\b/, 'form'], [/\bmanager\b/, 'manger'], [/\bteam\b/, 'tram'], [/\btrained\b/, 'trainee'], [/\bcoach\b/, 'couch'], [/\bbased\b/, 'bases'], [/\bmarried\b/, 'marries'], [/\bflu\b/, 'flue'], [/\bwhere\b/, 'were'], [/\bwhen\b/, 'wen']];
const AUTOCORRECT_RO = [[/\bunde\b/, 'under'], [/\bcine\b/, 'Cine'], [/\bpe\b/, 'Pe'], [/\bla\b/, 'LA'], [/\bcare\b/, 'car'], [/\bnoi\b/, 'noir'], [/\bdoar\b/, 'door'], [/\bcum\b/, 'cu m'],
  [/\bși\b/, 'si'], [/\bcă\b/, 'ca'], [/\bîn\b/, 'in']];
// Speech-to-text errors (dictation): homophones and near-homophones a recognizer confuses (proposal gap G22). None
// creates or removes a negation cue ("know" → "no" would read as a negation).
const DICTATION_EN = [[/\bbuy\b/, 'by'], [/\bby\b/, 'buy'], [/\btheir\b/, "they're"], [/\bto\b/, 'too'], [/\btwo\b/, 'to'], [/\bwrite\b/, 'right'], [/\bwhether\b/, 'weather'],
  [/\bfor\b/, 'four'], [/\bhear\b/, 'here'], [/\bweek\b/, 'weak'], [/\bone\b/, 'won'], [/\bplane\b/, 'plain'], [/\bsale\b/, 'sail'], [/\bpeace\b/, 'piece']];
const DICTATION_RO = [[/\bs-a\b/, 'sa'], [/\bi-a\b/, 'ia'], [/\bcă\b/, 'ca'], [/\bsă\b/, 'sa'], [/\bîntr-un\b/, 'într-un'], [/\bce-i\b/, 'cei']];
// SMS and regional forms: EN texting abbreviations; Romanian colloquial and regional variants (Moldova, Oltenia).
const SMS_EN = [[/\btomorrow\b/, 'tmrw'], [/\btonight\b/, 'tonite'], [/\bbecause\b/, 'bc'], [/\bpeople\b/, 'ppl'], [/\bsomeone\b/, 'some1'], [/\bthough\b/, 'tho'], [/\bplease\b/, 'plz'], [/\bthanks\b/i, 'thx']];
const REGIONAL_RO = [[/\bacum\b/, 'amu'], [/\bdeloc\b/, 'nicidecum'], [/\bfoarte\b/, 'tare'], [/\bunde\b/, 'unde-i'], [/\bmâine\b/, 'mâni'], [/\baici\b/, 'aci'], [/\bpuțin\b/, 'oleacă'], [/\bdoar\b/, 'numa'], [/\bnumai\b/, 'numa']];
const CEDILLA = { ș: 'ş', ț: 'ţ', Ș: 'Ş', Ț: 'Ţ' };
const WRONG_DIACRITIC = { ă: 'â', â: 'ă', î: 'â', Î: 'Â' };

const CHAT_EN = [[/\byou\b/g, 'u'], [/\bplease\b/gi, 'pls'], [/\byour\b/g, 'ur'], [/\bthanks\b/gi, 'thx'], [/\bbecause\b/g, 'cuz'], [/\bare\b/g, 'r']];
const CHAT_RO = [[/\bpentru\b/g, 'pt'], [/\bsă\b/g, 'sa'], [/\bși\b/g, 'si'], [/\bmersi\b/gi, 'ms'], [/\bce\b/g, 'ce'], [/\bnu știu\b/g, 'nush'], [/\bfoarte\b/g, 'f']];
const APOSTROPHES = [[/\bdon't\b/g, 'dont'], [/\bdoesn't\b/g, 'doesnt'], [/\bisn't\b/g, 'isnt'], [/\bI'm\b/g, 'im'], [/\bdidn't\b/g, 'didnt'], [/\bcan't\b/g, 'cant'], [/\bI'd\b/g, 'id'], [/\bwhat's\b/gi, 'whats']];

/**
 * Words whose corruption would change what the target must say: negation and omission cues, quantifiers and
 * presupposition triggers. Noise never touches them (a typo in "not" would make the label unfaithful).
 */
// JavaScript's \b is ASCII-only: "încă" or "fără" have no \b next to their diacritic, so letter lookarounds are used.
const CUE_WORDS = /(?<![\p{L}\p{N}])(not|no|never|none|nobody|nothing|without|neither|nor|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|hasn't|haven't|can't|won't|isnt|arent|wasnt|werent|doesnt|dont|didnt|hasnt|havent|cant|wont|all|every|each|everyone|everybody|any|anyone|still|again|also|absent|nu|n-a|n-au|nici|niciun|nicio|nimeni|nimic|niciodată|fără|toți|toate|fiecare|oricine|încă|mai|iar|iară|iarăși|din nou|lipsește|lipsesc|a lipsit)(?![\p{L}\p{N}])/giu;
const CUE_WORDS_FOLDED = new RegExp(foldDiacritics(CUE_WORDS.source), CUE_WORDS.flags);
/** A whole string that is a cue word (for space splits). */
const CUE_WORD_EXACT = new RegExp(`^(?:${foldDiacritics(CUE_WORDS.source)})$`, 'iu');
/**
 * Does the last sentence still read as a question without its "?": a wh-word, an inverted auxiliary, an embedded
 * "whether/if/dacă", a question particle or a request verb? A bare declarative loses its question mark only never:
 * without the mark it would be a statement, and the label would no longer match (DS015 noise policy).
 */
const QUESTION_START = /^(who|whom|whose|what|which|when|where|why|how|do|does|did|is|are|was|were|has|have|had|can|could|would|will|should|cine|ce|care|când|cand|unde|cum|câți|cati|câte|cate|cât|cat|de ce|de când|de cand|de câte|de cate|din ce|până când|pana cand|în ce|in ce|pentru ce|la ce|cu ce|oare)\b/i;
const QUESTION_ANYWHERE = /\b(whether|if|tell me|check|confirm|do you know|can you|could you|any idea|i wonder|i need to know|dacă|daca|verifică|verifica|spune-mi|zi-mi|confirmă|confirma|poți|poti|știi|stii|ai idee|mă întreb|ma intreb|am nevoie să știu)\b/i;
const interrogative = text => {
  const last = text.split(/(?<=[.!:])\s+/).at(-1) ?? text;
  // The clause after a leading "Given that …," or "Quick question:" is where a question word would start.
  const clauses = [last, ...last.split(/,\s*/).slice(1)].map(clause => clause.trim());
  return QUESTION_ANYWHERE.test(last) || clauses.some(clause => QUESTION_START.test(clause));
};
/** Spans that must not be corrupted by character or word errors: entity surfaces and cue words. */
function protectedSpans(text, surfaces) {
  const folded = foldDiacritics(text).toLowerCase();
  // Cue words are found in the text and in its accent-folded form, so "inca" stays protected after diacritics are dropped.
  const spans = [...text.matchAll(CUE_WORDS), ...(folded.length === text.length ? folded.matchAll(CUE_WORDS_FOLDED) : [])].map(m => [m.index, m.index + m[0].length]);
  for (const surface of surfaces) {
    if (!surface) continue;
    const needle = foldDiacritics(surface).toLowerCase();
    let from = 0;
    while ((from = folded.indexOf(needle, from)) >= 0) { spans.push([from, from + needle.length]); from += needle.length; }
  }
  return spans;
}
const outside = (spans, start, end) => !spans.some(([a, b]) => start < b && end > a);
/** Replace one match of the first applicable table entry outside protected spans. */
function applyTable(text, table, spans, random) {
  const options = [];
  for (const [pattern, to] of table) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    for (const m of text.matchAll(global)) if (outside(spans, m.index, m.index + m[0].length)) options.push([m.index, m[0], to]);
  }
  if (!options.length) return null;
  const [at, from, to] = random.pick(options);
  return { text: text.slice(0, at) + to + text.slice(at + from.length), from, to };
}

/**
 * Apply noise operations to a message. Returns {text, ops, level}. `surfaces` are entity surfaces protected from
 * character and word errors (the host never resolves a misspelled identity, DS014; diacritics and case in names
 * may still change, which accent-folded resolution tolerates). `language` selects the RO operations and the
 * keyboard layout (EN QWERTY; RO standard or programmer). `level` is light, medium or heavy (NOISE_LEVELS).
 */
export function addNoise(text, { language, random, surfaces = [], weights = DEFAULT_TYPO_WEIGHTS, count = null, level = null }) {
  const ops = [];
  let out = text;
  const chosenLevel = level ?? random.weighted(Object.entries(NOISE_LEVELS).map(([name, spec]) => [name, spec.share]));
  const [lo, hi] = NOISE_LEVELS[chosenLevel].ops;
  const n = count ?? lo + random.int(hi - lo + 1);
  const layout = language === 'ro' ? random.pick(['ro_standard', 'ro_programmer', 'en']) : 'en';
  const menu = formattingWeights(language === 'ro'
    ? [['typo', 6], ['diacritic_drop', 4], ['diacritic_cedilla', 1], ['diacritic_wrong', 1], ['phonetic', 2], ['autocorrect', 1], ['dictation', 1], ['regional', 1], ['space_split', 1], ['space_merge', 1], ['strip_diacritics', 3], ['lowercase_start', 2], ['drop_question_mark', 2], ['chat_spelling', 2], ['repeated_punctuation', 1], ['space_before_punctuation', 1], ['no_space_after_comma', 1]]
    : [['typo', 7], ['phonetic', 2], ['autocorrect', 2], ['dictation', 1.5], ['sms', 1], ['space_split', 1], ['space_merge', 1], ['lowercase_start', 3], ['drop_question_mark', 2], ['missing_apostrophe', 2], ['chat_spelling', 2], ['lowercase_i', 1], ['repeated_punctuation', 1], ['space_before_punctuation', 1], ['no_space_after_comma', 1]]);
  const repeatable = new Set(['typo', 'diacritic_drop', 'phonetic', 'space_split', 'space_merge']);
  const chosen = new Set();
  // A word takes at most one character or word error: stacking several typos on one short word ("fact" →
  // "fadzxt") produces garbage no user types, not realistic noise. Changed words are protected afterwards.
  const touched = new Set();
  // Operations that find no site are retried with another draw, up to three draws per wanted operation.
  for (let attempt = 0; ops.length < n && attempt < 3 * n; attempt++) {
    const op = random.weighted(menu.filter(([name]) => !chosen.has(name) || repeatable.has(name)));
    chosen.add(op);
    const before = out;
    const spans = protectedSpans(out, surfaces);
    const freeWords = min => [...out.matchAll(new RegExp(`\\p{L}{${min},}`, 'gu'))].filter(m => outside(spans, m.index, m.index + m[0].length) && !touched.has(m[0]));
    if (op === 'strip_diacritics') {
      const full = random.chance(0.7);
      out = full ? foldDiacritics(out) : out.replace(/[șțăâîȘȚĂÂÎ]/g, char => random.chance(0.6) ? foldDiacritics(char) : char);
      if (out !== before) ops.push({ op: full ? 'strip_diacritics' : 'strip_diacritics_partial' });
      continue;
    }
    if (op === 'typo') {
      const words = freeWords(4);
      if (!words.length) continue;
      const target = random.pick(words);
      const kind = random.weighted(Object.entries(weights));
      const changed = typo(target[0], kind, random, layout);
      if (!changed) continue;
      out = out.slice(0, target.index) + changed + out.slice(target.index + target[0].length);
      touched.add(changed);
      ops.push({ op: 'typo', kind, layout, from: target[0], to: changed });
      continue;
    }
    if (op === 'diacritic_drop' || op === 'diacritic_cedilla' || op === 'diacritic_wrong') {
      const table = op === 'diacritic_drop' ? null : op === 'diacritic_cedilla' ? CEDILLA : WRONG_DIACRITIC;
      const sites = [...out.matchAll(/[șțăâîȘȚĂÂÎ]/g)].filter(m => (op === 'diacritic_drop' || table[m[0]]) && (op !== 'diacritic_wrong' || outside(spans, m.index, m.index + 1)));
      if (!sites.length) continue;
      const site = random.pick(sites);
      const to = op === 'diacritic_drop' ? foldDiacritics(site[0]) : table[site[0]];
      out = out.slice(0, site.index) + to + out.slice(site.index + 1);
      ops.push({ op, from: site[0], to });
      continue;
    }
    if (op === 'phonetic' || op === 'autocorrect' || op === 'dictation' || op === 'sms' || op === 'regional') {
      const tables = { phonetic: [PHONETIC_EN, PHONETIC_RO], autocorrect: [AUTOCORRECT_EN, AUTOCORRECT_RO], dictation: [DICTATION_EN, DICTATION_RO], sms: [SMS_EN, SMS_EN], regional: [REGIONAL_RO, REGIONAL_RO] };
      const table = tables[op][language === 'ro' ? 1 : 0];
      const applied = applyTable(out, table, spans, random);
      if (!applied || applied.text === out) continue;
      out = applied.text;
      ops.push({ op, from: applied.from, to: applied.to });
      continue;
    }
    if (op === 'space_split') {
      const words = freeWords(6);
      if (!words.length) continue;
      const target = random.pick(words), at = 2 + random.int(target[0].length - 3);
      // A split must not create a cue word ("Numără" → "Nu mără" would read as a negation).
      const pieces = [target[0].slice(0, at), target[0].slice(at)];
      if (pieces.some(piece => CUE_WORD_EXACT.test(foldDiacritics(piece)))) continue;
      out = out.slice(0, target.index + at) + ' ' + out.slice(target.index + at);
      pieces.forEach(piece => touched.add(piece));
      ops.push({ op, from: target[0], to: target[0].slice(0, at) + ' ' + target[0].slice(at) });
      continue;
    }
    if (op === 'space_merge') {
      const pairs = [...out.matchAll(/(\p{L}+) (\p{L}+)/gu)].filter(m => outside(spans, m.index, m.index + m[0].length) && m[1].length + m[2].length <= 12 && !touched.has(m[1]) && !touched.has(m[2]));
      if (!pairs.length) continue;
      const pair = random.pick(pairs);
      out = out.slice(0, pair.index) + pair[1] + pair[2] + out.slice(pair.index + pair[0].length);
      touched.add(pair[1] + pair[2]);
      ops.push({ op, from: pair[0], to: pair[1] + pair[2] });
      continue;
    }
    if (op === 'lowercase_start') { if (spans.some(([a]) => a === 0)) continue; out = out[0].toLowerCase() + out.slice(1); }
    else if (op === 'drop_question_mark') { if (!interrogative(out)) continue; out = out.replace(/\?\s*$/, ''); }
    // Without another interrogative cue a final "?" may only be repeated, never replaced by "!!" or "...".
    // A final "." never becomes "??" (a statement would read as a question) and a final "?" without another
    // interrogative cue is only repeated.
    else if (op === 'repeated_punctuation') out = out.replace(/([?!.])\s*$/, mark => random.pick(mark.trim() === '?' ? (interrogative(out) ? ['??', '?!', '?!!'] : ['??', '?!']) : ['...', '!!']));
    else if (op === 'space_before_punctuation') out = out.replace(/([^\s])([?!.])\s*$/, '$1 $2');
    else if (op === 'no_space_after_comma') { const m = [...out.matchAll(/, (?=\S)/g)].find(x => outside(spans, x.index, x.index + 1)); if (m) out = out.slice(0, m.index + 1) + out.slice(m.index + 2); }
    else if (op === 'missing_apostrophe') { for (const [pattern, to] of APOSTROPHES) out = out.replace(pattern, to); }
    else if (op === 'lowercase_i') out = out.replace(/\bI\b/g, 'i');
    else if (op === 'chat_spelling') {
      // One chat spelling outside entity surfaces ("mâncare pentru bebeluși" is a name the host must still resolve).
      const applied = applyTable(out, language === 'ro' ? CHAT_RO : CHAT_EN, spans, random);
      if (applied) out = applied.text;
    }
    if (out !== before) ops.push({ op });
  }
  return { text: out, ops, level: chosenLevel };
}

// ---------------------------------------------------------------- EN/RO code-switching
/** Intra-sentential insertions: English chunks inside Romanian sentences and Romanian chunks inside English
 * ones, placed after a frame word or before the final punctuation, never inside an entity surface or a
 * relation phrase. Openers and tags are a separate, smaller kind. */
const RO_EN_LEXICAL = [
  [/\bîntrebare rapidă\b/gi, 'quick question'], [/\bte rog\b/g, 'please'], [/\bverifici\b/g, 'dai un check'], [/\bverifică\b/g, 'dă un check'],
  [/\bsincer\b/gi, 'honestly'], [/\bdin curiozitate\b/gi, 'just curious'], [/\bmă interesează\b/g, 'sunt curious'], [/\bam nevoie să știu\b/g, 'am nevoie, asap, să știu'],
  [/\bai idee\b/g, 'ai vreun clue'], [/\bspune-mi\b/g, 'zi-mi, pls,'], [/\bștii cumva\b/g, 'știi by any chance'],
  // Morphologically integrated English stems (Romanian inflection on an English verb or noun).
  [/\bsă verifici\b/g, 'să check-uiești'], [/\bVerifică, te rog\b/g, 'Check-uiește, te rog'], [/\bAflă, te rog\b/g, 'Află, please'], [/\bvreau să știu\b/g, 'vreau să știu, like,'],
  [/\bPoți să-mi spui\b/g, 'Poți să-mi zici, ca un quick update,'], [/\bAm nevoie să știu\b/g, 'Am nevoie să știu asap'], [/\bDin curiozitate\b/g, 'Just curious'],
];
const EN_RO_LEXICAL = [
  [/\bplease\b/g, 'te rog'], [/\bquick question\b/gi, 'întrebare rapidă'], [/\bhonestly\b/gi, 'sincer'], [/\bjust checking\b/gi, 'doar verific'],
  [/\bthanks\b/gi, 'mersi'], [/\bout of curiosity\b/gi, 'din curiozitate'],
  [/\bCan you tell me\b/g, 'Poți să-mi spui'], [/\bDo you know\b/g, 'Știi'], [/\bI wonder\b/g, 'Mă întreb'], [/\bTell me\b/g, 'Zi-mi'], [/\bAny idea\b/g, 'Ai idee'],
];
/** Carrier clauses that give a reason for asking and embed a noun or verb chunk from the other language, as
 * bilingual users write. The chunk is marked with [..] and the brackets are removed when inserted. Topic-neutral
 * on purpose: each is a reason to ask, so it connects to any question. */
export const RO_CARRIERS_WITH_EN = [
  'Am un [meeting] mâine și vreau să știu', 'Pregătesc un [report] pentru șef', 'Fac un [quick check] înainte de ședință:', 'Șeful vrea un [update] până diseară',
  'Am un [deadline] vineri și', 'Pregătesc [onboarding]-ul de luni', 'Fac un [double-check] pe niște date:', 'Colegul mi-a cerut un [follow-up]',
  'Scriu un [draft] pentru echipă și', 'Am nevoie de asta pentru un [call] la prânz:', 'Fac [research] pentru un proiect:', 'Închid un [ticket] și mai am o întrebare:',
  'Completez [spreadsheet]-ul pentru mâine', 'Actualizez [dashboard]-ul intern și', 'Am un [interview] mâine dimineață, deci', 'Pregătesc [slides] pentru prezentare:',
  'Verific ceva pentru [newsletter]:', 'Fac [planning] pe săptămâna viitoare și', 'Am primit un [feedback] ciudat', 'Am un [review] azi',
  'Îmi fac [notes] pentru ședință:', 'Am un [brainstorming] la patru și', 'Scriu un [post] pe blog', 'Fac [fact-checking] la un articol:',
  'Organizez un [event] mic și', 'Pregătesc un [pitch] și', 'Am un [workshop] mâine, deci', 'Fac un [audit] rapid:',
];
export const EN_CARRIERS_WITH_RO = [
  'I have a [ședință] tomorrow, so', 'My [șefa] asked me to check:', 'I am writing a [raport] and', 'I am going to the [primărie] later',
  'My [bunica] asked me this:', 'This is for the [proiect] I am on', 'I am preparing the [prezentare] and', 'I have a quick [întrebare]',
  'I promised my [colegă] an answer:', 'We have an [echipă] meeting soon', 'I am filling in a [formular] and', 'My [vecin] was wondering:',
  'I have an [examen] on Friday', 'I am writing a [cerere]', 'I have to answer a message from the [firmă]:', 'My [șefa] wants the calendar updated',
  'There is a [concurs] at school', 'I am planning the [excursie] and', 'My [prietenă] and I disagree:', 'There is a [nuntă] next month',
  'I am doing the [inventar] at work:', 'We have a [ședință] with the [părinți]', 'I am checking something for my [tata]:', 'I am planning the [petrecere] for Saturday',
];
const RO_TAGS_FOR_EN = [', nu?', ', știi?', ', nu-i așa?', ', da?', '? Mersi!'];
// Openers include discourse markers bilingual writers carry across ("deci", "adică"; "anyway", "basically").
const RO_OPENERS_FOR_EN = ['Salut, ', 'Bun, ', 'Mersi anticipat. ', 'Deci, ', 'Adică, ', 'Hai, '];
const EN_TAGS_FOR_RO = [', right?', ', ok?', ', you know?', '? Thanks!', ', correct?'];
const EN_OPENERS_FOR_RO = ['Ok, ', 'Hey, ', 'Sorry, ', 'Btw, ', 'Anyway, ', 'Basically, ', 'So, '];

/** The code-switching kinds the generator produces. */
export const CODE_SWITCH_KINDS = {
  clause_switch: 'assertions in one language, question in the other (inter-sentential)',
  ro_matrix_en_insertion: 'Romanian sentence with an English word or chunk inside it (intra-sentential)',
  en_matrix_ro_insertion: 'English sentence with a Romanian word or chunk inside it (intra-sentential)',
  ro_matrix_en_tag: 'Romanian sentence with an English opener or tag at its edge',
  en_matrix_ro_tag: 'English sentence with a Romanian opener or tag at its edge',
  ro_matrix_en_value: 'Romanian clause naming a common noun of the formalized proposition in English (inside the proposition; the target keeps the English label)',
  en_matrix_ro_value: 'English clause naming a common noun of the formalized proposition in Romanian (inside the proposition; the target writes its English label)',
};

const NAME_START = /^(?:\p{Lu}\p{Ll}+(?:[- ]\p{Lu}\p{Ll}+)*)\s+(?:lucrează|e|este|are|a|nu|și|locuiește|stă|învață|predă|joacă|zice|mi-a|vrea|intenționează|deține|vinde)\b/u;
/** Lowercase the first letter unless the message starts with a name. */
export const decapitalize = (text, names = []) => names.some(name => name && text.startsWith(name)) || /^(?:I|I'm|I'd)\b/.test(text) ? text : text[0].toLowerCase() + text.slice(1);
const DISCOURSE_OPENER = /^(Hi|Hey|Ok|Okay|So|Salut|Bun|Deci|Background|Context|Btw|Sorry|Here's|Știu|Anyway|Basically|Adică|Hai)\b/i;

/** Insert a chunk after the first comma or colon that is outside protected spans, else before the final mark. */
function insertChunk(text, chunk, protectedTexts) {
  const guard = index => !protectedTexts.some(p => { const at = text.indexOf(p); return at >= 0 && index > at && index < at + p.length; });
  const m = [...text.matchAll(/[,:] /g)].find(x => guard(x.index));
  if (m) return text.slice(0, m.index + 2) + chunk + ', ' + text.slice(m.index + 2);
  const end = text.search(/[?.!]\s*$/);
  return end > 0 ? `${text.slice(0, end)}, ${chunk}${text.slice(end)}` : `${text}, ${chunk}`;
}

/** Apply a switch of `kind` to a realized message. Returns {text, switch} or null. `protectedTexts` are entity
 * surfaces and relation phrases that must stay verbatim. The label records where the inserted text sits. */
export function codeSwitch(text, { matrix, random, kind, names = [], protectedTexts = [], choose = null }) {
  const guarded = [...names, ...protectedTexts];
  if ((kind === 'ro_matrix_en_insertion' || kind === 'en_matrix_ro_insertion') && DISCOURSE_OPENER.test(text)) kind = 'tag';
  if (kind === 'ro_matrix_en_insertion' || kind === 'en_matrix_ro_insertion') {
    const table = kind === 'ro_matrix_en_insertion' ? RO_EN_LEXICAL : EN_RO_LEXICAL;
    const applicable = table.filter(([pattern]) => { pattern.lastIndex = 0; const m = text.match(pattern); return m && !guarded.some(g => g.includes(m[0])); });
    if (applicable.length && random.chance(0.6)) {
      const [pattern, to] = random.pick(applicable); pattern.lastIndex = 0;
      pattern.lastIndex = 0;
      const at = text.search(pattern);
      const swapped = text.replace(pattern, to);
      const edge = at === 0 ? 'start' : 'inside';
      return { text: swapped[0].toUpperCase() + swapped.slice(1), switch: { kind: edge === 'start' ? (matrix === 'ro' ? 'ro_matrix_en_tag' : 'en_matrix_ro_tag') : kind, matrix, embedded: matrix === 'ro' ? 'en' : 'ro', inserted: [to], position: edge } };
    }
    const pool = kind === 'ro_matrix_en_insertion' ? RO_CARRIERS_WITH_EN : EN_CARRIERS_WITH_RO;
    const carrier = choose ? choose(`carrier:${kind}`, pool.map((text, i) => ({ id: `carrier.${kind}.${i}`, text }))).text : random.pick(pool);
    const inserted = [...carrier.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
    // The carrier becomes its own sentence, so it never collides with the question frame that follows.
    let sentence = carrier.replace(/[\[\]]/g, '');
    for (let previous = null; previous !== sentence;) { previous = sentence; sentence = sentence.replace(/(,? (și|deci|so|and)|,? (aș vrea|vreau) să știu)$/, '').replace(/[:,]$/, ''); }
    sentence += '.';
    return { text: `${sentence} ${text}`, switch: { kind, matrix, embedded: matrix === 'ro' ? 'en' : 'ro', inserted, position: 'inside' } };
  }
  const tagKind = matrix === 'ro' ? 'ro_matrix_en_tag' : 'en_matrix_ro_tag';
  // A tag ("right?", "nu?") only closes a yes/no question; a wh-question or an embedded question takes an opener.
  const lastSentence = text.split(/(?<=[.!:])\s+/).at(-1) ?? text;
  const tagFits = !/\b(who|whom|whose|what|which|when|where|why|how|do you know|can you|could you|is it true|is it correct|is it the case|confirm|cine|ce|care|când|unde|cum|câți|câte|cât|știi|poți|ai idee|e adevărat|e corect|se poate confirma)\b/i.test(lastSentence);
  // A question that already ends in a tag or "or not" takes no second tag.
  const tagged = /(,\s*(right|correct|ok|you know|nu|da|știi|nu-i așa|așa e|asa e)|\b(or not|sau nu)|așa e|nu-i așa)\s*\?$/i.test(text);
  if (tagFits && !tagged && random.chance(0.5) && /\?$/.test(text)) {
    const tag = random.pick(matrix === 'ro' ? EN_TAGS_FOR_RO : RO_TAGS_FOR_EN);
    return { text: text.replace(/\?$/, tag), switch: { kind: tagKind, matrix, embedded: matrix === 'ro' ? 'en' : 'ro', inserted: [tag.replace(/^(, |\? )/, '')], position: 'end' } };
  }
  if (DISCOURSE_OPENER.test(text)) return null;
  const opener = random.pick(matrix === 'ro' ? EN_OPENERS_FOR_RO : RO_OPENERS_FOR_EN);
  return { text: opener + (opener.endsWith('. ') ? text : decapitalize(text, names)), switch: { kind: tagKind, matrix, embedded: matrix === 'ro' ? 'en' : 'ro', inserted: [opener.trim()], position: 'start' } };
}
