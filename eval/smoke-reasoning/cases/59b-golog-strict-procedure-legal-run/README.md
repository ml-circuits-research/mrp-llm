# 59b-golog-strict-procedure-legal-run

**Reasoning feature exercised:** The compliant counterpart of 59a: the same strict procedure, a trace that is one legal run of it.

The trace backs up, runs the canary (the branch the true test requires), rolls out blue (one of the two choices) and announces within the deadline. The method is engaged by the trace, the program recognises the whole scope as one run, no norm is violated.

**Expected answer:** compliant; hard norms ok, no deviations, no soft violations, total cost 1 + 2 + 3 + 1 = 7.

**Needs:** check_plan, norms_soft, temporal_norms, method, conform_deviation, used, zero_arity.
