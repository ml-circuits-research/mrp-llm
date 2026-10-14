# 10e-conditional-redundant-assumptions

**Reasoning feature exercised:** Conditional answers with redundant assumptions: the list is all of them and flagged conditional_unknown.

Two suppositions supply the same claim. Removing either alone changes nothing, so a leave-one-out run would report an unconditional answer, which is false. Removing both changes the answer; the host then lists both and marks conditional_unknown: the exact minimal subset was not isolated.

**Expected answer:** row ann, conditional [s1, s2], conditional_unknown true.

**Needs:** whatif.
