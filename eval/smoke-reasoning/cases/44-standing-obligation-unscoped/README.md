# 44-standing-obligation-unscoped

**Reasoning feature exercised:** The `standing` marker (8.2, "Obligation triggers and scoping"): the one way to oblige a whole predicate. Case 38 is the default, scoped form (only the incident the goal concerns); here the author wrote `standing`, so the host applies the duty to every incident and reports `obligation_unscoped`.

Two incidents are in memory and the goal is `resolved i1`. Every incident must be logged within four steps (soft, cost 10 each). Resolving i1 costs 4; logging both incidents costs 2 more (cost 6, four steps), against a violation of 10 for each unlogged one, so the cheapest plan logs both. The validator warns `obligation_unscoped` on the marker, as the case declares.

**Expected answer:** plan_found, cost 6, 4 steps, obligations_triggered [log_all i1, log_all i2], obligation_unscoped [log_all].

**Needs:** plan, norms_soft, temporal_norms, used.
