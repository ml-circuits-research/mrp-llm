# 42a-until-loop-exits

**Reasoning feature exercised:** `step until door_open ?d max 3` with the body `~knock ?d`: the condition is tested before every pass.

The door is closed, so the first pass knocks; the knock opens it, the condition holds and the loop ends after one pass (a loop whose condition already holds would run zero passes).

**Expected answer:** plan_found with knock (cost 1), used open_door.

**Needs:** plan, method, htn_choice, used.
