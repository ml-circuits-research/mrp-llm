/**
 * The behaviour of one conversation (DS023 "Behaviour layer", experiments/proposal/behaviour-layer.md): the user's standing
 * instructions, the turn counter and the last time each kind of reaction was used. It is caller-owned conversation state, persisted
 * with the conversation (server/session-store.mjs), and it only feeds the reasoner: code maps it to facts and to SOP data and never
 * chooses a reply.
 *
 *   emptyBehaviour()                                  -> {turn, instructions, history, reactions, slots}
 *   applyInstructions(state, instructions, clock)     -> {facts, slots, changes}: set, cancel and list, recorded in the state
 *   overlayOf(state)                                  -> SOP text: one reply wire and one rule (origin user) per active instruction
 *   timeFacts(state, layerData, clock)                -> cv_turn_number, cv_turns_since, cv_seconds_since facts
 *   recordReactions(state, reply, layerData, clock)   the situations used by this reply (and their reaction kinds) are noted
 *   personalFacts(state, signals, layerData, clock)   -> {facts, slots}: the user's name (kept from an act that sets a slot) and the
 *                                                       time of day (P-2.3)
 *
 * An instruction set by the user is behaviour data: a `reply` wire whose text is the user's own words and a `rule` that makes it
 * applicable on every turn (or a rule deriving a style). The JS oracle reads them with the conversation layer, so "from now on start
 * with ..." is followed because the layer's reasoning derives it, and "stop ..." withdraws the wires.
 */
import {INSTRUCTION_TEXT_KINDS, INSTRUCTION_STYLE_KINDS} from '../../sop/enums.mjs';
import {line, joinList} from '../../sop/replies.mjs';
import {messageActs} from '../../sop/message-acts.mjs';

const MAX_HISTORY = 40;
/** Styles and registers that exclude each other: setting one withdraws the other. */
const EXCLUSIVE = {short: 'detailed', detailed: 'short', formal: 'playful', playful: 'formal'};

export const emptyBehaviour = () => ({turn: 0, instructions: [], history: [], reactions: {}, slots: {}});

/** The behaviour state of a conversation context, created on first use (older saved conversations have none). */
export function behaviourOf(context) {
  context.behaviour ??= emptyBehaviour();
  for (const [key, value] of Object.entries(emptyBehaviour())) context.behaviour[key] ??= value;
  return context.behaviour;
}

/** The description of an instruction, from the layer's lines ("start my answers with "I'm here:""). */
export const describeInstruction = i => line('instruction_' + i.kind, {text: i.text ?? ''});

/**
 * Applies this turn's `instruction` wires (packet.instructions) to the state. Returns the facts of their outcome (cv_turn_instruction_set,
 * cv_turn_instruction_cancelled, cv_turn_instruction_missing, cv_turn_instructions_listed, cv_turn_instructions_none) and the slots
 * `instruction` (the instruction set or withdrawn) and `instructions` (the active ones, as a list).
 */
export function applyInstructions(state, instructions = [], {turn, at}) {
  const facts = [], changes = [];
  let subject = null;
  for (const wire of instructions) {
    if (wire.do === 'set') {
      if (wire.text && /\{\{|\}\}/.test(wire.text)) continue;
      const withdrawn = state.instructions.filter(i => i.kind === wire.kind || i.kind === EXCLUSIVE[wire.kind]);
      for (const old of withdrawn) close(state, old, {turn, at});
      const id = `ui${state.history.length + 1}`;
      const added = {id, kind: wire.kind, ...(INSTRUCTION_TEXT_KINDS.includes(wire.kind) ? {text: wire.text} : {}), set: {turn, at}};
      state.instructions.push(added);
      state.history.push({...added});
      facts.push(`cv_turn_instruction_set ${wire.kind}`);
      changes.push({do: 'set', id, kind: wire.kind, text: added.text ?? null, replaced: withdrawn.map(w => w.id)});
      subject = added;
    } else if (wire.do === 'cancel') {
      const matching = state.instructions.filter(i => !wire.kind || i.kind === wire.kind);
      if (!matching.length) { facts.push('cv_turn_instruction_missing'); changes.push({do: 'cancel', kind: wire.kind, found: 0}); continue; }
      for (const old of matching) close(state, old, {turn, at});
      facts.push(matching.length > 1 ? 'cv_turn_instructions_cancelled' : `cv_turn_instruction_cancelled ${matching[0].kind}`);
      changes.push({do: 'cancel', kind: wire.kind, ids: matching.map(m => m.id)});
      subject = matching.length === 1 ? matching[0] : subject;
    } else if (wire.do === 'list') {
      facts.push(state.instructions.length ? 'cv_turn_instructions_listed' : 'cv_turn_instructions_none');
      changes.push({do: 'list', active: state.instructions.length});
    }
  }
  for (const i of state.instructions) facts.push(`cv_instruction_active ${i.kind}`);
  const slots = {
    ...(subject ? {instruction: describeInstruction(subject)} : {}),
    ...(state.instructions.length ? {instructions: joinList(state.instructions.map(describeInstruction))} : {}),
  };
  return {facts, slots, changes};
}

function close(state, instruction, {turn, at}) {
  state.instructions = state.instructions.filter(i => i !== instruction);
  const record = state.history.find(h => h.id === instruction.id);
  if (record) record.cancelled = {turn, at};
  if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
}

/**
 * The active instructions as SOP data of the conversation layer: a text instruction is a reply wire of its own situation (part prefix
 * or suffix, the user's verbatim words) with a rule that makes it applicable on every turn and a priority; a style instruction is a
 * rule deriving the style; a register is derived by the layer itself from the active instruction. Origin: the user.
 */
export function overlayOf(state) {
  const wires = [];
  for (const i of state.instructions) {
    const situation = `user_${i.id}`;
    if (INSTRUCTION_TEXT_KINDS.includes(i.kind)) {
      wires.push(`@cv_${i.id}_reply reply\n  situation ${situation}\n  part ${i.kind}\n  language en\n  text ${JSON.stringify(i.text)}\n  source "user instruction ${i.id} (turn ${i.set.turn})"`);
      wires.push(`@cv_${i.id}_rule rule\n  when cv_turn_language ?l\n  then cv_applies ${situation}\n  source "user instruction ${i.id}"`);
      wires.push(`@cv_${i.id}_priority fact\n  holds cv_situation_priority ${situation} 100`);
    } else if (INSTRUCTION_STYLE_KINDS.includes(i.kind)) {
      wires.push(`@cv_${i.id}_rule rule\n  when cv_turn_language ?l\n  then cv_style ${i.kind}\n  source "user instruction ${i.id}"`);
    }
    // A register instruction (formal, playful) needs no wire: the layer derives cv_register from cv_instruction_active (P-2.2).
  }
  return wires.join('\n\n') + (wires.length ? '\n' : '');
}

/**
 * Time facts of the turn: its number; for every reaction already used (a situation, or the reaction kind the layer gives it) the turns
 * and seconds since; for every drive of the layer not used yet, the turns since the start of the conversation.
 */
export function timeFacts(state, {drives = []} = {}, {turn, at}) {
  const facts = [`cv_turn_number ${turn}`];
  const seen = new Set();
  for (const [key, r] of Object.entries(state.reactions)) {
    facts.push(`cv_turns_since ${key} ${turn - r.turn}`, `cv_seconds_since ${key} ${Math.max(0, Math.round((at - r.at) / 1000))}`);
    seen.add(key);
  }
  for (const d of drives) if (!seen.has(d)) facts.push(`cv_turns_since ${d} ${turn}`);
  return facts;
}

/** Notes the situations the reply used (and their reaction kinds) as the last reaction of that kind. */
export function recordReactions(state, reply, {reactionKinds = new Map()} = {}, {turn, at}) {
  for (const part of Object.values(reply ?? {})) {
    if (!part?.situation) continue;
    state.reactions[part.situation] = {turn, at};
    const kind = reactionKinds.get(part.situation);
    if (kind) state.reactions[kind] = {turn, at};
  }
}

/**
 * The personal facts and slots of a turn (P-2.3). The user's name: a pragmatic signal of this turn whose act fills a slot
 * (cv_act_sets_slot, e.g. `introduction` with the copied name as its span) is kept in the conversation's state; every turn with a kept
 * name gets `cv_turn_user_name` and the slot `user_name`. The time of day: the part of the day of the turn's clock by the layer's
 * cv_day_part_starts data gives `cv_turn_time_of_day PART` and the slot `time_of_day`. Nothing is known: no fact and no slot, so the
 * personal replies are simply not applicable.
 */
export function personalFacts(state, signals = [], {dayParts = []} = {}, {at}) {
  state.slots ??= {};
  const acts = messageActs();
  for (const s of signals) {
    const slot = acts.acts.get(s.kind)?.slot;
    const value = typeof s.span === 'string' ? s.span.trim() : '';
    if (slot && value && value.length <= 80 && !/\{\{|\}\}/.test(value)) state.slots[slot] = value;
  }
  const facts = [], slots = {};
  if (state.slots.user_name) { facts.push('cv_turn_user_name'); slots.user_name = state.slots.user_name; }
  if (dayParts.length && Number.isFinite(at)) {
    const hour = new Date(at).getHours();
    const part = [...dayParts].reverse().find(p => p.hour <= hour)?.part ?? dayParts.at(-1).part;
    facts.push(`cv_turn_time_of_day ${part}`);
    slots.time_of_day = part;
  }
  return {facts, slots};
}
