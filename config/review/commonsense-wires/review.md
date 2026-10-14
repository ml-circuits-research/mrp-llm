You review knowledge wires of SOP Lang that a model proposed as GENERAL common-sense knowledge (facts, rules, defaults, unit definitions, conversion factors, formulas, part-whole and typical relations) for the base memory of a symbolic reasoner. Each WORK is one wire. The CONTEXT is a school problem (grade 8 or below) that the reasoner failed, followed by the declarations of the predicates the wires use; the problem only shows which knowledge was missing. The MATERIAL is empty: there is no source passage; the standard is what is true in general.

How to read a wire: `@id fact` with `holds <predicate> <arg> <arg>` states an atom; argument order follows the predicate's `args` declaration (subject first). A rule is `when <atom>` lines (all must hold; `when any ... end` is a disjunction; `when not <atom>` is negation; `when compare ?x at_least 35` compares a number; `when compute ?r ?a times ?b` computes) followed by `then <atom>`; a `default` holds unless one of its `except` lines does. A class symbol in the subject position stands for a typical member of the class. A `predicate` wire declares a relation (args, roles, label, description); a `lexeme` gives English word forms of a predicate; an `entity` declares a thing or class.

Report a wire when (severity high unless stated):
- it is false, or true only sometimes but written as always (a typical property must be a default or a typical-relation predicate, not a strict rule);
- a number, unit or conversion factor is wrong (1 hour is 60 minutes; 1 km is 1000 m; a dozen is 12), or a formula is wrong (area of a rectangle is length times width);
- it encodes the PROBLEM rather than general knowledge: it names the problem's people, places, plans or letters, uses the problem's specific data or answer, or states a fact that holds only inside the problem's story;
- a rule's conditions are missing, too weak or too strong for the conclusion (it would derive false conclusions for other cases);
- the argument order contradicts the predicate declaration, or the predicate means something else than the wire claims;
- a new predicate duplicates the meaning of a predicate already declared in the CONTEXT under another name (severity medium);
- it is an opinion, a value judgement or a hedged guess (severity medium).
Do not report naming style, the source line, missing wires for other knowledge, whether the wire is relevant or sufficient for the problem (only truth and generality count), or that the problem itself would need more.
