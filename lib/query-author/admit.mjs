import {parse, one, many, unquote, isMatch, parseMatch} from '../../sop/parser.mjs';
import {MODEL_TYPES, checkModelWire, checkCandidates} from '../../sop/declarative.mjs';
import {checkModelLinks} from '../../sop/clauses.mjs';
import {parseCondition} from '../../sop/conditions.mjs';
import {copulaForm} from '../../sop/copula-linker.mjs';
import {englishDictionary} from '../../sop/dictionary.mjs';
import {propositionOf} from '../../sop/propositions.mjs';
import {linkRelation, mentionedIn, mentionedThroughLexicon, mentionedThroughDictionary} from '../../sop/linking.mjs';
import {assert} from '../util.mjs';

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
/**
 * Numeric anchoring (structure, not understanding): a stated number is mentioned when the message writes the same number, with or
 * without thousands separators ("4,000", "4 000"), as a decimal ("0.5", ".5") or as a number word up to twenty.
 */
export function numberMentioned(value, text) {
  const found = String(text).match(/(?<![\d.])-?(?:\d{1,3}(?:[,\u00a0 ]\d{3})+|\d+)?(?:\.\d+)?(?![\d])/g) ?? [];
  if (found.some(token => token && token !== '-' && Number(token.replace(/[,\u00a0 ]/g, '')) === value)) return true;
  if (found.some(token => token && Number(token.replace(/[,\u00a0 ]/g, '')) === -value)) return true;
  return Number.isInteger(value) && value >= 0 && value < NUMBER_WORDS.length && new RegExp(`(?<![\\p{L}])${NUMBER_WORDS[value]}(?![\\p{L}])`, 'iu').test(text);
}

/** Model admission shared by the chat and the author; no execution or storage. */
export function admitModel(sop, text, lexicon, policy = {}, {definitions = new Map()} = {}) {
  const program = parse(sop);
  if (program.wires.some(w => w.type === 'unclear')) assert(program.wires.filter(w => w.type !== 'pragmatic' && w.type !== 'instruction').length === 1, 'unclear_not_alone: unclear must be the only wire of the model output besides pragmatic and instruction wires');
  const dictionary = policy.dictionary === false ? null : englishDictionary();
  // Quotation marks and apostrophes of any style compare equal (« » “ ” ‘ ’ and the plain ones).
  const verbatim = value => String(value).normalize('NFC').replace(/[‘’‚‛`´]/g, "'").replace(/[“”„«»]/g, '"').toLocaleLowerCase('ro').replace(/\s+/g, ' ').trim();
  // An identical statement written twice is a validator problem (the repair loop fixes it), not a runtime failure.
  const statedKeys = new Map();
  for (const wire of program.wires) {
    assert(MODEL_TYPES.has(wire.type), 'wire_not_allowed: Model output must be declarative: stated, assumed, unclear, query, constraint, unparsed, pragmatic or instruction');
    checkModelWire(wire);
    if ((wire.type === 'stated' || wire.type === 'assumed') && lexicon?.predicates) {
      const proposition = propositionOf(wire);
      const predicate = lexicon.predicates[proposition.relation];
      if (predicate) {
        const declared = new Set((predicate.roles ?? []).map(role => role.name));
        for (const role of proposition.roles) {
          if (role.name === 'time' && !declared.has('time') && typeof role.value === 'string') continue; // quoted validity, not an argument
          assert(declared.has(role.name), `undeclared_role: ${predicate.id} has no role ${role.name}; declared roles: ${[...declared].join(', ')}`);
        }
      }
    }
    if (wire.type === 'query' && lexicon?.predicates) {
      for (const condition of [...many(wire, 'where'), ...many(wire, 'scope')]) {
        parseCondition(condition, leaf => {
          if (!isMatch(leaf)) return leaf;
          const match = parseMatch(leaf, '@' + wire.id + ' match', {partial: wire.fields.fragment !== undefined});
          const predicate = lexicon.predicates[match.relation];
          const used = match.roles.map(role => role.name).filter(name => name !== 'time');
          if (!predicate && match.relation && !copulaForm(match.relation)) {
            const link = linkRelation(match.relation, used, lexicon, {exact: false, headVerb: false});
            if (link.status === 'role_mismatch') throw new Error(`undeclared_role: ${JSON.stringify(match.relation)} cannot use roles ${used.join(', ')}; declared roles: ${link.candidates.map(candidate => `${candidate.id}(${candidate.roles?.join(', ') ?? ''})`).join('; ')}`);
          }
          if (!predicate) return leaf; // Unknown phrases can still link after frame normalization.
          const declared = new Set((predicate.roles ?? []).map(role => role.name));
          for (const role of match.roles) {
            if (role.name !== 'time' || declared.has('time')) {
              assert(declared.has(role.name), `undeclared_role: ${predicate.id} has no role ${role.name}; declared roles: ${[...declared].join(', ')}`);
            }
          }
          return leaf;
        });
      }
    }
    if (wire.type === 'stated') {
      const p = propositionOf(wire);
      const key = JSON.stringify([p.relation, [...p.roles].map(r => [r.name, r.value]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), p.polarity, p.certainty, p.speaker, p.valid ?? null]);
      assert(!statedKeys.has(key), `stated_duplicate: @${wire.id} repeats the statement of @${statedKeys.get(key)}; write each fact once`);
      statedKeys.set(key, wire.id);
      for (const {name, value} of p.roles) {
        if (value && typeof value === 'object' || typeof value === 'string' && value.startsWith('?')) continue;
        assert((typeof value === 'number' && numberMentioned(value, text)) || mentionedIn(value, text) || mentionedThroughLexicon(value, text, lexicon) || mentionedThroughDictionary(value, text, dictionary), 'stated_value_not_in_message: ' + JSON.stringify(value) + ' (role ' + name + ' of @' + wire.id + ') is not mentioned in this message; use assumed, a query variable or an unparsed span');
      }
      if (p.speaker !== 'user') assert(mentionedIn(p.speaker, text), 'stated_value_not_in_message: speaker ' + JSON.stringify(p.speaker) + ' of @' + wire.id + ' is not mentioned in this message');
    }
    if (wire.type === 'pragmatic' && wire.fields.span) {
      const span = unquote(one(wire, 'span'));
      assert(verbatim(text).includes(verbatim(span)), 'pragmatic_span_not_in_message: ' + JSON.stringify(span) + ' of @' + wire.id + ' is not a verbatim part of this message');
    }
    if (wire.type === 'instruction') for (const key of ['text', 'span']) if (wire.fields[key]) {
      const value = unquote(one(wire, key));
      assert(verbatim(text).includes(verbatim(value)), 'instruction_' + key + '_not_in_message: ' + JSON.stringify(value) + ' of @' + wire.id + ' is not a verbatim part of this message');
    }
    if (wire.type === 'unparsed') {
      const span = unquote(one(wire, 'span'));
      assert(verbatim(text).includes(verbatim(span)), 'unparsed_span_not_in_message: ' + JSON.stringify(span) + ' of @' + wire.id + ' is not a verbatim part of this message');
    }
  }
  // `definitions`: the output's session definitions (id -> type); `if` and `candidate` may name a session rule (Q-LANG-10).
  checkModelLinks(program, {definitions});
  checkCandidates(program, {definitions});
  return program;
}
