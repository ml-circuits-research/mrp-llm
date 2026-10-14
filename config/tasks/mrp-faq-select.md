# MRP reflex slot, faq-llm-select: which FAQ entry, if any, fully answers the message?

## begin

### tier

tiny

### request

```json
{"maxTokens": 200, "temperature": 0}
```

### template

```text
A user wrote a chat message to an assistant that has a short FAQ. Decide whether one FAQ entry asks the same thing as the message, so that its answer fully answers the message. A message about a named person, project or company, or one that asks for something the entry does not cover, matches no entry.
Return one JSON object and nothing else: {"faq": "<the id of the entry>"} or {"faq": null}.

FAQ:
${entries}

MESSAGE: ${message}
```

### code

```javascript
this.end(result);
```
