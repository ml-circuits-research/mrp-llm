# 61-norm-conflict-horizon-blockers

**Reasoning feature exercised:** Norms over a horizon: hard norms as violation atoms with a "no violation" requirement that is lifted on unsat and minimised, which names the blockers (an unsat core cannot).

Releasing `svc1` takes three steps (build, test, deploy; cost 7). Two hard strict norms of equal strength disagree about the only deploy step: `freeze_hold` forbids `deploy` while the freeze lasts (it does), and `urgent_release` obliges `deploy` within three steps of the trigger (the goal names `svc1`, which is urgent), so the deploy at step three is both required and forbidden. No plan satisfies both within any horizon, so the answer is `blocked`, not `no_plan` and not `budget_exhausted`: a plan exists as soon as the named norms are waived. The third hard norm (`no_wipe`) forbids an action no plan needs and must not be named.

How a bounded engine finds the names: stage A (every hard norm enforced) is unsat; the requirement is lifted and the number of violated hard strict norms is minimised, with a forbidden instance that meets a triggered obligation marking both norms of the conflict. The cheapest route violates exactly those two.

The oracle (`js-oracle`) declares norms `not_expressible`; the expected answer was derived by hand from section 8.2 (qualifier `within N`, deontic conflict of equal strength) and is checked by both solver strategies.

**Expected answer:** status blocked, blocked_by [freeze_hold, urgent_release].

**Needs:** plan, rules, norms_hard, blocked_info, norm_conflict, temporal_norms.
