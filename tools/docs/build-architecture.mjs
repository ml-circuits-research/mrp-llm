/**
 * Generator of docs/architecture.html (`node tools/docs/build-architecture.mjs`). Every file:line is resolved from the working tree when it runs:
 * a citation is a `<code class="cite" data-re="...">file:line</code>` whose line is the first match of the stated pattern, a statement of the page that
 * the code must support is a `claim`, and `buildArchitecture()` returns the problems of the run (a pattern that no longer matches, a failed claim),
 * so the page can only state what the code showed at generation time. `tests/docs/architecture-page.test.mjs` re-checks every citation of the committed page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSS } from './architecture/css.mjs';
import * as D from './architecture/diagrams.mjs';
import { warnings } from './architecture/svg.mjs';
import { esc } from './architecture/svg.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** Builds the page from the working tree: `{html, problems, citations, reachable, total}`. */
export function buildArchitecture() {
  warnings.length = 0;
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  // The archive (probably_obsolete/) and the project history (questions.md) stay in the ChatSOP repository (MRP_CHATSOP_ROOT, default
  // ../ChatSOP); a path of theirs is found there.
  const chatsop = path.resolve(process.env.MRP_CHATSOP_ROOT ?? path.join(ROOT, '..', 'ChatSOP'));
  const exists = f => fs.existsSync(path.join(ROOT, f)) || (/^(probably_obsolete(\/|$)|questions\.md$)/.test(f) && fs.existsSync(path.join(chatsop, f)));
  const problems = [];

  /** Citations of the page: every `E` call outside the sections that other agents are still changing. */
  const citations = [];
  /** file:line of the first line of `file` matching `re`, kept as a checkable `<code class="cite">`; `live` leaves it out of the test. */
  function E(file, re, live = false) {
    if (!exists(file)) { problems.push('missing file ' + file); return `<code>${esc(file)}:?</code>`; }
    const lines = read(file).split('\n');
    const i = lines.findIndex(l => re.test(l));
    if (i < 0) { problems.push(`no match ${re} in ${file}`); return `<code>${esc(file)}:?</code>`; }
    if (live) return `<code>${esc(file)}:${i + 1}</code>`;
    citations.push({ file, line: i + 1, re: re.source });
    return `<code class="cite" data-re="${esc(re.source).replace(/"/g, '&quot;')}">${esc(file)}:${i + 1}</code>`;
  }
  const code = s => `<code>${esc(s)}</code>`;
  const P = f => { if (!exists(f.replace(/\/$/, ''))) problems.push('missing path ' + f); return code(f); };
  const Ps = list => list.map(P).join(', ');

  // ------------------------------------------------------------ reachability from the product entry points (static + dynamic imports)
  const ENTRIES = ['tools/serve-local.mjs', 'server/http.mjs', 'server/cli.mjs'];
  const seen = new Set();
  const resolveImport = (f, spec) => { let t = path.resolve(path.dirname(f), spec); try { if (fs.statSync(t).isDirectory()) t = path.join(t, 'index.mjs'); } catch { return null; } return fs.existsSync(t) ? t : null; };
  const visit = f => {
    if (seen.has(f)) return; seen.add(f);
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { return; }
    const re = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g; let m;
    while ((m = re.exec(src))) { const t = resolveImport(f, m[1]); if (t && t.endsWith('.mjs')) visit(t); }
  };
  ENTRIES.forEach(e => visit(path.join(ROOT, e)));
  const allProduct = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (['vendor', 'node_modules'].includes(e.name)) continue; walk(p); } else if (p.endsWith('.mjs')) allProduct.push(p); } };
  ['lib', 'sop', 'memory', 'reasoning', 'server'].forEach(d => walk(path.join(ROOT, d)));
  const rel = f => path.relative(ROOT, f);
  const reachable = allProduct.filter(f => seen.has(f)), unreachable = allProduct.filter(f => !seen.has(f));
  const outsideReach = [...seen].map(rel).filter(f => !/^(lib|sop|memory|reasoning|server)\//.test(f));
  const groupCount = list => { const g = {}; for (const f of list) { const r = rel(f).split('/'); const k = r[0] === 'reasoning' && r[1] === 'strategies' ? r.slice(0, 3).join('/') : r.slice(0, 2).join('/').replace(/\.mjs$/, ''); g[k] = (g[k] ?? 0) + 1; } return g; };
  const unreachableGroups = Object.entries(groupCount(unreachable)).sort();
  const isReach = f => seen.has(path.join(ROOT, f));

  // ------------------------------------------------------------ module-level layering of the product (cycles and links to eval/ and tools/)
  const importsOf = f => {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { return []; }
    const re = /(?:from\s+|(import)\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g; const out = []; let m;
    while ((m = re.exec(src))) { const t = resolveImport(f, m[2]); if (t && t.endsWith('.mjs')) out.push({ to: t, dynamic: Boolean(m[1]) }); }
    return out;
  };
  const insideProduct = f => /^(lib|sop|memory|reasoning|server)\//.test(rel(f));
  const moduleCycles = (() => {
    const index = new Map(), low = new Map(), stack = [], on = new Set(), found = []; let n = 0;
    const strong = v => {
      index.set(v, n); low.set(v, n); n++; stack.push(v); on.add(v);
      for (const { to } of importsOf(v)) {
        if (!seen.has(to)) continue;
        if (!index.has(to)) { strong(to); low.set(v, Math.min(low.get(v), low.get(to))); } else if (on.has(to)) low.set(v, Math.min(low.get(v), index.get(to)));
      }
      if (low.get(v) === index.get(v)) { const group = []; let w; do { w = stack.pop(); on.delete(w); group.push(rel(w)); } while (w !== v); if (group.length > 1) found.push(group); }
    };
    for (const v of seen) if (!index.has(v)) strong(v);
    return found;
  })();
  // Ploinky/ (the model gateway, a component of its own that the product calls through lib/pworker.mjs) is not an outside link.
  const productLinksOut = [...seen].filter(insideProduct).flatMap(f => importsOf(f).filter(e => !insideProduct(e.to) && !/^Ploinky\//.test(rel(e.to))).map(e => ({ from: rel(f), to: rel(e.to), dynamic: e.dynamic })));

  // ------------------------------------------------------------ component-level import graph
  const comp = f => {
    const r = rel(f).split('/');
    if (r[0] === 'lib') return r.slice(0, 2).join('/').replace(/\.mjs$/, '');
    if (r[0] === 'reasoning' && r[1] === 'strategies') return r.slice(0, 3).join('/');
    if (['server', 'memory', 'reasoning'].includes(r[0]) && r.length > 2 && r[1] !== 'pages') return r.slice(0, 2).join('/');
    if (r[0] === 'sop' && r[1] === 'knowledge') return 'sop/knowledge';
    if (r[0] === 'server') return r[1] === 'pages' ? 'server/pages' : r.slice(0, 2).join('/').replace(/\.mjs$/, '');
    if (r[0] === 'sop') return 'sop';
    return r[0] === 'memory' || r[0] === 'reasoning' ? r[0] : r.slice(0, 2).join('/').replace(/\.mjs$/, '');
  };
  const edges = new Map();
  for (const f of reachable) {
    const src = fs.readFileSync(f, 'utf8'); const re = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g; let m;
    while ((m = re.exec(src))) { const t = resolveImport(f, m[1]); if (!t || !t.endsWith('.mjs')) continue; const a = comp(f), b = comp(t); if (a !== b) { if (!edges.has(a)) edges.set(a, new Set()); edges.get(a).add(b); } }
  }
  const graphRows = [...edges.entries()].sort().map(([a, b]) => `<tr><td><code>${esc(a)}</code></td><td>${[...b].sort().map(x => `<code>${esc(x)}</code>`).join(' ')}</td></tr>`).join('');


  // ------------------------------------------------------------ claims that must hold (build fails otherwise)
  const claim = (ok, text) => { if (!ok) problems.push('claim failed: ' + text); };
  const has = (file, re) => exists(file) && re.test(read(file));
  claim(has('lib/chat-data/memories.mjs', /STRATEGIES = Object\.freeze\(\['sqlite'\]\)/), 'product strategies are sqlite only');
  claim(has('reasoning/registry.mjs', /EXTERNAL_STRATEGIES=\{'prolog-tabling':'prolog','z3-smt-bounded':'z3'\}/), 'external strategies');
  claim(has('reasoning/registry.mjs', /ROUTE_IDS=\['reference','js-reference','js-oracle'\]/), 'route ids');
  claim(has('sop/declarative.mjs', /MODEL_TYPES=Object\.freeze\(new Set\(\['stated','assumed','unclear','query','constraint','unparsed','pragmatic','instruction'\]\)\)/), 'model types');
  claim(has('config/runtime.json', /"engine": "sqlite"/), 'runtime engine sqlite');
  claim(has('config/runtime.json', /"mode": "none"/), 'retention none');
  claim(has('config/runtime.json', /"queryParser"/) && has('config/runtime.json', /"strategy": "LocalLLMStepByStep"/) && has('config/runtime.json', /"ladder"/) && has('lib/formalize/strategies.mjs', /export function ladderOf/), 'queryParser step-by-step default with a tier ladder');
  claim(!exists('lib/query-author/loop.mjs') && !exists('lib/query-author/context.mjs') && !exists('lib/query-author/backends') && exists('probably_obsolete/one-shot-formalization'), 'one-shot formalization is archived');
  claim(has('lib/chat-data/index.mjs', /tmpTtlHours: 24, sessionTtlDays: 14/), 'ttls');
  claim(has('lib/ingest/direct-author.mjs', /export async function directAuthor/) && has('lib/formalize/strategies.mjs', /const ta = pworker\(\{purpose/), 'every model is called through the Ploinky proxy: no tools, no shell');
  claim(!exists('lib/omp') && !exists('lib/query-author/backends/omp.mjs') && !/\bomp\b/.test(['server/query-parser.mjs', 'lib/formalize/strategies.mjs', 'lib/ingest/direct-author.mjs'].map(f => read(f).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')).join('\n')), 'no code path runs omp');
  claim(ENTRIES.every(e => exists(e)), 'entry points exist');
  claim(has('server/query-parser.mjs', /'parse_unavailable', 503/) && has('server/query-parser.mjs', /'parse_failed', 422/), 'parse error codes');
  claim(has('server/http.mjs', /code:'parse_unavailable'/) && has('server/http.mjs', /code:'parse_failed'/), 'chat answers the parse errors');
  claim(!/symbolic-lm|symbolicFormalize|formalizers\.json|text-to-clean-english/i.test(['server/http.mjs', 'server/query-parser.mjs', 'server/agent.mjs', 'server/capabilities.mjs'].map(read).join('\n')), 'the chat path has no SymbolicLM, registry or cleaning step');
  claim(!exists('lib/symbolic-lm') && !exists('lib/ud-to-sop') && !exists('server/formalizers.mjs') && !exists('training'), 'the frozen branch is not in the product tree');
  claim(exists('probably_obsolete/tinyLLMExperiments/README.md') && exists('probably_obsolete/tinyLLMExperiments/lib/symbolic-lm'), 'the frozen branch folder and its README exist');
  claim(has('lib/chat-data/sessions.mjs', /ingestFacts\(this\.repository\(id\)/), 'addCircuit ingests facts');
  claim(moduleCycles.length === 0, 'the product import graph has no module cycle: ' + JSON.stringify(moduleCycles));
  claim(productLinksOut.every(e => e.dynamic), 'a product module imports eval/ or tools/ statically: ' + JSON.stringify(productLinksOut.filter(e => !e.dynamic)));
  claim(has('reasoning/bridge/solve.mjs', /if \(backend === 'auto'\) backend = 'js';  \/\/ never chosen by problem size/), 'constraint auto is the JS oracle');
  claim(has('sop/runtime.mjs', /answerOverSlice\(\{memory:mem/), 'the reason step runs the completeness guard over a slice');
  claim(has('reasoning/linker.mjs', /from '\.\/slice\/index\.mjs'/), 'linkKnowledge uses slice retrieval');
  claim(has('sop/cnl.mjs', /renderAnswer\(packet/), 'cnl renders through answer-text');

  // ------------------------------------------------------------ diagrams
  const dg = { a: D.diagramA(), b: D.diagramB(), c: D.diagramC(), d: D.diagramD(), e: D.diagramE() };
  const svg = k => dg[k].render();
  if (warnings.length) problems.push('svg text overflow estimates:\n' + warnings.join('\n'));

  // ------------------------------------------------------------ cards
  const card = (name, purpose, rows) => `<article class="card" id="c-${esc(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}"><h3>${esc(name)}</h3><p>${purpose}</p><dl>` +
    rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('') + `</dl></article>`;
  const cards = [
    card('Server', 'The one Node process: static documentation, browser pages, the OpenAI-style chat facade, the service and product APIs, and the owner pages. It authenticates every request before any route that needs a user.', [
      ['Modules', Ps(['server/http.mjs', 'server/auth.mjs', 'server/web.mjs', 'server/api.mjs', 'server/capabilities.mjs', 'server/product.mjs', 'server/authoring.mjs', 'server/markdown.mjs', 'server/warm-memories.mjs', 'server/pages/'])],
      ['Entry points', `${code('npm start')} runs ${code('tools/serve-local.mjs')}, which calls ${code('startServer')} (${E('server/http.mjs', /export async function startServer/)}); ${code('createServer')} (${E('server/http.mjs', /export function createServer/)}) is what tests build.`],
      ['Configuration', `${code('config/runtime.json')} (root, memory, policy, chatData, llmProviders, ingest, queryParser, answerLanguage, server), ${code('state/auth.json')}, environment ${code('CHATSOP_HOST')}, ${code('CHATSOP_PORT')}, ${code('CHATSOP_CONFIG')}, ${code('CHATSOP_API_KEY')}.`],
      ['Tests', Ps(['tests/server/server-http.test.mjs', 'tests/server/auth-server.test.mjs', 'tests/docs/site-links.test.mjs', 'tests/docs/product-api-docs.test.mjs', 'tests/reasoning/capability-matrix.test.mjs'])],
      ['Specifications', 'DS009, DS022'],
    ]),
    card('Courtesy, emotion and the conversation layer', 'Part of the one understanding step: the step-by-step formalizer (LocalLLMStepByStep through its acts question) records what the message does besides asking or stating as advisory pragmatic wires (basis llm, a verbatim span when it has one). The compiler keeps them out of linking and execution. Every reply is data: the reply wires of the conversation layer conversation-v1; the result packet becomes facts, the layer rules and priorities derive the applicable replies and the JS oracle chooses the opening, body and closing (with the derivation in the trace). A turn without an answer gets the near-miss names of the memory; no word list or pattern reads the message and no sentence is written in code.', [
      ['Modules', Ps(['sop/pragmatic-text.mjs', 'sop/declarative.mjs', 'sop/replies.mjs', 'lib/conversation/index.mjs', 'lib/near-miss.mjs', 'lib/assistant/statistics.mjs', 'lib/query-author/step-by-step/questions.mjs', 'server/agent.mjs'])],
      ['Entry points', `${code('compileDeclarative')} splits the wires (${E('sop/declarative.mjs', /const signals=parsed\.wires\.filter/)}); ${code('courtesyResult')} answers a courtesy message (${E('sop/declarative.mjs', /function courtesyResult/)}); ${code('Agent.reply')} composes every reply (${E('server/agent.mjs', /const composed=composeReply/)}) through ${code('chooseReplies')} (${E('lib/conversation/index.mjs', /export function chooseReplies/)}); the step-by-step questions are ${code('firstQuestion')} (${E('lib/query-author/step-by-step/protocol.mjs', /export async function firstQuestion/)}).`],
      ['Configuration', `The message acts (${code('cv_act')}, ${code('cv_act_group')}, ${code('cv_act_description')}) declared by the reply memory's layers and read by ${code('messageActs')} (${P('sop/message-acts.mjs')}), rendered into the step-by-step act questions (texts in ${P('config/knowledge/formalizer-protocol-v1/0070-acts.sop')}); the conversation layer ${P('config/knowledge/conversation-v1/0010-situations.sop')} and the self layer ${P('config/knowledge/assistant-v1/0001-self.sop')}; ${code('answerLanguage.natural')} and ${code('assistant')} in ${code('config/runtime.json')}.`],
      ['Tests', Ps(['tests/conversation/pragmatic-turn.test.mjs', 'tests/conversation/conversation-layer.test.mjs', 'tests/sop/near-miss.test.mjs', 'tests/formalizer/local-llm-step-by-step-protocol.test.mjs', 'tests/docs/wire-help.test.mjs'])],
      ['Evaluation', P('tools/eval/conversation/pragmatics/run.mjs')],
      ['Specifications', 'DS023'],
    ]),
    card('Request parser', 'Turns the message of a chat turn into a circuit with the session\'s step-by-step formalization strategy: LocalLLMStepByStep (the default) or InternalReasoningStepByStep. The system asks short questions; the Ploinky proxy answers them on the tier ladder (tiny, then small, then good), each question escalating only when the answer of the tier below cannot be read or the tier does not answer. The one-shot LLMDirect is archived; a session that names it runs the default with a note in the trace. It caches identical requests per memory version, strategy and ladder and fails honestly: a strategy is never replaced by another and there is no fallback parser.', [
      ['Modules', Ps(['server/query-parser.mjs', 'server/status.mjs', 'lib/formalize/strategies.mjs', 'lib/llm-providers.mjs', 'lib/pworker.mjs'])],
      ['Entry points', `${code('createQueryParser')} (${E('server/query-parser.mjs', /export function createQueryParser/)}); errors ${code('parse_unavailable')} (503) and ${code('parse_failed')} (422) (${E('server/http.mjs', /code==='parse_unavailable'/)}); the chat takes the parser from ${E('server/http.mjs', /const queryParser=injected/)}.`],
      ['Configuration', `${code('queryParser')} in ${P('config/runtime.json')} (strategy, ${code('local.ladder')} of Ploinky tiers, local tier and method, timeoutSeconds, maxConcurrent, cacheEntries); the session settings ${code('formalizer_model')} (the first tier of the ladder) and ${code('formalizer')} (the strategy, matched by ${E('server/status.mjs', /export function strategyRequest/)}; archived names resolved by ${E('lib/formalize/strategies.mjs', /export function resolveStrategy/)}).`],
      ['Tests', Ps(['tests/formalizer/query-parser.test.mjs'])],
      ['Specifications', 'DS009 "Request parser", DS014'],
    ]),
    card('Step-by-step formalizer', 'Retrieves the vocabulary of the session memory (candidate predicates, the schema neighbourhood, entity hints), asks the model short questions one at a time, reads each answer structurally and assembles the circuit itself; a question whose answer cannot be read twice, or whose tier does not answer, goes up the tier ladder with the same history. The validator admits the circuit; the model never writes SOP.', [
      ['Modules', Ps(['lib/query-author/', 'lib/query-author/step-by-step/', 'lib/formalize/internal-reasoning/'])],
      ['Entry points', `${code('protocolQuery')} (${E('lib/query-author/step-by-step/protocol.mjs', /export function protocolQuery/)}); ${code('stepByStepQuery')} (${E('lib/query-author/step-by-step/index.mjs', /export async function stepByStepQuery/)}); the oracle and its per-question escalation ${code('createOracle')} (${E('lib/query-author/step-by-step/index.mjs', /export function createOracle/)}); the ladder ${code('ladderOf')} (${E('lib/formalize/strategies.mjs', /export function ladderOf/)}); ${code('candidatePredicates')} (${E('lib/query-author/retrieval.mjs', /export function candidatePredicates/)}); ${code('validateQuery')} (${E('lib/query-author/validate.mjs', /export function validateQuery/)}).`],
      ['Configuration', `${code('queryParser.local')} (${code('tier')}, ${code('ladder')}, ${code('method')}, ${code('maxTokens')}); the protocol layers ${P('config/knowledge/formalizer-protocol-v1/')}.`],
      ['Tests', Ps(['tests/formalizer/query-author.test.mjs', 'tests/formalizer/local-llm-step-by-step-protocol.test.mjs', 'tests/formalizer/formalization-strategies.test.mjs'])],
      ['Specifications', 'DS014 "The circuit author", DS022'],
    ]),
    card('Service facts', 'The versions of the components that produce an answer and the statistics of the one cache that exists, the request parser cache.', [
      ['Modules', Ps(['server/capabilities.mjs', 'server/api.mjs'])],
      ['Entry points', `${code('createCapabilities')} (${E('server/capabilities.mjs', /export function createCapabilities/)}); routes listed in ${code('API_ENDPOINTS')} (${E('server/api.mjs', /export const API_ENDPOINTS/)}).`],
      ['Configuration', 'none of its own; the parser cache size is queryParser.cacheEntries'],
      ['Tests', Ps(['tests/reasoning/capability-matrix.test.mjs', 'tests/docs/product-api-docs.test.mjs'])],
      ['Specifications', 'DS009 "Capabilities and caches"'],
    ]),
    card('Agent (one chat turn)', 'Runs one turn: asks the circuit author for SOP, admits it, runs the declarative pipeline in the session runtime, and keeps the asserted statements as caller-owned conversation context.', [
      ['Modules', Ps(['server/agent.mjs', 'server/session-store.mjs', 'server/session-runtime.mjs'])],
      ['Entry points', `${code('Agent.turn')} (${E('server/agent.mjs', /async turn\(/)}); admission ${code('validateVocabulary')} (${E('server/agent.mjs', /^ validateVocabulary\(/)}); sessions are opened by ${code('SessionRuntimes.open')} (${E('server/session-runtime.mjs', /^  open\(/)}).`],
      ['Configuration', `${code('config.policy')} from ${code('config/runtime.json')}.`],
      ['Tests', Ps(['tests/conversation/agent.test.mjs', 'tests/sop/declarative-runtime.test.mjs', 'tests/sop/stated-assumed.test.mjs'])],
      ['Specifications', 'DS003, DS014, DS009'],
    ]),
    card('DeclarativeCompiler and KnowledgeLinker', 'Turns the admitted circuit into an inspectable execution circuit: repairs unparsed spans, translates content words with the reviewed dictionary, and links entity strings (and relation phrases) to the predicates, lexemes and entities of the session lexicon. It asks one precise question instead of guessing.', [
      ['Modules', Ps(['sop/declarative.mjs', 'sop/knowledge-linker.mjs', 'sop/linking.mjs', 'sop/clauses.mjs', 'sop/propositions.mjs', 'sop/unclear.mjs', 'sop/repair.mjs', 'sop/copula-linker.mjs', 'sop/frames.mjs', 'sop/lexicon.mjs', 'sop/relation-lexicon.mjs', 'sop/dictionary.mjs'])],
      ['Entry points', `${code('runDeclarative')} (${E('sop/declarative.mjs', /export async function runDeclarative/)}), ${code('compileDeclarative')} (${E('sop/declarative.mjs', /export function compileDeclarative/)}), ${code('decide')} (${E('sop/knowledge-linker.mjs', /export function decide/)}), ${code('Lexicon.fromCircuits')} (${E('sop/lexicon.mjs', /static fromCircuits/)}).`],
      ['Configuration', `${P('config/dictionary/')}, ${P('config/relation-lexicon.json')}; the lexicon itself is knowledge in the base memory (circuits).`],
      ['Tests', Ps(['tests/sop/lexicon.test.mjs', 'tests/memory/linker.test.mjs', 'tests/linker/linking-r2.test.mjs', 'tests/linker/linking-report.test.mjs', 'tests/linker/knowledge-linker-scoring.test.mjs', 'tests/linker/knowledge-linker-copula.test.mjs', 'tests/sop/clause-links.test.mjs'])],
      ['Specifications', 'DS014 "KnowledgeLinker", DS004 "Lexicon wires"'],
    ]),
    card('Runtime and the SOP language', 'Parses typed wires, schedules a circuit by dependencies, expands solve into link, reason and binding, applies the write policy, and renders with the controlled-language renderer. A model-origin wire can only be compiled, never run directly.', [
      ['Modules', Ps(['sop/runtime.mjs', 'sop/parser.mjs', 'sop/lower.mjs', 'sop/expression.mjs', 'sop/conditions.mjs', 'sop/outputs.mjs', 'sop/cnl.mjs', 'sop/answer-text.mjs', 'sop/enums.mjs', 'sop/contracts/wires.json'])],
      ['Entry points', `${code('Runtime.run')} (${E('sop/runtime.mjs', /async run\(source/)}), ${code('DEFAULT_POLICY')} (${E('sop/runtime.mjs', /export const DEFAULT_POLICY/)}), ${code('renderAnswer')} (${E('sop/answer-text.mjs', /export function renderAnswer/)}); command line ${code('server/cli.mjs run|validate|chat')}.`],
      ['Configuration', `${code('policy')} block of ${P('config/runtime.json')}`],
      ['Tests', Ps(['tests/sop/parser.test.mjs', 'tests/sop/runtime.test.mjs', 'tests/sop/expression.test.mjs', 'tests/sop/outputs.test.mjs', 'tests/sop/answer-text.test.mjs', 'tests/docs/wire-help.test.mjs'])],
      ['Specifications', 'DS004, DS003, DS014'],
    ]),
    card('Knowledge validator', 'The single grammar and validator of the knowledge wires (predicate, lexeme, entity, fact, rule, default, integrity, aggregate, action, method, norm, procedure). Every circuit that becomes knowledge passes it.', [
      ['Modules', Ps(['sop/knowledge/'])],
      ['Entry points', `${code('parse')}, ${code('validateProgram')} (${E('sop/knowledge/index.mjs', /export \{validateWires, validateProgram\}/)}); used by base memories, the authoring loop and the oracle.`],
      ['Configuration', `contract tables ${P('sop/contracts/wires.json')}`],
      ['Tests', Ps(['tests/sop/knowledge-grammar.test.mjs', 'tests/docs/knowledge-docs.test.mjs', 'tests/docs/wire-help.test.mjs'])],
      ['Specifications', 'DS004 "Knowledge wires"'],
    ]),
    card('Memory (Repository)', 'Copy-on-write, bitemporal repository of admitted claims and approved definitions. Layers are sharded generations over one bank engine; snapshots and shards are content-addressed; retention and garbage collection are explicit.', [
      ['Modules', Ps(['memory/repository.mjs', 'memory/sharded.mjs', 'memory/temporal.mjs', 'memory/strategies.mjs', 'memory/factory.mjs', 'memory/banks/sqlite.mjs'])],
      ['Entry points', `${code('Repository')} (${E('memory/repository.mjs', /export class Repository/)}); retrieval ${code('StrategyRegistry.retrieve')} (${E('memory/strategies.mjs', /retrieve\(name,request\)/)}).`],
      ['Configuration', `${code('memory')} block of ${P('config/runtime.json')} (engine sqlite, retention, sharding)`],
      ['Tests', Ps(['tests/memory/repository.test.mjs', 'tests/memory/shards.test.mjs', 'tests/memory/memory-engines.test.mjs', 'tests/sop/temporal.test.mjs', 'tests/memory/memory-isolation.test.mjs'])],
      ['Specifications', 'DS005, DS018, DS021'],
    ]),
    card('Chat data (base memories and sessions)', 'The gitignored root that holds everything a chat produces: seeds become base memories, a session clones its base by hard links, validated session circuits become session circuits, and a commit forks the base. Also compiles and caches the lexicons.', [
      ['Modules', Ps(['lib/chat-data/', 'lib/knowledge-seeds.mjs', 'config/knowledge/'])],
      ['Entry points', `${code('BaseMemories')} (${E('lib/chat-data/memories.mjs', /export class BaseMemories/)}), ${code('Sessions')} (${E('lib/chat-data/sessions.mjs', /export class Sessions/)}), ${code('LexiconCache')} (${E('lib/chat-data/lexicons.mjs', /export class LexiconCache/)}); routes in ${P('server/product.mjs')}; maintenance ${P('tools/chat-data.mjs')}.`],
      ['Configuration', `${code('chatData')} block of ${P('config/runtime.json')} (root, tmpTtlHours 24, sessionTtlDays 14, cleanupIntervalMinutes); environment ${code('CHATSOP_CHAT_DATA')}.`],
      ['Tests', Ps(['tests/memory/chat-data.test.mjs', 'tests/memory/chat-memories.test.mjs', 'tests/memory/chat-sessions.test.mjs', 'tests/memory/warm-memories.test.mjs'])],
      ['Specifications', 'DS022'],
    ]),
    card('Reasoning', 'Strategy registry and the runtime bridge to the js-reference oracle (the reference route), the explicit prolog-tabling and z3-smt-bounded strategies, the StrategyRouter v1, the slice retrieval with its completeness guard behind the goal-directed linker, and the shared JS search controllers (abduction, learning, worlds).', [
      ['Modules', Ps(['reasoning/registry.mjs', 'reasoning/bridge/', 'reasoning/router/', 'reasoning/slice/', 'reasoning/linker.mjs', 'reasoning/strategies/js-reference/', 'reasoning/strategies/prolog-tabling/', 'reasoning/strategies/z3-smt-bounded/'])],
      ['Entry points', `${code('ReasoningRegistry.run')} (${E('reasoning/registry.mjs', /^ run\(name,request\)/)}), ${code('linkKnowledge')} (${E('reasoning/linker.mjs', /export function linkKnowledge/)}), ${code('answerOverSlice')} (${E('reasoning/slice/answer.mjs', /export function answerOverSlice/)}), ${code('judge')} (${E('reasoning/slice/guard.mjs', /export function judge/)}), ${code('ask')} of the oracle (${E('reasoning/strategies/js-reference/index.mjs', /export (async )?function ask/)}), ${code('routedAsk')} of the router (${E('reasoning/router/index.mjs', /export function routedAsk/)}).`],
      ['Configuration', `${code('policy.reasoningStrategy')} (default reference; auto asks the router), the request fields ${code('reasoning')} and ${code('verify')} of ${code('POST /v1/sessions/{id}/query')} (default auto), ${code('ROUTER_DEFAULTS')} (thresholds, engine order, verification), ${code('policy.retrievalStrategy')} (hybrid), environment ${code('SWIPL_BIN')}, ${code('Z3_BIN')}.`],
      ['Tests', Ps(['tests/reasoning/js-oracle.test.mjs', 'tests/reasoning/reasoning-bridge.test.mjs', 'tests/reasoning/reasoning-external.test.mjs', 'tests/memory/slice-retrieval.test.mjs', 'tests/reasoning/prolog.test.mjs', 'tests/engines/z3-ast.test.mjs', 'tests/engines/solver-qualification.test.mjs', 'tests/reasoning/strategy-router.test.mjs'])],
      ['Specifications', 'DS005, DS006, DS010'],
    ]),
    card('Authoring path', 'A chain model, called through the Ploinky proxy without tools, writes SOP knowledge circuits from attached files; the server validates and repairs them and adds them to the session layer once they validate (no manual acceptance). Committing a session to a base memory is a separate act.', [
      ['Modules', Ps(['lib/ingest/direct-author.mjs', 'lib/authoring/circuits.mjs', 'server/authoring.mjs', 'skills/sop-wire-authoring/'])],
      ['Entry points', `${code('POST /v1/author')} (${E('server/authoring.mjs', /path: '\/v1\/author'/)}), ${code('directAuthor')} (${E('lib/ingest/direct-author.mjs', /export async function directAuthor/)}), the model resolution ${code('chainEntry')} (${E('lib/llm-providers.mjs', /export function chainEntry/)}).`],
      ['Configuration', `${code('ingest')} and ${code('llmProviders')} blocks of ${P('config/runtime.json')} (tier, reasoning, concurrency); at most three repair rounds; the model is the request's or ${code('ingest.tier')}.`],
      ['Tests', Ps(['tests/ingestion/ingest-direct-author.test.mjs', 'tests/ingestion/authoring-circuits.test.mjs'])],
      ['Specifications', 'DS022 "The authoring path", DS013'],
    ]),
    card('Owner pages', 'The browser pages of the owner, behind the administrator session: the experiments index and journal, the evaluation browser entry and the administrator page. They read status files and reports; they are tooling inside the server, not part of a chat turn.', [
      ['Modules', Ps(['server/web.mjs', 'server/project.mjs', 'server/history.mjs', 'server/pages/'])],
      ['Entry points', `routes in ${P('server/web.mjs')}; journal writes ${code('node tools/journal.mjs add')}, topic notes ${code('node tools/notes.mjs add')}.`],
      ['Configuration', `${code('status/')} (journal.jsonl, experiments.json, tasks.json, topics.json), ${P('questions.md')}.`],
      ['Tests', Ps(['tests/server/experiments-pages.test.mjs', 'tests/server/eval-project-server.test.mjs'])],
      ['Specifications', 'DS009'],
    ]),
    card('Frozen branch (tinyLLMExperiments)', 'Everything built for the small-model research branch: Stanza with the Python UD worker, SymbolicLM, the UD-to-SOP rules, LanguagesUtil, textToCleanEnglish, TranslatorService, LanguageProofingLLM, SymbolicProofingLLM, FormalizerLLM, the GGUF model manager, training, the datasets and the corpus audit, plus the paused programming work. Frozen by the owner on 2026-10-01; not imported by the product.', [
      ['Modules', Ps(['probably_obsolete/tinyLLMExperiments/', 'probably_obsolete/paused/'])],
      ['Entry points', `the README ${P('probably_obsolete/tinyLLMExperiments/README.md')} maps every old path to its new one and says how to resume.`],
      ['Configuration', 'none; nothing under these folders is read by the product'],
      ['Tests', 'moved with the code, not run any more'],
      ['Specifications', 'DS000 "The frozen research branch"; archived specifications in probably_obsolete/tinyLLMExperiments/specs/'],
    ]),
  ].join('\n');

  // ------------------------------------------------------------ the page
  const table = (head, rows) => `<div class="table-wrap"><table class="arch-table"><thead><tr>${head.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

  const html = `<!doctype html>
  <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatSOP Architecture</title><link rel="stylesheet" href="styles.css"><style>
  ${CSS}
  .arch-lead{max-width:62rem}
  .legend{display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;font-size:.9rem;margin:.6rem 0 1rem}
  .legend span{display:inline-flex;align-items:center;gap:.4rem}
  .legend i{display:inline-block;width:1.6rem;height:.9rem;border:1.5px solid #3d566b;border-radius:3px;background:#fff}
  .legend i.model{background:#fbf0e0}.legend i.fence{background:#fbe9e7;border-color:#a8480f;border-style:dashed}.legend i.disk{background:#eef6ee}.legend i.tool{background:#f3f0fa}
  .legend i.gate{border-color:#0f5f8a;border-width:3px}.legend i.out{border-style:dotted}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,26rem),1fr));gap:1rem}
  .card{border:1px solid #cdd9e2;border-radius:.4rem;padding:.2rem 1rem .6rem;background:#fbfdfe}
  .card h3{margin:.7rem 0 .2rem}.card p{margin:.2rem 0 .5rem}
  .card dl{margin:0;display:grid;grid-template-columns:7.2rem 1fr;gap:.25rem .7rem;font-size:.92rem}
  .card dt{font-weight:650;color:#12324a}.card dd{margin:0;line-height:1.5}
  .arch-table td,.arch-table th{padding:.3rem .45rem;vertical-align:top}
  .arch-table{border-spacing:0;border-collapse:collapse}.arch-table td,.arch-table th{border-bottom:1px solid #dce6eb}
  .ev{font-size:.9rem;color:#33495c}
  details.graph{margin:.6rem 0}details.graph summary{cursor:pointer;font-weight:650}
  @media (max-width:640px){.card dl{grid-template-columns:1fr}.card dt{margin-top:.3rem}}
  </style></head><body>
  <div data-include="partials/header.html"></div><main class="page"><article class="page__panel"><p class="breadcrumb"><a href="index.html">Overview</a> / Architecture</p><h1>Architecture</h1>
  <p class="arch-lead">This page documents the product as the code is today: which components exist, how a message becomes an answer, where the trust boundaries are, and what is deliberately not part of the product. It is generated from the source tree (static import scan of ${code('lib/')}, ${code('sop/')}, ${code('memory/')}, ${code('reasoning/')} and ${code('server/')}, then reading the call paths); every file:line citation is resolved by a pattern when the page is built, and a test fails when one stops holding. The contracts remain the specifications: <a href="specsLoader.html?spec=DS002-architecture.md">DS002</a>, <a href="specsLoader.html?spec=DS009-local-server.md">DS009</a>, <a href="specsLoader.html?spec=DS014-model-surface.md">DS014</a>, <a href="specsLoader.html?spec=DS022-sessions-and-base-memories.md">DS022</a>; the execution walk-through is <a href="runtime.html">Runtime</a> and the names are in the <a href="wiki.html">Wiki</a>.</p>
  <nav aria-label="On this page"><p><a href="#diagram-a">a Components and boundaries</a> · <a href="#diagram-b">b A chat turn</a> · <a href="#diagram-c">c Memory</a> · <a href="#diagram-d">d Reasoning</a> · <a href="#diagram-e">e Authoring</a> · <a href="#imports">Import graph</a> · <a href="#components">Component cards</a> · <a href="#not-in-product">Not in the product</a></p></nav>
  <div class="legend" role="note" aria-label="Legend">
  <span><i></i>server component</span><span><i class="model"></i>formalizer model (circuit author)</span><span><i class="fence"></i>Ploinky boundary or explicit-request</span><span><i class="disk"></i>stored data</span><span><i class="tool"></i>owner tooling</span><span><i class="gate"></i>gate or boundary rule</span><span><i class="out"></i>outside the process or frozen</span></div>

  <section id="diagram-a"><h2>a. Components and trust boundaries</h2>
  ${svg('a')}
  <p>Five boundaries matter. <b>B1</b> is authentication: every route needs a bearer token or the administrator session cookie, except the documentation, the health check, the home and login pages and the administrator setup and login calls (${E('server/http.mjs', /const sessionUser=auth/)}). <b>B2</b> is the author boundary of <a href="specsLoader.html?spec=DS014-model-surface.md">DS014</a>: the formalizer's model only answers short questions about the message and the vocabulary of the session memory, and the system assembles the circuit (the one-shot MRP strategies DirectSOP and SchemaGuidedLLM write a whole circuit, which the same validator admits); the request parser has no fallback parser (${E('server/query-parser.mjs', /There is no fallback parser/, true)}), and the Agent admits only declarative circuit types whose values the message supports (${E('server/agent.mjs', /^ validateVocabulary\(/)}). <b>B3</b> is the Ploinky boundary: a model is called only through the Ploinky proxy (${code('lib/pworker.mjs')}) as a plain chat completion, with no tools and no shell (${E('lib/ingest/direct-author.mjs', /export async function directAuthor/)}, ${E('lib/formalize/strategies.mjs', /export function tierChat/)}); what it returns is text that the validator checks. <b>B4</b> is that stored knowledge changes only through the few explicit writers of diagram c; a base memory grows only through a validated, recorded addition. <b>B5</b> is the solver rule: ${code('swipl')} and ${code('z3')} run only when a wire names the backend (diagram d).</p>
  <p class="ev">Static scan of the product entry points ${Ps(ENTRIES)}: ${reachable.length} of ${allProduct.length} modules under ${code('lib/')}, ${code('sop/')}, ${code('memory/')}, ${code('reasoning/')} and ${code('server/')} are reachable through static or dynamic imports; ${unreachable.length} are not (listed in <a href="#not-in-product">not in the product</a>).</p>
  </section>

  <section id="diagram-b"><h2>b. One chat turn, end to end</h2>
  ${svg('b')}
  <p>The chat call (${E('server/http.mjs', /url!=='\/v1\/chat\/completions'/)}) answers through ChatSOPAdapter (${E('server/http.mjs', /await chatTurn\(\{adapter/)}, ${E('lib/adapter/chat-turn.mjs', /export async function chatTurn/)}, ${E('lib/adapter/index.mjs', /export function createChatSOPAdapter/)}), the turn the evaluation harnesses run too (${E('tools/eval/lib/chat-turn.mjs', /export function harnessChat/)}); in its default mode ${code('stepwise')} it builds a circuit author whose ${code('formalize')} calls the request parser with the lexicon of the session (${E('lib/adapter/modes/stepwise.mjs', /queryParser\.parse\(\{source/)}) and hands it to ${code('Agent.turn')} (${E('server/agent.mjs', /async turn\(/)}); the modes ${code('routed')} and ${code('direct-verified')} formalize the message with several paths and verify by agreement (${E('lib/adapter/modes/routed.mjs', /export async function symbolicPaths/)}). The request parser runs the session's step-by-step strategy (${E('server/query-parser.mjs', /await parser\.run\(/)}): the system asks short questions, each answered by the first tier of the ladder and escalated only when needed (${E('lib/query-author/step-by-step/index.mjs', /const climb = async/)}), and assembles and validates the circuit. The formalizer never answers and never adds a fact: it produces a query, a constraint or a labelled ${code('unclear')} verdict.</p>
  <p>Steps 5 to 7 are one pipeline. ${code('compileDeclarative')} (${E('sop/declarative.mjs', /export function compileDeclarative/)}) never executes anything: it returns the authored SOP, the generated execution SOP and the reports (clause links, translations, untranslated words, copula readings, repairs, unresolved spans). ${code('runDeclarative')} (${E('sop/declarative.mjs', /export async function runDeclarative/)}) then runs the execution SOP through ${code('Runtime.run')} with origin ${code('generated')}; a relation or entity that does not link produces a ${code('clarify')} wire instead of a guess (${E('sop/declarative.mjs', /reason:'unresolved_link'/)}). In ${code('Runtime')} the ${code('solve')} wire expands into ${code('link')}, ${code('reason')} and ${code('binding')} wires (${E('sop/runtime.mjs', /case 'solve':/)}); ${code('link')} calls ${code('linkKnowledge')} (${E('sop/runtime.mjs', /output=linkKnowledge/)}), which retrieves through ${code('reasoning/slice/')} (${E('reasoning/linker.mjs', /from '\.\/slice\/index\.mjs'/)}); ${code('reason')} picks the strategy with ${code('chooseReasoning')} (${E('sop/runtime.mjs', /const chooseReasoning/)}), by default the reference route (${E('sop/runtime.mjs', /reasoningStrategy:'reference'/)}), and judges a sliced answer with the completeness guard (${E('sop/runtime.mjs', /answerOverSlice\(\{memory:mem/)}).</p>
  <p>The answer text is written by ${code('cnl')} through ${code('renderAnswer')} (${E('sop/cnl.mjs', /renderAnswer\(packet/)}) from the result packet; the structured packet is never changed. The chain stops being read-only in exactly one place: the proof-use reinforcement of an admitted, metadata-verified observed fact after a real, non-hypothetical proof, allowed only when ${code('policy.reinforce')} and the retention configuration both permit it (${E('sop/runtime.mjs', /this\.repo\.reinforce/)}).</p>
  </section>

  <section id="diagram-c"><h2>c. Memory: base memories, sessions, layers, SQLite, retention</h2>
  ${svg('c')}
  <p>A <b>base memory</b> is a folder whose circuits are the source of truth; its repository is derived from the ${code('fact')} wires (${E('lib/chat-data/memories.mjs', /export function ingestFacts/)}). The product creates SQLite memories only (${E('lib/chat-data/memories.mjs', /export const STRATEGIES/)}); the other engines of ${code('memory/banks/')} stay for research. A <b>session</b> copies the base circuits, clones the repository with hard links (${E('lib/chat-data/sessions.mjs', /cloneRepository\(path\.join/)}) and compiles its own lexicon from the base circuits followed by the session circuits (${E('lib/chat-data/sessions.mjs', /lexicon\(id\) \{/)}); the lexicon is cached by the hash of those circuits (${E('lib/chat-data/lexicons.mjs', /export const hashCircuits/)}). The query author reads the vocabulary of that lexicon, so the circuit it writes can only name predicates the memory has.</p>
  <p>${code('Repository.visible')} (${E('memory/repository.mjs', /^ visible\(s\)/)}) lists the session's live layer, then the user chain, then the base chain, and retrieval reads across them. The shipped configuration keeps retention at ${code('mode: none')} with ${code('reinforceOnUse: true')}, and uses bounded sharding with a garbage collection every 32 writes (${E('config/runtime.json', /"gcEveryWrites"/)}). Temporary folders older than 24 hours and sessions idle for 14 days are removed by a scheduled cleanup (${E('lib/chat-data/index.mjs', /DEFAULT_CHAT_DATA/)}).</p>
  <p>There are two read paths with different inputs: a chat turn retrieves ${code('fact')} rows from the session repository through ${code('linkKnowledge')}, while ${code('POST /v1/sessions/{id}/query')} runs the oracle over the session theory, the circuits as text, through ${code('askMemory')} (${E('server/product.mjs', /askMemory\(\{theory/)}). The first sees only the facts stored in the repository; the second sees every wire of the circuits, rules and norms included, and answers a query circuit you send.</p>
  </section>

  <section id="diagram-d"><h2>d. Reasoning strategies and backends, with rule 8</h2>
  ${svg('d')}
  <p>The registry has five ids: ${code('reference')}, ${code('js-reference')} and ${code('js-oracle')} (the same oracle, ${E('reasoning/registry.mjs', /ROUTE_IDS/)}) and the two external strategies ${code('prolog-tabling')} and ${code('z3-smt-bounded')}, each pinned to one backend (${E('reasoning/registry.mjs', /EXTERNAL_STRATEGIES/)}). A wire that names ${code('backend prolog')} or ${code('backend z3')} is routed to its strategy (${E('sop/runtime.mjs', /STRATEGY_OF_BACKEND\[one/)}). Rule 8 shows as four rejections (${E('reasoning/registry.mjs', /reference_backend_mismatch/)}, ${E('reasoning/registry.mjs', /backend_strategy_mismatch/)}, ${E('reasoning/registry.mjs', /explicit_backend_not_available_for_query/)}, ${E('reasoning/registry.mjs', /finite_domain_required/)}) and as ${code('unsupported')} with ${code('fallback: null')} (${E('reasoning/common.mjs', /export function unsupported/)}) when a binary is missing (${E('reasoning/registry.mjs', /export function solverAvailable/)}). With Prolog, the oracle still answers first and the two results must agree (${E('reasoning/bridge/external.mjs', /backendAgreement: agree/)}).</p>
  <p>The StrategyRouter has two entries. On the typed path of a chat turn, ${code('reasoning auto')} reports the oracle with its features and the reason (${E('reasoning/registry.mjs', /decision=routeTyped\(request\)/)}). On the knowledge-wire path of ${code('POST /v1/sessions/{id}/query')}, ${code('routedAsk')} (${E('reasoning/slice/wire.mjs', /routedAsk\(\{/)}) may choose a wire engine, and the oracle re-checks the routed answer. The completeness guard ${code('judge')} (${E('reasoning/slice/guard.mjs', /export function judge/)}) decides whether an answer over a partial slice may be given. The other directories under ${code('reasoning/strategies/')} are the comparison set, exercised by ${code('eval/smoke-reasoning/')} and ${code('tests/strategy-*.test.mjs')}.</p>
  </section>

  <section id="diagram-e"><h2>e. The authoring path</h2>
  ${svg('e')}
  <p>The direct author runs only on an explicit call (${E('server/authoring.mjs', /path: '\/v1\/author'/)}). It is one chat-completion conversation through the Ploinky proxy with no tools and no shell (${E('lib/ingest/direct-author.mjs', /export async function directAuthor/)}); the repair loop is bounded by ${code('maxFixRounds')} (${E('lib/ingest/direct-author.mjs', /for \(let round = 0; round < calls/)}). A validated result joins the session layer at once (${E('lib/chat-data/sessions.mjs', /^  addCircuit\(/)}) and ${code('SessionRuntimes.refresh')} (${E('server/session-runtime.mjs', /refresh\(/)}) makes it visible to open agents, including through a new session lexicon. Committing is a separate action (${E('lib/chat-data/sessions.mjs', /^  commit\(/)}).</p>
  </section>

  <section id="imports"><h2>Import graph (generated)</h2>
  <p>Static and dynamic relative imports of the ${reachable.length} product-reachable modules, collapsed to components. The product graph has ${moduleCycles.length} module cycles${moduleCycles.length ? '' : ''}; ${code('sop')} and ${code('reasoning')} import each other (${E('sop/runtime.mjs', /from '..\/reasoning\/registry\.mjs'/)} and ${E('reasoning/linker.mjs', /from '..\/sop\/parser\.mjs'/)}) without a module cycle. The product has ${productLinksOut.length} links to ${code('eval/')} or ${code('tools/')}${productLinksOut.length ? ': ' + productLinksOut.map(e => code(e.from + ' -> ' + e.to + (e.dynamic ? ' (lazy)' : ''))).join(', ') : ''}.</p>
  <details class="graph"><summary>Show the ${edges.size} importing components</summary><div class="table-wrap"><table class="arch-table"><thead><tr><th scope="col">Component</th><th scope="col">Imports</th></tr></thead><tbody>${graphRows}</tbody></table></div></details>
  <p class="ev">Modules outside the five product directories that the product reaches: ${outsideReach.length ? outsideReach.map(code).join(', ') : 'none'}.</p>
  </section>

  <section id="components"><h2>Component cards</h2>
  <p>Names follow the glossary in the <a href="wiki.html">Wiki</a>. Every path below was checked to exist when the page was generated.</p>
  <div class="cards">
  ${cards}
  </div></section>

  <section id="not-in-product"><h2>Not in the product</h2>
  <p>The frozen branch is one box: ${code('probably_obsolete/tinyLLMExperiments')}, described by its README (${P('probably_obsolete/tinyLLMExperiments/README.md')}). Everything else here still exists in the product tree as evidence, comparison or tooling, and is either unreachable from the product entry points or reachable only for tooling.</p>
  ${table(['What', 'Where', 'Why it is not in the product'], [
    ['Frozen branch: SymbolicLM, Stanza, LanguagesUtil, textToCleanEnglish, TranslatorService, LanguageProofingLLM, SymbolicProofingLLM, FormalizerLLM, the GGUF model manager, training, the datasets and the corpus audit', P('probably_obsolete/tinyLLMExperiments/'), 'Frozen by the owner on 2026-10-01. Circuits now come from the formalization strategies of the request parser (the step-by-step strategies through the Ploinky tier ladder); there is no fallback parser. The README of the folder maps old paths to new ones and how to resume.'],
    ['One-shot formalization: LLMDirect, its author guide, the validate-and-repair loop, the completion backend and the constrained-decoding experiments', P('probably_obsolete/one-shot-formalization/'), 'Archived by the owner on 2026-10-02: formalization is step by step, and larger tiers answer the same questions as tiny (like with like).'],
    ['Paused work: programming P0', P('probably_obsolete/paused/'), 'Not small-model work, but not part of the current product either; resumable.'],
    ['The comparison strategies', `${code('reasoning/strategies/')} (asp-clingo, closure-template, code-sandbox, conform, datalog-*, dreaming-session, golog-swi, htn-strips-planner, llm-agent, modes, sql-sqlite, vrc-compressed-planning, worlds-sopr, solver-common)`, `The comparison set of DS010 and DS006. ${unreachable.filter(f => rel(f).startsWith('reasoning/strategies/')).length} of their modules are not reached from the entry points; the StrategyRouter reaches sql-sqlite, datalog-souffle, asp-clingo and datalog-e10 only on the knowledge-wire path.`],
    ['Research memory engines', `${Ps(['memory/weaver.mjs', 'memory/banks/holo.mjs', 'memory/banks/holo-kernel.mjs', 'memory/banks/hybrid.mjs', 'memory/banks/scan.mjs', 'memory/sqlite-simple.mjs'])}`, 'RecallMemory, HoloMemory, scan, hybrid and the exact sidecar are research engines (DS016, DS017, DS019, DS020). The product offers SQLite only; old snapshots keep loading.'],
    ['Evaluation harnesses and tooling', `${Ps(['eval/', 'tools/eval/', 'tools/linking/', 'tools/world-kb/'])}`, 'Evidence and comparison; they import the product, the product must not import them.'],
    ['Archive', `${Ps(['probably_obsolete/'])}`, 'Historical material, never required reading. Archived specifications are not linked through docs/specs/.'],
  ])}
  </section>
  </article></main><div data-include="partials/footer.html"></div><script type="module" src="partials-loader.mjs"></script></body></html>
  `;

  return {html, problems, citations, reachable: reachable.length, total: allProduct.length};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = buildArchitecture();
  if (result.problems.length) { console.error('BUILD PROBLEMS:\n' + result.problems.join('\n')); process.exitCode = 1; }
  fs.writeFileSync(path.join(ROOT, 'docs/architecture.html'), result.html);
  console.log('wrote docs/architecture.html', result.html.length, 'bytes; problems:', result.problems.length, '; reachable', result.reachable, 'of', result.total);
}
