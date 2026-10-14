# 47a-forbid-before-qualifier

**Reasoning feature exercised:** The temporal qualifier `before ~b` on a prohibition (8.2 table): `forbid ~deploy ?s` + `before ~test` is violated at a deploy step with no earlier test step.

The goal needs only the deploy (cost 1), but the hard norm prunes a deploy that is not preceded by a test, so the plan is test, deploy (cost 3).

**Expected answer:** plan_found test, deploy (cost 3), used test_first.

**Needs:** plan, norms_hard, temporal_norms, used.
