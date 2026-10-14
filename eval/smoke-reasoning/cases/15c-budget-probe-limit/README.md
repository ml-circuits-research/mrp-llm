# 15c-budget-probe-limit

**Reasoning feature exercised:** Budget exhaustion: a probe (candidate row) ceiling, reported as incomplete.

Same chain as 15a but the ceiling is on candidate probes (the work counter of the join engines), not on fixpoint rounds. An engine whose counter runs out must report an incomplete result. Some engines expose no partial rows (they answer budget_exhausted with none); that is acceptable, a wrong or complete-looking short list is not.

**Expected answer:** complete false; rows (if any) are a subset of n1..n12; status supported or budget_exhausted.

**Needs:** rules, recursion, budget_probes.
