/**
 * The slots of the MRP-LLM pipeline and the strategy catalog of every slot (DS025 "Slots and strategies"). A slot is one stage with a
 * fixed contract; a strategy is one interchangeable way of doing that stage. Every question the design leaves open ("how much
 * round-trip checking", "where does a reflex end", "who commits session knowledge", "which SAE") is a slot whose strategies are
 * documented here and chosen per Model (lib/mrp/models.mjs), with per-session and per-request overrides.
 *
 * A strategy entry: `{slot, id, title, summary, use, cost, params, runs, implemented}`. `runs` is `server` when this server executes it, or
 * `external` when it needs components that are not part of the Node runtime (a Python package, a solver, a trained model); an
 * external strategy is listed with its requirement and `available()` reports whether this machine provides it. `implemented` is false
 * for a catalog entry whose code does not exist yet (a documented design, not a missing dependency): `status` in the catalog is
 * `ready`, `missing-dependency` or `not-implemented`. A strategy is never
 * substituted silently: a turn whose model names an unavailable strategy is answered with the reason (DS025 "No silent substitution").
 *
 * `params` describes each parameter: `{key, type: tier|number|string|enum|boolean, default, values?, min?, max?, summary}`.
 */
import {tierReadiness} from '../pworker.mjs';
import {serviceAvailability} from './strategy-service.mjs';

export const SLOTS = Object.freeze([
  {id: 'normalize', title: 'Normalize', summary: 'Turns the user message into clean English: language detection, translation, spelling and register. Every later slot reads English; the original message is kept in the trace.', input: 'user message', output: 'English text + detected language'},
  {id: 'reflex', title: 'Reflex', summary: 'Answers a frequent question of the model at once from its FAQ, before any formalization or reasoning; below the strategy\'s boundary the message goes on to the pipeline.', input: 'English text', output: 'a reply that ends the turn, or nothing'},
  {id: 'affect', title: 'Affect', summary: 'Reads emotion and urgency. The result tunes the voice and never enters reasoning.', input: 'English text', output: 'affect label and intensity'},
  {id: 'formalize', title: 'Formalize', summary: 'Writes SOP Lang circuits from the English text: queries, constraints, assumed lines and unclear/unparsed markers; never answers.', input: 'English text + memory vocabulary', output: 'SOP circuit'},
  {id: 'admit', title: 'Admit and repair', summary: 'Validates the circuit against the memory declarations, repairs it in bounded rounds and opens the vocabulary dialog for a missing term.', input: 'SOP circuit', output: 'admitted circuit or rejection'},
  {id: 'link', title: 'Link', summary: 'Links entity strings and relation phrases of the circuit to the base memory.', input: 'admitted circuit', output: 'linked circuit'},
  {id: 'memory', title: 'Memory', summary: 'The physical engine of the model\'s base memory: used when a base memory is created for the model (POST /v1/mrp/models with createBase). An existing base memory keeps its engine; the base memory card shows it.', input: 'wires', output: 'stored facts + search capabilities'},
  {id: 'retrieve', title: 'Retrieve', summary: 'Chooses the slice of the memory the reasoner runs on, with the completeness guard.', input: 'linked query', output: 'fact slice + completeness'},
  {id: 'reason', title: 'Reason', summary: 'Computes the answer with a symbolic engine chosen by the StrategyRouter; a requested backend is never substituted.', input: 'circuit + slice', output: 'result packet + trace'},
  {id: 'verify', title: 'Verify', summary: 'Checks a routed answer against the JavaScript oracle and reports any discrepancy.', input: 'result packet', output: 'verification'},
  {id: 'roundtrip', title: 'Round-trip check', summary: 'Re-states the formalization in English and compares it with the normalized message, to catch a circuit that answers another question. Costs one model call when it runs.', input: 'circuit + English text', output: 'agreement score and verdict'},
  {id: 'render', title: 'Render', summary: 'Renders the result packet as a deterministic English answer that names the origin of every step.', input: 'result packet', output: 'English answer'},
  {id: 'voice', title: 'Voice', summary: 'Phrases the English answer for the user in the output language (the user\'s language, the session\'s or the API caller\'s), adding no fact.', input: 'English answer + packet + affect', output: 'final reply'},
  {id: 'commit', title: 'Commit policy', summary: 'Decides what happens to the definitions and assumptions a session adds: kept in the session, queued for review, or written to the model\'s memory after automatic checks.', input: 'session circuits', output: 'memory change or review item'},
  {id: 'discover', title: 'Discover schema', summary: 'Proposes value schemas (predicates, roles, lexemes, extractors) from the model\'s corpus; proposals are reviewed before use.', input: 'corpus', output: 'proposed schema wires'},
]);
export const SLOT_IDS = Object.freeze(SLOTS.map(s => s.id));

const TIER = (fallback, summary = 'Ploinky tier that serves the calls of this strategy') => ({key: 'tier', type: 'tier', default: fallback, summary});
const THRESHOLD = (fallback, summary) => ({key: 'threshold', type: 'number', min: 0, max: 1, default: fallback, summary});

/** The engines of the StrategyRouter a Model can name (reasoning/router/engines.mjs); availability is checked when a query runs. */
export const REASON_ENGINES = Object.freeze(['js-reference', 'sql-sqlite', 'datalog-e10', 'datalog-souffle', 'asp-clingo', 'prolog-tabling']);

const S = (slot, id, o) => Object.freeze({slot, id, runs: 'server', cost: 'none', params: [], implemented: o.runs !== 'external', ...o});

export const STRATEGIES = Object.freeze([
  // ---------------------------------------------------------------- normalize
  S('normalize', 'translate-llm', {title: 'Translate and clean (LLM)', cost: 'one model call per message', params: [TIER('small'), {key: 'formalize', type: 'boolean', default: true, summary: 'Also rewrite casual or garbled wording into plain, explicit English (no new content).'}, {key: 'context', type: 'number', min: 0, max: 20, default: 4, summary: 'Previous turns shown to the model, so the message is rewritten as a self-contained English message: pronouns and ellipsis resolved, values and facts the user gave earlier restated. 0 reads the message alone.'}],
    summary: 'One call detects the language, translates to English, fixes spelling, makes the wording explicit and, with context, makes the message self-contained from the previous turns ("What is MY_VAR?" after "Remember that MY_VAR is 100" becomes "Given that MY_VAR is 100, what is MY_VAR?"). Default: the whole system works in English.',
    use: 'Any model whose users write in several languages or informally.'}),
  S('normalize', 'translate-if-foreign', {title: 'Translate only non-English (LLM)', cost: 'one model call for non-English messages', params: [TIER('small')],
    summary: 'A cheap check decides whether the message reads as English; only other messages are translated (with spelling fixes). English messages go through unchanged.',
    use: 'Mostly English traffic where the extra call would be wasted.'}),
  S('normalize', 'proofread-llm', {title: 'Proofread English (LLM)', cost: 'one model call per message', params: [TIER('small'), {key: 'context', type: 'number', min: 0, max: 20, default: 4, summary: 'Previous turns shown to the model, so the message is rewritten as a self-contained English message: pronouns and ellipsis resolved, values and facts the user gave earlier restated. 0 reads the message alone.'}],
    summary: 'Fixes spelling and grammar of an English message and keeps its wording; a message in another language is translated as well, since every later slot reads English.',
    use: 'English-only models with noisy input.'}),
  S('normalize', 'passthrough', {title: 'Pass through', summary: 'The message is used as typed. The formalizer then reads the original language itself.', use: 'Tests, benchmarks of the formalizer alone, or English-only input known to be clean.'}),

  // ---------------------------------------------------------------- reflex
  S('reflex', 'off', {title: 'Off', summary: 'No reflex: every message goes through the full pipeline; the model\'s pattern reflexes and FAQ are ignored.', use: 'Rigorous models where every answer must be computed.'}),
  S('reflex', 'pattern-reflex', {title: 'Pattern reflexes only', summary: 'Only the model\'s pattern reflexes (case-insensitive regular expressions over the English message, tried by priority): stop answers and ends the turn, continue prefaces the computed answer, pragmatic only gives the voice a tone line. The FAQ is not consulted. Every other reflex strategy but off also tries the pattern reflexes before its FAQ.', use: 'Models without a FAQ that still need fixed replies (who are you, what can you do, repeat that).'}),
  S('reflex', 'faq-fixed', {title: 'FAQ, fixed boundary', params: [THRESHOLD(0.6, 'Similarity at or above which the FAQ answer is given.')],
    summary: 'Scores the English message against the model\'s FAQ questions (token cosine with light stemming) and answers when the best score reaches a fixed threshold.',
    use: 'Default for models with a FAQ: predictable, explainable, no model call.'}),
  S('reflex', 'faq-margin', {title: 'FAQ, fixed boundary with margin', params: [THRESHOLD(0.55, 'Minimum similarity of the best FAQ question.'), {key: 'margin', type: 'number', min: 0, max: 1, default: 0.15, summary: 'Required lead of the best question over the second best.'}],
    summary: 'Like faq-fixed, but also requires the best question to lead the second by a margin, so two similar FAQ entries never fire on an ambiguous message.',
    use: 'FAQs with many near-duplicate questions.'}),
  S('reflex', 'faq-feedback', {title: 'FAQ, boundary learned from feedback', params: [THRESHOLD(0.6, 'Starting threshold.'), {key: 'step', type: 'number', min: 0, max: 0.2, default: 0.02, summary: 'How far one vote moves the threshold.'}, {key: 'min', type: 'number', min: 0, max: 1, default: 0.5, summary: 'Lowest threshold the learning may reach.'}, {key: 'max', type: 'number', min: 0, max: 1, default: 0.95, summary: 'Highest threshold the learning may reach.'}],
    summary: 'Starts from a threshold and moves it with the users\' votes on reflex answers: a down vote raises it, an up vote on a borderline answer lowers it. The learned value is stored with the model and shown on /models.',
    use: 'Models with real traffic and votes, where the right boundary is not known in advance.'}),
  S('reflex', 'faq-llm-select', {title: 'FAQ entry chosen by a model', cost: 'one small model call per message', params: [TIER('tiny', 'Tier that chooses the FAQ entry'), {key: 'maxEntries', type: 'number', min: 1, max: 200, default: 60, summary: 'Largest FAQ shown whole to the model; a larger FAQ shows the best lexical candidates only.'}],
    summary: 'The model sees the FAQ questions (with their variants) and names the entry whose answer fully answers the message, or none. No lexical boundary: paraphrases and short questions are judged by meaning; a question about a named person or project matches no entry.', use: 'Small FAQs with paraphrase-heavy traffic, where lexical similarity misses too much.'}),
  S('reflex', 'faq-hybrid', {title: 'FAQ: lexical when clear, a model in between', cost: 'one small model call only for messages in the uncertain band', params: [{key: 'high', type: 'number', min: 0, max: 1, default: 0.8, summary: 'Lexical score at or above which the best entry answers without a model call.'}, {key: 'low', type: 'number', min: 0, max: 1, default: 0.25, summary: 'Lexical score below which no entry answers, without a model call.'}, {key: 'k', type: 'number', min: 1, max: 20, default: 5, summary: 'Lexical candidates shown to the model in between.'}, TIER('tiny', 'Tier that chooses among the candidates')],
    summary: 'A clear lexical match answers at once, a clear miss goes on to reasoning; in between, a small model chooses among the best lexical candidates (as faq-llm-select) or none.', use: 'FAQs with real traffic: most messages cost nothing, paraphrases are still caught.'}),
  S('reflex', 'faq-llm-judge', {title: 'FAQ, candidate confirmed by a model', cost: 'one small model call when a candidate exists', params: [THRESHOLD(0.45, 'Similarity at which the best FAQ question becomes a candidate.'), TIER('tiny', 'Tier that confirms that the message asks the same thing as the candidate question')],
    summary: 'A low lexical threshold selects a candidate; a small model answers yes or no to "does the message ask the same thing as this question?".',
    use: 'Paraphrase-heavy traffic where lexical similarity alone misses or misfires.'}),

  // ---------------------------------------------------------------- affect
  S('affect', 'formalizer-pragmatic', {title: 'From the formalizer (pragmatic wires)', summary: 'The MRP layer reads no affect; courtesy and emotion are read by the formalizer in the same step as the request and written as pragmatic wires (DS023), to which the conversation layer replies (it does so under every affect strategy).', use: 'Models that need neither tone nor affect reflexes.'}),
  S('affect', 'lexicon', {title: 'English cue lexicon', summary: 'Whole-word cues of config/affect/lexicon-en.tsv (frustrated, urgent, confused, grateful, angry, happy, sad, each with an intensity) read on the English message; no model call. The voice uses the label for tone, affect reflexes react to it.', use: 'Default: the best accuracy and precision on eval/pragmatics-v1 behind translation (0.85 / 0.90), at zero cost.'}),
  S('affect', 'lexicon-then-llm', {title: 'Lexicon, a model when it finds nothing', cost: 'one small model call for the messages without a cue', params: [TIER('tiny')],
    summary: 'The cue lexicon reads the message; only when it finds no cue does a small model label it. Keeps the precision of the lexicon on the messages it covers and adds the recall of the model on the others.', use: 'Support models where missing an emotion costs more than a call.'}),
  S('affect', 'llm-label', {title: 'Label with a small model', cost: 'one small model call per message', params: [TIER('tiny')],
    summary: 'A small model labels the message with one of neutral, frustrated, urgent, confused, grateful, angry and an intensity; the voice uses it for tone.',
    use: 'Support models where tone matters.'}),
  S('affect', 'off', {title: 'Off', summary: 'No affect detection besides what the formalizer writes.', use: 'Benchmarks.'}),

  // ---------------------------------------------------------------- formalize
  S('formalize', 'LocalLLMStepByStep', {title: 'Step by step (questions to a small model)', cost: 'several short model calls', params: [TIER('tiny', 'First tier of the question ladder; a question escalates up the ladder only when the answer cannot be read')],
    summary: 'The system asks short questions about the message and assembles the circuit itself; the model only answers the questions.',
    use: 'Default: small models, auditable steps.'}),
  S('formalize', 'InternalReasoningStepByStep', {title: 'Step by step, protocol planned by the oracle', cost: 'several short model calls', params: [TIER('tiny')],
    summary: 'The same questions, with the questioning protocol stored as wires of a base memory and the next question planned by the JavaScript oracle.',
    use: 'Experiments with the questioning protocol as data.'}),
  S('formalize', 'Routed', {title: 'Routed (structure, then compute paths that must agree)', cost: 'several model calls',
    summary: 'A structure step classifies the problem; the compute path, jsEval and engine code formalize it independently and the answer is verified by their agreement.',
    use: 'Self-contained word problems (arithmetic, logic puzzles).'}),
  S('formalize', 'DirectVerified', {title: 'Direct answer, verified symbolically', cost: 'several model calls',
    summary: 'A model answers directly; the routed formalizations try to verify that answer and the reply says whether it was verified.',
    use: 'Baselines and open questions where a verified subset is enough.'}),
  S('formalize', 'DirectSOP', {title: 'Direct SOP (one call + repair rounds)', cost: 'one model call, plus one per repair round (at most three)', params: [TIER('small', 'Tier that writes the whole circuit')],
    summary: 'One call with the SOP authoring guide, the retrieved candidate predicates and the entity hints writes the whole circuit; the validator\'s problems go back for at most three repair rounds and at most two vocabulary-dialog rounds.', use: 'The baseline: how much a model formalizes without the step-by-step protocol.'}),
  S('formalize', 'SchemaGuidedLLM', {title: 'Schema-guided single call', cost: 'one model call, plus one per repair round (at most three)', params: [TIER('small', 'Tier that writes the whole circuit')],
    summary: 'Like DirectSOP, but the vocabulary is closed: the prompt offers the predicates of the model\'s memory (its schema) with their roles, no session predicate, rule or assumption is admitted, and anything no predicate expresses is written as unparsed or unclear relation_not_in_memory.', use: 'Models whose memory vocabulary is reviewed and complete for the domain.'}),
  S('formalize', 'DependencyScaffold', {runs: 'external', implemented: true, service: true, serviceOps: ['parse/spacy'], title: 'Dependency scaffold + labelling', requires: 'the MRP strategy service with spaCy (en_core_web_sm)', cost: 'no model call when the parsed phrase links; one small call otherwise', params: [TIER('tiny', 'Tier that names the predicate when the phrase does not link')],
    summary: 'spaCy gives the skeleton (the relation phrase from the verb and its preposition, a copular noun, a passive turned active; the subject, the object, the asked slot, how many, negation); it becomes one match block with the phrase, bound by the KnowledgeLinker. When the phrase does not link, a tiny model only names the predicate from a closed list of candidates. Questions over one relation; joins become unparsed.', use: 'Very small models that confuse roles; simple questions at almost no model cost.'}),
  S('formalize', 'FrameGuided', {runs: 'external', implemented: true, service: true, serviceOps: ['parse/spacy', 'frames/framenet'], title: 'FrameNet-guided', requires: 'the MRP strategy service with spaCy and nltk FrameNet 1.7', cost: 'one model call when a frame matches (none otherwise)', params: [TIER('small', 'Tier of SchemaGuidedLLM over the selected predicates')],
    summary: 'The lemmas of the message evoke FrameNet frames (lexical units); the predicates whose lexemes evoke the same frames are selected, and SchemaGuidedLLM formalizes over them only. A message that evokes no frame of the memory is unclear. Frames route without a trained frame parser.', use: 'Event-heavy English text whose verbs vary within a frame.'}),
  S('formalize', 'SpladeRouted', {runs: 'external', implemented: true, service: true, serviceOps: ['encode/splade'], title: 'SPLADE-routed extractors', requires: 'the MRP strategy service with SPLADE, and extractor wires with term triggers in the memory', cost: 'one model call when an extractor fires (none otherwise)', params: [TIER('small', 'Tier of the selected extractor\'s SchemaGuidedLLM')],
    summary: 'The SPLADE expansion of the message fires the term triggers of the memory\'s extractor wires; only the selected extractors run, each restricted to the predicates of its schema (SchemaGuidedLLM). A message that fires no extractor is unclear (relation_not_in_memory), never sent to a default interpreter. The routing is in the parse record.', use: 'Models with many schemas: the interpreter is chosen by what the message is sensitive to.'}),
  S('formalize', 'SaeRouted', {runs: 'external', implemented: true, service: true, serviceOps: ['sae/encode'], title: 'SAE-routed extractors', requires: 'the MRP strategy service with PyTorch, and extractor wires with feature triggers (written by the SAE discover strategies)', cost: 'one model call when an extractor fires (none otherwise)', params: [TIER('small', 'Tier of the selected extractor\'s SchemaGuidedLLM')],
    summary: 'Like SpladeRouted, with feature triggers: feature:sae:<name>:<id> (an SAE trained on the corpus by sae-sentence-embeddings) or feature:gpt2:<layer>:<id> (the pre-trained GPT-2 small SAEs of sae-llm-activations) fire when the feature is active on the message.', use: 'Domains whose wording varies too much for term triggers.'}),
  S('formalize', 'CNL-ACE', {runs: 'external', title: 'Controlled English (ACE) + APE', requires: 'the Attempto Parsing Engine (APE, SWI-Prolog)',
    summary: 'A model rewrites the message in Attempto Controlled English; APE parses it deterministically into DRS and then wires. The intermediate text is human-readable.', use: 'Rule-heavy English with auditors.'}),
  S('formalize', 'SchemaOrDirect', {title: 'Schema-guided when a schema exists, else direct', cost: 'one model call, plus one per repair round (at most three)', params: [TIER('small', 'Tier that writes the whole circuit')],
    summary: 'SchemaGuidedLLM when the model\'s memory has a reviewed value schema, DirectSOP otherwise; the choice follows from the memory (not from a failure) and is recorded as chosen in the parse record.', use: 'Models whose schema is reviewed over time: the closed vocabulary applies as soon as a schema is approved.'}),
  S('formalize', 'EnsembleOneShot', {title: 'Ensemble of the one-shot authors', cost: 'two model calls (plus repair rounds)', params: [TIER('small', 'Tier both members formalize on')],
    summary: 'DirectSOP and SchemaGuidedLLM formalize the same message in parallel; when their circuits agree the answer stands, when they disagree (or the memory has no schema) the circuit of DirectSOP is used and the disagreement is a doubt signal for the round trip.', use: 'A cheaper ensemble: an agreement check at two calls instead of the step-by-step protocol.'}),
  S('formalize', 'Ensemble', {title: 'Ensemble of formalizers', cost: 'the calls of DirectSOP, SchemaGuidedLLM and LocalLLMStepByStep together', params: [TIER('small', 'Tier every member formalizes on')],
    summary: 'DirectSOP, SchemaGuidedLLM and LocalLLMStepByStep formalize the same message in parallel on the same tier; circuits are compared by signature (the same wires, predicates, roles and values, whatever the names). Two agreeing circuits win; with no agreement the first valid circuit is used and the disagreement is a doubt signal for the round-trip check (on-doubt).', use: 'Rigorous models and benchmark reference data.'}),
  S('formalize', 'FineTunedSOP', {runs: 'external', title: 'Fine-tuned small model', requires: 'a model fine-tuned on (text, circuit) pairs, served by a Ploinky tier',
    summary: 'A 1-8B model trained on validated pairs from traces writes the circuit directly.', use: 'Edge devices without cloud access.'}),

  // ---------------------------------------------------------------- admit, link
  S('admit', 'validate-repair', {title: 'Validate and repair', summary: 'The validator checks the circuit against the memory declarations; problems go back for bounded repair rounds and a missing term opens the vocabulary dialog (at most two expansions).', use: 'Always.'}),
  S('link', 'knowledge-linker', {title: 'KnowledgeLinker', summary: 'Links quoted entity names and relation phrases to the base memory\'s entities and predicates.', use: 'Always.'}),
  S('link', 'schema-linker', {runs: 'external', title: 'Schema linker', requires: 'a reviewed value schema with lexemes (Discover slot)', summary: 'Maps lexemes to predicates through the model\'s schemas before the KnowledgeLinker runs.', use: 'Models with a reviewed schema.'}),

  // ---------------------------------------------------------------- memory, retrieve
  // The base memories of the product are SQLite (lib/chat-data/memories.mjs); the research engines of memory/ (hybrid, RecallMemory,
  // HoloMemory, scan; DS016-DS020) are chosen by the runtime memory.engine of tools and tests, never per Model, so they are not listed here.
  S('memory', 'sqlite', {title: 'SQLite', summary: 'Exact indexed tuples; the source of truth. The only engine of product base memories.', use: 'Default.'}),
  S('memory', 'splade-index', {runs: 'external', implemented: true, service: true, serviceOps: ['encode/splade'], title: 'SQLite + SPLADE index', requires: 'the MRP strategy service (python3 services/strategy-service/server.py, started with the server) with SPLADE (naver/splade-cocondenser-ensembledistil)', summary: 'The SQLite memory plus a derived SPLADE index of its predicate documents (label, description, phrases, example facts), built on first use under state/indexes and rebuilt when the memory changes; read by splade-slice and hybrid-rerank.', use: 'Memories whose questions use other words than the vocabulary.'}),
  S('memory', 'dense-index', {runs: 'external', implemented: true, service: true, serviceOps: ['encode/dense'], title: 'SQLite + dense index', requires: 'the MRP strategy service (python3 services/strategy-service/server.py, started with the server) with a sentence-embedding model (BAAI/bge-small-en-v1.5)', summary: 'The SQLite memory plus a derived index of dense embeddings of its predicate documents; read by dense-slice, hybrid-rerank and the embedding round trip.', use: 'Domains with poor lexical overlap.'}),
  S('retrieve', 'slice', {title: 'Slice with completeness guard', summary: 'The engine reads the facts of the query\'s predicates and entities (an answer that needs a complete slice is never given from a partial one); the formalizer is offered the lexical candidate predicates only. Every retrieve strategy keeps this exact slice for the engine and only adds candidates for the formalizer.', use: 'Default.'}),
  S('retrieve', 'splade-slice', {runs: 'external', implemented: true, service: true, serviceOps: ['encode/splade'], title: 'SPLADE candidates', requires: 'the MRP strategy service (python3 services/strategy-service/server.py, started with the server) with SPLADE', params: [{key: 'k', type: 'number', min: 1, max: 60, default: 12, summary: 'Candidate predicates offered to the formalizer.'}], summary: 'The SPLADE terms of the English message are matched (dot product) against the splade index of the memory\'s predicate documents; the best predicates are offered to the one-shot formalizer before the lexical candidates. Explainable term by term.', use: 'Corpus-derived memories, paraphrased questions.'}),
  S('retrieve', 'dense-slice', {runs: 'external', implemented: true, service: true, serviceOps: ['encode/dense'], title: 'Dense candidates', requires: 'the MRP strategy service (python3 services/strategy-service/server.py, started with the server) with a sentence-embedding model', params: [{key: 'k', type: 'number', min: 1, max: 60, default: 12, summary: 'Candidate predicates offered to the formalizer.'}], summary: 'Like splade-slice with dense embeddings (cosine): catches meaning without shared words, less explainable.', use: 'Domains with poor lexical overlap.'}),
  S('retrieve', 'graph-walk', {title: 'Graph walk from the named entities', params: [{key: 'k', type: 'number', min: 1, max: 60, default: 12, summary: 'Candidate predicates offered to the formalizer.'}], summary: 'The predicates of the facts about the entities the message names (one hop), then of the facts about their neighbours, ranked by how often they occur; offered to the one-shot formalizer before the lexical candidates. No model, no service.', use: 'Questions about named entities in memories with many relations.'}),
  S('retrieve', 'hybrid-rerank', {runs: 'external', implemented: true, service: true, serviceOps: ['encode/splade', 'encode/dense'], title: 'Hybrid rerank', requires: 'the MRP strategy service (python3 services/strategy-service/server.py, started with the server) with SPLADE and a sentence-embedding model', params: [{key: 'k', type: 'number', min: 1, max: 60, default: 12, summary: 'Candidate predicates offered to the formalizer.'}], summary: 'The union of splade-slice, dense-slice and graph-walk, ranked by how many lists name a predicate and by rank, cut to k.', use: 'Large memories.'}),

  // ---------------------------------------------------------------- reason, verify
  S('reason', 'strategy-router', {title: 'StrategyRouter', summary: 'Chooses the JavaScript oracle or an installed engine (SQL, Datalog, ASP, Prolog) by the features of the problem; a requested backend is never substituted and an unavailable one is reported.', use: 'Default.'}),
  S('reason', 'engine', {title: 'Named engine', params: [{key: 'engine', type: 'enum', values: REASON_ENGINES, default: 'sql-sqlite', summary: 'The engine that answers every query of the step-by-step turn.'}],
    summary: 'Every query of the turn goes to the named engine (the router\'s rule 8): an engine that cannot express the circuit, or is not installed, answers unsupported with the reason, never another engine. Applies to the stepwise turn (the step-by-step and one-shot formalizers); Routed and DirectVerified compute their own paths.', use: 'Benchmarks of one engine, models whose domain fits one engine.'}),
  S('verify', 'oracle-js', {title: 'Oracle cross-check', summary: 'A routed answer is compared with the exact JavaScript reference when the problem is small (or in a sample of large ones); a disagreement returns the oracle\'s answer with the discrepancy.', use: 'Default.'}),
  S('verify', 'oracle-always', {title: 'Oracle cross-check, always', cost: 'one oracle run per routed answer', summary: 'Every answer of an engine other than the oracle is checked against the JavaScript reference, whatever the size of the problem.', use: 'Compliance models where every answer must be checked.'}),
  S('verify', 'off', {title: 'No verification', summary: 'Routed answers are not checked against the oracle (the router records verification: never). Faster on large memories; a wrong engine answer is not caught.', use: 'Benchmarks of raw engine speed only.'}),
  S('verify', 'cross-engine', {title: 'Two engines, oracle as referee', cost: 'a second engine run per routed answer (an oracle run on a disagreement)', params: [{key: 'engine', type: 'enum', values: ['auto', ...REASON_ENGINES.filter(e => e !== 'js-reference')], default: 'auto', summary: 'The second engine; auto takes the first other installed engine.'}],
    summary: 'Besides the oracle check, a second installed engine answers every routed query; agreement is recorded in the route. On a disagreement the oracle decides which answer stays; an explicitly named engine is never replaced (the turn answers verification_discrepancy). With no second engine installed the trace says so.', use: 'Compliance models; a check of a new engine against the others.'}),

  // ---------------------------------------------------------------- roundtrip
  S('roundtrip', 'off', {title: 'Off', summary: 'No round-trip check. No extra cost.', use: 'Default for fast, low-risk models.'}),
  S('roundtrip', 'lexical-always', {title: 'Always, lexical comparison', cost: 'one model call per formalized message', params: [TIER('small', 'Tier that restates the circuit in English'), THRESHOLD(0.4, 'Token-cosine agreement below which the turn is flagged (0.4: the best catch rate with the fewest false alarms, eval 2026-10-14).'), {key: 'onMismatch', type: 'enum', values: ['note', 'warn'], default: 'note', summary: 'note: record in the trace; warn: also tell the user the question may have been misunderstood.'}],
    summary: 'Every formalization is restated in English by a model and compared with the normalized message by token cosine.', use: 'Models where a misread question is costly.'}),
  S('roundtrip', 'lexical-sampled', {title: 'Sampled, lexical comparison', cost: 'one model call for a sampled share of messages', params: [TIER('small'), THRESHOLD(0.4, 'Agreement below which the turn is flagged.'), {key: 'rate', type: 'number', min: 0, max: 1, default: 0.2, summary: 'Share of formalized messages that are checked.'}, {key: 'onMismatch', type: 'enum', values: ['note', 'warn'], default: 'note', summary: 'What a mismatch does.'}],
    summary: 'The same check on a random share of turns: a quality signal for the model\'s owner at a fraction of the cost.', use: 'Production monitoring.'}),
  S('roundtrip', 'on-doubt', {title: 'Only when the formalizer doubted', cost: 'one model call when triggered', params: [TIER('small'), THRESHOLD(0.4, 'Agreement below which the turn is flagged.'), {key: 'onMismatch', type: 'enum', values: ['note', 'warn'], default: 'warn', summary: 'What a mismatch does.'}],
    summary: 'Runs only when the circuit holds unclear/unparsed/assumed lines or a question had to escalate to a larger tier.', use: 'A good default for production: pays only on hard messages.'}),
  S('roundtrip', 'judge-on-doubt', {title: 'Model judge, only when the formalizer doubted', cost: 'two model calls when triggered', params: [TIER('small'), {key: 'onMismatch', type: 'enum', values: ['note', 'warn'], default: 'warn', summary: 'What a mismatch does.'}],
    summary: 'The doubt signals of on-doubt (unclear, unparsed or assumed lines, an escalated question, an ensemble without agreement) decide when to check; the check is the model judge of llm-judge (it caught every misread circuit of the benchmark).', use: 'Production models that want the strongest check at the cost of hard messages only.'}),
  S('roundtrip', 'llm-judge', {title: 'Model judges equivalence', cost: 'two model calls per formalized message', params: [TIER('small'), {key: 'onMismatch', type: 'enum', values: ['note', 'warn'], default: 'note', summary: 'What a mismatch does.'}],
    summary: 'The circuit is restated in English and a model answers whether the restatement asks the same thing as the message.', use: 'Paraphrase-heavy domains where token overlap is a poor signal.'}),
  S('roundtrip', 'embedding', {runs: 'external', implemented: true, service: true, serviceOps: ['encode/dense'], title: 'Embedding comparison', requires: 'the MRP strategy service with a sentence-embedding model (BAAI/bge-small-en-v1.5)', cost: 'one model call per formalized message (the restatement); the comparison is local', params: [TIER('small', 'Tier that restates the circuit in English'), THRESHOLD(0.85, 'Cosine of the two sentence embeddings below which the turn is flagged (0.85: 92% of the misread circuits caught at 4% false alarms, eval 2026-10-14).'), {key: 'onMismatch', type: 'enum', values: ['note', 'warn'], default: 'note', summary: 'What a mismatch does.'}],
    summary: 'The circuit is restated in English as in lexical-always, and the restatement and the message are compared by the cosine of their sentence embeddings: wording may differ, meaning is compared.', use: 'Paraphrase-heavy domains where token overlap is a poor signal and a judge call is too costly.'}),

  // ---------------------------------------------------------------- render, voice
  S('render', 'answer-text', {title: 'Deterministic English', summary: 'Renders the result packet in English, naming the origin of every step (memory, definition, assumption). Always kept in the trace.', use: 'Always.'}),
  S('voice', 'natural-rephrase', {title: 'Natural phrasing in the output language', cost: 'one model call per answer', params: [TIER('small')],
    summary: 'A model rewrites the English answer as a short natural reply in the output language; every number, date, name and source id must survive or the English answer is shown.', use: 'Default for chat.'}),
  S('voice', 'natural-if-foreign', {title: 'Natural phrasing for other languages only', cost: 'one model call for non-English output', params: [TIER('small')],
    summary: 'English output shows the deterministic English answer with no call; any other output language is phrased as natural-rephrase does.', use: 'Mostly English traffic that still wants natural replies in other languages.'}),
  S('voice', 'translate-only', {title: 'Translate when needed', cost: 'one model call for non-English output', params: [TIER('small')],
    summary: 'The deterministic English answer is shown as is for English output and faithfully translated otherwise.', use: 'Precise answers with minimal rewording.'}),
  S('voice', 'english-only', {title: 'Deterministic English only', summary: 'No model call: the rendered English answer is the reply, whatever the output language.', use: 'Benchmarks, offline devices.'}),

  // ---------------------------------------------------------------- commit
  S('commit', 'manual', {title: 'Manual commit', summary: 'Session definitions and assumptions stay in the session; a user commits a session explicitly into a new base memory (POST /v1/sessions/{id}/commit).', use: 'Default.'}),
  S('commit', 'review-queue', {title: 'Review queue', summary: 'Every definition the validator admitted in a session is queued on the model; an administrator approves or rejects it on /models, and approved ones are written to the model\'s base memory with provenance.', use: 'Shared models whose memory grows from conversations.'}),
  S('commit', 'auto-validated', {title: 'Automatic after checks', summary: 'Definitions the validator admitted are written to the model\'s base memory at once, with provenance; errors are corrected through tests and later interactions.', use: 'Single-owner models that should learn fast.'}),
  S('commit', 'never', {title: 'Never', summary: 'Sessions never change any base memory; explicit commits are refused.', use: 'Read-only published models.'}),

  // ---------------------------------------------------------------- discover
  S('discover', 'manual', {title: 'Manual schema', summary: 'An expert writes the schema (predicate, entity and lexeme wires) directly in SOP Lang through the knowledge API or an ingestion.', use: 'Always available; the benchmark reference.'}),
  S('discover', 'term-stats', {runs: 'external', implemented: true, service: true, title: 'Term statistics (strategy service)', requires: 'the MRP strategy service (python3 services/strategy-service/server.py; standard library only)', params: [{key: 'top', type: 'number', min: 5, max: 500, default: 60, summary: 'Lexeme candidates kept.'}],
    summary: 'The corpus terms that are frequent in the passages and rare in general English become lexeme candidates, the verbal ones predicate candidates of unknown arity. No package, no model: the baseline of splade-stats and the check of the strategy service. It gives no roles, so its candidates are listed for review, never written as wires.', use: 'A first look at any corpus; the baseline of splade-stats.'}),
  S('discover', 'splade-stats', {runs: 'external', implemented: true, service: true, title: 'SPLADE statistics', requires: 'the MRP strategy service with Python packages transformers and torch (a SPLADE encoder, MRP_SPLADE_MODEL)', params: [{key: 'top', type: 'number', min: 5, max: 500, default: 60, summary: 'Lexeme candidates kept.'}], summary: 'Terms that fire specifically on the corpus become lexeme candidates, stable co-occurrences schema candidates, frequent verbs predicate candidates. Cheap, deterministic, gives no roles.', use: 'First pass on any corpus.'}),
  S('discover', 'llm-consolidate', {title: 'LLM extraction and consolidation', cost: 'one strong model call per batch of passages, plus one unifying call', params: [TIER('good', 'Tier that names the relations and merges synonyms'), {key: 'batchChars', type: 'number', min: 1000, max: 60000, default: 12000, summary: 'Characters of passages per call.'}],
    summary: 'POST /v1/mrp/models/{id}/discover with passages: batches go to a strong tier that names the recurring relations (predicate, roles, role kinds, description, English phrases); candidates are merged by name, a unifying call merges synonyms, each one is checked by the knowledge validator, and every valid predicate with its lexeme becomes one review item. Names the memory already has are reported as known, never overwritten.', use: 'Best names and roles; the most expensive.'}),
  S('discover', 'frame-seed', {runs: 'external', implemented: true, service: true, serviceOps: ['frames/framenet', 'frames/units', 'frames/synonyms'], title: 'Frame seeding (FrameNet)', requires: 'the MRP strategy service with nltk FrameNet 1.7',
    summary: 'The frames the verb lexemes of the memory\'s predicates evoke give their other lexical units that are also WordNet synonyms of the predicate\'s head verb as new phrases of the same predicate; each proposed lexeme is checked by the knowledge validator, whose round trip refuses a phrase that would link elsewhere, and queued for review. Runs without passages.', use: 'After another discover strategy, or to widen the phrases of a reviewed memory.'}),
  S('discover', 'sae-llm-activations', {runs: 'external', implemented: true, service: true, serviceOps: ['sae/gpt2'], title: 'SAE on LLM activations', requires: 'the MRP strategy service with sae-lens and transformer-lens (GPT-2 small and its pre-trained residual SAEs, release gpt2-small-res-jb)', cost: 'local SAE reading plus one strong batched model call to name the features', params: [TIER('good', 'Tier that names the features'), {key: 'layer', type: 'number', min: 0, max: 11, default: 6, summary: 'Residual layer of GPT-2 small read through its SAE.'}, {key: 'top', type: 'number', min: 1, max: 200, default: 30, summary: 'Features kept (frequent in the corpus, at most half of the passages).'}],
    summary: 'The corpus runs through GPT-2 small; its residual stream is read through the pre-trained sparse autoencoders of that model; features that fire on part of the corpus are named by a strong tier from their top passages, which also picks the memory\'s predicates they express. Each named feature becomes a proposed schema and an extractor with the feature as trigger (SaeRouted). Gemma Scope would be richer but Gemma\'s licence must be accepted first.', use: 'Large, unfamiliar corpora where concepts are not lexical.'}),
  S('discover', 'sae-sentence-embeddings', {runs: 'external', implemented: true, service: true, serviceOps: ['sae/train'], title: 'SAE trained on sentence embeddings', requires: 'the MRP strategy service with PyTorch and sentence-transformers (BAAI/bge-small-en-v1.5)', cost: 'a local training of a few seconds plus one strong batched model call to name the features', params: [TIER('good', 'Tier that names the features'), {key: 'latents', type: 'number', min: 16, max: 8192, default: 512, summary: 'Features of the autoencoder.'}, {key: 'epochs', type: 'number', min: 10, max: 5000, default: 300, summary: 'Training passes.'}, {key: 'top', type: 'number', min: 1, max: 200, default: 30, summary: 'Features kept.'}],
    summary: 'Every passage is embedded; a small sparse autoencoder is trained on these embeddings for this corpus (weights kept under state/sae, so SaeRouted reads the same features); the features are named by a strong tier, which also picks the predicates they express; each becomes a proposed schema and an extractor with the feature as trigger. Cheaper and more stable than activation SAEs; sentence-level topics, not token-level features.', use: 'Medium corpora; repeatable discovery.'}),
  S('discover', 'sae-pretrained-dictionary', {runs: 'external', title: 'Pre-trained SAE dictionary, no training', requires: 'a published SAE over a public sentence-embedding model: none exists (2026-10-14: the 170 releases of sae-lens are all over language models, which sae-llm-activations covers)',
    summary: 'Would use a published SAE over a public embedding model without training. Not implemented: no such dictionary is published; the activation SAEs of language models are sae-llm-activations.', use: 'When such a dictionary is published.'}),
]);

export const strategiesOf = slot => STRATEGIES.filter(s => s.slot === slot);
export const strategy = (slot, id) => STRATEGIES.find(s => s.slot === slot && s.id === id) ?? null;

/** The default strategy of every slot (what a Model gets when it names none). */
export const DEFAULT_SLOTS = Object.freeze({
  normalize: 'translate-llm', reflex: 'faq-hybrid', affect: 'lexicon', formalize: 'DirectSOP', admit: 'validate-repair', link: 'knowledge-linker',
  memory: 'sqlite', retrieve: 'slice', reason: 'strategy-router', verify: 'oracle-js', roundtrip: 'on-doubt', render: 'answer-text', voice: 'natural-rephrase', commit: 'manual', discover: 'manual',
});

/** The parameters of a strategy with defaults filled in and values checked; unknown keys are refused. */
export function checkParams(entry, params = {}) {
  if (params == null) params = {};
  if (typeof params !== 'object' || Array.isArray(params)) throw Object.assign(new Error(`${entry.slot}/${entry.id}: params must be an object`), {status: 400, code: 'invalid_parameter'});
  const out = {};
  for (const key of Object.keys(params)) if (!entry.params.some(p => p.key === key)) throw Object.assign(new Error(`${entry.slot}/${entry.id} has no parameter ${key}`), {status: 400, code: 'invalid_parameter'});
  for (const p of entry.params) {
    const v = params[p.key] ?? p.default;
    const bad = () => Object.assign(new Error(`${entry.slot}/${entry.id}: invalid ${p.key}`), {status: 400, code: 'invalid_parameter'});
    if (p.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v) || (p.min != null && v < p.min) || (p.max != null && v > p.max))) throw bad();
    if (p.type === 'boolean' && typeof v !== 'boolean') throw bad();
    if (p.type === 'enum' && !p.values.includes(v)) throw bad();
    if (p.type === 'tier' && (typeof v !== 'string' || !/^[A-Za-z][\w-]{0,39}$/.test(v))) throw bad();
    out[p.key] = v;
  }
  return out;
}

/**
 * Whether a strategy can run on this server now: `{available, reason?}`. Server strategies that call a model check their tier through
 * the Ploinky proxy (never starting it); external strategies report their requirement (checked where a check is cheap and reliable).
 */
export async function availability(entry, {params = null, tierCheck = tierReadiness, cache = new Map()} = {}) {
  if (entry.runs === 'external' && !entry.implemented) return {available: false, status: 'not-implemented', reason: `not implemented yet (a catalog entry of the design): would require ${entry.requires}`};
  if (entry.service) {
    for (const op of entry.serviceOps ?? [`${entry.slot}/${entry.id}`]) { const [slot, id] = op.split('/'); const s = await serviceAvailability(slot, id); if (!s.available) return {available: false, status: 'missing-dependency', reason: s.reason}; }
    if (!entry.params.some(p => p.type === 'tier')) return {available: true, status: 'ready'};
  }
  if (entry.runs === 'external') return {available: false, status: 'missing-dependency', reason: `external strategy: requires ${entry.requires}`};
  const tierParam = entry.params.find(p => p.type === 'tier');
  if (!tierParam) return {available: true, status: 'ready'};
  const tier = params?.tier ?? tierParam.default;
  if (!cache.has(tier)) cache.set(tier, await tierCheck(tier));
  const state = cache.get(tier);
  return state.available ? {available: true, status: 'ready'} : {available: false, status: 'missing-dependency', reason: `tier ${tier}: ${state.reason}`};
}

/** The whole catalog for the API and /models: slots with their strategies (params, cost, use) and, with `check`, availability. */
export async function catalog({check = false, tierCheck = tierReadiness} = {}) {
  const cache = new Map();
  const out = [];
  for (const slot of SLOTS) {
    const list = [];
    for (const s of strategiesOf(slot.id)) list.push({...s, default: DEFAULT_SLOTS[slot.id] === s.id, status: s.implemented ? (s.runs === 'external' ? 'missing-dependency' : 'ready') : 'not-implemented', ...(check ? await availability(s, {tierCheck, cache}) : {})});
    out.push({...slot, default: DEFAULT_SLOTS[slot.id], strategies: list});
  }
  return out;
}
