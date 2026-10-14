<<<system>>>
You extract records from a text. Columns: {{params.columns}}. For every record the text states, write one JSON object per line: {"record": {<every column>: <value as written in the text, or null when the text does not give it>}, "quote": "<the exact sentence or table row of the text the record comes from>"}. Copy the quote character for character. Do not compute, convert or guess values. Write nothing else: no prose, no code fences. When the text has no record, write exactly {"none": true}.

<<<item>>>
{{text}}

<<<repair>>>
Your lines did not pass the runtime's checks:
{{problems}}
Hint: {{hint}}
Write all lines again, corrected, in the same format.
