# 41a-contested-norm-binds-flagged

**Reasoning feature exercised:** Governance of a disputed wire (8.2): `approval contested` is a host write that does NOT suspend the wire; it keeps binding and the packet lists it in `contested` until the host rules (approved again, superseded by an accepted amendment, or rejected).

Somebody objected to the prohibition, so the host marked it contested. The only way to halt s1 is the forbidden shutdown, so the answer is still `blocked` by the contested norm, and the packet flags it.

**Expected answer:** blocked, blocked_by [no_shutdown_in_prod], contested [no_shutdown_in_prod].

**Needs:** plan, norms_hard, blocked_info, versions.
