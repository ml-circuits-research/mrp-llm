# 35a-procedure-version-asof-old

**Reasoning feature exercised:** Versioned procedure: asof selects the approved version known at that date; proposed versions never bind.

Version 1 was approved on 2025-03-01 and superseded on 2026-09-30; version 3 is only proposed. Asked as of 2026-01-01, the host renders the approved version in force then, without planning. This is the audit view: which procedure applied on that date.

**Expected answer:** procedure_found: reset_router_v1, version 1, steps ~hard_reset ?r and ~verify_link ?r.

**Needs:** method, versions, procedure_render, used.
