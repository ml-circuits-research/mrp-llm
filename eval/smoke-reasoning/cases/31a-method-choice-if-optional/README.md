# 31a-method-choice-if-optional

**Reasoning feature exercised:** Method control forms: if/else on a state, a choice the engine optimises, an optional step it may skip.

The method fixes the skeleton of a backup: lock, snapshot a big database or dump a small one (if/else on the state), upload to S3 or to the NAS (a choice), optionally verify, unlock. The engine optimises only at the choice point and the optional step: the S3 upload is cheaper and the verification adds cost without achieving anything, so it is skipped.

**Expected answer:** plan_found with lock_db, snapshot, upload_s3, unlock_db (cost 7).

**Needs:** plan, method, htn_choice.
