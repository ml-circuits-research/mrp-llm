# 42b-until-max-exhausted

**Reasoning feature exercised:** Unbounded loops are not expressible (8.2): every loop has a `max`, and a cap hit gives `budget_exhausted`, never a plan and never `no_plan`.

Dialing never connects (no action adds `connected`), so the loop runs its three passes and stops with the condition still false. The engine cannot tell whether a fourth pass would have helped, so the answer is `budget_exhausted` with reason `depth`, `complete: false`.

**Expected answer:** budget_exhausted, reason depth, complete false.

**Needs:** plan, method, budget.
