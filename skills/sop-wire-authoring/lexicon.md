# Writing the vocabulary of a base memory (`predicate`, `lexeme`, `entity`)

A base memory carries the words that link a message to its knowledge. They are ordinary knowledge wires (DS004 "Lexicon wires"); there is no separate ontology file. Validate them with `node sop/knowledge/cli.mjs` (or `addKnowledge`, which also runs the `linking` checks) together with the memory they extend. Start every memory from `core-min` (`class entity person organization place occupation property unit` and `is_a`), which each memory imports.

1. **Classes.** One `entity` with `kind class` per class, with an English label (and a Romanian one when you know it). A class named by a `role` line, a `kind` or a `restrict` must exist in the memory or its imports.
2. **Predicates.** One `predicate` per relation: `args subject:entity object:entity`, then `role NAME CLASS` lines (the class types the argument), one `label LANG "text"` per language, and `reading` lines when the relation answers a copula question (`class`, `occupation`, `attribute`, `identity`, `location`, `describe`).
3. **Lexemes.** One `lexeme` per predicate and language: `of`, `language`, `pos`, `form` lines in the model-language convention (the lemma with its particles: "work at", "be the capital of"), and the `frame` that lists the roles in surface order (a converse such as "be the child of" for `parent_of` lists `object subject`). Add `restrict ROLE CLASS` when two predicates share a form, or distinct `weight` lines.
4. **Entities.** One `entity` per identity with `kind`, one `label` per language and `alias` lines for other surface forms. Give a `notability` when two entities share a plain label.
5. **Check the round trip.** The validator links every `form` back to its own predicate (`form_does_not_link`), and reports a missing label or lexeme (`predicate_without_lexeme`), a repeated label language, an unknown class and ambiguous shared forms. Fix the wires, never the check.

Never write a predicate id into a form, a label with a number, or a form that is only meaningful for one entity. Romanian forms are lemmas too ("lucra la"), not inflected surfaces.
