# 35b-procedure-render-current

**Reasoning feature exercised:** Versioned procedure: the current approved version is rendered (a block is flattened step by step).

Most questions about a manual want its text, not a plan. The current approved version (2) is returned with its steps as written; the proposed version 3 is ignored.

**Expected answer:** procedure_found: reset_router, version 2, with the choose block kept.

**Needs:** method, versions, procedure_render, used.
