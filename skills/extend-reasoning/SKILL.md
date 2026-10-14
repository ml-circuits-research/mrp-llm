---
name: extend-reasoning
description: Implement and compare a reasoning strategy
---

# Implement and compare a reasoning strategy

Read the archived legacy chapters `probably_obsolete/legacy/requirements/24-semantica-firelor.md`, `probably_obsolete/legacy/requirements/25-motorul-de-referinta.md` and `probably_obsolete/legacy/requirements/26-strategii-si-contracte.md` (their still-valid content was consolidated in the register archived at `probably_obsolete/specs/legacy-registers/DS028-legacy-reasoning-and-operations.md`) together with DS006, which includes the strategy × backend matrix. Extend the strategy first, not the LLM syntax. Register a handler in `ReasoningRegistry` with documented operations and profiles. It receives a typed AST and returns status, completeness, epistemic status, route, proof or candidates as applicable.

In a trusted circuit, an explicitly requested but unavailable backend or profile must produce `unsupported` with the requested backend in `route.backend` and `fallback: null` (AGENTS.md rule 8); for a model-origin problem that no engine can compute, the runtime answers `not_computable` and shows the formalization (DS014), never `unsupported`. You may ignore only objects explicitly not admitted as evidence, and you must report them as ignored. Do not drop constraints, negation, time or assumptions to fit a backend. External execution goes through the compiler, never through a shell command built from user text.

Add differential tests, timeout/cutoff, contradictions, ambiguous outputs, zero solutions, multiple optima and accidental persistence. Run the same SOP against every memory engine. Do not claim memory independence if an exact scan was hidden inside an associative engine. Document the real fallback behavior and the cost of all metadata.
