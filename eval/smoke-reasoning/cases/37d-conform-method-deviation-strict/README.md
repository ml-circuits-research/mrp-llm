# 37d-conform-method-deviation-strict

**Reasoning feature exercised:** Method deviation in conformance (review round 2, SHOULD-FIX 5).

The trace satisfies every norm (it notifies first, does not hard reset) but inserts a step, `extra_check`, that the strict method reset_router does not allow. Under `binding strict` a run that leaves the method is non-compliant and the method is reported in `compliance.deviations`; under `binding advisory` the same trace is compliant and the deviations are only reported. Total cost 6 (1 + 3 + 1 + 1).

**Expected answer:** non_compliant, deviations [reset_router], hard norms ok, total cost 6

**Needs:** check_plan, norms_hard, norms_soft, method, conform_deviation, zero_arity.
