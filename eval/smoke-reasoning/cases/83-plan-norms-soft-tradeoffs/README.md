# 83-plan-norms-soft-tradeoffs

**Reasoning feature exercised:** LLM stress: a plan under two hard prohibitions and two soft obligations, one cheaper to violate than to meet and one cheaper to meet.

Goal: s1 live. The change freeze forbids the cheap direct deploy (blue-green costs 5 instead of 1) and the high-risk flag forbids the fast test (the full test costs 6 instead of 2). Notifying security costs 6 but its soft obligation only costs 4 when unmet, so the cheapest legal plan violates it. Announcing costs 1 and its soft obligation costs 3 when unmet, so the plan meets it. The total cost is the action cost 14 plus the penalty 4. The expected answer comes from the htn-strips-planner and was checked by hand.

**Expected answer:** plan_found: build, test_full, deploy_blue_green, announce (cost 14, total cost 18, one soft violation).

**Needs:** plan, norms_hard, norms_soft, procedures, used, zero_arity.
