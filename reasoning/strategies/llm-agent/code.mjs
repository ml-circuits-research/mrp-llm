/**
 * The `code` presentation of llm-agent (programming plan, milestone P0): the model gets one programming instruction and writes TWO SOP files,
 * `task.sop` (task facts and `test` wires) and `candidate.sop` (one `code` wire), in two labelled fenced blocks. The instruction text of
 * `skills/sop-wire-authoring/programming/TASK.md` is the prompt's rule set. The reply is parsed strictly into `{files}`; checking it (the
 * validator, the sandbox) is host work in `lib/programming/`. The prompt never contains a sealed test: the caller passes only the
 * instruction, the task symbol, the entry name, the visible examples and, in a repair round, the previous files with the host's report.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const CODE_SYSTEM_PROMPT = 'You are a careful JavaScript programmer and a precise writer of SOP wires. You write short, correct, dependency-free functions and the tests that show them.';
const here = path.dirname(fileURLToPath(import.meta.url));
const TASK_MD = path.resolve(here, '../../../skills/sop-wire-authoring/programming/TASK.md');

/** The vocabulary the host declares for every task circuit (the agent never declares these). */
export const TASK_VOCABULARY = `@task_kind predicate
  args subject:entity object:entity
  description "a task instance and the family it is an instance of"
@input_of predicate
  args subject:entity object:entity
  description "a task and the name of one of its parameters"
@returns predicate
  args subject:entity object:entity
  description "a task and the kind of value it returns"
@language predicate
  args subject:entity object:entity
  description "a task and the language of its program"
`;

export const taskText = () => fs.readFileSync(TASK_MD, 'utf8');

/** `{id, instruction, entry, examples?}` plus an optional `repair: {files, report}`. */
export function codePrompt({task, repair = null}) {
  const examples = (task.examples ?? []).length ? `\nExamples given with the instruction (the host also runs them as tests):\n${task.examples.map(e => `- ${e.call}  ->  ${e.expect}`).join('\n')}\n` : '';
  const fix = repair ? `\nPREVIOUS ATTEMPT (it did not pass; fix the cause and write both files again in full):\n\`\`\`task.sop\n${repair.files['task.sop'] ?? '(missing)'}\n\`\`\`\n\`\`\`candidate.sop\n${repair.files['candidate.sop'] ?? '(missing)'}\n\`\`\`\nHOST REPORT:\n${repair.report}\n` : '';
  return `${taskText().trim()}

---
THE TASK
Task symbol: ${task.id}
Function name (the entry): ${task.entry}
Instruction:
${task.instruction.trim()}
${examples}${fix}
Reply with the two fenced blocks \`task.sop\` and \`candidate.sop\` now.`;
}

/** Strict: exactly one block of each name. Returns {ok, files} or {ok: false, error}. */
export function parseCodeAnswer(text) {
  const files = {};
  for (const m of String(text).matchAll(/^```(task\.sop|candidate\.sop)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm)) {
    if (m[1] in files) return {ok: false, error: `two ${m[1]} blocks`};
    files[m[1]] = m[2] + '\n';
  }
  for (const name of ['task.sop', 'candidate.sop']) if (!(name in files)) return {ok: false, error: `no ${name} block (a fenced block labelled ${name})`};
  return {ok: true, files};
}
