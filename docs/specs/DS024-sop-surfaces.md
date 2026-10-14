---
title: DS024-sop-surfaces
summary: The two accepted surfaces of SOP Lang (canonical field lines and compact key=value pairs), how the compact surface is read, what is stored, and the rule for output.
---

## Introduction

SOP Lang is the common language of MRP-LLM: formalizations, facts, schemas, queries, traces and intermediate answers are SOP circuits, and JSON appears only at the edges of the system (the web API and configuration files). DS004 defines the semantics of the wires and DS014 the circuit surface a formalizer may author. This specification defines the two textual surfaces in which a circuit may be written and how they relate. Both surfaces are part of the language contract; neither is deprecated.

## Core Content

### The canonical surface

A wire starts at column 1 with `@name type`. Every field is a line indented by exactly two spaces that holds a keyword, one space and a value. Multiline values use `key |` followed by lines indented by four spaces. Condition groups (`all`, `any`, `match` … `end`) span several lines. Comments are lines that start with `#`. The canonical surface is the only one that is stored, hashed, compared, cached, versioned and shown as "the circuit" in traces and in the knowledge browser.

### The compact surface

A wire may also carry `key=value` pairs. Pairs may follow the type on the header line (`@order entity name="Order 17" kind=order`) or stand on their own indented lines (`  owner=$customer`, several pairs on one line are allowed). Both surfaces may be mixed inside one wire: a pair and a canonical field line of the same wire are fields of that wire in source order. A compact pair carries exactly one term: a canonical symbol, an integer or decimal, a JSON string, a `$wire` reference, a `?variable` or a `~id` handle. A value of several terms (an atom, a condition, a list) must use the canonical line form. A JSON string keeps its quotes: `name="Order 17"` becomes the field line `name "Order 17"`. An `=` inside a JSON string is part of the string.

### Reading

`sop/compact.mjs` `expandCompact` rewrites a source to the canonical surface before any other reader sees it. The circuit parser (`sop/parser.mjs` `parse`), the knowledge parser (`sop/knowledge/lexical.mjs` `parse`) and the formalizer's circuit splitter (`lib/query-author/session.mjs` `splitCircuits`) call it, so every validator, compiler and memory path receives canonical text. A source without compact pairs is returned unchanged. Lines inside a `|` block are never rewritten. A header line whose trailing text is not made only of compact pairs is left as it is, and the parser rejects it with its usual `expected @name type` error. Line numbers in validator messages refer to the canonical text, in which every header pair occupies its own line.

### Output

Every component writes the canonical surface. `compactSource(program)` renders a parsed program in the compact surface for display or export: a wire whose values are all single terms becomes one header line, and any other wire keeps its canonical lines. The compact rendering of a program parses back to the same program. Prompts that ask a model for circuits show the canonical surface; a model that answers in the compact surface is accepted because reading expands it first.

### Invariants

Expanding a canonical source is the identity. Expanding twice gives the same text as expanding once. Both surfaces describe the same wire graph: the same ids, types, fields and values in the same order. No wire type, field or term is reachable through one surface only.
