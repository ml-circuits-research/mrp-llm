/**
 * The LFM's input units. The T5 NL-to-FOL model was trained on single statements (WillowNLtoFOL, MALLS), and given a whole problem it
 * merges or drops sentences, so a problem is sent sentence by sentence. Splitting is structural: sentence punctuation followed by a
 * capital, a digit or a quote, and line breaks; a sentence that ends with `?` is a question unit (its formula becomes the query).
 */
export function sentencesOf(text) {
  return String(text ?? '').split(/\n+/)
    .flatMap(line => line.split(/(?<=[.!?;])\s+(?=[A-Z0-9"“(])/))
    .map(s => s.trim()).filter(Boolean)
    .map((s, i) => ({index: i, text: s, question: /\?\s*$/.test(s)}));
}
