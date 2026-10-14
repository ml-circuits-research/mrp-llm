/**
 * The engineCode path of ChatSOPAdapter (proposal P-7, owner authorization 2026-10-03): one call asks the model for the computation
 * of a problem in several engine languages at once (JavaScript, SMT-LIB, ASP, Prolog), each program runs in its sandbox on the
 * problem's registry numbers (lib/formalize/engine-code), and every language is a formalization of its own (`engineCode:<lang>`), so
 * two languages that give the same answers agree. The programs are untrusted; the sandbox refuses I/O and loading.
 *
 * The question is a step-by-step template that may stay in code for now (AGENTS.md "No hardcoded understanding"); it is byte-identical
 * to the one of the 2026-10-03 run (tools/eval/routed/engine-code/run.mjs), so the proxy cache replays its answers for the same languages.
 */
import {registryOf} from '../../formalize/expression-program.mjs';
import {runEngineCode} from '../../formalize/engine-code/index.mjs';
import {allCached} from '../clients.mjs';
import {pathResult} from './result.mjs';

export const ENGINE_CODE_LANGUAGES = Object.freeze(['js', 'asp', 'smt', 'prolog']);
export const ENGINE_CODE_SYSTEM = 'You write small programs that compute the answer of a problem from its inputs. Reply with the code blocks only.';
export const CONTRACT = Object.freeze({
  js: 'JavaScript: the body of a function; the inputs are constants (const v1 = ...); end with `return` of the answer (a number, a boolean, a string, or an array when several values are asked). No I/O, no async.',
  asp: 'ASP (clingo): the inputs are facts v1(12). ... (numbers that are not integers appear as strings, so prefer integer reasoning or scale); define answer/1 (one atom per answered value). Integer division is `/` and remainder is `\\` in clingo. Use #minimize/#maximize for optimisation. No #script, no #include.',
  smt: 'SMT-LIB (Z3): the inputs are already defined constants v1, v2, ... (Int or Real); declare the result constants named exactly answer (or answer1, answer2 ... when several values are asked) with declare-const and constrain them with assert. Do not write check-sat or get-value. No include.',
  prolog: 'SWI-Prolog: the inputs are facts v1(12). ...; define answer/1 so that answer(X) gives each answered value. Only pure Prolog and arithmetic; no I/O, no shell, no assert.',
});

/** The question for a problem text and its registry, in the given languages. */
export function engineCodePrompt(text, registry, langs = ENGINE_CODE_LANGUAGES) {
  const inputs = registry.map(v => `v${v.index} = ${v.value}   (${v.context})`).join('\n');
  return [
    `Problem:\n${text}`,
    '',
    `Inputs (the numbers of the problem, by name):\n${inputs || '(none)'}`,
    '',
    'Write a program that computes the answer FROM THESE INPUTS (never write the final number directly), once in each of these languages.',
    'The inputs v1, v2, ... are ALREADY DEFINED for you in every language: do not declare, define or assert them again.',
    ...langs.map(l => `- ${l}: ${CONTRACT[l]}`),
    '',
    `Reply with exactly one fenced code block per language, labelled with its name (${langs.map(l => '```' + l).join(', ')}), and nothing else.`,
  ].join('\n');
}

/** The code blocks of a reply by language (the first block of each). */
export function codeBlocks(text, langs = ENGINE_CODE_LANGUAGES) {
  const out = {};
  for (const m of String(text).matchAll(/```\s*([A-Za-z-]+)\s*\n([\s\S]*?)```/g)) {
    const tag = m[1].toLowerCase(), lang = tag === 'javascript' ? 'js' : tag === 'smt2' || tag === 'smtlib' || tag === 'smt-lib' ? 'smt' : tag === 'clingo' || tag === 'lp' ? 'asp' : tag === 'pl' ? 'prolog' : tag;
    if (langs.includes(lang) && !out[lang]) out[lang] = m[2].trim();
  }
  return out;
}

/**
 * Structural normalization of a generated program against the inputs it was given: models often re-declare the inputs (const v1 = ...,
 * facts v1(12)., declare-const v1 + assert (= v1 12)). Those re-declarations are removed so the runner's own definitions stand
 * (a redefinition would be an error in JS and SMT and a duplicate in Prolog/ASP). Only exact input names are touched.
 */
export function normalizeProgram(lang, code, names, inputs = {}) {
  const n = names.map(x => x.replace(/[^a-z0-9_]/gi, '')).join('|');
  if (!n) return code;
  // Prolog and ASP: an input used as a bare constant (X is v1 * v2) means its value; it is replaced by the number (a call v1(V)
  // keeps the fact). Structure only: exact input names, never followed by '('.
  const bare = text => text.replace(new RegExp(`\\b(${n})\\b(?!\\s*\\()`, 'g'), (m, name) => (lang === 'asp' && !Number.isInteger(inputs[name]) ? `"${inputs[name]}"` : String(inputs[name])));
  if (lang === 'js') return code.replace(new RegExp(`^\\s*(?:const|let|var)\\s+(?:${n})\\s*=\\s*[^;\\n]+;?\\s*$`, 'gm'), '');
  if (lang === 'asp' || lang === 'prolog') return bare(code.replace(new RegExp(`^\\s*(?:${n})\\(\\s*[^()]*\\)\\.\\s*$`, 'gm'), ''));
  if (lang === 'smt') return code.replace(new RegExp(`^\\s*\\(\\s*(?:declare-const|declare-fun|define-fun|define-const)\\s+(?:${n})\\b[^\\n]*$`, 'gm'), '')
    .replace(new RegExp(`^\\s*\\(\\s*assert\\s*\\(\\s*=\\s*(?:${n})\\s+[^()\\n]+\\)\\s*\\)\\s*$`, 'gm'), '');
  return code;
}

const numericValues = values => values.flat(Infinity).map(v => (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : v));

/** Runs one language's program on the registry: {ok, values, ms} (distinct values, numeric text as numbers) or {ok: false, code, message, ms}. */
export async function runProgram(lang, code, registry) {
  const inputs = Object.fromEntries(registry.map(v => [`v${v.index}`, v.value]));
  const x = await runEngineCode(lang, normalizeProgram(lang, code, Object.keys(inputs), inputs), inputs);
  return x.ok ? {ok: true, values: [...new Set(numericValues(x.values).map(v => JSON.stringify(v)))].map(v => JSON.parse(v)), ms: x.ms} : {ok: false, code: x.code, message: x.message, ms: x.ms};
}

/**
 * The engineCode path on a message: one call, then every language run. Returns {reply, runs, results: [pathResult('engineCode:<lang>')]}.
 * `maxTokens` 3000 as in the 2026-10-03 run.
 */
export async function pathEngineCode({message, chat, registry = null, langs = ENGINE_CODE_LANGUAGES, maxTokens = 3000}) {
  const t0 = performance.now();
  registry ??= registryOf(message);
  const r = await chat([{role: 'system', content: ENGINE_CODE_SYSTEM}, {role: 'user', content: engineCodePrompt(message, registry, langs)}], maxTokens);
  const code = r.ok ? codeBlocks(r.text, langs) : {};
  const callMs = Math.round(performance.now() - t0);
  const runs = {}, results = [];
  for (const lang of langs) {
    if (!code[lang]) runs[lang] = {ok: false, code: 'code_missing'};
    else runs[lang] = await runProgram(lang, code[lang], registry);
    const x = runs[lang];
    results.push(pathResult(`engineCode:${lang}`, {status: x.ok ? 'ok' : r.ok ? 'rejected' : 'unavailable', answers: x.ok ? x.values.map(value => ({kind: 'value', value})) : [],
      circuits: code[lang] ? [code[lang]] : [], tier: chat.tier ?? null, calls: chat.calls, cached: allCached(chat), ms: callMs + (x.ms ?? 0), detail: x.ok ? {lang} : {lang, code: x.code, message: x.message ?? (r.ok ? null : r.reason)}}));
  }
  return {ok: r.ok, reason: r.ok ? null : r.reason, code, runs, results, ms: Math.round(performance.now() - t0)};
}
