# 36-amendment-whatif

**Reasoning feature exercised:** Mode of work: an amendment wire with an argument, evaluated as a what-if before anyone approves it.

The user proposes an amendment of the reset procedure: its member is the proposed norm version relax_hours. Supposing the amendment puts the proposed wire in force; the host then shows the delta (cost 5 to 3) and the user accepts or rejects. Acceptance would write the new version with provenance (a host write, not part of this query).

**Expected answer:** plan_found with notify_oncall, hard_reset, verify_link, conditional on am1.

**Needs:** plan, method, htn_choice, norms_hard, whatif, versions, amendment, zero_arity, naf, closed_world.
