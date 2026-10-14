# MRP reflex slot, faq-llm-judge: does the message ask what the FAQ question asks?

## begin

### tier

tiny

### request

```json
{"maxTokens": 200, "temperature": 0}
```

### template

```text
Decide whether a user's message asks the same thing as a FAQ question, so that the FAQ answer fully answers it. Return one JSON object and nothing else: {"same": true|false}.

MESSAGE: ${message}
FAQ QUESTION: ${question}
```

### code

```javascript
this.end(result);
```
