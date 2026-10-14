---
name: procedure-library
description: Build approved SOP rules and templates
---

# Build approved SOP rules and templates

Read the archived legacy chapters `probably_obsolete/legacy/requirements/01-sop.md`, `probably_obsolete/legacy/requirements/02-runtime.md` and `probably_obsolete/legacy/requirements/06-backenduri.md` (consolidated in the archived register `probably_obsolete/specs/legacy-registers/DS027-legacy-architecture-language.md`) together with DS004. Write Horn rules with `?x` variables, SOP dependencies with `$wire` and handles with `~wire`. Do not confuse these roles. Every variable in a rule's conclusion must be bound by its conditions.

For a template, define `params`, `yield` and `body`. Reuse the standard wires and explicit references. Use the expression function `only(...)` when a scalar requires a unique result. Never resolve an ambiguity silently by picking the first row.

Test repeated instantiation without name collisions, missing arguments, epochs, budgets, missing data, contradictory sources and effect ordering. Publish the exact source with its checksum only after review; memory support is not authorization for code.
