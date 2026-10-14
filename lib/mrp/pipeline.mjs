/**
 * The MRP-LLM turn around the symbolic core (DS025 "The turn", DS026 "Language"). The core (lib/adapter/chat-turn.mjs: formalize,
 * admit, link, retrieve, reason, verify, render) is ChatSOP's and reads English. This module runs the slots before and after it with
 * the strategies of the turn's Model:
 *
 *   before   normalize (the message in clean English + its language)  ->  reflex (an FAQ answer ends the turn)  ->  affect
 *   core     the English text through the formalizer and the reasoners; the rendered English answer
 *   after    roundtrip (restate the circuit, compare)  ->  voice (the answer in the output language)  ->  commit (session knowledge)
 *
 * Every stage appends `{slot, strategy, ms, ...}` to the turn's trace. A strategy that cannot run (its tier is unavailable) is reported
 * in the trace and its stage degrades in the documented way (normalize keeps the original text, voice keeps the English answer); a
 * strategy is never replaced by another one.
 */
import {pworker, jsonOf, stripThinking} from '../pworker.mjs';
import {strategy as findStrategy} from './strategies.mjs';
import {rank, similarity} from './similarity.mjs';
import {looksEnglish, keptTokens, keptNames, compactPacket} from '../../server/answer-language.mjs';

export const LANGUAGE_NAMES = Object.freeze({en: 'English', ro: 'Romanian', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch',
  pl: 'Polish', ru: 'Russian', uk: 'Ukrainian', hu: 'Hungarian', cs: 'Czech', sk: 'Slovak', bg: 'Bulgarian', el: 'Greek', tr: 'Turkish', ar: 'Arabic', he: 'Hebrew',
  zh: 'Chinese', ja: 'Japanese', ko: 'Korean', hi: 'Hindi', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', sr: 'Serbian', hr: 'Croatian', sl: 'Slovenian', md: 'Romanian'});
export const languageName = code => LANGUAGE_NAMES[String(code ?? '').toLowerCase().split('-')[0]] ?? String(code);
const AFFECT_LABELS = ['neutral', 'frustrated', 'urgent', 'confused', 'grateful', 'angry', 'happy', 'sad'];

const NORMALIZE_SYSTEM = `You prepare a user's chat message for a symbolic reasoning system that reads only English.
Return one JSON object and nothing else: {"language": "<ISO 639-1 code of the message's language>", "english": "<the message in English>", "changed": <true|false>}.
Rules: translate faithfully into English; fix spelling and grammar; keep every name, number, date, quantity, code and quoted text exactly; never answer the message, never add or remove content, never add explanations.`;
const NORMALIZE_FORMAL = ' Also make casual, elliptical or garbled wording explicit and plain (for example "u know where ana works??" becomes "Do you know where Ana works?"), without adding content.';
const NORMALIZE_CONTEXT = ' PREVIOUS TURNS of the conversation are given before the message: make the message self-contained, so it can be understood without them. Resolve pronouns and ellipsis ("and Globex?" after a question about Acme), and restate in the message every value, name or fact the user stated in the previous turns that the message relies on (for example "What is MY_VAR?" after "Remember that MY_VAR is 100" becomes "Given that MY_VAR is 100, what is MY_VAR?"). Use only what the user said; never use the assistant\'s answers as facts; add nothing else.';
const PROOFREAD_SYSTEM = `You proofread a user's chat message for a symbolic reasoning system that reads only English.
Return one JSON object and nothing else: {"language": "<ISO 639-1 code of the message's language>", "english": "<the corrected message>", "changed": <true|false>}.
Rules: when the message is English, fix only spelling and grammar and keep its wording; when it is in another language, translate it faithfully into English; keep names, numbers, dates and quoted text exactly; never answer the message.`;
const AFFECT_SYSTEM = `Label the emotion of a user's chat message. Return one JSON object and nothing else: {"label": one of ${JSON.stringify(AFFECT_LABELS)}, "intensity": a number from 0 to 1}.`;
const JUDGE_FAQ = `Decide whether a user's message asks the same thing as a FAQ question, so that the FAQ answer fully answers it. Return one JSON object and nothing else: {"same": true|false}.`;
const RESTATE = `You read a formal query or statement written in SOP Lang (wires: @name type, then indented "key value" lines; ?x are variables, quoted strings are names, "where p a b" means a condition p(a,b), "select ?x" means the answer asked for).
Restate in ONE plain English sentence what the user asked or stated, as the user would have said it. Output only that sentence.`;
const JUDGE_SAME = `Decide whether two English sentences ask or state the same thing (the same question about the same entities and relation; wording may differ). Return one JSON object and nothing else: {"same": true|false}.`;
const VOICE_NATURAL = target => `You are the voice of a symbolic question-answering assistant. Rewrite the DRAFT REPLY as a short, natural, friendly chat reply in ${target}.
Rules: use ONLY what the DRAFT REPLY and the RESULT say; add no fact, no opinion and nothing from your own knowledge; keep every number, date, proper name and source id exactly as written; keep the meaning of yes, no, "I don't know", of an apology and of a suggestion, and keep every question the draft asks the user; keep what the draft says about the assistant itself and never claim a feeling, experience or ability the draft does not state; you may turn lists into a sentence, drop labels such as "Answer:" and shorten the sources line to one short sentence. Keep it brief. Output only the reply text.`;
const VOICE_TRANSLATE = target => `You translate a verified answer into ${target}.
Rules: translate faithfully; add no fact, no explanation and no opinion; keep every number, date, proper name and source id exactly as written; keep the meaning of yes, no, "I do not know" and of a clarification question; keep the sources line, translating only its words. Output only the translated text.`;
const TONE = {frustrated: 'The user seems frustrated: be calm, brief and acknowledge it in a few words.', angry: 'The user seems angry: stay calm and polite, acknowledge it in a few words.',
  urgent: 'The user seems in a hurry: be very brief.', confused: 'The user seems confused: be especially clear.', sad: 'The user seems sad: be warm.'};

/** Picks the circuit's doubt signals: unclear/unparsed/assumed lines, or a step-by-step question that escalated to a larger tier. */
export function doubted({modelSop = '', parse = null} = {}) {
  const reasons = [];
  const kinds = [...String(modelSop).matchAll(/^@[A-Za-z][A-Za-z0-9_]*\s+(unclear|unparsed|assumed)\b/gm)].map(m => m[1]);
  if (kinds.length) reasons.push(`${[...new Set(kinds)].join(', ')} lines in the circuit`);
  const escalated = parse?.escalated ?? parse?.escalations ?? parse?.questions?.filter?.(q => q?.escalated)?.length ?? 0;
  if ((Array.isArray(escalated) ? escalated.length : Number(escalated)) > 0) reasons.push('a formalization question escalated to a larger tier');
  return reasons;
}

/**
 * The MRP turn runner. `models`: lib/mrp/models.mjs; `client`: a Ploinky client factory `(purpose) => client` (tests pass fakes);
 * `random`: the sampling source of lexical-sampled; `extraBody`: request fields sent with every call (config `mrp.extraBody`, for example
 * thinking disabled).
 */
export function createMrpPipeline({models, client = purpose => pworker({purpose, priority: 'interactive'}), random = Math.random, extraBody = null} = {}) {
  const ask = async (purpose, {tier, system, prompt, maxTokens = 600}) => {
    const r = await client(purpose).chat({tier, system, prompt, maxTokens, temperature: 0, ...(extraBody ? {extraBody} : {})});
    return {...r, text: stripThinking(r.text ?? '')};
  };

  async function normalize(slot, text, trace, history = []) {
    const t0 = Date.now(), {strategy: id, params} = slot;
    const done = (out, extra = {}) => { trace.push({slot: 'normalize', strategy: id, ms: Date.now() - t0, language: out.language, english: out.english, changed: out.english !== text, ...extra}); return out; };
    const heuristic = looksEnglish(text) ? 'en' : null;
    if (id === 'passthrough') return done({english: text, language: heuristic ?? 'und'});
    if (id === 'translate-if-foreign' && heuristic === 'en') return done({english: text, language: 'en'}, {skipped: 'the message reads as English'});
    const previous = (params.context ?? 0) > 0 ? history.slice(-2 * params.context).filter(h => h && typeof h.text === 'string' && h.text.trim()) : [];
    const system = (id === 'proofread-llm' ? PROOFREAD_SYSTEM : NORMALIZE_SYSTEM + (id === 'translate-llm' && params.formalize !== false ? NORMALIZE_FORMAL : '')) + (previous.length ? NORMALIZE_CONTEXT : '');
    const turns = previous.length ? `PREVIOUS TURNS:\n${previous.map(h => `${h.role === 'user' ? 'USER' : 'ASSISTANT'}: ${h.text.slice(0, 600)}`).join('\n')}\n\n` : '';
    const r = await ask('normalize', {tier: params.tier, system, prompt: `${turns}MESSAGE:\n${text}`, maxTokens: 800});
    const j = r.ok ? jsonOf(r.text) : null;
    if (!j || typeof j.english !== 'string' || !j.english.trim()) return done({english: text, language: heuristic ?? 'und'}, {degraded: r.ok ? 'the model returned no readable JSON; the original message is used' : `tier ${params.tier} failed (${r.reason}); the original message is used`});
    const language = typeof j.language === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(j.language) ? j.language.toLowerCase() : heuristic ?? 'und';
    return done({english: j.english.trim(), language}, {served: r.served ?? null, ...(previous.length ? {context_turns: previous.length} : {})});
  }

  async function reflex(slot, english, model, trace) {
    const t0 = Date.now(), {strategy: id, params} = slot;
    if (id === 'off' || !model.faq?.length) { trace.push({slot: 'reflex', strategy: id, ms: 0, fired: false, ...(id !== 'off' ? {note: 'the model has no FAQ'} : {})}); return null; }
    const ranked = rank(english, model.faq);
    const best = ranked[0], second = ranked[1] ?? {score: 0};
    const entry = {slot: 'reflex', strategy: id, best: best ? {id: best.id, score: best.score, matched: best.matched} : null, threshold: params.threshold};
    let fired = best && best.score >= params.threshold;
    if (fired && id === 'faq-margin') { entry.margin = Math.round((best.score - second.score) * 1000) / 1000; fired = entry.margin >= params.margin; }
    if (fired && id === 'faq-llm-judge') {
      const q = model.faq.find(f => f.id === best.id).q;
      const r = await ask('reflex', {tier: params.tier, system: JUDGE_FAQ, prompt: `MESSAGE: ${english}\nFAQ QUESTION: ${q}`, maxTokens: 200});
      const j = r.ok ? jsonOf(r.text) : null;
      entry.judge = j ? {same: j.same === true} : {failed: r.reason ?? 'unreadable reply'};
      fired = j?.same === true;
    }
    trace.push({...entry, fired: Boolean(fired), ms: Date.now() - t0});
    if (!fired) return null;
    models.recordReflexHit(model.id);
    const item = model.faq.find(f => f.id === best.id);
    return {id: item.id, question: item.q, answer: item.a, score: best.score};
  }

  async function affect(slot, english, trace) {
    const t0 = Date.now(), {strategy: id, params} = slot;
    if (id !== 'llm-label') { trace.push({slot: 'affect', strategy: id, ms: 0}); return null; }
    const r = await ask('affect', {tier: params.tier, system: AFFECT_SYSTEM, prompt: `MESSAGE:\n${english}`, maxTokens: 200});
    const j = r.ok ? jsonOf(r.text) : null;
    const out = j && AFFECT_LABELS.includes(j.label) ? {label: j.label, intensity: Math.max(0, Math.min(1, Number(j.intensity) || 0))} : null;
    trace.push({slot: 'affect', strategy: id, ms: Date.now() - t0, ...(out ?? {degraded: r.ok ? 'unreadable reply' : r.reason})});
    return out;
  }

  /** The slots before the core: `{effective, english, language, reflex, affect, trace}`. */
  /** `history`: the previous turns of the session, oldest first: `[{role: 'user'|'assistant', text}]` (the user's turns in English when known). */
  async function before({modelId, text, session = {}, request = {}, history = []}) {
    const effective = models.effective(modelId, {session, request});
    // A slot whose strategy runs outside this server (an external strategy) stops the turn with the reason: never a silent substitute.
    const external = Object.entries(effective.slots).filter(([slot, v]) => findStrategy(slot, v.strategy)?.runs === 'external');
    if (external.length) {
      const [slot, v] = external[0];
      throw Object.assign(new Error(`the model ${modelId} uses the ${slot} strategy ${v.strategy}, which requires ${findStrategy(slot, v.strategy).requires}; choose a server strategy on /models`), {status: 503, code: 'strategy_unavailable'});
    }
    const trace = [];
    if (effective.refused.length) trace.push({slot: 'model', note: `the model does not allow overrides; the ${effective.refused.join(' and ')} overrides were not applied`});
    const n = await normalize(effective.slots.normalize, text, trace, history);
    const hit = await reflex(effective.slots.reflex, n.english, effective.model, trace);
    const mood = hit ? null : await affect(effective.slots.affect, n.english, trace);
    const output = effective.language.output === 'auto' ? (n.language === 'und' ? (looksEnglish(text) ? 'en' : 'und') : n.language) : effective.language.output;
    return {effective, original: text, english: n.english, language: n.language, output, reflex: hit, affect: mood, trace};
  }

  async function roundtrip(slot, {english, modelSop, parse}, trace) {
    const t0 = Date.now(), {strategy: id, params} = slot;
    if (id === 'off' || !modelSop) { trace.push({slot: 'roundtrip', strategy: id, ms: 0, ran: false, ...(id !== 'off' ? {note: 'no circuit'} : {})}); return null; }
    // A circuit made only of unclear/unparsed reports formalized nothing: there is no question to restate.
    const types = [...String(modelSop).matchAll(/^@[A-Za-z][A-Za-z0-9_]*\s+([A-Za-z]+)/gm)].map(m => m[1]);
    if (types.length && types.every(t => t === 'unclear' || t === 'unparsed')) { trace.push({slot: 'roundtrip', strategy: id, ms: 0, ran: false, note: 'nothing was formalized'}); return null; }
    if (id === 'lexical-sampled' && random() >= params.rate) { trace.push({slot: 'roundtrip', strategy: id, ms: 0, ran: false, note: 'not sampled'}); return null; }
    if (id === 'on-doubt') {
      const reasons = doubted({modelSop, parse});
      if (!reasons.length) { trace.push({slot: 'roundtrip', strategy: id, ms: 0, ran: false, note: 'the formalizer showed no doubt'}); return null; }
    }
    const r = await ask('roundtrip', {tier: params.tier, system: RESTATE, prompt: `SOP:\n${modelSop}`, maxTokens: 300});
    const restated = r.ok ? r.text.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '' : '';
    if (!restated) { trace.push({slot: 'roundtrip', strategy: id, ms: Date.now() - t0, ran: false, degraded: r.reason ?? 'empty restatement'}); return null; }
    let agree, score = Math.round(similarity(english, restated) * 1000) / 1000;
    if (id === 'llm-judge') {
      const j = await ask('roundtrip', {tier: params.tier, system: JUDGE_SAME, prompt: `A: ${english}\nB: ${restated}`, maxTokens: 200});
      const parsed = j.ok ? jsonOf(j.text) : null;
      agree = parsed ? parsed.same === true : null;
    } else agree = score >= params.threshold;
    const out = {ran: true, restated, score, agree, onMismatch: params.onMismatch};
    trace.push({slot: 'roundtrip', strategy: id, ms: Date.now() - t0, ...out});
    return out;
  }

  async function voice(slot, {english, packet, output, original, affect: mood}, trace) {
    const t0 = Date.now(), {strategy: id, params} = slot;
    const target = output === 'und' ? 'the language of the USER MESSAGE' : languageName(output);
    const plainEnglish = output === 'en';
    if (id === 'english-only' || (id === 'translate-only' && plainEnglish)) { trace.push({slot: 'voice', strategy: id, ms: 0, applied: false, output, note: id === 'english-only' ? 'deterministic English' : 'output is English'}); return {text: english, applied: false}; }
    const natural = id === 'natural-rephrase';
    const system = (natural ? VOICE_NATURAL(target) : VOICE_TRANSLATE(target)) + (mood && TONE[mood.label] && mood.intensity >= 0.4 ? '\n' + TONE[mood.label] : '');
    const prompt = natural ? `USER MESSAGE:\n${original}\n\nDRAFT REPLY:\n${english}\n\nRESULT:\n${JSON.stringify(compactPacket(packet ?? {}))}\n\nWrite the reply.` : `USER MESSAGE:\n${original}\n\nANSWER:\n${english}\n\nWrite the answer in ${target}.`;
    const r = await ask('voice', {tier: params.tier, system, prompt, maxTokens: 700});
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
    let draft = english;
    if (check?.ran && check.agree === false && check.onMismatch === 'warn') draft = `${english}\n\n(Note: I understood your message as: "${check.restated}". If that is not what you meant, please rephrase.)`;
    const spoken = await voice(pre.effective.slots.voice, {english: draft, packet: result?.packet, output: pre.output, original: pre.original, affect: pre.affect}, trace);
    return {text: spoken.text, english: draft, roundtrip: check, trace};
  }

  /** A reflex turn: the FAQ answer through the voice slot. */
  async function reflexReply({pre}) {
    const trace = [...pre.trace];
    const spoken = await voice(pre.effective.slots.voice, {english: pre.reflex.answer, packet: {status: 'faq', reply: null}, output: pre.output, original: pre.original, affect: null}, trace);
    return {text: spoken.text, english: pre.reflex.answer, trace};
  }

  return {before, after, reflexReply, normalize, reflex, roundtrip, voice};
}

/** Whether a strategy id exists for a slot (used by tests and the API). */
export const knownStrategy = (slot, id) => Boolean(findStrategy(slot, id));
