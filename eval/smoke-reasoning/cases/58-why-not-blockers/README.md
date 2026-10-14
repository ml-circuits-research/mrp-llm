# 58-why-not-blockers

**Reasoning feature exercised:** why_not names the minimal missing atoms AND the blockers.

Ann can enter a door two ways. By badge: she has badge b7, but `suspended ann` holds, and the rule needs `absent suspended ?u`, so that route is dead whatever is added (the blocker is `suspended ann`). By escort: Cy escorts her, and the only missing premise is `escort_authorized cy vault`; but the knowledge also holds the explicit negative fact `not escort_authorized cy vault`, so adding the positive atom would contradict it (the second blocker, a `contradicts`). The answer is the abduction with a restricted hypothesis space (minimal sets of base atoms whose addition makes the claim derivable), not an unsat core.

**Expected answer:** status unknown (nothing derivable, nothing refuted); missing `escort_authorized cy vault`; blockers `suspended ann` and `not escort_authorized cy vault`.

**Needs:** rules, why_not, naf, closed_world, classical_negation.
