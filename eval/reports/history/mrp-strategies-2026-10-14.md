# MRP strategies compared, slot by slot (2026-10-14)

Every strategy of a slot ran on the same cases, the same base memory and the same Ploinky tier (`fast`: DeepSeek flash with GLM flash
as fallback, thinking off; most calls of this day were served by `glm-5.3-flash`). Runners: `tools/eval/mrp/` (DS028 "Benchmark
contract"); regenerable rows and JSON reports under `eval/reports/current/mrp-formalize/` and `eval/reports/current/mrp-slots/`.
These are historical numbers of one run, not a guarantee: the sets are small dev sets written for this benchmark (the `world-v1`
memory of the larger sealed suites is not on this machine). Latency was measured with three benchmarks sharing one Ploinky queue, so
compare latencies within a table only. Model calls and tokens per question come from Ploinky's request log (upstream attempts per run
tag); a response served from Ploinky's cache costs no call, which is why `Ensemble` (whose members repeat the prompts of runs made just
before it) shows almost no latency and tokens.

## Formalize (`eval/mrp-formalize-v1`)

acme (40 questions over acme-demo: lists, yes/no, counts, rule-derived relations, joins, casual wording, 6 unanswerable):

| strategy | correct | wrong | honest unknown | parser failed | accuracy | mean s | calls/q | tokens/q |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DirectSOP | 37 | 0 | 3 | 0 | 0.925 | 8.4 | 1.1 | 17 391 |
| Ensemble | 37 | 0 | 3 | 0 | 0.925 | (cached) | 8.5 | (cached) |
| SchemaGuidedLLM | 36 | 0 | 4 | 0 | 0.900 | 8.1 | 1.0 | 12 170 |
| InternalReasoningStepByStep | 33 | 2 | 4 | 1 | 0.825 | 45.8 | 5.7 | 6 301 |
| LocalLLMStepByStep (today's default) | 32 | 1 | 6 | 1 | 0.800 | 46.5 | 6.4 | 8 144 |
| Routed | 6 | 0 | 34 | 0 | 0.150 | 31.8 | - | - |
| DirectVerified | 6 | 0 | 34 | 0 | 0.150 | 50.3 | - | - |

Every strategy abstained on all 6 unanswerable questions. The three honest unknowns of DirectSOP are the yes/no questions whose gold is
"no" over open-world relations (`Does Elena work at Acme?`): unknown is the correct answer of the system there. The step-by-step
strategies lose on joins over two relations (a dropped condition gave the one wrong answer of LocalLLMStepByStep, a type clash an error).
Routed and DirectVerified formalize a message as a self-contained problem and do not read the memory: they are for word problems, not
for questions about a Model's knowledge (their 6 correct are the 6 abstentions).

commonsense (32 questions over commonsense-v1 alone): DirectSOP 13 correct / 0 wrong, Ensemble 13 / 0, LocalLLMStepByStep 11 / 4,
InternalReasoningStepByStep 4 / 1, Routed and DirectVerified 0 / 0, SchemaGuidedLLM refused every question (the memory has no reviewed
schema, as designed). Most questions name entities that commonsense-v1 alone does not hold (Paris, Einstein, Mozart), so the honest
answer is a clarification; the order of the strategies is the same as on acme.

acme-ro (16 acme questions in Romanian, casual ones included, DirectSOP behind each normalize strategy): translate-llm 16/16,
translate-if-foreign 16/16, passthrough 16/16 (the one-shot model reads Romanian itself, against the English-inside rule of DS026),
proofread-llm 15/16.

## Reflex (`eval/mrp-slots-v1`, 46 cases over the acme-demo FAQ, 24 of which need reasoning, short and paraphrased questions included)

| strategy | precision | recall | intrusive | calls/case |
| --- | --- | --- | --- | --- |
| faq-llm-select (new) | 0.913 | 0.955 | 2 | 1 |
| faq-llm-judge | 0.833 | 0.455 | 2 | 0.4 |
| faq-fixed (default, 0.6) | 0.769 | 0.455 | 3 | 0 |
| faq-feedback | 0.769 | 0.455 | 3 | 0 |
| faq-margin | 0.714 | 0.455 | 4 | 0 |

A threshold sweep of the lexical score (0.4 to 0.8, with and without a two-shared-terms guard) never passed F1 0.57: lexical
similarity misses paraphrases ("When can I visit you?") and fires on short questions ("Who?", "How can I contact Elena Ionescu?"). The
two intrusions of faq-llm-select are one-word messages ("Who?", "open").

## Affect (`eval/pragmatics-v1`, 300 labelled messages in several languages; acts mapped to affect labels)

| strategy | normalize | accuracy | emotion precision | emotion recall | calls/message |
| --- | --- | --- | --- | --- | --- |
| lexicon | translate-llm | 0.850 | 0.903 | 0.644 | 0 (+1 normalize) |
| llm-label | translate-llm | 0.837 | 0.708 | 0.920 | 1 (+1 normalize) |
| llm-label | passthrough | 0.800 | 0.648 | 0.908 | 1 |
| lexicon | passthrough | 0.793 | 0.875 | 0.402 | 0 |
| off | any | 0.710 | - | 0 | 0 |

## Round trip (52 pairs from the LocalLLMStepByStep acme circuits: each correct circuit with its own question, and with another question)

| strategy | misreads caught | false alarms | calls/check |
| --- | --- | --- | --- |
| llm-judge | 1.000 | 0.115 | 2 |
| lexical-always, threshold 0.45 | 0.846 | 0.077 | 1 |
| lexical-always, threshold 0.40 | 0.846 | 0.038 | 1 |

## Voice (26 correct English answers of the acme run, phrased in Romanian and French)

Both natural-rephrase and translate-only passed the fidelity guard (every number, name and source id kept) on 26/26 answers in both
languages, one call each. natural-rephrase reads as a chat reply ("Ana Popescu lucrează la Acme."); translate-only keeps the labels and
the sources line ("Răspuns: Acme. ... Surse folosite: ...").

## Defaults

Applied: the affect default is `lexicon` (best accuracy and precision at no cost, and it runs before the reflex so affect reflexes work);
the lexical round-trip threshold is 0.4 (same catch rate, half the false alarms); `companion-edge` formalizes with DirectSOP; the new
profile `talk-to-book`. Unchanged and confirmed: normalize `translate-llm` (it also makes multi-turn messages self-contained, which
translate-if-foreign does not), roundtrip `on-doubt`, voice `natural-rephrase`, reason `strategy-router`, verify `oracle-js`.

Recommended, not applied (they reverse the owner decision of 2026-10-02 that the chat formalizes step by step, or add a model call to
every turn): formalize `DirectSOP` (SchemaGuidedLLM for a Model whose memory has a reviewed schema): higher accuracy, no wrong answer,
about one call and a fifth of the latency, at about twice the prompt tokens (a shared prefix the serving model can cache). Reflex
`faq-llm-select` for Models with a FAQ when one small call per message is acceptable: it doubles the recall of the lexical boundary.

## Addendum (later the same day): the owner's decision and the new strategies

The owner approved DirectSOP as the formalize default ("DirectSOP e una din strategii, da, sigur, facem cât mai multe strategii"). New
strategies, measured on the same sets: `faq-hybrid` (reflex: lexical when clear, a model in between) precision 0.900, recall 0.818, 0.7
calls per case, now the reflex default; `lexicon-then-llm` (affect) accuracy 0.817, emotion precision 0.692 and recall 0.931, no better
than `lexicon`, which stays the default; `SchemaOrDirect` acme 36/40 (it chose SchemaGuidedLLM, the memory has a reviewed schema);
`EnsembleOneShot` acme 37/40, the answers of DirectSOP (both from Ploinky's cache, so their latency is not measured). Also added:
`judge-on-doubt` (roundtrip), `natural-if-foreign` (voice), `cross-engine` (verify: a second installed engine, refereed by the oracle).
Profiles: acme-demo, general and support-bot formalize with DirectSOP, rigorous-judge with Ensemble.
