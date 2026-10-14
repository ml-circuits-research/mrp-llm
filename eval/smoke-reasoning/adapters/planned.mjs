/**
 * Adapter stubs for strategies that do not exist in reasoning/ yet (none today: `neural-assist` was removed on 2026-10-01, there is no evidence for it). Each stub documents the feature coverage the
 * strategy is expected to reach (`supports`) and how it would consume the standardized circuits (`lowering`); run()
 * is never called because the harness reports `planned` (the harness also prints the DECLARED coverage per case:
 * "exp" = every required feature is declared, "n/e" = a required feature is declared unsupported).
 * Round 2: the Z3 stub lowers explicit negation to two relations (p_pos and p_neg), uses completion only for
 * NON-recursive predicates and declares `recursion` unsupported; the modes-of-work features are declared per strategy.
 */
const planned = (id, origin, description, lowering, supports, extra = {}) => ({id, status: 'planned', origin, description, lowering, supports: new Set(supports), async available() { return {ok: false, reason: 'planned'}; }, async run() { throw new Error('planned adapter'); }, ...extra});

/**
 * Private comparison binaries (tools/.solvers/<name>, env CLINGO_BIN / SOUFFLE_BIN, PATH as fallback). `available()` reports
 * whether the executable is present with its version and path; the strategy stays `planned` for running cases until its lowering exists.
 */
const probeBinary = (envVar, privatePath, name) => async () => {
  const {spawnSync} = await import('node:child_process');
  const {existsSync} = await import('node:fs');
  const {fileURLToPath} = await import('node:url');
  const priv = fileURLToPath(new URL('../../../' + privatePath, import.meta.url));
  const command = process.env[envVar] || (existsSync(priv) ? priv : name);
  const r = spawnSync(command, ['--version'], {encoding: 'utf8', timeout: 5000});
  if (r.status !== 0) return {ok: false, reason: `${name} binary not available (${envVar} or ${privatePath})`, binary: {available: false, command}};
  const version = ((r.stdout || '') + (r.stderr || '')).split('\n').map(l => l.trim()).find(l => /version/i.test(l)) ?? '';
  return {ok: true, version, path: command, binary: {available: true, version, path: command}};
};

const HORN = ['facts', 'select', 'open_world', 'classical_negation', 'rules', 'recursion', 'conflict', 'count', 'every', 'exists', 'conjunction', 'explain', 'used', 'whatif', 'epistemic_status', 'budget', 'temporal', 'interval', 'versions', 'zero_arity', 'time_vars'];
const NAF = ['naf', 'closed_world', 'closed_derived', 'compute_in_rules', 'compare_in_rules', 'aggregate', 'default', 'overrides', 'strict_contrary', 'integrity'];
const MODES = ['overrides', 'method', 'htn_choice', 'on_failure', 'norms_hard', 'norms_soft', 'temporal_norms', 'procedures', 'procedure_render', 'amendment', 'check_plan', 'blocked_info', 'abduce_waive', 'binding_advisory', 'norm_conflict', 'conform_asof', 'conform_deviation'];

/** No strategy is planned: every strategy of the proposal exists, was pruned (2026-10-01) or is deferred without evidence. */
export const plannedAdapters = [];
