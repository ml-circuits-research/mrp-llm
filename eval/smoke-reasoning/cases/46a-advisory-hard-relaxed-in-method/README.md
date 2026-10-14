# 46a-advisory-hard-relaxed-in-method

**Reasoning feature exercised:** The severity x binding matrix (8.2) inside a method (case 39a is the bare goal). The restart method is strict, so only its two alternatives are legal; the hard but advisory norm `no_force` forbids the forced stop under load.

The service is overloaded and not drained, so the graceful stop (cost 5) is not applicable. Every legal run is then forbidden by the advisory norm, which the engine relaxes because the goal is otherwise blocked: force_stop, start (cost 3), `relaxed [no_force]`, `compliance.hard "relaxed"`. A strict norm would give `blocked` (case 30b).

**Expected answer:** plan_found force_stop, start (cost 3), relaxed [no_force].

**Needs:** plan, method, htn_choice, norms_hard, binding_advisory, used.
