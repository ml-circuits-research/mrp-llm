# 15a-budget-partial-answers

**Reasoning feature exercised:** Budget exhaustion: a partial result says it is partial.

A chain of 12 edges and a budget of 3 fixpoint rounds. The engine must stop, report complete false, and return only answers that are really true (a subset of the 12). A silent short list marked complete is the failure this case guards against.

**Expected answer:** complete false; rows are a non-empty subset of n1..n12; status supported or budget_exhausted.

**Needs:** rules, recursion, budget.
