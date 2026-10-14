# 43b-on-failure-abort-blocked

**Reasoning feature exercised:** `on_failure abort` and the blocked information of a method (sop-r's BLOCKED): the failing step and the requirement it could not meet.

The only method needs `network_up s1`, which is closed and has no fact. The method says to abort on failure, so the engine neither falls back to primitives (it could plan `copy_tape`) nor invents another route: the problem is `blocked`, naming `~upload_cloud s1` and the unmet `network_up s1`, with no norm to waive.

**Expected answer:** blocked, blocked.step ~upload_cloud s1, blocked.requirement network_up s1.

**Needs:** plan, method, on_failure, blocked_info.
