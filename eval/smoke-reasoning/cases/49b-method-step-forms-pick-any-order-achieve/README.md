# 49b-method-step-forms-pick-any-order-achieve

**Reasoning feature exercised:** Three forms of the method grammar (8.2) that the other cases do not use. `any_order` accepts the account and the desk in either order; `pick ?h where host_free ?h` makes the engine choose a free host; `achieve badge_ready ?u` leaves the gap to the planner, which finds print_badge then laminate by blind search (no method achieves `badge_ready`, so primitives are allowed there).

Cost: account 1, desk 1, provision 2, print 1, laminate 1, finish 1 = 7 in 6 steps. The order of the first two steps and the host are ties and are not asserted.

**Expected answer:** plan_found, cost 7, 6 steps, used onboard, print_badge, laminate.

**Needs:** plan, method, htn_choice, used.
