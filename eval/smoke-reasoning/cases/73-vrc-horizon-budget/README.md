# 73-vrc-horizon-budget

**Reasoning feature exercised:** A bound of the engine is not a negative answer (proposal section 6): the VRC energy world of case 70 with the horizon cut to three steps.

The goal q at least 100 needs four steps (three give at most 96). The search ends with a live frontier at the horizon, so the honest answer is \`budget_exhausted\` with \`reason horizon\`; \`no_plan\` would claim that no plan exists, which is false.

**Expected answer:** budget_exhausted, complete false, reason horizon.

**Needs:** plan, numeric_action, zero_arity, budget.
