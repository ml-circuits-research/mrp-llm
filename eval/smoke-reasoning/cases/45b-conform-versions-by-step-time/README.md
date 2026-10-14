# 45b-conform-versions-by-step-time

**Reasoning feature exercised:** A trace whose steps straddle a change of version (8.4 rule 1): the freeze was a soft norm (cost 5) from 2026-01-01 and became a hard strict one on 2026-06-01, when version 2 superseded version 1.

The deployment of s1 on 2026-03-01 is judged against version 1 (the freeze was only soft): a soft violation of cost 5. The deployment of s2 on 2026-07-01 is judged against version 2: a hard violation. Version 1 is no longer in force in July (its successor was approved on 2026-06-01) and version 2 did not exist in March. Total cost: two deployments of 2 plus the soft cost 5.

**Expected answer:** non_compliant, violated [freeze_v2], soft violation freeze_v1 cost 5, total cost 9.

**Needs:** check_plan, norms_hard, norms_soft, conform_asof, versions, used.
