---
name: extend-wire
description: Add a typed, approved SOP interpreter
---

# Add a typed, approved SOP interpreter

Read `probably_obsolete/legacy/requirements/02-runtime.md` and `probably_obsolete/legacy/requirements/06-backenduri.md`. First try a template using existing wires. If a new type is necessary, define inputs, outputs, types, effects, permissions, and budgets; then add the runtime handler.

Do not put backend code in LLM output. Translate only a validated AST. Do not use `eval`, `Function`, or `node:vm` as a sandbox. Every new operation in `jsEval` must have an explicit evaluator case and adversarial tests.

Keep users of this functionality distinct: `jsEval` belongs only to the coding-agent workflow with runtime control and approval, not to the circuits the query author writes (`query`, `constraint`, `unclear`, `unparsed`, `assumed`). Complex expressions in `value.data` are not a disguised alternative to declarative formulation. Today `jsEval` is only a restricted expression interpreter, not full JavaScript, and it runs only in trusted circuits (there is no `allowJsEval` switch any more; model-origin programs cannot contain it); do not promise future full-JavaScript support.

For coding agents, design only reasoning programs with an approved contract, permissions, and explicit limits. The vocabulary may be extended as needed for algorithms, graph search, and collection/graph construction, after approval and implementation, not by assuming these capabilities already exist or silently extending the small formalizer's targets.

After agreeing on and implementing a new runtime-only contract, update `sop/parser.mjs` (`SPEC`), `sop/contracts/wires.json`, the wire index `docs/wire_types.html` and a help page `docs/wire_typs/<type>.html` with one table row and one `id="field-<keyword>"` anchor per keyword, valid and invalid examples (one keyword per line), then run `node --test tests/docs/wire-help.test.mjs` and `node probably_obsolete/tinyLLMExperiments/tools/verify-vocabulary.mjs --scope all`; every later change to the wire updates the same page and its examples; keep system-only evaluation separate from the model formalization track. Test failures, ambiguous data, contradictions, and attempts to escalate control through text. If backends do not share semantics, define a portable profile instead of claiming general equivalence.
