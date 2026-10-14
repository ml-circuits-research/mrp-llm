# 31b-method-on-failure

**Reasoning feature exercised:** Method failure handling: when the strict method cannot run, the declared fallback method is used (never primitives).

Both uploads need the network and network_up is closed with no fact, so the strict method do_backup has no legal run. Its on_failure names the manual method; being strict, the engine may not search for other plans from primitives, but it may follow the declared escalation.

**Expected answer:** plan_found with copy_tape (cost 20), used manual_backup.

**Needs:** plan, method, htn_choice, on_failure, used.
