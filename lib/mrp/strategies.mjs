/**
 * The slots of the MRP-LLM pipeline and the strategy catalog of every slot (DS025 "Slots and strategies"). A slot is one stage with a
 * fixed contract; a strategy is one interchangeable way of doing that stage. Every question the design leaves open ("how much
 * round-trip checking", "where does a reflex end", "who commits session knowledge", "which SAE") is a slot whose strategies are
 * documented here and chosen per Model (lib/mrp/models.mjs), with per-session and per-request overrides.
 *
 * A strategy entry: `{slot, id, title, summary, use, cost, params, runs}`. `runs` is `server` when this server executes it, or
 * `external` when it needs components that are not part of the Node runtime (a Python package, a solver, a trained model); an
 * external strategy is listed with its requirement and `available()` reports whether this machine provides it. A strategy is never
 * substituted silently: a turn whose model names an unavailable strategy is answered with the reason (DS025 "No silent substitution").
 *
 * `params` describes each parameter: `{key, type: tier|number|string|enum|boolean, default, values?, min?, max?, summary}`.
 */
import {spawnSync} from 'node:child_process';
import {tierReadiness} from '../pworker.mjs';

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

const S = (slot, id, o) => Object.freeze({slot, id, runs: 'server', cost: 'none', params: [], ...o});

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
  S('reflex', 'off', {title: 'Off', summary: 'No reflex: every message goes through the full pipeline.', use: 'Rigorous models where every answer must be computed.'}),
  S('reflex', 'faq-fixed', {title: 'FAQ, fixed boundary', params: [THRESHOLD(0.6, 'Similarity at or above which the FAQ answer is given.')],
    summary: 'Scores the English message against the model\'s FAQ questions (token cosine with light stemming) and answers when the best score reaches a fixed threshold.',
    use: 'Default for models with a FAQ: predictable, explainable, no model call.'}),
  S('reflex', 'faq-margin', {title: 'FAQ, fixed boundary with margin', params: [THRESHOLD(0.55, 'Minimum similarity of the best FAQ question.'), {key: 'margin', type: 'number', min: 0, max: 1, default: 0.15, summary: 'Required lead of the best question over the second best.'}],
    summary: 'Like faq-fixed, but also requires the best question to lead the second by a margin, so two similar FAQ entries never fire on an ambiguous message.',
    use: 'FAQs with many near-duplicate questions.'}),
  S('reflex', 'faq-feedback', {title: 'FAQ, boundary learned from feedback', params: [THRESHOLD(0.6, 'Starting threshold.'), {key: 'step', type: 'number', min: 0, max: 0.2, default: 0.02, summary: 'How far one vote moves the threshold.'}, {key: 'min', type: 'number', min: 0, max: 1, default: 0.5, summary: 'Lowest threshold the learning may reach.'}, {key: 'max', type: 'number', min: 0, max: 1, default: 0.95, summary: 'Highest threshold the learning may reach.'}],
    summary: 'Starts from a threshold and moves it with the users\' votes on reflex answers: a down vote raises it, an up vote on a borderline answer lowers it. The learned value is stored with the model and shown on /models.',
    use: 'Models with real traffic and votes, where the right boundary is not known in advance.'}),
  S('reflex', 'faq-llm-judge', {title: 'FAQ, candidate confirmed by a model', cost: 'one small model call when a candidate exists', params: [THRESHOLD(0.45, 'Similarity at which the best FAQ question becomes a candidate.'), TIER('tiny', 'Tier that confirms that the message asks the same thing as the candidate question')],
    summary: 'A low lexical threshold selects a candidate; a small model answers yes or no to "does the message ask the same thing as this question?".',
    use: 'Paraphrase-heavy traffic where lexical similarity alone misses or misfires.'}),

  // ---------------------------------------------------------------- affect
  S('affect', 'formalizer-pragmatic', {title: 'From the formalizer (pragmatic wires)', summary: 'Courtesy and emotion are read by the formalizer in the same step as the request and written as pragmatic wires (DS023); the conversation layer replies to them.', use: 'Default: no extra call.'}),
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
  S('formalize', 'SchemaGuidedLLM', {runs: 'external', title: 'Schema-guided single call', requires: 'a reviewed value schema in the model\'s memory (Discover slot) and the schema prompt task',
    summary: 'One call whose prompt holds only the predicates, roles and lexemes of the model\'s active schemas, with unknown as the reserve predicate; validated and repaired in rounds.', use: 'Models with a reviewed schema.'}),
  S('formalize', 'DependencyScaffold', {runs: 'external', title: 'Dependency scaffold + labelling', requires: 'Python 3 with spaCy (en_core_web_lg) or Stanza',
    summary: 'A dependency parser gives who-did-what-to-whom, negation and coordination; a tiny model only labels predicates and roles with schema names.', use: 'Very small models that confuse roles.'}),
  S('formalize', 'FrameGuided', {runs: 'external', title: 'Frame-semantic parsing', requires: 'a frame-semantic parser (frame-semantic-transformer) and FrameNet data',
    summary: 'Frames and roles from a frame parser become match blocks, then frames map to model predicates.', use: 'Event-heavy English text.'}),
  S('formalize', 'SpladeRouted', {runs: 'external', title: 'SPLADE-routed extractors', requires: 'a SPLADE encoder (Python, transformers) and extractor wires produced by Discover',
    summary: 'SPLADE terms of the message select the extractors whose triggers match; only those run. The interpreter is chosen by what the message is sensitive to.', use: 'Models with many schemas.'}),
  S('formalize', 'SaeRouted', {runs: 'external', title: 'SAE-routed extractors', requires: 'a sparse autoencoder over a local model or sentence embeddings (see the discover strategies) and extractor wires',
    summary: 'Like SpladeRouted, with active SAE features as triggers: more semantic, more expensive.', use: 'Domains with very variable wording.'}),
  S('formalize', 'CNL-ACE', {runs: 'external', title: 'Controlled English (ACE) + APE', requires: 'the Attempto Parsing Engine (APE, SWI-Prolog)',
    summary: 'A model rewrites the message in Attempto Controlled English; APE parses it deterministically into DRS and then wires. The intermediate text is human-readable.', use: 'Rule-heavy English with auditors.'}),
  S('formalize', 'Ensemble', {runs: 'external', title: 'Ensemble of formalizers', requires: 'at least two other formalize strategies available on this server',
    summary: 'Runs several formalizers, keeps what they agree on as stated and marks the rest assumed or unclear.', use: 'Rigorous models and benchmark reference data.'}),
  S('formalize', 'FineTunedSOP', {runs: 'external', title: 'Fine-tuned small model', requires: 'a model fine-tuned on (text, circuit) pairs, served by a Ploinky tier',
    summary: 'A 1-8B model trained on validated pairs from traces writes the circuit directly.', use: 'Edge devices without cloud access.'}),

  // ---------------------------------------------------------------- admit, link
  S('admit', 'validate-repair', {title: 'Validate and repair', summary: 'The validator checks the circuit against the memory declarations; problems go back for bounded repair rounds and a missing term opens the vocabulary dialog (at most two expansions).', use: 'Always.'}),
  S('link', 'knowledge-linker', {title: 'KnowledgeLinker', summary: 'Links quoted entity names and relation phrases to the base memory\'s entities and predicates.', use: 'Always.'}),
  S('link', 'schema-linker', {runs: 'external', title: 'Schema linker', requires: 'a reviewed value schema with lexemes (Discover slot)', summary: 'Maps lexemes to predicates through the model\'s schemas before the KnowledgeLinker runs.', use: 'Models with a reviewed schema.'}),

  // ---------------------------------------------------------------- memory, retrieve
  S('memory', 'sqlite', {title: 'SQLite', summary: 'Exact indexed tuples; the source of truth.', use: 'Default.'}),
  S('memory', 'hybrid', {runs: 'external', requires: 'the server-wide engine setting memory.engine of config/runtime.json (DS005); the base memories of chat sessions store their tuples in SQLite', title: 'Hybrid', summary: 'Exact SQLite evidence plus associative hints.', use: 'Large memories where hints speed retrieval.'}),
  S('memory', 'recall-memory', {runs: 'external', requires: 'the server-wide engine setting memory.engine of config/runtime.json (DS005); the base memories of chat sessions store their tuples in SQLite', title: 'RecallMemory', summary: 'Several hashed views that must agree.', use: 'Research.'}),
  S('memory', 'holo-memory', {runs: 'external', requires: 'the server-wide engine setting memory.engine of config/runtime.json (DS005); the base memories of chat sessions store their tuples in SQLite', title: 'HoloMemory', summary: 'Superposed codes in fixed signed-counter banks.', use: 'Research.'}),
  S('memory', 'scan', {runs: 'external', requires: 'the server-wide engine setting memory.engine of config/runtime.json (DS005); the base memories of chat sessions store their tuples in SQLite', title: 'Scan', summary: 'Linear scan; the baseline.', use: 'Benchmarks.'}),
  S('memory', 'splade-index', {runs: 'external', title: 'SPLADE index', requires: 'a SPLADE encoder (Python, transformers)', summary: 'Sparse lexical-semantic index over facts and passages, explainable term by term.', use: 'Talk-to-a-book models.'}),
  S('memory', 'dense-index', {runs: 'external', title: 'Dense index', requires: 'an embedding model (e5/bge) served locally', summary: 'Dense embedding per wire; used by dense retrieval and embedding round-trip checks.', use: 'Domains with poor lexical overlap.'}),
  S('retrieve', 'slice', {title: 'Slice with completeness guard', summary: 'Fetches the facts of the query\'s predicates and entities; an answer that needs a complete slice is never given from a partial one.', use: 'Always.'}),
  S('retrieve', 'splade-slice', {runs: 'external', title: 'SPLADE slice', requires: 'the splade-index memory', summary: 'SPLADE terms of the query circuit fetch candidate facts written with other words.', use: 'Corpus-derived memories.'}),
  S('retrieve', 'graph-walk', {runs: 'external', title: 'Graph walk', requires: 'the wire graph index', summary: 'k steps from the query entities over shared entities and references.', use: 'Rule-heavy memories.'}),
  S('retrieve', 'hybrid-rerank', {runs: 'external', title: 'Hybrid rerank', requires: 'splade-slice and graph-walk', summary: 'Union of slice, splade-slice and graph-walk, reranked by agreement and cut to a budget; a cut slice marks the answer partial.', use: 'Large memories.'}),

  // ---------------------------------------------------------------- reason, verify
  S('reason', 'strategy-router', {title: 'StrategyRouter', summary: 'Chooses the JavaScript oracle or an installed engine (SQL, Datalog, ASP, Prolog, SMT) by the features of the problem; a requested backend is never substituted and an unavailable one is reported.', use: 'Default.'}),
  S('verify', 'oracle-js', {title: 'Oracle cross-check', summary: 'A routed answer is compared with the exact JavaScript reference; a disagreement returns the oracle\'s answer with the discrepancy.', use: 'Default.'}),
  S('verify', 'cross-engine', {runs: 'external', title: 'Two engines', requires: 'two installed external engines that can express the circuit', summary: 'The answer is computed by two engines and compared besides the oracle.', use: 'Compliance models.'}),

  // ---------------------------------------------------------------- roundtrip
  S('roundtrip', 'off', {title: 'Off', summary: 'No round-trip check. No extra cost.', use: 'Default for fast, low-risk models.'}),
  S('roundtrip', 'lexical-always', {title: 'Always, lexical comparison', cost: 'one model call per formalized message', params: [TIER('small', 'Tier that restates the circuit in English'), THRESHOLD(0.45, 'Token-cosine agreement below which the turn is flagged.'), {key: 'onMismatch', type: 'enum', values: ['note', 'warn'], default: 'note', summary: 'note: record in the trace; warn: also tell the user the question may have been misunderstood.'}],
    summary: 'Every formalization is restated in English by a model and compared with the normalized message by token cosine.', use: 'Models where a misread question is costly.'}),
  S('roundtrip', 'lexical-sampled', {title: 'Sampled, lexical comparison', cost: 'one model call for a sampled share of messages', params: [TIER('small'), THRESHOLD(0.45, 'Agreement below which the turn is flagged.'), {key: 'rate', type: 'number', min: 0, max: 1, default: 0.2, summary: 'Share of formalized messages that are checked.'}, {key: 'onMismatch', type: 'enum', values: ['note', 'warn'], default: 'note', summary: 'What a mismatch does.'}],
    summary: 'The same check on a random share of turns: a quality signal for the model\'s owner at a fraction of the cost.', use: 'Production monitoring.'}),
  S('roundtrip', 'on-doubt', {title: 'Only when the formalizer doubted', cost: 'one model call when triggered', params: [TIER('small'), THRESHOLD(0.45, 'Agreement below which the turn is flagged.'), {key: 'onMismatch', type: 'enum', values: ['note', 'warn'], default: 'warn', summary: 'What a mismatch does.'}],
    summary: 'Runs only when the circuit holds unclear/unparsed/assumed lines or a question had to escalate to a larger tier.', use: 'A good default for production: pays only on hard messages.'}),
  S('roundtrip', 'llm-judge', {title: 'Model judges equivalence', cost: 'two model calls per formalized message', params: [TIER('small'), {key: 'onMismatch', type: 'enum', values: ['note', 'warn'], default: 'note', summary: 'What a mismatch does.'}],
    summary: 'The circuit is restated in English and a model answers whether the restatement asks the same thing as the message.', use: 'Paraphrase-heavy domains where token overlap is a poor signal.'}),
  S('roundtrip', 'embedding', {runs: 'external', title: 'Embedding comparison', requires: 'the dense-index memory (an embedding model)', summary: 'Compares embeddings of the restatement and of the message.', use: 'When an embedding model is already served.'}),

  // ---------------------------------------------------------------- render, voice
  S('render', 'answer-text', {title: 'Deterministic English', summary: 'Renders the result packet in English, naming the origin of every step (memory, definition, assumption). Always kept in the trace.', use: 'Always.'}),
  S('voice', 'natural-rephrase', {title: 'Natural phrasing in the output language', cost: 'one model call per answer', params: [TIER('small')],
    summary: 'A model rewrites the English answer as a short natural reply in the output language; every number, date, name and source id must survive or the English answer is shown.', use: 'Default for chat.'}),
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
  S('discover', 'splade-stats', {runs: 'external', title: 'SPLADE statistics', requires: 'a SPLADE encoder (Python, transformers)', summary: 'Terms that fire specifically on the corpus become lexeme candidates, stable co-occurrences schema candidates, frequent verbs predicate candidates. Cheap, deterministic, gives no roles.', use: 'First pass on any corpus.'}),
  S('discover', 'llm-consolidate', {runs: 'external', title: 'LLM extraction and consolidation', requires: 'the batch discovery task (Ploinky, tier good) and a corpus ingested into the model', summary: 'Batches of passages go to a strong model for concepts, predicates and roles; clustering and a unifying pass merge synonyms.', use: 'Best names and roles; the most expensive.'}),
  S('discover', 'frame-seed', {runs: 'external', title: 'Frame seeding', requires: 'FrameNet or PropBank data', summary: 'Maps candidate predicates to existing frames and proposes standard roles, so synonyms share roles.', use: 'After another discover strategy.'}),
  S('discover', 'sae-llm-activations', {runs: 'external', title: 'SAE on LLM activations', requires: 'Python with PyTorch, a local LLM and pre-trained SAEs for it (for example Gemma 2 2B with Gemma Scope)',
    summary: 'Runs the corpus through a local LLM, reads its residual-stream activations through pre-trained sparse autoencoders, keeps features frequent in the corpus and rare in general text, and asks a strong model to name each feature from its top passages. Rich concepts; tied to one model\'s internals; the most expensive SAE option.', use: 'Large, unfamiliar corpora where concepts are not lexical.'}),
  S('discover', 'sae-sentence-embeddings', {runs: 'external', title: 'SAE trained on sentence embeddings', requires: 'Python with PyTorch and a sentence-embedding model (e5/bge)',
    summary: 'Embeds every passage, trains a small sparse autoencoder on these embeddings for this corpus, and names the features from their top passages. Cheaper and more stable between runs than activation SAEs; captures sentence-level topics, not token-level features.', use: 'Medium corpora; repeatable discovery.'}),
  S('discover', 'sae-pretrained-dictionary', {runs: 'external', title: 'Pre-trained SAE dictionary, no training', requires: 'Python with PyTorch and a published SAE dictionary for a public embedding model',
    summary: 'Uses a published SAE over a public embedding model without training: encode passages, keep corpus-specific features, name them. The cheapest SAE option; its features may not fit the domain.', use: 'Quick exploratory discovery.'}),
]);

export const strategiesOf = slot => STRATEGIES.filter(s => s.slot === slot);
export const strategy = (slot, id) => STRATEGIES.find(s => s.slot === slot && s.id === id) ?? null;

/** The default strategy of every slot (what a Model gets when it names none). */
export const DEFAULT_SLOTS = Object.freeze({
  normalize: 'translate-llm', reflex: 'faq-fixed', affect: 'formalizer-pragmatic', formalize: 'LocalLLMStepByStep', admit: 'validate-repair', link: 'knowledge-linker',
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

const commandWorks = (cmd, args) => { try { const r = spawnSync(cmd, args, {encoding: 'utf8', timeout: 4000}); return !r.error && r.status === 0; } catch { return false; } };
const PYTHON_MODULES = {DependencyScaffold: ['spacy'], SpladeRouted: ['transformers', 'torch'], 'splade-index': ['transformers', 'torch'], 'splade-stats': ['transformers', 'torch'],
  'sae-llm-activations': ['torch', 'sae_lens'], 'sae-sentence-embeddings': ['torch', 'sentence_transformers'], 'sae-pretrained-dictionary': ['torch', 'sae_lens'], FrameGuided: ['frame_semantic_transformer']};
// Whether the Python packages are installed: located with importlib (nothing is imported), once per package set and process.
const pythonCache = new Map();
const pythonHas = mods => {
  const key = mods.join(',');
  if (!pythonCache.has(key)) pythonCache.set(key, commandWorks(process.env.MRP_PYTHON ?? 'python3', ['-c', `import importlib.util,sys; sys.exit(0 if all(importlib.util.find_spec(m) for m in ${JSON.stringify(mods)}) else 1)`]));
  return pythonCache.get(key);
};

/**
 * Whether a strategy can run on this server now: `{available, reason?}`. Server strategies that call a model check their tier through
 * the Ploinky proxy (never starting it); external strategies report their requirement (checked where a check is cheap and reliable).
 */
export async function availability(entry, {params = null, tierCheck = tierReadiness, cache = new Map()} = {}) {
  if (entry.runs === 'external') {
    const mods = PYTHON_MODULES[entry.id];
    // The Python components are necessary, not sufficient: the strategy's own adapter is part of a separate service.
    const python = mods ? (pythonHas(mods) ? 'the Python packages are installed, the strategy service is not configured' : `needs Python packages ${mods.join(', ')}`) : null;
    return {available: false, reason: `external strategy: requires ${entry.requires}${python ? ` (${python})` : ''}`};
  }
  const tierParam = entry.params.find(p => p.type === 'tier');
  if (!tierParam) return {available: true};
  const tier = params?.tier ?? tierParam.default;
  if (!cache.has(tier)) cache.set(tier, await tierCheck(tier));
  const state = cache.get(tier);
  return state.available ? {available: true} : {available: false, reason: `tier ${tier}: ${state.reason}`};
}

/** The whole catalog for the API and /models: slots with their strategies (params, cost, use) and, with `check`, availability. */
export async function catalog({check = false, tierCheck = tierReadiness} = {}) {
  const cache = new Map();
  const out = [];
  for (const slot of SLOTS) {
    const list = [];
    for (const s of strategiesOf(slot.id)) list.push({...s, default: DEFAULT_SLOTS[slot.id] === s.id, ...(check ? await availability(s, {tierCheck, cache}) : {})});
    out.push({...slot, default: DEFAULT_SLOTS[slot.id], strategies: list});
  }
  return out;
}
