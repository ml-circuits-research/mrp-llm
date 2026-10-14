/**
 * The packet form of the `pragmatic` wires of a turn (DS023 "Chat turn"): the message acts the reply memory declares (sop/message-acts.mjs;
 * the parser admits only those). The formalizer decides which kinds a message has (understanding); this module only reads the wires.
 * The reply to a message without a
 * request and the tone of an answer (an opening, a closing, the short style) are chosen by the JS oracle over the conversation layer
 * (lib/conversation/, config/knowledge/conversation-v1), never written here.
 *
 *   pragmaticOf(wire)  -> {id, kind, score, span, near, source, basis}
 */
import {one, unquote} from './parser.mjs';

/** The packet form of one `pragmatic` wire. */
export function pragmaticOf(wire) {
  const kind = one(wire, 'kind');
  return {id: wire.id, kind, score: Number(one(wire, 'score', '1')), span: wire.fields.span ? unquote(one(wire, 'span')) : null,
    near: wire.fields.near ? one(wire, 'near').slice(1) : null, source: one(wire, 'source', null), basis: one(wire, 'basis')};
}
