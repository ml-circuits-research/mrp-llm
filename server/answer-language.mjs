/**
 * Answer formulation in the user's language (DS009 "Answer language"). The request parser reads any language and writes English
 * circuits; the runtime reasons in English and `sop/answer-text.mjs` renders the answer deterministically in English. This optional
 * final step phrases that answer in the language of the user's message with the default model through the proxy (the providers of
 * `answerLanguage.providers`, by default the proxy tier `tiny` (the local Qwen3.6-35B-A3B, a short rewriting task) then `small`; never omp), strictly from the result: the English answer and a compact copy of the result
 * packet (status, answers, count, the facts used and their sources). The model adds no fact; every number and every source id of the
 * English answer must appear in its text, otherwise the English answer is returned. The English rendering is always kept in the trace.
 *
 * Natural phrasing (DS023 "Conversation layer", owner 2026-10-02: "less robotic, more natural"): the reply chosen from the conversation
 * layer and filled from the packet is the DRAFT; for an English message the same step rewrites it as a natural chat reply (varied
 * wording, lists as sentences, no "Answer:" label) under the same rules (no new fact; numbers, source ids and the names of the draft
 * kept). The draft stays the fallback and is kept in the trace.
 *
 * Settings (`answerLanguage` of config/runtime.json): `mode` `auto` (the default: on when the message does not look English; for English
 * the `natural` setting decides), `always` or `off`; `natural` `all` (the default: every English reply is phrased naturally),
 * `conversation` (only replies with a conversation-layer part besides the answer) or `off`; `timeoutSeconds` (default 25, the budget of the whole step).
 * `looksEnglish` is also the hook for local formalization strategies: the request parser receives `messageLanguage` (`en` or `other`)
 * and may translate a non-English message to English before a small local model reads it.
 */
import {providerChat} from '../lib/llm-providers.mjs';

export const DEFAULT_ANSWER_LANGUAGE = Object.freeze({mode: 'auto', natural: 'all', providers: ['tiny', 'small'], timeoutSeconds: 25, maxTokens: 400});

const ENGLISH = new Set(('a an the is are was were be been am do does did has have had who whom whose what which where when why how many much ' +
  'of in on at to from by with for about into over under than then and or not no yes my your his her its our their i you he she it we they ' +
  'this that these those there here can could would should will shall may might must located born live lives lived died wrote write written ' +
  'capital country city people person share border borders most least largest biggest list name all any some each every one two three if ' +
  'mother father son daughter wife husband author because after before since during').split(' '));

/** Whether a message reads as English: enough English function words, or a short plain-ASCII text (a name, a title). */
export function looksEnglish(text) {
  const words = String(text).toLowerCase().match(/\p{L}+/gu) ?? [];
  if (!words.length) return true;
  const english = words.filter(w => ENGLISH.has(w)).length;
  if (english / words.length >= 0.2) return true;
  return words.length <= 3 && /^[\x00-\x7f]*$/.test(text);
}

export function answerLanguageSettings(config = {}) {
  const own = config.answerLanguage ?? {};
  const merged = {...DEFAULT_ANSWER_LANGUAGE, ...own};
  // `provider` (one name) is the older form: it goes first, before the default chain.
  const providers = Array.isArray(own.providers) && own.providers.length ? own.providers : own.provider ? [own.provider, ...DEFAULT_ANSWER_LANGUAGE.providers] : DEFAULT_ANSWER_LANGUAGE.providers;
  return {...merged, providers: [...new Set(providers)], config};
}

const SYSTEM = `You phrase a verified answer for a user, in the language of the user's message.
Rules: use ONLY what the ENGLISH ANSWER and the RESULT say; add no fact, no explanation of your own, no opinion; never answer from your own knowledge; keep every number, date, proper name and source id exactly as written (you may use the usual form of a name in the user's language only when the English answer gives no other form of it); keep the meaning of yes, no, "I do not know" and of a clarification question; keep the sources line, translating only its words. Output only the answer text, nothing else.`;

const NATURAL = `You are the voice of a symbolic question-answering assistant. Rewrite the DRAFT REPLY as a short, natural, friendly chat reply in the language of the user's message, the way a helpful person would say it.
Rules: use ONLY what the DRAFT REPLY and the RESULT say; add no fact, no opinion and nothing from your own knowledge; keep every number, date, proper name and source id exactly as written; keep the meaning of yes, no, "I don't know", of an apology and of a suggestion, and keep every question the draft asks the user; keep what the draft says about the assistant itself (what it is, what it can or cannot do, that it has no feelings or experiences) and never claim a feeling, experience or ability the draft does not state; you may turn lists into a sentence, drop labels such as "Answer:" and shorten the sources line to one short sentence. Keep it brief. Output only the reply text.`;

/** Proper-name-like words of an English draft (a capital letter inside a sentence): the natural phrasing must keep them. */
export function keptNames(english) {
  const out = new Set();
  for (const line of String(english).split('\n')) for (const sentence of line.split(/(?<=[.!?:])\s+/)) {
    const words = sentence.split(/\s+/).slice(1);
    for (const w of words) { const m = /^\(?(\p{Lu}[\p{L}\p{M}'’-]+)/u.exec(w); if (m && m[1].length > 1) out.add(m[1].replace(/['’]s$/, '')); }
  }
  return [...out];
}

/** The compact result the model may use: no more than the English answer already states. */
export function compactPacket(packet = {}) {
  const facts = (packet.proof ?? []).slice(0, 20).map(f => ({relation: f.atom?.p, args: f.atom?.a, negated: f.atom?.neg || undefined, source: f.source || undefined}));
  return {status: packet.status ?? null, answers: packet.answers ?? packet.rows ?? undefined, count: packet.count, at_least: packet.at_least, facts};
}

/** Numbers and source ids of the English answer that the formulated answer must keep. */
export function keptTokens(english) {
  return [...new Set(String(english).match(/\b(?:Q\d+|P\d+|\d+(?:[.,]\d+)?)\b/g) ?? [])];
}

export function createAnswerFormulator({settings, chat = providerChat}) {
  /** Returns `{applied, text?, model?, ms, reason?, tried}`; `applied: false` keeps the English answer (the draft). */
  async function formulate({message, english: full, packet}) {
    const started = Date.now();
    const mode = settings.mode;
    const english_input = looksEnglish(message);
    const base = {mode, message_language: english_input ? 'en' : 'other'};
    const conversational = Boolean(packet.reply && (packet.reply.opening || packet.reply.closing || !/^answer_/.test(packet.reply.body?.situation ?? 'answer_found')));
    const natural = english_input && mode === 'auto' && (settings.natural === 'all' || (settings.natural === 'conversation' && conversational));
    if (mode === 'off' || (mode === 'auto' && english_input && !natural)) return {...base, applied: false, ms: 0, reason: mode === 'off' ? 'off by configuration' : 'the message is English'};
    base.natural = natural;
    // The user's instructed prefix and suffix (packet.reply.frame) are kept verbatim around the reworded reply.
    const frame = packet.reply?.frame ?? {};
    let english = String(full);
    if (frame.prefix && english.startsWith(frame.prefix)) english = english.slice(frame.prefix.length).trimStart();
    if (frame.suffix && english.endsWith(frame.suffix)) english = english.slice(0, -frame.suffix.length).trimEnd();
    const framed = text => [frame.prefix && String(full).startsWith(frame.prefix) && !text.startsWith(frame.prefix) ? frame.prefix : null, text, frame.suffix && String(full).endsWith(frame.suffix) && !text.endsWith(frame.suffix) ? frame.suffix : null].filter(Boolean).join(' ');
    const system = natural ? NATURAL : SYSTEM;
    const prompt = natural
      ? `USER MESSAGE:\n${message}\n\nDRAFT REPLY:\n${english}\n\nRESULT:\n${JSON.stringify(compactPacket(packet))}\n\nWrite the reply.`
      : `USER MESSAGE:\n${message}\n\nENGLISH ANSWER:\n${english}\n\nRESULT:\n${JSON.stringify(compactPacket(packet))}\n\nWrite the answer in the language of the USER MESSAGE.`;
    // A natural phrasing may shorten the evidence lines; it must keep the answer: the numbers and names of the first line and every number
    // of the answer values. A translation keeps every number and source id of the English answer.
    const first = english.split('\n')[0];
    const values = [...(packet.rows ?? []).flatMap(r => Object.values(r ?? {})), packet.count, packet.at_least].filter(v => typeof v === 'number').map(String);
    const kept = text => (natural ? [...new Set([...keptTokens(first), ...keptNames(first), ...values])] : keptTokens(english)).filter(t => !text.includes(t));
    const tried = [];
    // Every call goes directly through the proxy (owner order 2026-10-02: no omp): the providers in order, the first faithful text wins.
    // One time budget for the whole step (`timeoutSeconds`): the later providers get what the earlier ones left.
    for (const provider of settings.providers) {
      const left = settings.timeoutSeconds * 1000 - (Date.now() - started);
      if (left < 1000) { tried.push({model: provider, reason: 'no time left'}); break; }
      const run = await chat({system, prompt, provider, config: settings.config ?? {}, timeoutMs: left, maxTokens: settings.maxTokens, purpose: natural ? 'answer-natural-phrasing' : 'answer-language'});
      const text = String(run.text ?? '').trim();
      const missing = run.ok && text ? kept(text) : [];
      if (run.ok && text && !missing.length) return {...base, applied: true, text: framed(text), model: run.model, ms: Date.now() - started, tried};
      tried.push({model: run.model ?? provider, reason: !run.ok || !text ? run.reason ?? 'no text' : `dropped ${missing.slice(0, 5).join(', ')}`});
    }
    return {...base, applied: false, ms: Date.now() - started, reason: tried.length ? `${tried.at(-1).reason}; the English draft is shown` : 'no provider configured', tried};
  }
  return {formulate, settings};
}
