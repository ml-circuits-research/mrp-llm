# 43a-on-failure-escalation-chain

**Reasoning feature exercised:** `on_failure $method` chains (31b is the single step): the primary method needs the closed `network_up`, its fallback the closed `vpn_up`, the last resort needs nothing.

The cloud method has no legal run, so the engine follows its declared escalation to the VPN method, which has none either, and then to the tape method. Fallbacks are tried only after a failure: the cheaper tape-free options are not available, and no primitive is planned (binding strict). The cost is that of the plan that is returned, not of the failed attempts.

**Expected answer:** plan_found with copy_tape (cost 30), used tape_backup.

**Needs:** plan, method, htn_choice, on_failure, used.
