# 47b-oblige-after-follow-up

**Reasoning feature exercised:** `oblige ... after ~b` (8.2 table): "a required follow-up". The instance for s1 is triggered by the goal (s1 is its argument); after the deploy step the announcement must occur at a later step.

Deploying alone reaches the goal but leaves the hard obligation unmet at the end of the run, which is a violation, so the plan is deploy, announce (cost 2). A soft obligation would only cost.

**Expected answer:** plan_found deploy, announce (cost 2), obligation instance announce_after s1.

**Needs:** plan, norms_hard, temporal_norms, used.
