# 67-aggregates-with-groups

**Reasoning feature exercised:** three aggregates over the same `over` group with the same `group ?d`: a sum, a maximum and a count, each yielding its own relation, joined by one query.

Rows of `over` are the distinct bindings of all its variables, so two people with the same salary both count in the sum and in the count (set semantics over the person, not over the value). The count groups are projected from the rows: a department with no row has no group. `bench/datalog-scale.mjs` `groupAggregates` builds the same circuit with 10^5 salaries.

**Expected answer:** dev: total 310, maximum 120, size 3; ops: total 175, maximum 95, size 2; lab: total 100, maximum 50, size 2 (two people earn 50 each: both count, because the rows are the distinct (person, salary) bindings).

**Needs:** aggregate.
