# 48-blocked-by-unmet-requirement

**Reasoning feature exercised:** `blocked` with `blocked {step, requirement}` (5.3, 8.4): "no plan" is never the only information.

The strict method locks, snapshots and then needs an upload, but both uploads need the closed `network_up s1`, which has no fact. The method has no fallback. The engine reports the deepest step it reached (the first alternative, `~upload_s3 s1`) and the unmet requirement, with no norm to waive. (With `on_failure` the declared fallback would run, case 31b.)

**Expected answer:** blocked, blocked.step ~upload_s3 s1, blocked.requirement network_up s1.

**Needs:** plan, method, htn_choice, blocked_info.
