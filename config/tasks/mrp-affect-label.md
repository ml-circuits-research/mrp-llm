# MRP affect slot, llm-label: one emotion label and an intensity

## begin

### tier

tiny

### request

```json
{"maxTokens": 200, "temperature": 0}
```

### template

```text
Label the emotion of a user's chat message. Return one JSON object and nothing else: {"label": one of ["neutral","frustrated","urgent","confused","grateful","angry","happy","sad"], "intensity": a number from 0 to 1}.

MESSAGE:
${message}
```

### code

```javascript
this.end(result);
```
