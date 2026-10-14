---
title: DS001-coding-style
summary: Node module conventions, dependency rules, test organization, and source layout.
---

## Introduction

Changed executable project code uses Node.js ECMAScript `.mjs` modules, except Python kept for ML operations that cannot reasonably be performed by the Node runtime. The repository roots `sop/`, `memory/`, `reasoning/`, `eval/`, `tests/`, `tools/`, and `server/` correspond to separate responsibilities.

## Core Content

### Modules and boundaries

Use explicit exports, relative imports with `.mjs` suffixes, `node:` prefixes for Node built-ins, and async/await for asynchronous operations. Prefer built-ins and local code over npm packages or unnecessary Python subprocesses. Resolve bundled files relative to `import.meta.url`; accept documented user input paths explicitly, without assuming the working directory contains resources. `lib/`, primitive `sop/`, `memory/`, and `reasoning/` must not import `server/`; `sop/runtime.mjs` can orchestrate memory and reasoning, and the server consumes that runtime. The [SOP](wiki.html#definition-sop) language, exported APIs, on-disk snapshots, and CLI semantics are not changed merely by moving code.

### Dependencies and checks

Record every necessary runtime, system tool, Python ML package, development dependency, and vendored source in root `dependencies.md` with its scope, evidence, alternatives, version, source, licensing obligations, check, and removal opportunity. Keep locally owned skill dependencies inside their skill folder. Check an indispensable external prerequisite before its affected command changes durable state; optional [reasoning backends](wiki.html#definition-reasoning-strategy) are probed when requested and skipped or reported according to their route contract. Do not silently download, install, or claim an unverified machine-specific environment. Keep unavoidable Python inside an owning skill folder; the Python of the frozen tiny-model branch lives under `probably_obsolete/tinyLLMExperiments/`.

### Testing and file maintenance

Organize targeted deterministic tests under `tests/` by consumer-visible contract, and run with Node's built-in `node --test` and `node:assert/strict`. A meaningful regression checks results, boundaries, invalid inputs, permission transitions, time, or incomplete retrieval, not a mock echo or source-text detail. Demos remain in `examples/`; verification and data inspection tools remain in `tools/`; historical records under `eval/reports/history/` are not fresh verification results. Keep modules focused, avoid redundant copies and incidental formatting churn, and maintain readable lines without hard-wrapping documentation prose. Source-size checks are review aids, not a reason to split cohesive logic or shorten Markdown and HTML prose; their thresholds do not change runtime semantics. Update both HTML documentation and the DS specifications when changing a documented contract.
