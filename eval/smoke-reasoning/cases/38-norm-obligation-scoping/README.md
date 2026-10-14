# 38-norm-obligation-scoping

**Reasoning feature exercised:** Norm obligations are instantiated per trigger, not per row of memory (review round 2, SHOULD-FIX 1).

Two incidents are in memory, the goal is `resolved i1`. The obligation `oblige ~log_incident ?i when incident ?i within 3` is triggered at the first step where `when` holds for a binding bound by the goal's arguments (i1) or by an executed action; i2 is never bound, so no instance for i2 exists and its unmet logging costs nothing. The cheapest legal plan investigates, patches and logs i1 (cost 5); the alternative of skipping the log costs 4 plus the violation 10. A standing obligation (the marker line `standing`, applied to every binding of the `when`) gets the packet note `obligation_unscoped` and the validator warning of the same name; a variable that no `when` atom binds is the validator error `unsafe_variable`.

**Expected answer:** plan_found, cost 5, 3 steps, one obligation instance (log_promptly i1), no violation

**Needs:** plan, norms_soft, temporal_norms, used.
