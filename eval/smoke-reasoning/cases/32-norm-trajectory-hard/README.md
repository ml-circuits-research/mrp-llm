# 32-norm-trajectory-hard

**Reasoning feature exercised:** Trajectory constraint as a hard norm: a state that must never hold along the plan (always forbid).

Both valves must be rinsed, but the two may never be open together. The shortest unconstrained plan opens both; the hard trajectory norm prunes any plan in which both_open ever holds, so one valve must be closed before the other opens. Closing valve a is cheaper than closing valve b, so the a-first order is the unique optimum (cost 5 against 7).

**Expected answer:** plan_found with open_a, rinse_a, close_a, open_b, rinse_b (cost 5).

**Needs:** plan, rules, norms_hard, temporal_norms, zero_arity, used.

**Correction (planner-agent, 2026-10-01):** the valve predicates are now declared `closed true`. With open predicates the planner state is polarity-explicit (4.2 item 8): `requires not valve_a_open` needs NEGATIVE evidence, and the case states none, so neither valve could ever be opened and the right answer would have been `no_plan`, not the plan below. The author's intention, that both valves start closed, is exactly what `closed true` says (absence of the fact is then the closed state). The expected plan and costs are unchanged.
