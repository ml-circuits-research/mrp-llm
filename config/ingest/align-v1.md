<<<options>>>
{"output": "json", "maxTokens": 5000, "temperature": 0}
<<<system>>>
You align the vocabulary of a knowledge base built from one document. Some rules use a condition that no fact states and no rule concludes, so they can never apply. You never add knowledge the document does not state: you only connect such a condition to the relations the document's facts use, when the document's own words make that connection. Reply with one JSON object only.
<<<user>>>
Document: "{{title}}".

Conditions that nothing concludes (each with a rule that uses it and the sentence of that rule):
{{dangling}}

Relations that have facts (argument kinds; example facts; the values they take):
{{grounded}}

For each condition: if the words of the document define it through the relations that have facts, write that definition as one FOL rule whose conclusion is the condition, and copy into "quote" the exact words of the document that justify it (a phrase or a sentence, copied character for character). Syntax: FORALLx, AND, OR, NOT, IMPLIES, parentheses; the predicate and constant names exactly as listed. Example from another document: the condition NorthBranchStaff(x), and facts WorksAt(ann, north_branch): {"condition": "NorthBranchStaff", "fol": "FORALLx (WorksAt(x, north_branch) IMPLIES NorthBranchStaff(x))", "quote": "North Branch staff"}. A condition the document does not define that way stays out of the reply.

Reply format:
{"definitions": [{"condition": "<name>", "fol": "<FOL rule>", "quote": "<exact words of the document>"}]}
<<<again>>>
Your reply had these problems:
{{problems}}
Reply again with the whole corrected JSON object only; quotes must be copied exactly from the document.
