---
title: DS012-evaluation-metrics
summary: Generic evaluation obligations (sealed tests, lexically disjoint variants, leakage guard, staged early stopping, intervals) and the metrics of the symbolic-versus-LLM benchmark.
---

# Evaluation metrics

## Scope

This specification defines how ChatSOP results are measured and reported: the obligations that every evaluation meets, and one definition per metric of the benchmark that compares symbolic reasoning with small language models (plan: `experiments/proposal/symbolic-vs-llm-benchmark.md`). The evaluation of the frozen tiny-model branch (formalizer, proofing and analysis metrics, the clean-English score, the wild and natural suites) is archived with its code and reports in `probably_obsolete/tinyLLMExperiments/` (specification `probably_obsolete/tinyLLMExperiments/specs/DS008-data-evaluation.md`); none of it is a current metric. Evaluation is an engineering check: it supports a claim only for the forms the system was built on, with different words.

## Evaluation obligations

1. **Sealed tests.** Authoritative sealed test exports live under `eval/suites/<name>/test.jsonl` (today `kbqa-mintaka`, `kbqa-lcquad2`, `kbqa-qald10`, `kbqa-simplequestions` and `linking-v1`). Development and selection data are separate files. A generator or a prompt tuner never reads a sealed test file; `eval/leakage.mjs` (`auditTrainingSelection`, `auditSourceBoundary`, `auditSealedTests`) is the mechanical guard.
2. **Lexically disjoint variants.** The only generalization tested is the same question form with different words. Every form of a sealed set has development cases of the same form with different content words (fresh entity and predicate names, `tools/datasets/diversity/names.mjs`). `tools/datasets/audit/content-word-overlap.mjs` fails closed on an exact or normalized duplicate and on a lexical duplicate (identical content words and identical form); `tools/eval/formalization/query-forms/overlap.mjs` does the same for the query-forms set. No claim is made about forms the system was not built on.
3. **Staged evaluation with early stopping.** A run proceeds in nested stratified stages (100, 300, the full set) with a paired bootstrap interval after each stage. It stops when the interval is decisive in the preregistered direction by a practically relevant margin, when a useful gain is impossible (futility), or when the condition is broken (more than 20% empty, unparsable or `parser_failed` outputs among the first 100 rows). Every stop is recorded with its stage, numbers and reason in the journal, the topic notes and the experiment record. The stopping rules are written in the preregistration ([DS007](specsLoader.html?spec=DS007-experiment-preregistration.md)) or recorded as a deviation.
4. **Intervals.** Every rate is reported with numerator, denominator and a Wilson 95% interval (`wilson` in `tools/eval/symbolic-vs-llm/score.mjs`, `tools/eval/kbqa/report.mjs` and `tools/eval/lib/severity/metrics.mjs`). A difference between two arms on the same questions is a paired bootstrap of the per-question difference in percentage points, 10,000 resamples with a fixed seed (`pairedBootstrap` in `tools/eval/kbqa/report.mjs`).
5. **Observations versus history.** `eval/reports/current/` holds regenerable observations and `eval/reports/history/` archived numbers; a historical number is never presented as a current run. A report names the system versions, prompt hashes (`context.version` of `lib/query-author`), memory versions and seeds that produced it.
7. **No capability loss (owner request 2026-10-02).** The capability battery guards what the language and the engines can do. `tools/capabilities/inventory.mjs` derives the capability list mechanically from the grammar tables, `sop/enums.mjs`, the model-surface parser, the validators' problem codes and the strategy features, with the meaningful pairwise combinations (`eval/capabilities/capabilities.json`, regenerated with `--write`; `tests/reasoning/capability-battery.test.mjs` fails when it is stale). `tools/capabilities/coverage.mjs` counts the circuits that exercise each cell by parsing the circuits the tests parse (`--capture` records them through `lib/circuit-capture.mjs`), the smoke cases, the wire-help examples, the formalization regression runs and the battery itself. The battery has three layers: L1, validation cases generated per wire type, keyword, enum value and condition word, plus hand-written cases for validator codes (`eval/capabilities/l1-cases.json`), and the converter cases of the FOL path (`eval/capabilities/fol-cases.json`, `tools/capabilities/l1-fol.mjs`): fixed fol-v3 lines of invented problems read by the FOL reader, lowered by the converters and executed on the product route without any model, one capability per line form (`SUPPOSE`, `ASSUME`), support question (Effect, Explain, Missing, Why, Change, Assumed) and effect class, each answer checked by kind, status, value and detail; L2, small programs from a seeded all-pairs covering array over the language constructs and a sweep of every compute word, run on the js-reference oracle and every engine, where each engine must agree with the oracle or refuse honestly (`not_expressible`, `unsupported`, a budget stop), with three metamorphic relations: an irrelevant predicate added, entities renamed, a rule split through an auxiliary relation; L3, a catalog of invented messages, each needing one capability and scored by answer (`eval/capabilities/l3/catalog.jsonl`). The ledger `eval/capabilities/ledger.json` records per case, per program and engine, and per capability what passes. `tools/capabilities/check.mjs` fails when something that passed in the ledger no longer passes, or when an engine gives a new answer that differs from the oracle. The fast tier (L1 and about 290 programs, about 30 s) runs in `npm test` and `npm run verify`; the full tier (`--tier full`, about 2,500 programs) refreshes the ledger with `--update`. A lower ledger needs `--accept-loss "<reason>"`, which writes a journal entry.
6. **No substitution.** A requested backend or model is never replaced silently; an unavailable one is reported as unavailable ([DS006](specsLoader.html?spec=DS006-reasoning.md) "Strategy × backend matrix").

## Answer classes

Each question of a benchmark has a gold answer from an independent source: the construction of a generated instance, the JS reference oracle on the same slice, or a public benchmark's gold. A system answer is classified as:

| Class | Meaning |
| --- | --- |
| `correct` | A definite answer equal to the gold (answer tuples compared as sets; the epistemic status agrees, `eval/contracts.mjs` `epistemicResult`). |
| `wrong` | A definite answer different from the gold. This is the dangerous class and is always reported beside accuracy. |
| `unknown` | An honest non-answer: `unknown`, `incomplete`, `clarify`, `unclear`, `not_computable`, `budget_exhausted`. Honest unknown on an answerable question costs accuracy but is not `wrong`. |
| `invalid` / `failed` | The circuit was rejected by the validator after the repair rounds, or the author, engine or oracle failed (timeout, unavailable). |

## Definitions

| Metric | Definition |
| --- | --- |
| `accuracy` | `correct` / questions, with a Wilson interval. |
| `wrong_rate` | `wrong` / questions; `wrong_among_answered` = `wrong` / (`correct` + `wrong`). |
| `unknown_rate` | `unknown` / answerable questions (calibrated abstention: a low `wrong_among_answered` with a moderate `unknown_rate`). |
| `invalid_rate` | `invalid` + `failed` / questions. |
| `verified_correct` | `correct` answers whose route carries `route.verification` (the oracle replayed the answer); for language-model arms, answers replayed with `reasoning/strategies/llm-agent/verify.mjs` (re-derivation of the cited facts). |
| `proof_validity` | Answers with a proof that replays / answers with a proof. |
| `latency_ms` | p50, p95 and maximum wall time per question, split into authoring (parse), retrieval, engine and verification. A local model is also reported in tokens per second; CPU timing uses a sample of about 20 questions. |
| `cost_usd` | Cost per 100 questions from the Ploinky Workers usage (`cost_usd` of the parse record); a local model costs 0 and reports its tokens. |
| `scaling_curve` | `accuracy` and `wrong_rate` against the number of facts (10^2 to 10^6) and against rule or hop depth (1 to 10), per arm. |
| `practical_margin` | Arm B beats arm A when the paired-bootstrap 95% lower bound of (B - A) accuracy is above 0, the point estimate is at least 10 percentage points and B's `wrong_rate` is at most A's plus 2 points. |
| `failure_layer` | Each non-correct symbolic row is attributed to one layer: `authoring` (invalid or unclear circuit, or a circuit whose execution differs from the gold circuit on the same slice), `linking` (`unknown_predicate`, `entity_id_not_listed`, candidate recall miss), `retrieval` (`partial_retrieval`), `engine` or `rendering`. Layers are mutually exclusive; the first failing layer in pipeline order is recorded (`failureLayer` in `tools/eval/symbolic-vs-llm/score.mjs`). Direct-answer arms have no symbolic engine: valid wrong answers or abstentions are `reasoning`, malformed answer packets are `rendering`, and unavailable transports are `transport`. |
| `retrieval_recall` | Gold predicates and entities present in the candidate list offered to the author / gold predicates and entities (the `retrieval` record of a formalization: `lib/query-author/retrieval.mjs`). |
| `proof_retrieval` | Observed fact ids cited by the system's proof that are in the gold proof / cited ids (precision), and gold ids cited / gold ids (recall); this is evidence retrieval against the gold execution, not recall over all relevant stored facts. |
| `route_observed` | Counts of executed strategy, backend and fallback as the result packet reports them; a route is observed, never inferred from the requested configuration. |

`eval/contracts.mjs` supplies `epistemicResult`, `fraction` and `distribution`. The benchmark entry points are `tools/eval/symbolic-vs-llm/{run,score,report}.mjs`: five arms A, A', B, C and D, nested size/depth/form-stratified stages 100/300/600, strict smoke-packet comparison and the KBQA paired-bootstrap implementation with 10,000 resamples. The harness refuses sealed execution until the preregistration is frozen. Gold evidence is the final product slice reconstructed through `SliceRetrieval`; membership counts and oracle replay must agree before any model runs. Evidence above 90,000 characters becomes a keyed sample of at most 450 facts, explicitly not complete, and `evidence_does_not_fit` is reported separately from reasoning comparisons. A dev pilot is labelled sanity only. Every row records actual cost, tokens, timings, author context version, observed route, verification and the first failing pipeline layer.

The exploratory one-shot variants `B-grammar` and `B-structured` (and the one-shot arms `B` and `B-local`) are archived with LLMDirect in `probably_obsolete/one-shot-formalization/` (2026-10-02); the comparison arms of the symbolic-versus-LLM harness are now `A` and `B-stepbystep`, and arm `C` is the same step-by-step protocol answered by a named tier (`--tier`). What follows describes the archived variants: they constrained the completion decoder as specified then, without changing scoring, validation or symbolic execution. Their question-level wall/output-token ceilings are shared across repair rounds, and family reports retain correct, dangerous wrong, unknown, invalid and failed denominators, latency, tokens, Wilson intervals and paired-bootstrap comparisons against A and B. Compiler refusal remains failed rather than being disguised as correct syntax or unknown. The harness rejects these variants on non-development inputs: appending a dev deviation does not change the frozen sealed arm contract. Reused baseline outputs retain their original run identity and runtime provenance; matched questions alone do not establish a same-runtime ablation. A stratified 30-row pilot does not extrapolate the first-100 stopping rule and supports no superiority claim.

Controlled development-only format/restriction/steps comparisons use the same request-local schema and admitted semantic subset in DS014. Report per-step model-call latency and tokens, prompt-processing and generation timings separately from end-to-end wall time, repair rounds, symbolic execution and verification. Native generation tokens/s is not output tokens divided by total model-call wall time: the latter includes prompt processing and is labelled effective throughput. Time-to-first-token is measured from a streamed request to its first nonempty generated token, not an HTTP header. Serial requests/minute projections are the inverse measured mean end-to-end latency, include branch-specific two/three-step protocols and repairs, and never imply batching or concurrency. Architecture-load failure is unavailable, not a measured quality result; retained reference runs keep their original provenance, and memory-hash mismatches are disclosed or excluded from paired claims.

At the first 100-row stage, `broken_model_output` identifies successful but empty circuit/answer output or a syntactically unparsable circuit/answer, not a semantic validator refusal, unavailable transport or engine failure. `parse_ok`, `response_empty` and compact author diagnostics preserve that distinction. More than 20 such rows drops the arm; the count, denominator and reason are recorded for dev pilots as well as sealed runs. A smaller subscription reference sample does not trigger or extrapolate the first-100 rule. Paired comparisons key by family and instance, never by an unqualified instance identifier. An incomplete supported packet is an honest unknown, not a correct full answer.

An authored query rejected for an unbound projection (`select_unbound`) is attributed to `authoring`, even if surface validation passed. It is an invalid circuit, not a solver discrepancy; the exception and failed outcome remain visible.

Run provenance pins the executable source and author-guide hashes before model calls, without reading sealed cases or session data. Reports expose accuracy and verified-correct separately, all outcome denominators, latency and reported usage-based USD per 100, not an invoice or additional subscription charge. A subscription service identity is not a weight-file attestation.

## Epistemic diagnostics

These diagnostics apply to any arm whose answers carry an epistemic status (`eval/contracts.mjs` `STATUS_DECISIONS`):

| Metric | Definition |
| --- | --- |
| `unknown_recall`, `false_unknown_rate` | Predicted unknown / gold-unknown rows; predicted unknown / other rows. Discrete diagnostics, not probability calibration. |
| `contradictions_preserved` | A conflicted gold (`both`) answered as conflict, never resolved into one side. |
| `over_inference` | A definite answer where the gold is unknown or conflict; counts unsupported certainty. |
| `provenance_presence` | Answer evidence that points to proof entries: observed entries have source and quote, derived entries have a rule and present `from` ids. |
| `unauthorized_writes` | Successful runs that changed session or repository state beyond what the request allows; a read never hides a write ([DS005](specsLoader.html?spec=DS005-memory.md)). |

## Graded severity

When an answer or a rendering is compared with a packet or a gold by a judge, the verdict is graded S0 to S4 (S4 an answer that contradicts the evidence) or NONE. The scale, the mechanical comparison and the Wilson metrics are in `tools/eval/lib/severity/` (`scale.mjs`, `mechanical.mjs`, `metrics.mjs`). Reported: the severity distribution, the recall of S4 and the false-S4 rate against a labelled sample, with intervals. The faithfulness of an optionally formulated final answer is measured this way: the severity of the rendered answer against the result packet. A judge is calibrated against labelled rows before its verdicts count, and a strict score is never replaced by a lenient one.

## Reference-free checks

A circuit, an answer or a rendering can be checked against its message and packet without a gold: the validator's admission (`lib/query-author/validate.mjs`), the oracle replay of an answer (`route.verification`) and the no-hidden-write check. They are reported as flags per row and never replace a gold-based score.

## Scope of the current sanity checks

A passing sanity check on finite worlds is never universal equivalence; a benchmark win on generated families is not a claim about natural questions. Natural-language KBQA (the four sealed `kbqa-*` suites) is measured once per stage through the coding-agent path, never tuned on, and reported separately from the synthetic families.
