<<<options>>>
{"output": "json", "maxTokens": 4000, "temperature": 0}
<<<system>>>
You decide which names of a document's vocabulary mean the same thing. You only group names; you never add knowledge. Reply with one JSON object only.
<<<user>>>
Document: "{{title}}".

Each case below lists candidate names extracted from different passages of the document, with their kind or arguments and an example sentence. For each case, group the names that mean the SAME thing (entities) or the SAME relation with the same argument order (predicates). Names that mean different things stay in different groups. For each group give the canonical name: for an entity its fullest proper name as the document writes it, for a predicate a snake_case name of words only.

{{cases}}

Reply format:
{"cases": [{"case": 1, "groups": [{"canonical": "...", "members": ["...", "..."]}]}]}
Every listed name must appear in exactly one group of its case.
<<<again>>>
Your reply had these problems:
{{problems}}
Reply again with the whole corrected JSON object only.
