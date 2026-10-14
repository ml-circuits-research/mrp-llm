# 90-every-grouped-select

**Reasoning feature exercised:** Quantifiers: every with a grouping `select` (DS014 "Which teams have only certified players?").

`mode every` with `select ?t` decides the universal per group of the selected variable: rapid has only certified players, united has di, who is not certified, and `certified` is closed, so di is a counterexample for united. The answer is the set of groups where the universal holds (`rows`), not one verdict over every player. Until 2026-10-01 the oracle ignored the grouping and answered `refuted` because of di.
