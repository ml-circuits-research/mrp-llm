/**
 * What every smoke adapter shares: the error a strategy raises when a circuit needs a feature it declares unsupported (the harness
 * reports `not_expressible`, the circuit is never weakened) and the private solver binaries of the repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export class NotExpressible extends Error {}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

/** Point a run at the private solver binaries (already on disk under tools/.solvers) when none is on PATH. */
export function solverEnv() {
  const env = {...process.env};
  const swi = path.join(repo, 'tools/.solvers/swi/swipl'), z3 = path.join(repo, 'tools/.solvers/z3/bin/z3');
  if (!env.SWIPL_BIN && fs.existsSync(swi)) env.SWIPL_BIN = swi;
  if (!env.Z3_BIN && fs.existsSync(z3)) env.Z3_BIN = z3;
  return env;
}
