/**
 * The single table of `unclear` kinds (DS014). The small model has no context
 * and does not reason, so it reports only what it can recognise from the text
 * itself: unintelligible text, a message with neither a statement nor a
 * question, or a visible ambiguity it prefers not to resolve (`ambiguous`, with
 * `reading "…"` lines paraphrasing each candidate reading). The reply is never
 * written here: the conversation layer (config/knowledge/conversation-v1, DS023
 * "Conversation layer") phrases each kind, and the JS oracle chooses the reply
 * of a turn (lib/conversation/). Renaming or adding a kind is a change to this
 * table (plus DS014, the wire help page and the layer's rules and replies).
 */
export const UNCLEAR_KINDS = Object.freeze({
  gibberish: Object.freeze({readings: false}),
  no_request: Object.freeze({readings: false}),
  ambiguous: Object.freeze({readings: true}),
  // Written only by a request parser that knows the memory's vocabulary (codingAgentQuery, DS022): the question is clear, but no relation of the memory expresses it.
  relation_not_in_memory: Object.freeze({readings: false}),
});
/** Kinds that carry `reading` lines; every other kind takes none. */
export const READING_KINDS = Object.freeze(Object.keys(UNCLEAR_KINDS).filter(kind => UNCLEAR_KINDS[kind].readings));

/** The one language of the reply layer: the core renders English and the output edge translates (DS014 "English-only core"). */
export const REPLY_LANGUAGES = Object.freeze(['en']);
