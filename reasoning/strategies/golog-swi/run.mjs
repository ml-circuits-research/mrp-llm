/**
 * One Prolog run of golog-swi: the generated world, the data, golog.pl, and a task goal; the JSON line it prints is the result.
 * The wall limit is the host's (the process is killed, reason `wall`; see prolog-tabling/index.mjs for why not call_with_time_limit),
 * the probe limit is call_with_inference_limit.
 */
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {runSwipl} from '../prolog-tabling/swipl.mjs';
import {ProgramError, NotExpressibleError} from '../js-reference/values.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(here, '../prolog-tabling/runtime.pl');
const GOLOG = path.join(here, 'golog.pl');

/** Map a Prolog error of the runtime to the error classes of the strategy interface. */
function fail(text) {
  const m = /(norm_unbound_variable|norm_qualifier_unsupported|method_forms_not_checked|unknown_action)\(([^)]*)\)/.exec(text);
  if (m && m[1] === 'unknown_action') throw new ProgramError('unknown_action', `the trace step ~${m[2]} names no action (or with another number of arguments)`);
  if (m) throw new NotExpressibleError([m[1] === 'method_forms_not_checked' ? 'conform_deviation' : 'temporal_norms'], `golog-swi: ${m[0]}`);
  throw new ProgramError('prolog_failed', `swipl: ${text}`);
}

/** `taskGoal` is a Prolog goal that prints nothing itself: it ends with gl_emit(D). Returns {data} or {exhausted}. */
export function runGolog({text, taskGoal, limits}) {
  if (process.env.GOLOG_SWI_DUMP) fs.writeFileSync(process.env.GOLOG_SWI_DUMP, text + '\n% goal: ' + taskGoal + '\n');
  const goal = `gl_run(${Math.floor(limits.infer)}, (${taskGoal}))`;
  const r = runSwipl({text, goal, files: [RUNTIME, GOLOG], wallMs: limits.wallMs + 300});
  if (r.timedOut) return {exhausted: 'wall'};
  if (!r.ok) fail(r.stderr);
  const {status, result, error} = r.json;
  if (status === 'probes') return {exhausted: 'probes'};
  if (status === 'error') fail(error);
  if (status !== 'done') throw new ProgramError('prolog_failed', `swipl returned ${status}: ${r.stderr}`);
  return {data: result};
}
