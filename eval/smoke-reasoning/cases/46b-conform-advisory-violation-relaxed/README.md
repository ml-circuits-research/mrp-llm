# 46b-conform-advisory-violation-relaxed

**Reasoning feature exercised:** The audit side of `binding advisory` (8.4): the trace forces a stop under load, which `no_force` discourages. The norm is hard but advisory, so the violation is listed in `relaxed` and `compliance.hard` is `relaxed`, and the trace is still `compliant`; the trace follows the strict restart method (the forced stop is one of its two alternatives), so there is no deviation either.

**Expected answer:** compliant, relaxed [no_force], total cost 3.

**Needs:** check_plan, norms_hard, binding_advisory, method, zero_arity.
