# 11c-procedure-method

**Reasoning feature exercised:** Procedures from a manual: an ordered method with steps.

The manual says: to reset a router press the button, wait ten seconds, release. The `method` wire keeps that recipe and its order; the three actions give each step preconditions and effects so a state-space planner reaches the same answer.

**Expected answer:** plan_found with the ordered steps press_button, wait_ten, release_button.

**Needs:** plan, method.
