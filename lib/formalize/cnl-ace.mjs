/**
 * CNL-ACE (DS028 "Routed formalizers"): a model rewrites the English question in Attempto Controlled English (the Ploinky task
 * mrp-cnl-ace, content words marked p:/n:/v:/a: so APE needs no lexicon), the Attempto Parsing Engine (`tools/.solvers/ape/ape.exe`, or
 * `APE_BIN`) parses it deterministically into a DRS, and the DRS becomes the skeleton of DependencyScaffold (one relation phrase, its
 * subject and object, the asked slot), which the KnowledgeLinker binds or a tiny tier labels (lib/formalize/scaffold.mjs
 * `skeletonCircuit`). The intermediate ACE text is human-readable and kept in the trace. A rewrite APE refuses goes back once with APE's
 * message; a DRS beyond one relation (two predicates, a join) is unclear, never half read. English only.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runTask} from '../mrp/tasks.mjs';
import {stripThinking} from '../pworker.mjs';
import {skeletonCircuit} from './scaffold.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const apeCommand = (env = process.env) => env.APE_BIN ?? path.join(ROOT, 'tools', '.solvers', 'ape', 'ape.exe');
export const apeAvailable = () => fs.existsSync(apeCommand());

/** The DRS conditions of an ACE text: `{ok, conditions: [{name, args: [string]}], error}` (`-solo drspp`). */
export function apeParse(ace, {command = apeCommand(), timeoutMs = 10_000} = {}) {
  const r = spawnSync(command, ['-text', ace, '-solo', 'drspp'], {encoding: 'utf8', timeout: timeoutMs});
  if (r.error) return {ok: false, conditions: [], error: r.error.message};
  const out = r.stdout ?? '';
  if (/<messages>/.test(out)) {
    const m = /value="([^"]*)"[\s\S]*?repair="([^"]*)"/.exec(out.slice(out.indexOf('importance="error"')));
    return {ok: false, conditions: [], error: m ? `${m[2]} (${m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>')})` : 'APE refused the text'};
  }
  const conditions = [...out.matchAll(/^\s*([a-z_]+)\((.*)\)-\d+\/\d+\s*$/gm)].map(m => ({name: m[1], args: splitArgs(m[2])}));
  return conditions.length ? {ok: true, conditions} : {ok: false, conditions: [], error: 'APE returned no condition'};
}

function splitArgs(text) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of text) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const lemma = verb => /ies$/.test(verb) ? verb.slice(0, -3) + 'y' : /(ss|sh|ch|x|z)es$/.test(verb) ? verb.slice(0, -2) : /[^s]s$/.test(verb) ? verb.slice(0, -1) : verb;

/** The skeleton of a DRS (DependencyScaffold's shape) or null when it is not one relation. */
export function skeletonOfDrs(conditions) {
  const by = name => conditions.filter(c => c.name === name);
  const query = by('query')[0] ?? null;
  const asked = query?.args[0] ?? null, count = query?.args[1] === 'howm';
  const named = arg => /^named\((.*)\)$/.exec(arg)?.[1]?.replace(/-/g, ' ') ?? null;
  const term = arg => arg === asked ? '?x' : named(arg) ?? (/^'?[A-Z]/.test(arg) ? null : arg.startsWith("'") ? arg.replace(/'/g, '') : null);
  const preds = by('predicate');
  if (preds.length !== 1) return null;
  const [p] = preds, [event, verb, a, b] = p.args;
  const negated = conditions.some(c => c.name === 'negation' || c.name === 'not');
  if (verb === 'be' && b) {
    const noun = by('object').find(o => o.args[0] === b), rel = by('relation').find(r => r.args[0] === b);
    if (!noun) return null;
    return {phrase: `${noun.args[1]}${rel ? ' ' + rel.args[1] : ''}`, subject: term(a), object: rel ? term(rel.args[2]) : null, asked: Boolean(asked), count, negated};
  }
  const pp = by('modifier_pp').find(m => m.args[0] === event);
  const s = {phrase: `${lemma(verb)}${pp ? ' ' + pp.args[1] : ''}`, subject: term(a), object: b != null ? term(b) : pp ? term(pp.args[2]) : null, asked: Boolean(asked), count, negated};
  return s.subject == null || (b != null && pp) ? null : s;
}

/** The strategy object of the request parser. */
export function cnlAce({tier, labelTier = tier, client, parse = apeParse, tierReadiness = null}) {
  return {
    name: 'CNL-ACE', tier, ladder: [tier], tag: `tier:${tier}@pworker#CNL-ACE`, server: {stop: async () => {}},
    availability: async firstTier => !apeAvailable() ? {available: false, reason: `APE is not built (${apeCommand()})`, models: [], skipped: []} : tierReadiness ? tierReadiness(firstTier ?? tier) : {available: true, models: [tier], skipped: []},
    async run({message, lexicon, circuits = [], repo = null, session = null, firstTier = null, retrieval = null, link = null}) {
      const t0 = Date.now(), steps = [], useTier = firstTier ?? tier;
      let ace = '', parsed = null, error = '';
      for (let round = 0; round < 2 && !parsed?.ok; round++) {
        const r = await runTask('mrp-cnl-ace', {message, error}, {client, tier: useTier});
        if (!r.ok) return {ok: false, status: 'failed', reason: r.error, steps, ms: Date.now() - t0};
        ace = stripThinking(String(r.value ?? '')).split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '';
        parsed = parse(ace);
        steps.push({name: round ? 'ace-repair' : 'ace', answer: ace, tier: useTier, ...(parsed.ok ? {} : {ok: false, reason: parsed.error})});
        error = parsed.ok ? '' : `\n\nYOUR ACE TEXT: ${ace}\nAPE REFUSED IT: ${parsed.error}\nWrite a corrected ACE question.`;
      }
      const s = parsed?.ok ? skeletonOfDrs(parsed.conditions) : null;
      steps.push({name: 'skeleton', answer: s ? JSON.stringify(s) : 'none'});
      return skeletonCircuit(s, {message, lexicon, circuits, repo, session, retrieval, link, client, tier: labelTier, steps, t0, extra: {ace}});
    },
  };
}
