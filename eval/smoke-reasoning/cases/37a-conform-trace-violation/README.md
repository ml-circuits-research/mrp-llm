# 37a-conform-trace-violation

**Reasoning feature exercised:** Mode of work: conformance checking of a performed trace against the procedures and norms in force.

The same wires serve audit as well as planning. The trace follows the method (the hard reset is one of the allowed alternatives) and notifies in time, but it hard-resets during business hours.

**Expected answer:** status non_compliant; the hard norm no_hard_reset_in_hours is violated; no soft violations; total cost 3.

**Needs:** check_plan, norms_hard, norms_soft, method, zero_arity.
