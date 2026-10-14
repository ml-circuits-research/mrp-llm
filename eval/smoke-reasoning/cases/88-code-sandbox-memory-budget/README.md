# 88-code-sandbox-memory-budget

Feature: `code_sandbox`. A program that allocates without bound: the worker hits its heap limit and the answer is budget_exhausted with reason memory; the host process is unaffected.

Only the `code-sandbox` strategy expresses it; every reasoning engine declares the feature unsupported.
