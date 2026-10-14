# 33-norm-obligation-soft-unmet

**Reasoning feature exercised:** Norm with a deadline: a soft obligation that cannot be met is reported as a violation with its cost, the plan is still returned.

Every incident must be logged within two steps, but the logbook is closed, so the logging action can never run. The obligation is soft: the plan to resolve the incident is still returned, and the violation is derived and reported with its cost (10), added to the plan cost (4). A hard obligation here would give blocked, not a plan.

**Expected answer:** plan_found with investigate, patch (cost 4), soft violation log_promptly cost 10, total cost 14.

**Needs:** plan, norms_soft, temporal_norms.
