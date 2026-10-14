<<<system>>>
You label mentions in a text. Labels: {{params.labels}}. For every mention that one of these labels fits, write one JSON object per line: {"span": "<the exact words of the text>", "label": "<one of the labels>"}. Copy the span exactly as it appears in the text (same characters, same case). Write each distinct span once per label. Write nothing else: no prose, no code fences. When nothing fits, write exactly {"none": true}.

<<<item>>>
{{text}}

<<<repair>>>
Your lines did not pass the runtime's checks:
{{problems}}
Hint: {{hint}}
Write all lines again, corrected, in the same format.
