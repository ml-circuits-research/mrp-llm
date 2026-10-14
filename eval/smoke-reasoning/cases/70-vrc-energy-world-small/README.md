# 70-vrc-energy-world-small

**Reasoning feature exercised:** Numeric planning with exact rationals and certified state compression (extension E2, the numeric `action`).

Four coordinate pairs (1,1), (2,2), (3,3), (4,4) are turned by the four dihedral maps; each action adds the squared norm of its bucket to `q` and keeps the squared norm of every pair. The mode flags `normal` and `service` follow VRC's mode machine (`a2` from normal enters service). The goal is `q` at least 100. Squared norms 2, 8, 18 and 32 are invariant, so 9 coordinates compress to 5 (`q` and four norms).

**Expected answer:** plan_found, four steps. Three steps give at most 96 (32 each, `a3` is always enabled), so four is the shortest; the host replays the plan in the original laws.

**Needs:** plan, numeric_action, zero_arity. The oracle cannot express it; the shadow check lowers the instance to ground STRIPS (see `tests/engines/strategy-vrc-compressed-planning.test.mjs`).
