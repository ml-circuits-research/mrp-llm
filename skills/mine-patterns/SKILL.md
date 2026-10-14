---
name: mine-patterns
description: Generate and validate candidate patterns from traces
---

# Generate and validate candidate patterns from traces

Work from explicit source documents and traces; do not invert bitsets or claim to enumerate every experience they represent. Separate train and holdout cases by document and origin. Use `induce` for candidate templates and compare them with a simple generator; use `associate` only to score or route candidates.

`closed=true` requires a completeness justification for each case. Otherwise an absent consequent is unknown, not a counterexample. Report supporting examples, counterexamples, unknowns, conflicts, and cost. Include adverse cases, not just highly scored patterns.

Propose a new rule through a separate review file only. Do not `remember` inductive conclusions as facts: that operation records an explicit session fact/event, not proof of truth or automatic global publication. Keep nonuniversal patterns as hypotheses or restrict their scope with verifiable preconditions. Do not treat hash-derived scores as truth probabilities.
