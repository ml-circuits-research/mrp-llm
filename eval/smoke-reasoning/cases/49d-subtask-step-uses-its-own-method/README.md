# 49d-subtask-step-uses-its-own-method

**Reasoning feature exercised:** A step that is a task atom rather than an action (8.2 step table, "a sub-task; some approved method must achieve it").

The release method says: test the service, then deploy. `tested ?s` is a task, not an action; the engine finds the approved method `run_tests` that achieves it (lint, then unit) and decomposes it in place, then checks that the task atom holds before going on. Both methods appear in `used`.

**Expected answer:** plan_found lint, unit, deploy (cost 3), used release and run_tests.

**Needs:** plan, method, htn_choice, used.
