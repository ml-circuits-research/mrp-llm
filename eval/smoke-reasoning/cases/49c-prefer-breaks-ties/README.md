# 49c-prefer-breaks-ties

**Reasoning feature exercised:** `prefer ~wire_transfer over ~cheque` (8.2): the engine optimises at the choice point, and among runs of equal cost the preferred branch wins. The cheque is listed first in the `choose`, so without the preference the order of the branches would decide; with it the transfer is chosen and `choices` says so.

**Expected answer:** plan_found with wire_transfer (cost 2); choices include ~wire_transfer p1.

**Needs:** plan, method, htn_choice.
