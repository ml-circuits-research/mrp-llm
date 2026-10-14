/**
 * The questions of the generic protocol (DS022 "LocalLLMStepByStep", methods B and D) and the choice lists every formalization
 * strategy shares: the answer kinds and the aspects of a request. The message acts of the `pragmatic` wire are memory data of the reply
 * memory (sop/message-acts.mjs; P-2.1, 2026-10-03) and their questions are protocol data (formalizer-protocol-v1 0070-acts.sop). The system
 * message is method A's (byte-identical); the first user turn starts with the answer kinds and the aspects, also
 * byte-identical for every request and memory, so llama-server keeps them in the cached prefix. Every question is a numbered choice
 * ("0" is always "none"), a short list of numbers, lettered lines or a part of the request copied verbatim; the model never writes SOP
 * or JSON. These lists are the protocol, not understanding: the model reads the message, the system only asks and assembles.
 */
/** The aspects of the checklist question (Q2), in the fixed order of the cached prompt. */
export const ASPECTS = Object.freeze([
  ['limit', 'a number limit (more than, fewer than, at least, at most, between two numbers, before or after a year)'],
  ['options', 'a choice between named things (A or B)'],
  ['exclusion', 'something to leave out (not X, except X, besides X, other than X)'],
  ['date', 'a calendar date or period'],
  ['supposition', 'a supposition (if, suppose, were)'],
  ['twoSided', 'two named things compared with each other (before X did, more than X, the same as, both X and Y)'],
  ['second', 'a second question'],
  ['reason', 'a reason (because)'],
  ['negation', 'something that does not hold (not, no, never, without, missing)'],
  ['chain', 'a chain of links from one thing to another (reach, get from A to B, connected through)'],
  ['fewest', 'the fewest steps or links between two things'],
]);

export const KINDS = Object.freeze([
  ['yesno', 'yes or no: whether something is true, holds, is allowed or is absent', 'Is Ana a doctor? May Ion work on 2026-04-01? Is Ana older than Ion?'],
  ['reach', 'whether one thing can be reached from another through a chain of links', 'Can one get from A to B without passing a closed point?'],
  ['list', 'the names of the things that fit', 'Who works at Acme? Which cities are in Spain?'],
  ['value', 'one stored value of something: an amount, a total, a size, a date, a difference', 'What is the total pay of Sales? What is the age of Ana?'],
  ['count', 'how many different things fit', 'How many people work at Acme?'],
  ['highest', 'the thing with the highest or largest value', 'Who earns the most at Acme?'],
  ['lowest', 'the thing with the lowest or smallest value', 'Which city is the smallest?'],
  ['puzzle', 'numbers for unknowns (x, y) that must satisfy given equations or limits', 'Let x and y be integers from 0 to 5; is there an assignment with x + y = 4?'],
  ['problem', 'a result worked out from numbers, things, facts or rules the request itself gives (a word problem, a choice by given numbers, a deduction)', 'Pens cost 1.5 each; what do 12 pens cost? Plan A costs 400, Plan B 150; which is cheaper? Every glorp is blue and Zed is a glorp; is Zed blue?'],
  ['every', 'whether all, none, most or at least some number of the members of a group fit', 'Is everyone at Acme certified? Do most members hold a licence?'],
  ['when', 'when something held, since when, until when, or for how long', 'When did Ana work at Acme? How long has Ion lived in Cluj?'],
  ['why', 'why something is true: its reason or explanation', 'Why is Ana eligible?'],
  ['statement', 'nothing is asked: the user states a fact', 'Ana works at Acme.'],
  ['instruction', 'an instruction about how the assistant should answer from now on, stopping one, or which instructions are active', 'From now on start every answer with "OK:". Stop that. What are my instructions?'],
  ['self', 'about the assistant itself or its memory: who it is, what it can do, what it knows, a random fact or some examples', 'What do you know? What can you do? Tell me a random fact.'],
  ['none', 'nothing to look up: a greeting, thanks, or no request', 'Hello! Thanks.'],
]);

/** What a request of kind `self` asks about the assistant (one numbered question; the circuit is written by the system). */
export const SELF_ASPECTS = Object.freeze([
  ['describe', 'who or what the assistant is'],
  ['abilities', 'what the assistant can do'],
  ['topics', 'what the assistant knows about (its topics)'],
  ['size', 'how much its memory holds'],
  ['random_fact', 'one random fact'],
  ['examples', 'several facts or examples'],
]);

/** What a request of kind `instruction` asks (one numbered question; then the words are copied or the kind to stop is chosen). */
export const INSTRUCTION_ASPECTS = Object.freeze([
  ['prefix', 'start every answer with some words'],
  ['suffix', 'end every answer with some words'],
  ['short', 'give short answers'],
  ['detailed', 'give detailed answers'],
  ['formal', 'answer in a formal, professional tone from now on'],
  ['playful', 'answer in a playful, light tone from now on'],
  ['cancel', 'stop following an instruction given before'],
  ['list', 'say which instructions are active'],
]);

/** The instructions that can be set (and so stopped): every aspect but cancel and list. */
export const SETTABLE = Object.freeze(INSTRUCTION_ASPECTS.filter(([kind]) => kind !== 'cancel' && kind !== 'list'));

export const QUANTIFIERS = Object.freeze([
  ['all', 'all of them'], ['none', 'none of them'], ['most', 'most of them (more than half)'], ['not_all', 'not all of them'], ['half', 'exactly half of them'], ['at_least', 'at least a number of them'],
]);

export const CLAUSE_ROLES = Object.freeze([
  ['supposition', 'a supposition the question assumes (if, suppose, were)'],
  ['fact', 'a fact the user states'],
  ['time', 'a time limit for the question (before, after, when something happened)'],
  ['second', 'a second question'],
  ['same', 'part of the same question'],
  ['ignore', 'nothing to look up (a remark, a reason for asking)'],
]);

const numbered = list => list.map(([, text, examples], i) => `${i + 1}. ${text}${examples ? ` (for example: ${examples})` : ''}`).join('\n');
const choices = list => list.map((text, i) => `${i + 1}. ${text}`).join('\n');

/** The byte-identical start of the first user turn of methods B, C and D (prewarmed with the system message). */
/**
 * The cached prefix lists the first eight aspects; the later ones are listed in the checklist question itself, since a longer list in
 * the prefix shifted Qwen3-4B's first answer (2026-10-02: "Is X absent from the complete list ..." read as a quantified question).
 */
export const PREFIX_ASPECTS = 8;
export const PROTOCOL_PREFIX = `Kinds of answer a request can want:\n${numbered(KINDS)}\n\nParts a request can have:\n${numbered(ASPECTS.slice(0, PREFIX_ASPECTS))}\n\nThe user's request:\n<<<\n`;

export const q = {
  kind: message => `${PROTOCOL_PREFIX}${message}\n>>>\n\nWhich kind of answer from the list does the request want? Reply with the number only.`,
  optionNames: names => `Which names are the choices the request offers?\n${choices(names)}\n0. none\nReply with the numbers separated by commas.`,
  exclusionNames: names => `Which names does the request leave out (not, except, besides, other than)?\n${choices(names)}\n0. none\nReply with the numbers separated by commas.`,
  copyPart: what => `Copy ${what} of the request exactly as it is written, on one line. Reply with the copied words only, or 0 if there is none.`,
  parts: () => 'Copy each part of the request on its own line, exactly as it is written: first the main question, then every other part (a supposition, a fact the user states, a time limit, a second question). If the request is one part, copy it once.',
  supposition: part => `The request supposes "${part}". Does the question hold\n1. if that is true\n2. unless that is true\nReply with the number only.`,
  timeLink: part => `The request limits the time by "${part}". Is the question about the time\n1. before that\n2. after that\n3. when or while that holds\nReply with the number only.`,
  measure: () => `Which time does the request ask for?\n1. when (a point or period in time)\n2. since when (the start)\n3. until when (the end)\n4. how long (the duration)\nReply with the number only.`,
  clauseName: (clause, names) => `The request contains the part "${clause}". Which name is that part about?\n${choices(names)}\n0. none of these\nReply with the number only.`,
  clauseTruth: clause => `Does "${clause}" say that something holds or that it does not hold?\n1. it holds\n2. it does not hold\nReply with the number only.`,
  notHolding: lines => `The request says that something does NOT hold. Which statement is that?\n${choices(lines)}\n0. none of these\nReply with the number only.`,
  self: (message, other = null) => `The request is about the assistant itself: "${message}"\nWhat does it want?\n${SELF_ASPECTS.map(([, t], i) => `${i + 1}. ${t}`).join('\n')}${other ? `\n0. ${other}` : ''}\nReply with the number only.`,
  instruction: message => `The request gives an instruction about the answers: "${message}"\nWhat does it ask?\n${INSTRUCTION_ASPECTS.map(([, t], i) => `${i + 1}. ${t}`).join('\n')}\nReply with the number only.`,
  instructionStop: () => `Which instruction should be stopped?\n${SETTABLE.map(([, t], i) => `${i + 1}. ${t}`).join('\n')}\n0. all of them\nReply with the number only.`,
  kindAgain: kinds => `The message seems to ask for something. Which kind of answer does it want?\n${kinds.map(([, t], i) => `${i + 1}. ${t}`).join('\n')}\n0. none: there is nothing to look up\nReply with the number only.`,
  kindCheck: options => `Which of these fits the request better?\n${options.map(([, t], i) => `${i + 1}. ${t}`).join('\n')}\nReply with the number only.`,
  aspects: () => `Which parts from the list "Parts a request can have", or from these, does the request have?\n${ASPECTS.slice(PREFIX_ASPECTS).map(([, text], i) => `${PREFIX_ASPECTS + i + 1}. ${text}`).join('\n')}\nReply with the numbers separated by commas, or 0 for none.`,
  aspectCheck: (span, text) => `The request says "${span}". Is that ${text}?\n1. yes\n2. no\nReply with the number only.`,
  statements: (lines, more, what) => `The knowledge can hold these statements (A, B, C stand for names or values):\n${lines.join('\n')}${more ? `\n${lines.length + 1}. none of these; show other statements` : ''}\n0. none of these fits\n\nWhich statements does ${what} need? Pick as few as possible: usually the one statement that directly says what is asked (the knowledge applies its own rules); add another only for a separate condition or for a value to compare or limit. Reply with the numbers only, separated by commas.`,
  places: (statement, letters, options, note = '') => `${note}For the statement "${statement}", what are ${letters.join(' and ')} in the request?\nChoices:\n${choices(options)}\nReply with one line per letter, like "${letters[0]}: 1".`,
  truth: options => `Does the request ask\n${numbered(options)}\nReply with the number only.`,
  limitTarget: (span, options) => `The request has the limit "${span}". What does it limit?\n${choices(options)}\n0. nothing\nReply with the number only.`,
  limitKind: number => `Which limit does the request set with the number ${number}?\n${choices([`more than ${number} (above, over, after)`, `less than ${number} (below, under, before)`, `at least ${number}`, `at most ${number}`, `exactly ${number}`])}\n0. none\nReply with the number only.`,
  optionsTarget: (span, options) => `The request offers a choice: "${span}". Which unknown must be one of these named things?\n${choices(options)}\n0. none\nReply with the number only.`,
  exclusionTarget: (span, options) => `The request leaves out "${span}". Which unknown must not be that?\n${choices(options)}\n0. none\nReply with the number only.`,
  twoSided: (span, options) => `The request compares two things: "${span}". How are they compared?\n${choices(options)}\n0. they are not compared\nReply with the number only.`,
  nameLetter: (statement, letters, names) => `In the statement "${statement}", which letter is ${names}? Reply with the letter only.`,
  scope: lines => `Which of these statements must hold for each member of the group (the others say who belongs to the group)?\n${choices(lines)}\nReply with the number only.`,
  quantifier: () => `How many of the members does the request ask about?\n${numbered(QUANTIFIERS)}\nReply with the number only.`,
  chain: (statement) => `Does the request follow a chain of several "${statement}" links, one after another, or only one direct link?\n1. a chain of several links\n2. only one direct link\nReply with the number only.`,
  definition: () => `None of the statements says it directly. Can it be worked out from them?\n1. by following a chain of links from one thing to another\n2. by counting, for each group, the things in it\n3. by the fewest links needed to get from one thing to another\n0. no\nReply with the number only.`,
  stepStatement: lines => `Which statement is one link from one thing to the next?\n${choices(lines)}\nReply with the number only.`,
  pickName: (what, names) => `Which name is ${what}?\n${choices(names)}\nReply with the number only.`,
  clauseRole: (clause) => `The request contains the part "${clause}". What is that part?\n${numbered(CLAUSE_ROLES)}\nReply with the number only.`,
  clauseStatement: (clause, lines) => `Which statement says "${clause}"?\n${choices(lines)}\n0. none of these\nReply with the number only.`,
  clauseKind: clause => `The request also asks: "${clause}". Which kind of answer from the first list does that part want? Reply with the number only.`,
  contrast: options => `Which of these says what the request asks?\n${choices(options)}\n${options.length + 1}. neither\nReply with the number only.`,
  confirm: paraphrase => `The system understood the request as:\n"${paraphrase}"\nIs this what the request asks? Reply yes or no.`,
  wrongPart: parts => `Which part is wrong?\n${choices(parts)}\nReply with the number only.`,
  unusedName: (surface, lines) => `The request also names "${surface}". Which statement says something about it?\n${choices(lines)}\n0. none\nReply with the number only.`,
};
