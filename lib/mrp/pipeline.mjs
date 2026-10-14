/**
 * The MRP-LLM turn around the symbolic core (DS025 "The turn", DS026 "Language"). The core (lib/adapter/chat-turn.mjs: formalize,
 * admit, link, retrieve, reason, verify, render) is ChatSOP's and reads English. This module runs the slots before and after it with
 * the strategies of the turn's Model:
 *
 *   before   normalize (the message in clean English + its language)  ->  affect  ->  reflex (a pattern or affect reflex, or an FAQ answer, may end the turn)
 *   core     the English text through the formalizer and the reasoners; the rendered English answer
 *   after    roundtrip (restate the circuit, compare)  ->  voice (the answer in the output language)  ->  commit (session knowledge)
 *
 * Every stage appends `{slot, strategy, ms, ...}` to the turn's trace. A strategy that cannot run (its tier is unavailable) is reported
 * in the trace and its stage degrades in the documented way (normalize keeps the original text, voice keeps the English answer); a
 * strategy is never replaced by another one.
 */
import {pworker, jsonOf, stripThinking} from '../pworker.mjs';
import {strategy as findStrategy, availability} from './strategies.mjs';
import {rank, similarity} from './similarity.mjs';
import {readAffect} from './affect-lexicon.mjs';
import {runTask} from './tasks.mjs';
import {serviceCall} from './strategy-service.mjs';
import {looksEnglish, keptTokens, keptNames, compactPacket} from '../../server/answer-language.mjs';

export const LANGUAGE_NAMES = Object.freeze({en: 'English', ro: 'Romanian', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch',
  pl: 'Polish', ru: 'Russian', uk: 'Ukrainian', hu: 'Hungarian', cs: 'Czech', sk: 'Slovak', bg: 'Bulgarian', el: 'Greek', tr: 'Turkish', ar: 'Arabic', he: 'Hebrew',
  zh: 'Chinese', ja: 'Japanese', ko: 'Korean', hi: 'Hindi', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', sr: 'Serbian', hr: 'Croatian', sl: 'Slovenian', md: 'Romanian'});
export const languageName = code => LANGUAGE_NAMES[String(code ?? '').toLowerCase().split('-')[0]] ?? String(code);
const AFFECT_LABELS = ['neutral', 'frustrated', 'urgent', 'confused', 'grateful', 'angry', 'happy', 'sad'];

// The prompts of the slots are Ploinky tasks: config/tasks/mrp-normalize.md, mrp-faq-judge.md, mrp-affect-label.md, mrp-roundtrip.md, mrp-voice.md (lib/mrp/tasks.mjs).
const TONE = {frustrated: 'The user seems frustrated: be calm, brief and acknowledge it in a few words.', angry: 'The user seems angry: stay calm and polite, acknowledge it in a few words.',
  urgent: 'The user seems in a hurry: be very brief.', confused: 'The user seems confused: be especially clear.', sad: 'The user seems sad: be warm.'};

/** Picks the circuit's doubt signals: unclear/unparsed/assumed lines, a step-by-step question that escalated to a larger tier, or an ensemble without agreement. */
export function doubted({modelSop = '', parse = null} = {}) {
  const reasons = [];
  const kinds = [...String(modelSop).matchAll(/^@[A-Za-z][A-Za-z0-9_]*\s+(unclear|unparsed|assumed)\b/gm)].map(m => m[1]);
  if (kinds.length) reasons.push(`${[...new Set(kinds)].join(', ')} lines in the circuit`);
  const escalated = parse?.escalated ?? parse?.escalations ?? parse?.questions?.filter?.(q => q?.escalated)?.length ?? 0;
  if ((Array.isArray(escalated) ? escalated.length : Number(escalated)) > 0) reasons.push('a formalization question escalated to a larger tier');
  if (parse?.ensemble?.agreement === 'none') reasons.push('the formalizers of the ensemble disagreed');
  return reasons;
}

/**
 * The MRP turn runner. `models`: lib/mrp/models.mjs; `client`: a Ploinky client factory `(purpose) => client` (tests pass fakes);
 * `random`: the sampling source of lexical-sampled; `extraBody`: request fields sent with every call (config `mrp.extraBody`, for example
 * thinking disabled).
 */
/**
 * The Ploinky purpose tag of each slot's calls. Ploinky admits only its allowed purposes (chat, formalize, answer-*, job:*, ...) and
 * counts every other tag against a small daily allowance, so the slots of a chat turn are tagged as answer work.
 */
export const SLOT_PURPOSES = Object.freeze({normalize: 'answer-normalize', reflex: 'answer-reflex', affect: 'answer-affect', roundtrip: 'answer-roundtrip', voice: 'answer-voice'});

export function createMrpPipeline({models, client = purpose => pworker({purpose: SLOT_PURPOSES[purpose] ?? `answer-${purpose}`, priority: 'interactive'}), random = Math.random, extraBody = null} = {}) {
  // One Ploinky task of a slot (lib/mrp/tasks.mjs), run in this process through the slot's client: `{ok, text, value, reason, served}`.
  const task = async (purpose, name, input, tier) => {
    const r = await runTask(name, input, {client: client(purpose), tier, extraBody});
    return {ok: r.ok, value: r.value, text: r.ok && typeof r.value === 'string' ? stripThinking(r.value) : '', reason: r.error, served: r.served};
  };

  async function normalize(slot, text, trace, history = []) {
    const t0 = Date.now(), {strategy: id, params} = slot;
    const done = (out, extra = {}) => { trace.push({slot: 'normalize', strategy: id, ms: Date.now() - t0, language: out.language, english: out.english, changed: out.english !== text, ...extra}); return out; };
    const heuristic = looksEnglish(text) ? 'en' : null;
    if (id === 'passthrough') return done({english: text, language: heuristic ?? 'und'});
    if (id === 'translate-if-foreign' && heuristic === 'en') return done({english: text, language: 'en'}, {skipped: 'the message reads as English'});
    const previous = (params.context ?? 0) > 0 ? history.slice(-2 * params.context).filter(h => h && typeof h.text === 'string' && h.text.trim()) : [];
    const turns = previous.map(h => `${h.role === 'user' ? 'USER' : 'ASSISTANT'}: ${h.text.slice(0, 600)}`).join('\n');
    const r = await task('normalize', 'mrp-normalize', {mode: id === 'proofread-llm' ? 'proofread' : id === 'translate-llm' ? 'translate' : 'foreign', formal: params.formalize !== false, turns, message: text}, params.tier);
    const j = r.ok ? jsonOf(r.text) : null;
    if (!j || typeof j.english !== 'string' || !j.english.trim()) return done({english: text, language: heuristic ?? 'und'}, {degraded: r.ok ? 'the model returned no readable JSON; the original message is used' : `tier ${params.tier} failed (${r.reason}); the original message is used`});
    const language = typeof j.language === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(j.language) ? j.language.toLowerCase() : heuristic ?? 'und';
    return done({english: j.english.trim(), language}, {served: r.served ?? null, ...(previous.length ? {context_turns: previous.length} : {})});
  }

  /**
   * The pattern reflexes of the model (every reflex strategy but `off`): the first pattern by priority that matches the English text.
   * `stop` answers and ends the turn, `continue` prefaces the computed answer, `pragmatic` only gives the voice a tone line.
   */
  function patternReflex(model, english, memoryReflexes = [], mood = null) {
    const list = [...(model.reflexes ?? []), ...memoryReflexes].sort((a, b) => b.priority - a.priority);
    const text = String(english).slice(0, 2000);
    const feels = label => mood?.label === label && mood.intensity >= 0.5;
    for (const r of list) if ((!r.pattern || new RegExp(r.pattern, 'iu').test(text)) && (!r.affect || feels(r.affect))) return r;
    return null;
  }

  async function reflex(slot, english, model, trace, {memoryReflexes = [], mood = null} = {}) {
    const t0 = Date.now(), {strategy: id, params} = slot;
    const pattern = id === 'off' ? null : patternReflex(model, english, memoryReflexes, mood);
    const patternEntry = pattern ? {pattern: {id: pattern.id, mode: pattern.mode, ...(pattern.affect ? {affect: pattern.affect} : {}), ...(pattern.source === 'memory' ? {source: 'memory'} : {})}} : {};
    if (pattern) models.recordReflexHit(model.id);
    if (pattern?.mode === 'stop') { trace.push({slot: 'reflex', strategy: id, ms: Date.now() - t0, fired: true, ...patternEntry}); return {hit: {id: pattern.id, kind: 'pattern', question: pattern.pattern, answer: pattern.reply, score: 1}}; }
    const extra = pattern?.mode === 'continue' ? {preface: pattern.reply} : pattern?.mode === 'pragmatic' ? {tone: pattern.tone} : {};
    if (id === 'off' || id === 'pattern-reflex' || !model.faq?.length) { trace.push({slot: 'reflex', strategy: id, ms: Date.now() - t0, fired: false, ...patternEntry, ...(id !== 'off' && id !== 'pattern-reflex' ? {note: 'the model has no FAQ'} : {})}); return {hit: null, ...extra}; }
    if (id === 'faq-hybrid') {
      const ranked = rank(english, model.faq), best = ranked[0];
      const entry = {slot: 'reflex', strategy: id, ...patternEntry, best: best ? {id: best.id, score: best.score} : null};
      if (!best || best.score < params.low) { trace.push({...entry, fired: false, band: 'low', ms: Date.now() - t0}); return {hit: null, ...extra}; }
      if (best.score >= params.high) { models.recordReflexHit(model.id); const item = model.faq.find(f => f.id === best.id); trace.push({...entry, fired: true, band: 'high', ms: Date.now() - t0}); return {hit: {id: item.id, kind: 'faq', question: item.q, answer: item.a, score: best.score}, ...extra}; }
      const shown = ranked.slice(0, params.k).map(r => model.faq.find(f => f.id === r.id));
      const r = await task('reflex', 'mrp-faq-select', {entries: shown.map(f => `- ${f.id}: ${[f.q, ...(f.variants ?? [])].join(' | ')}`).join('\n'), message: english}, params.tier);
      const j = r.ok ? jsonOf(r.text) : null;
      const item = j && typeof j.faq === 'string' ? shown.find(f => f.id === j.faq) : null;
      trace.push({...entry, fired: Boolean(item), band: 'model', ms: Date.now() - t0, ...(j ? {chosen: j.faq ?? null} : {degraded: r.ok ? 'unreadable reply' : r.reason})});
      if (!item) return {hit: null, ...extra};
      models.recordReflexHit(model.id);
      return {hit: {id: item.id, kind: 'faq', question: item.q, answer: item.a, score: best.score}, ...extra};
    }
    if (id === 'faq-llm-select') {
      const shown = model.faq.length <= params.maxEntries ? model.faq : rank(english, model.faq).slice(0, params.maxEntries).map(r => model.faq.find(f => f.id === r.id));
      const entries = shown.map(f => `- ${f.id}: ${[f.q, ...(f.variants ?? [])].join(' | ')}`).join('\n');
      const r = await task('reflex', 'mrp-faq-select', {entries, message: english}, params.tier);
      const j = r.ok ? jsonOf(r.text) : null;
      const item = j && typeof j.faq === 'string' ? shown.find(f => f.id === j.faq) : null;
      trace.push({slot: 'reflex', strategy: id, ...patternEntry, ms: Date.now() - t0, fired: Boolean(item), shown: shown.length, ...(j ? {chosen: j.faq ?? null} : {degraded: r.ok ? 'unreadable reply' : r.reason})});
      if (!item) return {hit: null, ...extra};
      models.recordReflexHit(model.id);
      return {hit: {id: item.id, kind: 'faq', question: item.q, answer: item.a, score: null}, ...extra};
    }
    const ranked = rank(english, model.faq);
    const best = ranked[0], second = ranked[1] ?? {score: 0};
    const entry = {slot: 'reflex', strategy: id, best: best ? {id: best.id, score: best.score, matched: best.matched} : null, threshold: params.threshold};
    let fired = best && best.score >= params.threshold;
    if (fired && id === 'faq-margin') { entry.margin = Math.round((best.score - second.score) * 1000) / 1000; fired = entry.margin >= params.margin; }
    if (fired && id === 'faq-llm-judge') {
      const q = model.faq.find(f => f.id === best.id).q;
      const r = await task('reflex', 'mrp-faq-judge', {message: english, question: q}, params.tier);
      const j = r.ok ? jsonOf(r.text) : null;
      entry.judge = j ? {same: j.same === true} : {failed: r.reason ?? 'unreadable reply'};
      fired = j?.same === true;
    }
    trace.push({...entry, ...patternEntry, fired: Boolean(fired), ms: Date.now() - t0});
    if (!fired) return {hit: null, ...extra};
    models.recordReflexHit(model.id);
    const item = model.faq.find(f => f.id === best.id);
    return {hit: {id: item.id, kind: 'faq', question: item.q, answer: item.a, score: best.score}, ...extra};
  }

  async function affect(slot, english, trace) {
    const t0 = Date.now(), {strategy: id, params} = slot;
    if (id === 'lexicon' || id === 'lexicon-then-llm') {
      const read = readAffect(english);
      if (read.label !== 'neutral' || id === 'lexicon') {
        trace.push({slot: 'affect', strategy: id, ms: Date.now() - t0, label: read.label, intensity: read.intensity, cues: read.cues});
        return read.label === 'neutral' ? null : {label: read.label, intensity: read.intensity};
      }
    }
    if (id !== 'llm-label' && id !== 'lexicon-then-llm') { trace.push({slot: 'affect', strategy: id, ms: 0}); return null; }
    const r = await task('affect', 'mrp-affect-label', {message: english}, params.tier);
    const j = r.ok ? jsonOf(r.text) : null;
    const out = j && AFFECT_LABELS.includes(j.label) ? {label: j.label, intensity: Math.max(0, Math.min(1, Number(j.intensity) || 0))} : null;
    trace.push({slot: 'affect', strategy: id, ms: Date.now() - t0, ...(out ?? {degraded: r.ok ? 'unreadable reply' : r.reason})});
    return out;
  }

  /** The slots before the core: `{effective, english, language, reflex, affect, trace}`. */
  /** `history`: the previous turns of the session, oldest first: `[{role: 'user'|'assistant', text}]` (the user's turns in English when known). `memoryReflexes`: the reflex wires of the base memory (sop/lexicon.mjs `reflexes`). */
  async function before({modelId, text, session = {}, request = {}, history = [], memoryReflexes = []}) {
    const effective = models.effective(modelId, {session, request});
    // A slot whose strategy runs outside this server (an external strategy) stops the turn with the reason: never a silent substitute.
    // A strategy of the strategy service runs when the service can run it now (lib/mrp/strategies.mjs availability).
    const external = [];
    for (const [slot, v] of Object.entries(effective.slots)) {
      const entry = findStrategy(slot, v.strategy);
      if (entry?.runs !== 'external') continue;
      if (entry.service && (await availability(entry, {params: v.params})).available) continue;
      external.push([slot, v]);
    }
    if (external.length) {
      const [slot, v] = external[0];
      const entry = findStrategy(slot, v.strategy);
      const reason = entry.service ? (await availability(entry, {params: v.params})).reason : null;
      throw Object.assign(new Error(`the model ${modelId} uses the ${slot} strategy ${v.strategy}, which ${entry.implemented ? `requires ${entry.requires}${reason ? ` (${reason})` : ''}` : `is not implemented yet (a catalog entry of the design; it would require ${entry.requires})`}; choose a server strategy on /models`), {status: 503, code: 'strategy_unavailable'});
    }
    const trace = [];
    if (effective.refused.length) trace.push({slot: 'model', note: `the model does not allow overrides; the ${effective.refused.join(' and ')} overrides were not applied`});
    const n = await normalize(effective.slots.normalize, text, trace, history);
    // Affect runs before the reflex, so a reflex can react to an emotion ("I see this is urgent; checking now").
    const mood = await affect(effective.slots.affect, n.english, trace);
    const {hit, preface = null, tone = null} = await reflex(effective.slots.reflex, n.english, effective.model, trace, {memoryReflexes, mood});
    const output = effective.language.output === 'auto' ? (n.language === 'und' ? (looksEnglish(text) ? 'en' : 'und') : n.language) : effective.language.output;
    return {effective, original: text, english: n.english, language: n.language, output, reflex: hit, preface, tone, affect: mood, trace};
  }

  async function roundtrip(slot, {english, modelSop, parse}, trace) {
    const t0 = Date.now(), {strategy: id, params} = slot;
    if (id === 'off' || !modelSop) { trace.push({slot: 'roundtrip', strategy: id, ms: 0, ran: false, ...(id !== 'off' ? {note: 'no circuit'} : {})}); return null; }
    // A circuit made only of unclear/unparsed reports formalized nothing: there is no question to restate.
    const types = [...String(modelSop).matchAll(/^@[A-Za-z][A-Za-z0-9_]*\s+([A-Za-z]+)/gm)].map(m => m[1]);
    if (types.length && types.every(t => t === 'unclear' || t === 'unparsed')) { trace.push({slot: 'roundtrip', strategy: id, ms: 0, ran: false, note: 'nothing was formalized'}); return null; }
    if (id === 'lexical-sampled' && random() >= params.rate) { trace.push({slot: 'roundtrip', strategy: id, ms: 0, ran: false, note: 'not sampled'}); return null; }
    if (id === 'on-doubt' || id === 'judge-on-doubt') {
      const reasons = doubted({modelSop, parse});
      if (!reasons.length) { trace.push({slot: 'roundtrip', strategy: id, ms: 0, ran: false, note: 'the formalizer showed no doubt'}); return null; }
    }
    const judged = id === 'llm-judge' || id === 'judge-on-doubt';
    const r = await task('roundtrip', 'mrp-roundtrip', {sop: modelSop, english, judge: judged}, params.tier);
    const restated = r.ok ? stripThinking(String(r.value?.restated ?? '')) : '';
    if (!restated) { trace.push({slot: 'roundtrip', strategy: id, ms: Date.now() - t0, ran: false, degraded: r.reason ?? 'empty restatement'}); return null; }
    let agree, score = Math.round(similarity(english, restated) * 1000) / 1000;
    if (id === 'embedding') {
      const [a, b] = (await serviceCall('encode', 'dense', {texts: [english, restated]})).vectors;
      score = Math.round(a.reduce((s, x, i) => s + x * b[i], 0) * 1000) / 1000;
      agree = score >= params.threshold;
    } else if (judged) {
      const parsed = r.value?.verdict ? jsonOf(stripThinking(String(r.value.verdict))) : null;
      agree = parsed ? parsed.same === true : null;
    } else agree = score >= params.threshold;
    const out = {ran: true, restated, score, agree, onMismatch: params.onMismatch};
    trace.push({slot: 'roundtrip', strategy: id, ms: Date.now() - t0, ...out});
    return out;
  }

  async function voice(slot, {english, packet, output, original, affect: mood, tone = null}, trace) {
    const t0 = Date.now(), {strategy: id, params} = slot;
    const target = output === 'und' ? 'the language of the USER MESSAGE' : languageName(output);
    const plainEnglish = output === 'en';
    if (id === 'english-only' || ((id === 'translate-only' || id === 'natural-if-foreign') && plainEnglish)) { trace.push({slot: 'voice', strategy: id, ms: 0, applied: false, output, note: id === 'english-only' ? 'deterministic English' : 'output is English'}); return {text: english, applied: false}; }
    const natural = id === 'natural-rephrase' || id === 'natural-if-foreign';
    const toneLine = [mood && TONE[mood.label] && mood.intensity >= 0.4 ? TONE[mood.label] : '', tone && natural ? 'Tone: ' + tone : ''].filter(Boolean).join('\n');
    const r = await task('voice', 'mrp-voice', {mode: natural ? 'natural' : 'translate', target, tone: toneLine, original, english, packet: JSON.stringify(compactPacket(packet ?? {}))}, params.tier);
    const text = r.ok ? r.text.trim() : '';
    const first = english.split('\n')[0];
    const must = natural && plainEnglish ? [...new Set([...keptTokens(first), ...keptNames(first)])] : keptTokens(english);
    const missing = text ? must.filter(t => !text.includes(t)) : [];
    if (!text || missing.length) {
      trace.push({slot: 'voice', strategy: id, ms: Date.now() - t0, applied: false, output, degraded: !text ? (r.reason ?? 'no text') : `the phrasing dropped ${missing.slice(0, 5).join(', ')}; the English answer is shown`});
      return {text: english, applied: false};
    }
    trace.push({slot: 'voice', strategy: id, ms: Date.now() - t0, applied: true, output, served: r.served ?? null});
    return {text, applied: true};
  }

  /**
   * The slots after the core: `{text, english, roundtrip, trace}`. `result`: the core's turn result (`text` the rendered English answer,
   * `sop` the authored circuit, `packet`); `parse`: the formalizer's parse record.
   */
  async function after({pre, result, parse = null}) {
    const trace = [...pre.trace];
    const english = String(result?.text ?? '');
    const check = await roundtrip(pre.effective.slots.roundtrip, {english: pre.english, modelSop: result?.sop ?? '', parse}, trace);
    let draft = pre.preface ? `${pre.preface}\n\n${english}` : english;
    if (check?.ran && check.agree === false && check.onMismatch === 'warn') draft = `${draft}\n\n(Note: I understood your message as: "${check.restated}". If that is not what you meant, please rephrase.)`;
    const spoken = await voice(pre.effective.slots.voice, {english: draft, packet: result?.packet, output: pre.output, original: pre.original, affect: pre.affect, tone: pre.tone}, trace);
    return {text: spoken.text, english: draft, roundtrip: check, trace};
  }

  /** A reflex turn: the FAQ or pattern answer (after a `continue` pattern's preface) through the voice slot. */
  async function reflexReply({pre}) {
    const trace = [...pre.trace];
    const english = pre.preface ? `${pre.preface}\n\n${pre.reflex.answer}` : pre.reflex.answer;
    const spoken = await voice(pre.effective.slots.voice, {english, packet: {status: pre.reflex.kind === 'pattern' ? 'reflex' : 'faq', reply: null}, output: pre.output, original: pre.original, affect: null, tone: pre.tone}, trace);
    return {text: spoken.text, english, trace};
  }

  return {before, after, reflexReply, normalize, reflex, roundtrip, voice};
}

/** Whether a strategy id exists for a slot (used by tests and the API). */
export const knownStrategy = (slot, id) => Boolean(findStrategy(slot, id));
