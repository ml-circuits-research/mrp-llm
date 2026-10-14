# 30d-router-abduce-waive-norm

**Reasoning feature exercised:** Mode of work: the minimal norms to waive so that a blocked step becomes possible (abduction with a restricted hypothesis space).

The only hypothesis offered is to waive the business-hours prohibition. The engine returns the minimal sets of waivers under which a plan through the hard reset exists; the set is what the host puts to the user as the negotiable change.

**Expected answer:** status hypotheses (the status of every abduction, as in case 14a; the first version of this file said `supported`, which is the status of a relational answer), one explanation: waive no_hard_reset_in_hours.

**Correction (planner-agent, 2026-10-01):** `expected.json` said `status: supported`. Section 5.3 lists `hypotheses` as the status of an abduction and the table of 8.6 gives the answer as `hypotheses [[waive no_hard_reset_in_hours]]`; the oracle answers 14a with `hypotheses` too. Only the status changed; the explanation set is as derived by hand.

**Needs:** abduce, abduce_waive, plan, method, norms_hard.
