# 30a-router-reset-plan-under-norms

**Reasoning feature exercised:** Mode of work: a strict method with a choice, a hard prohibition and a soft obligation; the plan is the cheapest legal run.

The approved method (version 2, strict) says: notify on-call, then reset softly or hard, then verify. The hard prohibition applies during business hours, so the engine may choose only the soft reset even though the hard reset is cheaper; the soft obligation to notify within 10 steps is met. The superseded version 1 and the proposed amendment do not bind. The engine optimises only at the choice point and may not plan from primitives (binding strict).

**Expected answer:** plan_found with notify_oncall, soft_reset, verify_link (cost 5, norms hard ok, nothing violated), used lists the method and the two norms in force with their versions.

**Needs:** plan, method, htn_choice, norms_hard, norms_soft, temporal_norms, procedures, used, zero_arity.
