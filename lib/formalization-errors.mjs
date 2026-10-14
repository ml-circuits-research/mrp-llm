/**
 * The formalization error inbox (AGENTS.md "Formalization improvement"): every case where a message was formalized into a wrong,
 * invalid or missing circuit is appended here, from any source (eval harnesses, Ploinky job plugins, agents, the chat audit), for the
 * formalization improver. Append-only JSONL under state/ (operational, gitignored); the improver turns cases into its regression set.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INBOX = path.join(ROOT, 'state/formalization-errors/inbox.jsonl');

/** Kinds: parse_failed (no valid circuit after repairs), invalid (validator refused), wrong (a circuit that executes to a wrong
 * answer), unclear (asked back although the message was clear), missing_construct (the language could not express it). */
export const ERROR_KINDS = Object.freeze(['parse_failed', 'invalid', 'wrong', 'unclear', 'missing_construct']);

export function reportFormalizationError({source, kind, message, strategy = null, tier = null, circuit = null, expected = null, detail = null, ref = null}, {file = INBOX, now = () => new Date()} = {}) {
  if (!source || !message) throw new Error('reportFormalizationError: source and message are required');
  if (!ERROR_KINDS.includes(kind)) throw new Error(`reportFormalizationError: kind must be one of ${ERROR_KINDS.join(', ')}`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const row = {t: now().toISOString(), source, kind, message, strategy, tier, circuit, expected, detail, ref};
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}
