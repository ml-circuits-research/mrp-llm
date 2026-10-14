---
title: DS008-material-sources
summary: Source material for base memories: rights per asset, supported formats, and ingestion by a model with provenance.
---

## Scope

Material (documents, books, manuals, articles) becomes knowledge of a task-type base memory through **document ingestion** (DS022 "Ingesting documents into a base memory"; `lib/ingest/`, `POST /v1/memories/{id}/ingest`, `node tools/ingest-documents.mjs ingest`). This specification states what material may enter and how it is traced; the ingestion procedure itself is in DS022.

## Rights

Every document declares its rights (`cleared`, `permissive-attribution` or `owner-provided`, with URL, licence and attribution where they apply). Rights are per asset, not per software licence (DS011). A document without a usable rights statement is refused (`rights_required`). Source text whose rights are unverified or restricted stays in the local source cache and is never ingested, exported or published.

## Provenance

Every stored circuit records its source: document name, title, SHA-256, URL and licence, the chunk coordinates (section path, line range, chunk SHA-256) and, for every fact, a `quote` that is words of the passage (checked; a paraphrased quote is rejected). A chunk already stored in the memory (same SHA-256) is skipped, so ingesting the same document again adds nothing and an edited document adds only its changed chunks.

## Correction

There is no manual acceptance step (owner, 2026-10-02). Knowledge enters after the knowledge validator and the automated checks (quote check, conflicts with the memory held back: memory wins); errors are found and corrected through tests and interactions, and `/review` shows what a memory knows with its provenance.

## Formats

Supported: UTF-8 text and Markdown. Planned (from the superseded material workflow, archived in `probably_obsolete/specs/removed-sections-2026-10-02.md`): text extraction from DOCX paragraphs, PDF text pages (not OCR) and static HTML text blocks, each with a stable passage reference, before chunking.
