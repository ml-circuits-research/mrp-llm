# 94-compute-minimum-maximum

**Reasoning feature exercised:** the compute words `minimum_with` and `maximum_with` (the smaller or the larger of two values) inside rule bodies, chained and over decimals.

Four serial stage capacities (170, 140, 100, 130.5): the throughput is the smallest, 100 (three chained `minimum_with`). Raising stage c by 30% (130) makes the bottleneck min(170, 140, 130, 130.5) = 130. Two parallel branches of 12.5 and 17 minutes join after the longer one, plus 5: 22. The extra capacity needed for c to reach b is max(100 - 140, 0) = 0, a floor at zero. Book problems that need these: bottlenecks of serial stages, critical paths of parallel branches, "additional units needed" that cannot be negative (eval/reports/current/books-triage, 11 of 109 step-by-step formula answers wrote min/max).

**Expected answer:** rows as in `expected.json` (derived by hand, confirmed by the oracle).

**Needs:** rules, compute_in_rules, exact_arithmetic.
