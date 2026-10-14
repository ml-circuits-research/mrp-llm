import { Svg } from './svg.mjs';

/* ---------------------------------------------------------------- (a) components and trust boundaries */
export function diagramA() {
  const s = new Svg('dg-a', 1100, 'Components and trust boundaries of the running product',
    'Callers on the left cross the authentication boundary B1 into the server process; the server hands the message to the formalizer model across the author boundary B2, reaches every model only through the Ploinky proxy (B3, no tools, no shell) and solver binaries only on explicit request (B5); stored knowledge changes only through explicit writers (B4).');
  // Callers
  s.zone(10, 10, 224, 414, 'Callers', 'z-out');
  let y = 40;
  for (const [k, t, ls] of [
    ['c1', 'Browser chat', ['/chat page', 'server/pages/chat.mjs']],
    ['c2', 'API client', ['Bearer token; OpenAI-style', 'chat, product and service APIs']],
    ['c3', 'Command line', ['server/cli.mjs chat, run', '~own state/ repository']],
    ['c4', 'Owner in a browser', ['/experiments /eval /admin', '(administrator session)']],
  ]) { const g = s.node(k, 20, y, 204, t, ls, 'n-out'); y = g.b + 12; }
  s.boundary(242, 10, 242, 690, null);
  s.text(20, y + 14, 'B1 authentication boundary:', 'blabel');
  s.text(20, y + 28, 'bearer token or administrator', 'blabel');
  s.text(20, y + 42, 'session cookie (server/auth.mjs)', 'blabel');

  // Server
  s.zone(250, 10, 560, 680, 'Server process (Node 22.13+), one port: server/http.mjs', 'z-srv');
  const routes = s.node('routes', 262, 40, 536, 'Routes', [
    'chat facade: http.mjs      pages: web.mjs, pages/*      authentication: auth.mjs',
    'product API: product.mjs, authoring.mjs      service facts: api.mjs, capabilities.mjs'], 'n-srv');
  const LX = 262, RX = 536, W = 262;
  let ry = routes.b + 14;
  const rows = [
    [['qp', 'Request parser', ['server/query-parser.mjs: model chain,', 'cache, parse_unavailable 503,', 'parse_failed 422; no other parser']],
     ['qa', 'Query author', ['lib/query-author/: prompt from the', 'message and the memory vocabulary;', 'validate and repair, bounded rounds']]],
    [['agent', 'Agent (one chat turn)', ['server/agent.mjs, session-store.mjs,', 'session-runtime.mjs; admission;', 'caller-owned conversation context']],
     ['comp', 'Compiler and KnowledgeLinker', ['sop/declarative.mjs, knowledge-linker.mjs,', 'linking.mjs, clauses.mjs, repair.mjs,', 'lexicon.mjs, dictionary.mjs']]],
    [['rt', 'Runtime (SOP circuits)', ['sop/runtime.mjs, parser.mjs, lower.mjs,', 'cnl.mjs, answer-text.mjs: runs the', 'generated circuit, renders English']],
     ['slice', 'Slice retrieval', ['reasoning/slice/: keyed lookups,', 'widening, completeness guard', 'behind reasoning/linker.mjs']]],
    [['rs', 'Reasoning', ['reasoning/registry.mjs, bridge/, router/:', 'js-reference oracle; prolog-tabling,', 'z3 and routed engines on request']],
     ['auth', 'Authoring orchestrator', ['server/authoring.mjs, lib/ingest/', 'direct-author.mjs; validated at once']]],
    [['mem', 'Memory and chat data', ['memory/ (Repository, SQLite bank),', 'lib/chat-data/ (base memories,', 'sessions), sop/knowledge/ validator']],
     ['own', 'Owner pages', ['server/history.mjs, project.mjs,', 'pages/*: read journal, notes, reports', '~no part of a chat turn']]],
  ];
  for (const [l, r] of rows) {
    const a = s.node(l[0], LX, ry, W, l[1], l[2], 'n-srv');
    s.node(r[0], RX, ry, W, r[1], r[2], r[0] === 'own' ? 'n-tool' : 'n-srv');
    ry = a.b + 12;
  }
  const N = k => s.nodes[k];
  s.arrow([[234, 75], [262, 75]]);
  s.arrow([[N('routes').x + 40, N('routes').b], [N('qp').x + 40, N('qp').y]]);
  s.arrow([[N('qp').r, N('qp').cy], [N('qa').x, N('qa').cy]]);
  s.arrow([[N('qa').cx, N('qa').b], [N('qa').cx, N('comp').y]], { dashed: true });
  s.arrow([[N('qp').x + 40, N('qp').b], [N('agent').x + 40, N('agent').y]]);
  for (const [a, b] of [['agent', 'rt'], ['rt', 'rs'], ['rs', 'mem']])
    s.arrow([[N(a).x + 40, N(a).b], [N(b).x + 40, N(b).y]]);
  s.arrow([[N('agent').r, N('agent').cy], [N('comp').x, N('comp').cy]]);
  s.arrow([[N('rt').r, N('rt').cy], [N('slice').x, N('slice').cy]]);

  // The author boundary and the frozen branch
  s.boundary(822, 10, 822, 400, null);
  s.zone(834, 10, 256, 392, 'B2 author boundary', 'z-model');
  const ca = s.node('ca', 844, 40, 236, 'Formalizer (step by step)', ['short questions, tier ladder', 'tiny, then small, then good', '(escalated per question);', '~the system assembles the circuit'], 'n-model');
  s.text(844, ca.b + 22, 'It yields circuits (a query or an unclear', 'blabel');
  s.text(844, ca.b + 36, 'verdict); it never answers and never', 'blabel');
  s.text(844, ca.b + 50, 'adds a fact. The validator admits them.', 'blabel');
  s.arrow([[N('qa').r, N('qa').cy], [834, N('qa').cy]]);
  s.node('frozen', 844, ca.b + 76, 236, 'Frozen branch', ['probably_obsolete/tinyLLMExperiments:', 'SymbolicLM, Stanza, proofing and', 'formalizer models; not in the product'], 'n-out');
  // Fence + solvers
  s.zone(834, 414, 256, 186, 'B3 Ploinky and B5 solvers', 'z-fence');
  const om = s.node('omp', 844, 444, 236, 'Ploinky proxy (B3)', ['lib/pworker.mjs; tiers tiny,', 'small, medium, good; no tools,', '~no shell; the answer is text'], 'n-fence');
  s.node('sol', 844, om.b + 10, 236, 'Solver binaries (B5)', ['swipl, z3: only when a wire names', 'the backend; never a fallback'], 'n-fence');
  s.arrow([[N('auth').r, N('auth').cy], [834, N('auth').cy]]);
  s.arrow([[N('rs').r, N('rs').cy + 20], [530, N('rs').cy + 20], [530, 660], [814, 660], [814, N('sol').cy], [834, N('sol').cy]], { dashed: true });
  // Disk
  s.zone(10, 438, 224, 252, 'Disk and gates', 'z-out');
  const d1 = s.node('d1', 20, 468, 204, 'chat_data/ (gitignored)', ['base_memories/, sessions/,', 'cache/lexicon/, tmp/'], 'n-disk');
  const d2 = s.node('d2', 20, d1.b + 10, 204, 'config/ and state/', ['config/runtime.json, knowledge/', 'state/: auth.json'], 'n-disk');
  s.node('d3', 20, d2.b + 10, 204, 'B4 knowledge writes', ['base memories grow by', 'recorded acts (diagram c)'], 'n-gate');
  s.arrow([[N('mem').x, N('mem').cy], [224, N('mem').cy]]);
  return s;
}

/* ---------------------------------------------------------------- (b) one chat turn */
export function diagramB() {
  const s = new Svg('dg-b', 1100, 'One chat turn, end to end',
    'Nine steps from the message to the rendered answer: the request parser asks the formalizer model for a circuit, the query author validates and repairs it, the Agent admits it, the KnowledgeLinker binds its strings to the memory, slice retrieval and the StrategyRouter with the oracle compute the answer, and the deterministic English rendering writes it.');
  const X = 34, W = 700;
  let y = 12;
  const steps = [
    ['1', 'A message in any language', ['server/pages/chat.mjs or an API client: exactly one user message; the answer language is English'], 'n-out'],
    ['2', 'POST /v1/chat/completions', [
      'server/http.mjs: bearer or session cookie, checkBody, one request per conversation (409 while busy)',
      'server/session-runtime.mjs opens the session: its repository (a clone of the base memory) and its lexicon'], 'n-srv'],
    ['3', 'Request parser (server/query-parser.mjs)', [
      'readiness of the first tier of queryParser.local.ladder; cache keyed by memory version, strategy, ladder and message',
      'first tier cannot run: parse_unavailable (503); questions ran, no valid circuit: parse_failed (422); no other parser'], 'n-srv'],
    ['4', 'Step-by-step formalizer (lib/query-author/step-by-step)', [
      'retrieval.mjs and neighbourhood.mjs: candidate predicates, schema neighbourhood and entity hints of the memory',
      'protocol.mjs asks short questions; createOracle sends each to the first tier and escalates only unreadable ones',
      'the system assembles the circuit; validate.mjs admits it; an unclear verdict is a valid circuit'], 'n-model'],
    ['5', 'Agent.turn (server/agent.mjs): admission', [
      'validateVocabulary: model types only, unclear alone, stated values found in the message, spans verbatim',
      'then Runtime.run(sop, origin model) -> runDeclarative'], 'n-srv'],
    ['6', 'Compile and link: compileDeclarative (sop/declarative.mjs)', [
      'KnowledgeLinker: the session Lexicon (base + accepted session circuits) -> knowledge-linker.mjs, linking.mjs',
      'entity strings (relation phrases in phrase mode) bound to the memory; no match or a tie is a clarify question',
      'output: the generated circuit: resolve wires, solve, cnl (plus a hypothetical branch for assumptions)'], 'n-srv'],
    ['7', 'Runtime runs the circuit (sop/runtime.mjs)', [
      'solve expands to link + reason + binding; link = linkKnowledge (reasoning/linker.mjs)',
      'reasoning/slice/ retrieves a slice of the session Repository by keyed lookups, widens, reports completeness'], 'n-srv'],
    ['8', 'Reasoning: StrategyRouter and the oracle', [
      'ReasoningRegistry.run: reference (js-reference oracle) by default; auto records the route; prolog, z3 on request',
      'answerOverSlice: the guard accepts, widens or withholds; reinforcement only after a real proof, if policy allows'], 'n-srv'],
    ['9', 'Render and respond', [
      'sop/cnl.mjs -> sop/answer-text.mjs renders the packet deterministically in English; no model writes the answer',
      'transcript appended; the response adds chatSop: status, parse record, packet, trace'], 'n-srv'],
  ];
  const geo = [];
  for (const [n, t, ls, cls] of steps) {
    const g = s.node('s' + n, X, y, W, t, ls, cls);
    s.badge(X - 16 + 2, g.y + 17, n);
    geo.push(g); y = g.b + 22;
  }
  for (let i = 0; i < geo.length - 1; i++) s.arrow([[X + 60, geo[i].b], [X + 60, geo[i + 1].y]]);
  const MX = 786, MW2 = 300;
  s.zone(MX - 12, geo[2].y - 4, MW2 + 24, geo[3].b - geo[2].y + 8, 'Formalizer (B2)', 'z-model');
  s.node('ca', MX, geo[2].y + 26, MW2, 'Tier ladder: tiny, small, good', ['answers short questions only;', '~never writes SOP, knowledge or an answer'], 'n-model');
  s.arrow([[X + W, geo[3].cy], [MX - 12, geo[3].cy]], { start: true });
  s.node('mem', MX - 12, geo[5].y + 4, MW2 + 24, 'Per-session Lexicon', ['sop/lexicon.mjs, LexiconCache', '~compiled from circuits, cached by hash'], 'n-disk');
  s.arrow([[MX - 12, geo[5].y + 34], [X + W, geo[5].y + 34]]);
  s.node('slice', MX - 12, geo[6].y + 4, MW2 + 24, 'Repository (memory/)', ['SQLite bank; session layer, user and', 'base chains; read only except the', '~writers listed in diagram c'], 'n-disk');
  s.arrow([[MX - 12, geo[6].y + 34], [X + W, geo[6].y + 34]], { start: true });
  return s;
}

/* ---------------------------------------------------------------- (c) memory */
export function diagramC() {
  const s = new Svg('dg-c', 1100, 'Memory: base memories, sessions, layers, SQLite and retention',
    'Seeds create base memories; a session clones its base by hard links and adds its own accepted circuits and conversation context. The Repository reads the session layer, then the user chain, then the base chain, over sharded generations stored in a SQLite bank. Only validated, recorded acts write knowledge.');
  s.zone(10, 10, 230, 150, 'Shipped seeds', 'z-out');
  s.node('seed', 20, 40, 210, 'config/knowledge/', ['core-min (shared classes), demo,', 'core-en (English content)', '~ensureSeedMemories creates them'], 'n-disk');
  s.zone(270, 10, 380, 330, 'Base memory: chat_data/base_memories/<id>/', 'z-srv');
  const b1 = s.node('b1', 282, 40, 356, 'circuits/NNNN-*.sop  (source of truth)', ['predicate, lexeme, entity, fact, rule, default ...', 'the theory the exact oracle reads; the lexicon source'], 'n-srv');
  const b2 = s.node('b2', 282, b1.b + 10, 356, 'repo/  (Repository, one base named "main")', ['the fact wires, in the sqlite memory strategy only', 'content-addressed snapshots/ and shards/'], 'n-srv');
  const b3 = s.node('b3', 282, b2.b + 10, 356, 'manifest.json, imports/<id>/, provenance.jsonl', ['imports are snapshots of other memories (core-min first)', 'every addition records who approved it and why'], 'n-srv');
  s.node('b4', 282, b3.b + 10, 356, 'Lifecycle', ['fork: circuits copied, repo cloned by hard links;', 'session commit = fork; tmp 24 h, idle sessions 14 d'], 'n-srv');
  s.arrow([[240, 90], [270, 90]]);
  s.zone(680, 10, 410, 330, 'Session: chat_data/sessions/<id>/', 'z-srv');
  const c1 = s.node('c1', 692, 40, 386, 'repo/  (hard-link clone of the base repo)', ['accepted draft facts are added to its base', '"main"; the live layer gets trusted remember', 'and proof-use reinforcement only'], 'n-srv');
  const c2 = s.node('c2', 692, c1.b + 10, 386, 'base_circuits/  circuits/  drafts/', ['base circuits copied (self-contained); accepted', 'draft circuits; proposed drafts wait for the user'], 'n-srv');
  const c3 = s.node('c3', 692, c2.b + 10, 386, 'agent/  transcript.jsonl  provenance.jsonl', ['asserted statements and the last query stay here', 'as caller-owned conversation context, not facts'], 'n-srv');
  s.node('c4', 692, c3.b + 10, 386, 'Lexicon of the session', ['LexiconCache: sha256 of (base + session circuits)', 'in memory and chat_data/cache/lexicon/'], 'n-disk');
  s.arrow([[638, 120], [692, 120]], { label: 'create', lx: 642, ly: 112 });
  s.arrow([[692, 305], [638, 305]], { dashed: true });
  // Repository stack
  s.zone(10, 360, 1080, 230, 'Repository stack: memory/', 'z-srv');
  s.node('r1', 22, 390, 340, 'Repository (memory/repository.mjs)', ['visible(session) = session live layer,', 'then the user head chain, then the base head', 'chain; sessions detect stale revisions'], 'n-srv');
  s.node('r2', 376, 390, 340, 'ShardedLayer / TemporalLayer', ['hot and cold generations, pinned vs normal bank;', 'valid time and known time; corrections kept;', 'GC roots: pinned snapshots, bases, sessions'], 'n-srv');
  s.node('r3', 730, 390, 348, 'SQLiteBank (memory/banks/sqlite.mjs)', ['node:sqlite, exact atoms, indexed lookups', 'engine chosen by memory.engine; the product', 'offers sqlite only (DS022)'], 'n-srv');
  s.arrow([[362, 440], [376, 440]]); s.arrow([[716, 440], [730, 440]]);
  s.node('cfg', 22, 480, 540, 'config/runtime.json: memory', ['engine sqlite; retention mode none, reinforceOnUse true;', 'sharding bounded, maxClaimsPerShard 1024, gcEveryWrites 32'], 'n-disk');
  s.node('wr', 578, 480, 500, 'The only writers of knowledge (a read never hides a write)', ['addKnowledge (validator + provenance) | acceptDraft (user act, validated)', 'commit (fork) | trusted remember (Runtime effect) | reinforce (real proof only)'], 'n-gate');
  s.arrow([[300, 340], [300, 360]]); s.arrow([[880, 340], [880, 360]]);
  s.text(560, 612, 'Readers: the query author (vocabulary), KnowledgeLinker (lexicon), linkKnowledge (slice retrieval per goal), POST /v1/sessions/{id}/query (oracle over the circuits).', 'tl', 'middle');
  return s;
}

/* ---------------------------------------------------------------- (d) reasoning */
export function diagramD() {
  const s = new Svg('dg-d', 1100, 'Reasoning strategies and backends, with rule 8',
    'A solve or reason wire picks a strategy: its reasoning field, else the strategy of its backend, else the policy default reference. Reference is the js-reference oracle; prolog-tabling and z3-smt-bounded run only when named. A mismatch or a missing binary is unsupported with fallback null; nothing is substituted.');
  const w1 = s.node('w', 12, 20, 300, 'solve / reason wire', ['fields: reasoning, backend, mode, assume', 'sop/runtime.mjs chooseReasoning order:', '1 the wire\'s reasoning field', '2 the strategy of its backend (prolog, z3)', '3 policy default (reference)', 'allowedReasoningStrategies can forbid'], 'n-srv');
  s.node('pol', 12, w1.b + 14, 300, 'Retrieval is orthogonal', ['policy.retrievalStrategy (hybrid) decides how', 'facts are fetched from memory; it never', 'changes the reasoning strategy'], 'n-disk');
  s.zone(340, 10, 430, 332, 'ReasoningRegistry (reasoning/registry.mjs)', 'z-srv');
  const a = s.node('ref', 352, 40, 406, 'reference | js-reference | js-oracle', ['the js-reference oracle through reasoning/bridge', 'backend auto or js; route.backend js, fallback null', 'deduce, temporal, classify -> solveHorn (instant or', 'interval); constraint, optimize -> finite integer', 'enumeration; abduce, diagnose, associate, induce,', 'analogize, plan, simulate -> shared JS controllers'], 'n-srv');
  const b = s.node('pl', 352, a.b + 10, 406, 'prolog-tabling (backend prolog, SWI-Prolog)', ['Horn at a point in time; the oracle answers first and', 'the Prolog result must agree on status and rows'], 'n-fence');
  s.node('z3', 352, b.b + 10, 406, 'z3-smt-bounded (backend z3)', ['integer constraints and optimization, plus an', 'optimality check against the oracle'], 'n-fence');
  s.arrow([[312, 60], [340, 60]]);
  s.zone(800, 10, 290, 332, 'Rule 8: never substituted', 'z-fence');
  const rj = ['reference + backend prolog or z3:', 'reference_backend_mismatch', 'prolog-tabling + another backend:', 'backend_strategy_mismatch', 'swipl or z3 not installed:', 'unsupported, backend named, fallback null', 'interval query on prolog:', 'explicit_backend_not_available_for_query', 'infinite domain on js:', 'finite_domain_required'];
  s.node('rej', 810, 40, 270, 'Rejections (registry.mjs)', rj, 'n-gate');
  s.arrow([[758, 150], [810, 150]], { dashed: true });
  // router + slice
  s.zone(12, 360, 1078, 110, 'StrategyRouter and the completeness guard', 'z-srv');
  s.node('typed', 24, 390, 340, 'Typed path (chat turn)', ['reasoning auto: router/typed.mjs reports the oracle', 'with features and reason; the answer keeps its proof'], 'n-srv');
  s.node('wire', 378, 390, 340, 'Knowledge-wire path (session query)', ['slice/wire.mjs askMemory -> router/index.mjs routedAsk;', 'engines sql-sqlite, souffle, clingo; oracle verifies'], 'n-srv');
  s.node('guard', 732, 390, 346, 'Completeness guard (slice/guard.mjs)', ['accept, widen the slice, or answer incomplete;', 'answerOverSlice reports the retrieval'], 'n-gate');
  // comparison set
  s.zone(12, 484, 1078, 150, 'Comparison set: reasoning/strategies/ (only sql-sqlite, datalog-souffle, asp-clingo and datalog-e10 are reached, by the StrategyRouter)', 'z-out');
  const names = ['asp-clingo', 'closure-template', 'code-sandbox', 'conform', 'datalog-common', 'datalog-e10', 'datalog-souffle', 'dreaming-session', 'golog-swi', 'htn-strips-planner', 'llm-agent', 'modes', 'solver-common', 'sql-sqlite', 'vrc-compressed-planning', 'worlds-sopr'];
  let x = 24, yy = 512, col = 0;
  for (const nm of names) {
    s.node('c-' + nm, x, yy, 252, null, [nm], 'n-tool', { h: 28 });
    col++; x += 262; if (col === 4) { col = 0; x = 24; yy += 30; }
  }
  return s;
}

/* ---------------------------------------------------------------- (e) authoring */
export function diagramE() {
  const s = new Svg('dg-e', 1100, 'The authoring path: from an attachment to a session circuit',
    'A user act sends files or a request to the direct author, a chain model called through the Ploinky proxy without tools; the server validates and repairs the circuits and, with a session, stores the valid ones in the session layer at once. A commit to a fork of the base memory is a separate explicit act.');
  const t = s.node('t', 12, 20, 300, '1  A user act', ['attach files and instructions, or', 'call POST /v1/author; nothing is', 'authored without this explicit call'], 'n-out');
  const a = s.node('a', 12, t.b + 22, 300, '2  POST /v1/author', ['server/authoring.mjs; session or temp folder;', 'wait false answers 202, then poll the request', '~answer 429 author_busy at the concurrency limit'], 'n-srv');
  s.arrow([[162, t.b], [162, a.y]]);
  const f = s.node('f', 12, a.b + 22, 300, '3  Request folder', ['sessions/<id>/requests/<req>/: input/', '(files, vocabulary), skill/ (sop-wire-', 'authoring), TASK.md (fence, outputs)'], 'n-srv');
  s.arrow([[162, a.b], [162, f.y]]);
  s.zone(340, 20, 330, 190, 'B3 Ploinky', 'z-fence');
  const o = s.node('o', 352, 50, 306, '4  directAuthor (direct-author.mjs)', ['one chat-completion conversation via', 'Ploinky; no tools, no shell, no files;', 'no credentials in the prompt; call timeout', '~answers knowledge.sop, queries.sop, report.md'], 'n-fence');
  s.arrow([[312, f.cy], [330, f.cy], [330, o.cy], [352, o.cy]]);
  const v = s.node('v', 340, 236, 330, '5  Validate and repair (server)', ['sop/knowledge validate with the session theory;', 'on problems the same conversation continues', 'with the validator output as patches, up to 3 rounds'], 'n-srv');
  s.arrow([[505, o.b + 0], [505, v.y]]);
  const d = s.node('d', 700, 236, 390, '6  Session layer (no manual step)', ['Sessions.addCircuit: validated with the base and', 'session circuits, copied to circuits/, facts ingested,', 'provenance kind add; invalid: refused, nothing stored'], 'n-srv');
  s.arrow([[670, v.cy], [700, v.cy]]);
  const g = s.node('g', 700, d.b + 24, 390, '7  Next request sees it', ['SessionRuntimes.open notices the changed session', 'circuits and refreshes the lexicon and repository view;', 'errors are corrected through tests and interactions'], 'n-srv');
  s.arrow([[895, d.b], [895, g.y]]);
  const c = s.node('c', 700, g.b + 24, 390, '8  Commit (separate, explicit)', ['POST .../commit: a new fork of the base memory,', 'validated again, provenance kind commit; the base the', 'session started from does not change'], 'n-gate');
  s.arrow([[895, g.b], [895, c.y]]);
  s.node('k', 340, 400, 330, 'Alternative: prepare a base memory', ['POST /v1/memories/{id}/knowledge: circuits must', 'pass sop/knowledge; recorded with the acting user', '~document ingestion: lib/ingest (stored after checks)'], 'n-srv');
  return s;
}
