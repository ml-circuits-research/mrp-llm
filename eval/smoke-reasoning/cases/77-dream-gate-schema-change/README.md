# 77-dream-gate-schema-change

**Reasoning feature exercised:** The acceptance rule of a learned artefact (proposal 5.6, backlog N02): re-certify on load, shadow, revoke or quarantine. A plan is bound to the contract of its schema cone.

Version 1 of `hit` joins a, b and c. The wires named `new_*` are the schema change: version 2 (approved later, supersedes version 1) adds the filter `d ?z`. The adapter lets the session dream on the old schema (the `new_*` wires removed, the superseded rule back in force), then asks the new one.

**Expected answer:** o0 and o20 only (the rows of version 1 that also satisfy `d`). The plan certified on version 1 is retired on load (its contract no longer matches), its skill is quarantined, and the wrapped strategy answers plainly; a plan applied blindly to the changed rule would reorder the wrong atoms.

**Needs:** rules, conjunction, versions.
