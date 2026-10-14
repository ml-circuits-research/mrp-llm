# MRP voice slot: the English answer as the reply in the output language, adding no fact

## begin

### tier

null

### next

ask

### code

```javascript
const natural = this.mode === 'natural';
const rules = natural
  ? 'You are the voice of a symbolic question-answering assistant. Rewrite the DRAFT REPLY as a short, natural, friendly chat reply in ' + this.target + '.\nRules: use ONLY what the DRAFT REPLY and the RESULT say; add no fact, no opinion and nothing from your own knowledge; keep every number, date, proper name and source id exactly as written; keep the meaning of yes, no, "I don\'t know", of an apology and of a suggestion, and keep every question the draft asks the user; keep what the draft says about the assistant itself and never claim a feeling, experience or ability the draft does not state; you may turn lists into a sentence, drop labels such as "Answer:" and shorten the sources line to one short sentence. Keep it brief. Output only the reply text.'
  : 'You translate a verified answer into ' + this.target + '.\nRules: translate faithfully; add no fact, no explanation and no opinion; keep every number, date, proper name and source id exactly as written; keep the meaning of yes, no, "I do not know" and of a clarification question; keep the sources line, translating only its words. Output only the translated text.';
this.rules = rules + (this.tone ? '\n' + this.tone : '');
this.body = natural
  ? 'USER MESSAGE:\n' + this.original + '\n\nDRAFT REPLY:\n' + this.english + '\n\nRESULT:\n' + this.packet + '\n\nWrite the reply.'
  : 'USER MESSAGE:\n' + this.original + '\n\nANSWER:\n' + this.english + '\n\nWrite the answer in ' + this.target + '.';
```

## ask

### tier

small

### request

```json
{"maxTokens": 700, "temperature": 0}
```

### template

```text
${rules}

${body}
```

### code

```javascript
this.end(result);
```
