# 40b-amendment-tightens-blocked

**Reasoning feature exercised:** A what-if over an amendment that adds a prohibition: the host shows the delta before anyone approves it (8.5 step 3), here that the change would leave no legal reset.

Both alternatives of the strict method are now forbidden in business hours: the approved prohibition of the hard reset and the proposed prohibition of the soft reset, which `if $am_tight` supposes. The answer is `blocked`; the norms to waive are the union of the minimal sets, each of which alone unblocks the plan (`no_hard_reset_in_hours` alone, or `no_soft_reset_in_hours` alone). The answer is conditional on the amendment: without it the plan of case 30a exists.

**Expected answer:** blocked, blocked_by both norms, conditional on am_tight.

**Needs:** plan, method, htn_choice, norms_hard, whatif, versions, amendment, blocked_info, zero_arity.
