---
name: sop-wire-authoring
description: Compile a long text (a book, manual, regulation or article) into checked knowledge wires for evaluations and memory, with the mandatory write-validate-fix loop, source quotes, closedness only with a source sentence, reification and a differential check
---

# Authoring knowledge wires from a source

A coding agent, an omp agent or a subagent reads a source and writes **knowledge wires**: predicates, facts, rules, defaults, aggregates, actions, methods, norms. The runtime stores them, a different system turns users' questions into queries, and exact engines answer. The wires must be **checkable, one idea each, and faithful to the source**. Write what the source says, never what you know; if the source is silent, write nothing.

The language is documented in `docs/specs/DS004-sop.md` (section "Knowledge wires", the user manual) and in the wire help pages (`docs/wire_types.html`, one page per wire). The compact pattern guide, with one executed example per pattern, is `authoring-guide.md` in this folder: read it before you write. The grammar, parser and validator are the single source `sop/knowledge/`; the command is `node eval/smoke-reasoning/validator.mjs`. This skill grants no approval: what you write is a proposal, and compiling a text does not establish that it is true (AGENTS.md rules 4 and 5).

## Inputs and outputs

**Inputs.** (1) The source passage or file, UTF-8, with its coordinates (title, chapter, page or paragraph) and its rights record: only text recorded as cleared or permissive-attribution in `docs/specs/DS011-source-rights.md` may be ingested or exported (AGENTS.md rule 10); text of unverified rights stays in the local cache `datasets_sources/`. (2) The purpose: an evaluation (questions will be asked of the wires) or memory (the wires will be ingested). (3) The vocabulary of the passages compiled before this one, if any (the `predicate` wires already declared). (4) The task folder given by the caller, if any.

**Outputs**, written to the task folder (or the paths the caller names), never to `datasets/`, `config/` or memory:

- `knowledge.sop`: the wires, vocabulary first, then facts, then rules, defaults, aggregates, actions, methods, norms, procedures.
- `queries.sop`: at least one test query per rule, per aggregate and per procedure, including one that must be blocked, refuted or unknown, and one that exercises each `closed` predicate you declared. Each query circuit is a `query` wire (a file whose name contains `query` is read as a query circuit).
- `report.md`: plain text, at the end of the job: the sentences you did not formalise and why, the predicates you declared `closed` and the sentence that justifies each, every wire the validator warned about that you left, what the language could not express ("not expressed"), and the compilation's size.

## The mandatory loop

1. **Declare the vocabulary** (the words for a base memory: `lexicon.md`). One `predicate` wire per relation, with `args` roles and types (`args subject:entity object:entity`, `args none`). A predicate without roles cannot be linked to a question.
2. **Write the wires**, one idea each, in the patterns of `authoring-guide.md`.
3. **Run the validator in authoring mode**: `node eval/smoke-reasoning/validator.mjs --authoring knowledge.sop queries.sop`. Fix every error and every warning, or write the warning you keep in `report.md` with the reason. The authoring mode ignores `approval`, `approved_by` and `approved_at` with the warning `governance_ignored`: remove them, you never write them.
4. **Fix and repeat** until the output is `OK` with no unexplained warning. Do not hand the files on after a failing run, and never edit the validator, the grammar or `sop/` to make a wire pass.
5. **Execute the queries.** Where the wires and a query are expressible by the oracle (`select`, `exists`, `count`, `every`, `explain`, defaults, aggregates, integrity), run them: `node eval/smoke-reasoning/run.mjs` runs the smoke cases, and a small script calling `ask({theory: {knowledge}, query}, {})` from `reasoning/strategies/js-reference/index.mjs` runs yours. A rule whose test query does not return what the source says is wrong, whatever the validator said. Queries in the planning and conformance modes (`plan`, `why_not`, `abduce`, `conform`, `procedure`) are validated only; the oracle declares them `not_expressible`.
6. **Report** what you could not express.

## The source rules

- **Every wire keeps its sentence.** Put the sentence in `source` (a short citation with its coordinates, `"Ops manual 4.3"`) or in `quote` (the exact words, copied byte for byte from the source). A fact, rule, default, norm or method without either is incomplete. A paraphrase is never put in `quote`.
- **One claim per wire.** Split a sentence with two claims into two wires; do not merge two sentences into one rule.
- **Write only what the source says.** A fact you know to be true but the text does not state is not written. A plausible rule the text does not state is not written. If the text is silent, say so in the report.
- **The strength of the wire is the strength of the sentence.** "Always", "never", "must not" are a `rule`, an `integrity` or a `norm`. "Usually", "normally", "as a rule ... except" are a `default` with its `except`. "Reportedly", "according to X" is a `fact` with `status reported`, a `speaker` and the `quote`. "Possibly", "may" is `status hedged`. "Recommended", "should" is a norm or method with `binding advisory`; "always do it this way" is `binding strict`, and an omitted `binding` is strict.
- **A revision is a new wire.** When the source revises a rule, write the new wire with `version N+1` and `supersedes $old`; never edit or delete the old one. Use `overrides $other` between defaults, never a global `priority` number.
- **Dates and numbers.** Integers only: money in cents, time in minutes, no floats. A fact true for a period has `valid START END`.
- **Say what you cannot express.** Unbounded loops, percentages with fractions, rounding rules, date arithmetic, string operations and anything that needs more than `compute`, `compare` and the aggregates go into `report.md` as "not expressed", never into an approximation.

## Closedness is proposed with a source sentence

`closed true` on a predicate says the list is exhaustive, and it is what makes `absent`, a count, a sum and `every` meaningful. Declare it **only** when the source says the list is complete ("the table lists the salary of every employee", "these are all the exits"), and quote that sentence in the predicate's `description`. Without such a sentence, leave the predicate open: the answers are then lower bounds or `unknown`, which is the honest result. Never write `absent` over a predicate that is not closed, and never write `not p a` for "the source does not list `p a`": `not` is explicit evidence that the source says it is false. The runtime accepts closedness only after review, over an archive or pinned view; your declaration is a proposal.

## Reification, symbols and strings

- **Reify an event.** A relation has at most six terms. An event with more participants, or optional ones, is one event fact plus one fact per participant, each with its own role predicate (`shipment s1`, `shipment_from s1 oslo`, `shipment_to s1 rome`, `shipment_weight s1 1200`); the event symbol is a fresh lowercase symbol you invent, used in every participant fact, and the source sentence goes on the event fact. Do not flatten an event ad hoc.
- **Entities are lowercase symbols; strings are only text.** `alpha_lab`, not `"Alpha Lab"`: lowercase and join the words with underscores (`"Dr. O'Neil"` becomes `dr_oneil`), and keep the original wording in `source` or `quote`. Use a string only for an argument of type `text`, or for `source`, `quote`, `speaker`, `description`, `message`. When the display form matters, state it once as a text fact (`display_name alpha_lab "Alpha Lab"` over a predicate `args subject:entity object:text`).
- **Words, not operators.** `above`, `at_least`, `plus`, `times`; never `>`, `+`. No parentheses, no commas.
- **The same symbol everywhere.** Use one spelling per entity across the whole job; the vocabulary of earlier passages is the authority, and a new predicate is declared only when no existing one means the same.

## No jsEval, no approval, no model-surface wires

Never write `jsEval`: it is a trusted, runtime-only wire, opaque to every engine, and an expression from a source is code, not knowledge. What `compute`, `compare`, the aggregates and `constraint` cannot express goes in the report. Never write `approval`, `approved_by` or `approved_at`, and never write an `amendment` (the runtime composes it). The programming wires `test` and `code` are runtime or turn wires: write them only under the programming task `programming/TASK.md` (an instruction to a small JavaScript function), never in knowledge compiled from a source, and never a `test` of `kind sealed`. Never write the model-surface wires `stated`, `assumed`, `unclear`, `unparsed`: they are what the small model emits from a user's message, and the model-origin compiler rejects every knowledge wire. A `query` wire is allowed only in `queries.sop`, as a test.

## The differential check

A single compilation can silently omit a sentence. For an evaluation corpus, compile every passage **twice, independently**: two agents (or two runs of one agent with different instructions on the order of work) that do not see each other's output, each producing `knowledge.sop` for the same passage and the same inherited vocabulary. Then compare:

```sh
node skills/sop-wire-authoring/scripts/compare-compilations.mjs a/knowledge.sop b/knowledge.sop --queries queries.sop
```

The script validates both files, compares the wires on meaning (ids, `source`, `quote`, `description` and `message` are ignored, variables are renamed, predicates are compared by name, roles and `closed` flag) and runs each test query against both with the oracle. Each line it prints is a disagreement: a wire only one compilation wrote (an omitted sentence, or a divergent reading), a predicate with a different signature or `closed` flag, a query with a different answer. Resolve each one **against the source sentence**, not by majority: write the merged `knowledge.sop` with the reading the sentence supports, and list in `report.md` the disagreements you resolved and how. If the two compilations agree, the check passes; agreement shows consistency, not truth. Two compilations that both omit a sentence still agree, so the reviewer's reading of the source against the wires remains the final check.

## Splitting long texts

- **Split along the source's own structure**: chapters, sections, numbered clauses, one table at a time. A passage is small enough to read in one go, typically a few pages or a few hundred lines; the boundaries and their coordinates are recorded, never guessed.
- **Vocabulary first, as its own pass.** Read the whole text (or its table of contents and definitions) and write the shared `predicate` vocabulary and the symbol conventions (how an entity is spelled, which roles each relation uses) before the first passage is compiled. Every passage then starts from that vocabulary file, and a new predicate is added to it, not declared twice.
- **One output folder per passage**, named by its coordinates, each with its own `knowledge.sop`, `queries.sop` and `report.md`; ids are unique across the job (use a short passage prefix, `c3_` for chapter 3, never the reserved `x_`). A rule that spans passages ("as stated in section 2") is written in the later passage over the predicates of the earlier one.
- **Merge** by concatenating the vocabulary and the passages' knowledge files in order, then run the validator on the whole: duplicate ids, arity mismatches, a `closed` flag that two passages declare differently and rules that become non-stratifiable only in combination show up at this step. Run the queries of every passage again on the merged file.
- **Cross-passage corrections.** If a later passage revises an earlier one, write the new wire with `supersedes`; do not edit the earlier passage's file after it was merged.
- **Keep the job auditable**: the report of each passage lists what was not formalised, so a reader can see what the compilation leaves out.

## Common mistakes the validator and the review look for

1. `not` where `absent` is meant (a rule that never fires); `closed true` plus `absent`, only if the source says the list is exhaustive.
2. Arity or argument-order drift: always declare `args` with roles and types.
3. Floats and units: integers only.
4. Global `priority` numbers: use `overrides`.
5. Forgetting `closed` before a count, sum, `every` or `absent`.
6. A rule written for "usually" (a conflict becomes `both`), or a default written for an exceptionless law.
7. An event with more than six participants flattened ad hoc.
8. A wire without its source sentence, or a `quote` that is a paraphrase.
9. A variable only a `when` under `absent` or `compare` mentions (`unsafe_negation`, `unsafe_variable`).
10. An `oblige` norm whose variable no `when` atom binds, or a `standing` marker written to silence the warning.

## Records

Log the job with `node tools/journal.mjs add --area data --state started|done|blocked …` (actor from `CHATSOP_ACTOR`), and record the results, the disagreements of the differential check and the sentences left out as a topic note (`node tools/notes.mjs add --topic … --kind result …`). The output goes through the knowledge validator and the automated checks of document ingestion (DS008, DS022); there is no manual approval step.
