# 49a-horizon-cut-is-budget

**Reasoning feature exercised:** The bounded-engine negative of section 6: the robot needs four moves to reach e, the policy allows plans of at most three steps. Nothing in the model forbids the goal, so `no_plan` would be a wrong answer about the theory; the engine reports `budget_exhausted`, reason `horizon`, `complete: false`.

**Expected answer:** budget_exhausted, reason horizon, complete false.

**Needs:** plan, budget.
