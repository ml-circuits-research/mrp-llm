# 46c-advisory-hard-not-relaxed-when-legal

**Reasoning feature exercised:** `binding advisory` means "may be relaxed when the goal is otherwise blocked", not "may be traded for cost" (8.2).

The service is now drained, so the graceful stop applies. The forced stop is cheaper (2 against 5) but the advisory norm still forbids it, and since a legal plan exists the norm is NOT relaxed: graceful_stop, start (cost 6), `compliance.hard "ok"`, nothing in `relaxed`. A soft norm would trade cost; a hard advisory one only gives way when it blocks.

**Expected answer:** plan_found graceful_stop, start (cost 6), compliance hard ok.

**Needs:** plan, method, htn_choice, norms_hard, binding_advisory, used.
