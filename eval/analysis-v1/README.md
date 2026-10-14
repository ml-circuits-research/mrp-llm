# analysis-v1: a test set for analysis procedures

This is the test set for the analysis procedures of DS022 "Analysis procedures" (`lib/analysis`, the library `config/knowledge/analysis-core-v1/`, docs `docs/analysis.html`).

**Rights.** All eight documents were written for this project by the analysis-procedures agent on 2026-10-03. They are fictional: the companies, people, products, trials and figures are invented, and no third-party text was copied. Their rights are `owner-provided` (project-authored text under the repository licence, DS011), which is the value the end-to-end run passes to ingestion.

## Contents

| Document | Kind | Planted issues | KPIs |
| --- | --- | --- | --- |
| `northwind-annual-2025` | business report | breakdown does not add up, shares sum to 96, "no debt" against a loan and the rule that a loan is debt, a claim on an unstated order book | 3 shares, growth, average, net margin |
| `hx200-pump-manual` | technical manual | rated pressure above the stated maximum, two weights, "never run dry" against "may run dry", 112% efficiency | 2 shares, average |
| `statin-trial-abstract` | scientific abstract | groups exceed the enrolled total, trial ends before it starts, oldest patient outside the eligible ages, a conclusion on unreported mortality | 2 shares, average, response ratio |
| `meridian-leave-policy` | policy | 50% of 25 days stated as 15, a contractor who is also an employee, approval dated before the request | none |
| `ada-brennan-biography` | book excerpt | two ages that do not match the birth years, an age of 141, "never married" against a husband, an institute dissolved before it was founded | none |
| `orion-project-status` | project status report | budget lines do not add up, phase order against the dates, progress 135% | 3 shares, average, budget burn |
| `kiln-lab-note` | lab note | two start dates, -300 °C, a part in grams in a sample in kilograms, the parts exceed the total because of that unit slip | none (mixed units) |
| `harbor-supplies-budget` | budget (control) | none | 3 shares, growth, average |

There are 27 planted findings and 23 KPI values in total. The rubric score of each document is given too.

- `documents/<doc>.md`: the documents.
- `sop/<doc>.sop`: the hand-written SOP of each document. This is the document layer an ideal ingestion would write: facts with `quote` (words of the document) and `source` (document and line), dates as the integer YYYYMMDD.
- `sop/<doc>.request.sop`: the analysis request of a document, when there is one. It is a domain procedure written as data (a ratio KPI) that reuses the library's ratio rule.
- `truth.json`: the ground truth. For each planted issue it gives `{rule, witness, lines}` (the integrity wire that must fire, its witness in the hand-written SOP, and the document lines involved). It also gives the KPI values and the rubric score.

## Levels and how to run them

- **(a) The procedures in isolation:** `node tools/eval/analysis/run.mjs`. This runs the hand-written SOP over analysis-core-v1. A finding matches a planted issue by `{rule, witness}`. The same check is the last test of `tests/analysis/analysis.test.mjs`. The procedures were written together with this set, so level (a) checks coverage and correctness. It does not show that the procedures generalise to new documents.
- **(b) End to end:** run the task template `analyze-document` once per document (`pworker task --template analyze-document ...`). Each run ingests the document with ingestion v2 into a new session on analysis-core-v1, then analyses it. Then run `node tools/eval/analysis/run.mjs --mode analyses --dir <dir with <doc>/analysis.json>`. The ingested symbols are the ingestion's own, so a finding matches a planted issue by its rule (strict) or by its procedure (family), and by the document lines of its evidence. KPIs are not scored at this level.

Reports are written to `eval/reports/current/analysis/<mode>.json`, which is regenerable and gitignored.

## Results

### Level (a), 2026-10-03

All 8 documents: 27 of 27 planted issues found and 0 spurious findings (precision 1, recall 1). 23 of 23 KPI values are correct and 8 of 8 rubric scores are correct. 169 of 169 evidence quotes are words of the document at the line they name. The router kept every query on the oracle. With `--reasoning prolog-tabling` the results are the same on the two documents tried. With `sql-sqlite`, `datalog-souffle` and `asp-clingo` most queries are `not_expressible`, because these engines decline the library's decimal divisions. The report lists those queries and leaves their findings out; it never substitutes another engine.

### Level (b), 2026-10-03, stage 1 (4 of 8 documents), stopped

This stage ran the `analyze-document` template, one task per document, with target `none`. Each task ingested the document with ingestion v2 into a new session on analysis-core-v1, using tier `small` for the structure role and `medium` with reasoning for the FOL role and the merge, and then analysed it. It covered four documents with 15 planted issues: northwind, hx200, statin and orion. 2 of the 15 were found, both with the right rule, and there were 4 spurious findings: precision 0.33 and recall 0.13 (bootstrap interval of the recall over documents 0 to 0.29). All 41 evidence quotes are words of the document at the line they name. Orion's phase order against its dates was found end to end, and so was statin's trial that ends before it starts. Orion's three budget shares (52%, 24%, 18%) came out right under the ingestion's own names. The four ingestions made 14 calls (6 small, 8 medium) and cost 6.6 openference credits.

**Why the numbers are low.** The procedures fired correctly on every wire the ingestion wrote. The misses and the spurious findings come from how the documents were formalized:

1. The converter's group repair, which handles statements a document makes about a group, distributed statements about a whole to its parts. "Total revenue was 12.4" became `amount ?x 12.4` for every component of total revenue, and the pump's weight became the weight of its motor and its controller. This produced the three spurious value conflicts of northwind and hid the totals.
2. Ingestion wrote document-specific predicates with the unit in the name (`weight_kg`, `max_operating_pressure_bar`, `rated_continuous_pressure_bar`) where the library vocabulary would have served (`amount`, `unit_of`, `upper_limit`). It declared no `key`. A stated limit and a value were therefore never compared, and two weights were never seen as a conflict.
3. Negations and conditions became separate predicates (`prohibited_dry_run`, `allowed_dry_run_duration_min`) instead of `not` on one atom. "A loan is debt" became the fact `implies bank_loan debt` instead of a rule. Shares were written as fractions (0.49) instead of percentages.
4. Claims became facts (`expects_growth`, status reported) without `claim_rests_on`.

**Stop.** After four documents the answer was clear: end to end, the document's formalization is the bottleneck, not the procedures. In the same hour the job runner moved into `Ploinky-Worker/lib/jobs/` and ingestion v2 lost an import, so the other four tasks could not start. They were not retried. The ingestion gaps are reported to the ingestion v2 work in `TODO.md`. Rerun level (b) on all eight documents once ingestion v2 writes the library's vocabulary.
