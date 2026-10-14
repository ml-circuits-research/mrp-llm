# 63-abduction-all-minimal-equal-cost

**Reasoning feature exercised:** Abduction returns ALL inclusion-minimal explanations of an observation, not the cheapest one: here two explanations of the same cost 1 (a smoke sighting, a running drill) and a costlier one that needs two hypotheses together (heat and motion). The hypothesis `smoke_seen hall` explains nothing about the lab and must not appear.

In ASP the explanations come from a choice rule over the hypotheses, the observation as a constraint, `#minimize` over the number of chosen hypotheses and an iteration that blocks every superset of an explanation already found (so each model is inclusion-minimal and none is missed); in Z3 from a Boolean per hypothesis with `minimize` and the same blocking. The oracle searches subsets by increasing size. Explanations are hypotheses, never facts.

**Expected answer:** status hypotheses: {smoke_seen lab}, {drill_running lab}, {heat_high lab, motion_seen lab}.

**Needs:** rules, abduce.
