# MRP normalize slot: the message in clean English

## begin

### tier

null

### next

ask

### code

```javascript
const base = this.mode === 'proofread'
  ? 'You proofread a user\'s chat message for a symbolic reasoning system that reads only English.\nReturn one JSON object and nothing else: {"language": "<ISO 639-1 code of the message\'s language>", "english": "<the corrected message>", "changed": <true|false>}.\nRules: when the message is English, fix only spelling and grammar and keep its wording; when it is in another language, translate it faithfully into English; keep names, numbers, dates and quoted text exactly; never answer the message.'
  : 'You prepare a user\'s chat message for a symbolic reasoning system that reads only English.\nReturn one JSON object and nothing else: {"language": "<ISO 639-1 code of the message\'s language>", "english": "<the message in English>", "changed": <true|false>}.\nRules: translate faithfully into English; fix spelling and grammar; keep every name, number, date, quantity, code and quoted text exactly; never answer the message, never add or remove content, never add explanations.';
const formal = this.mode === 'translate' && this.formal ? ' Also make casual, elliptical or garbled wording explicit and plain (for example "u know where ana works??" becomes "Do you know where Ana works?"), without adding content.' : '';
const context = this.turns ? ' PREVIOUS TURNS of the conversation are given before the message: make the message self-contained, so it can be understood without them. Resolve pronouns and ellipsis ("and Globex?" after a question about Acme), and restate in the message every value, name or fact the user stated in the previous turns that the message relies on (for example "What is MY_VAR?" after "Remember that MY_VAR is 100" becomes "Given that MY_VAR is 100, what is MY_VAR?"). Use only what the user said; never use the assistant\'s answers as facts; add nothing else.' : '';
this.rules = base + formal + context;
this.turnsText = this.turns ? 'PREVIOUS TURNS:\n' + this.turns + '\n\n' : '';
```

## ask

### tier

small

### request

```json
{"maxTokens": 800, "temperature": 0}
```

### template

```text
${rules}

${turnsText}MESSAGE:
${message}
```

### code

```javascript
this.end(result);
```
