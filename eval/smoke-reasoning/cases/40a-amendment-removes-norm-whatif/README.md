# 40a-amendment-removes-norm-whatif

**Reasoning feature exercised:** An `amendment` with `removes` (case 36 is the amendment with `members`): supposing it takes the named wire out of force, so the what-if answers "what would the plan be if the prohibition were lifted".

The approved strict method lets the engine choose between the soft and the hard reset; the approved prohibition forbids the hard reset in business hours. The amendment `am_rm` proposes to remove the prohibition. With `if $am_rm` the prohibition does not bind, the cheaper hard reset becomes legal (cost 3 against 5) and the answer is conditional on the amendment. Without the supposition the answer is that of case 30a.

**Expected answer:** plan_found with notify_oncall, hard_reset, verify_link (cost 3), conditional on am_rm.

**Needs:** plan, method, htn_choice, norms_hard, whatif, versions, amendment, zero_arity.
