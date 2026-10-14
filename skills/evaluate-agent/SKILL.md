---
name: evaluate-agent
description: Audit the complete ChatSOP experiment: circuits written by the coding agent, execution through the StrategyRouter, and comparison with small LLMs
---

# Evaluating the agent experiment

Read `eval/README.md`, [DS012](../../docs/specs/DS012-evaluation-metrics.md) (one definition per metric), [DS007](../../docs/specs/DS007-experiment-preregistration.md) (what is frozen before a holdout is used) and [DS014](../../docs/specs/DS014-model-surface.md) (the circuit language), and the benchmark plan `experiments/proposal/symbolic-vs-llm-benchmark.md`. The server's `/eval` page and its guide at `/eval/guide` show the suites and reports this skill produces. Keep the two evaluation tracks distinct.

## 1. Circuit authoring (track `authoring`)

- **Input:** the user's message and the memory vocabulary only. The evaluator sends the coding agent nothing else: no answers, gold, sealed tests, other sessions or clock.
- **Eligible output:** `query`, `constraint`, `unclear`, `unparsed` and `assumed` session definitions; never an answer or a fact. The validator (`lib/query-author/validate.mjs`) admits the rest.
- **Suites:** the query-forms dev set (`tools/eval/formalization/query-forms`) and the sealed KBQA suites (`eval/suites/kbqa-*`), each scored once per selected tier (`--tier tiny|small|medium|good`; the tier answers the same step-by-step questions). The one-shot calibration of candidate models is archived (`probably_obsolete/one-shot-formalization/tools/eval/query-model-calibration/`).
- **What to measure:** valid circuits; correct execution against the oracle on the gold slice; **wrong** (a definite answer different from the gold) versus honest unknown (`unclear`, `parse_unavailable`, `unknown`); failure attribution by layer (authoring, linking, retrieval, engine, rendering); latency and cost per question.

## 2. The complete ChatSOP system (track `system`)

Use independent dialogues with new information, questions, explanations, corrections, past events, missing data and ambiguity; check user isolation too. Evaluate linking and clarification, memory, reasoning, approved procedures (including coding-agent-supplied `jsEval` in trusted circuits), the observed route and backend, time, provenance and the end-to-end result and latency. A formalized problem without an engine is answered `not_computable` with the formalization shown; count it separately from wrong answers. `unsupported` is only an explicitly requested, unavailable backend (AGENTS.md direction 3): a missing backend is a skipped test, never a passed one.

## 3. Reporting

For every report name the track, the suite and its checksum, the model or system configuration and the backend actually observed. Give each metric's numerator and denominator: eligible, attempted, missing or invalid, `unclear`, `not_computable`, `parse_unavailable` and operational exclusions. Break results down by task family, size, depth and question type. Preserve raw outputs. Fresh results go to `eval/reports/current/`; archived numbers stay in `eval/reports/history/` and are never presented as a current run. For a superiority claim, compare the systems on the same evidence with equivalent tool and memory access, with a paired bootstrap interval and the preregistered practical margin.

Log each evaluation with `node tools/journal.mjs add --area eval …` and record the arm in `status/experiments.json`. Also record each evaluation's numbers, slices and validity findings as a topic note: `node tools/notes.mjs add --topic evaluation --kind <result|observation|analysis> --title "…" --body "…" --link <report>`. Notes are append-only; a corrected number gets a new note with `--supersedes <note id>`. The `/experiments` pages are the living index.
