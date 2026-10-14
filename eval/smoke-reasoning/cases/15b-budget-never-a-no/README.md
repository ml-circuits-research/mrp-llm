# 15b-budget-never-a-no

**Reasoning feature exercised:** Budget exhaustion: running out of budget is never a negative answer.

n12 is reachable from n0 through 12 edges but the budget allows 3 rounds. The engine may not answer unknown or refuted for a claim it merely failed to reach: it must answer budget_exhausted (or find the proof and say supported).

**Expected answer:** budget_exhausted when incomplete; supported only if complete.

**Needs:** rules, recursion, budget.
