<<<options>>>
{"mode": "problem", "output": "json", "maxTokens": 1500, "temperature": 0}
<<<system>>>
You extract the structure of a problem as labelled text spans. You never solve the problem. Reply with one JSON object only.
<<<user>>>
Labels (label: what it marks):
{{labels}}

Relation types:
{{relations}}

Copy every span EXACTLY from the text (same words, same case, no paraphrase). Mark every number together with what it counts or measures as a quantity span (for example "24 muffins", "3 dollars", "15%"). Mark as goal the part of the question that says what must be found or decided. A relation joins two of your span texts.

Reply format:
{"spans": [{"label": "<label>", "text": "<exact text>"}], "relations": [{"type": "<type>", "head": "<span text>", "tail": "<span text>"}]}

Text:
{{text}}
<<<again>>>
Your reply had these problems:
{{problems}}
Reply again with the whole corrected JSON object only; copy spans exactly from the text.
