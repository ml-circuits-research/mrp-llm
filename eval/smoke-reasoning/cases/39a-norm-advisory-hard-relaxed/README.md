# 39a-norm-advisory-hard-relaxed

**Reasoning feature exercised:** The severity x binding matrix: `severity` says what a violation does (hard: the plan is invalid; soft: a cost), `binding` says whether the engine may relax the norm when it would otherwise block (strict never, advisory may).

The only way to fix m1 is the forbidden `force_fix`. The norm is hard and advisory, so the engine relaxes it because the goal is otherwise blocked, returns the plan and lists the norm in `relaxed`; with `binding strict` the answer would be `blocked`, `blocked_by [no_force]` (case 30b is the strict form). `binding` on a soft norm is vacuous (a soft norm never blocks) and the validator warns `binding_on_soft_norm`.

**Expected answer:** plan_found force_fix (cost 2), relaxed [no_force]

**Needs:** plan, norms_hard, binding_advisory, used.
