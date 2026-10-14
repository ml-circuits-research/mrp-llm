/** Execute a row's target against the real runtime (data QA only): the verification world's facts and rules are
 * published as reviewed host knowledge, and the model target runs with model origin, so the host links its
 * strings to the verification lexicon exactly as it would at serving time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Repository } from '../../../memory/repository.mjs';
import { publishKnowledge } from '../../../sop/ingest.mjs';
import { Lexicon } from '../../../sop/lexicon.mjs';
import { Runtime } from '../../../sop/runtime.mjs';
import { rowWorld, verificationContext } from '../../../lib/row-world.mjs';

const summarize = result => {
  const packet = result?.result?.packet ?? result?.result ?? {};
  const status = packet.status ?? result?.result?.status ?? result?.status ?? 'error';
  const answers = (packet.answers ?? []).map(answer => Object.values(answer.binding ?? answer ?? {}));
  return { status, answers, ...(packet.count !== undefined ? { count: packet.count } : {}), ...(packet.hypothetical ? { hypothetical: true } : {}) };
};

/** Run one target. `row` supplies ontology_sop, setup_sop (early knowledge) and optional late_setup_sop. */
export async function executeTarget(row, target, { engine = 'scan', shared = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diversity-'));
  try {
    // The row's own world plus the shared blocks it references (lib/row-world.mjs).
    const full = rowWorld(row, { shared });
    row = { ...row, ontology_sop: full.ontology, setup_sop: full.setup, late_setup_sop: full.late };
    const lexicon = row.ontology_sop?.trim() ? new Lexicon(row.ontology_sop) : null;
    const world = [row.setup_sop, row.late_setup_sop].some(text => text?.trim());
    let repo = null, session = null;
    if (world) {
      repo = new Repository(directory, { memory: { engine } });
      if (row.setup_sop?.trim()) publishKnowledge(repo, 'world', row.setup_sop, { schema: lexicon.predicates, reviewed: true, knownAt: Date.parse('2023-06-01T00:00:00Z') });
      if (row.late_setup_sop?.trim()) publishKnowledge(repo, 'world', row.late_setup_sop, { schema: lexicon.predicates, reviewed: true, knownAt: Date.parse('2025-06-01T00:00:00Z') });
      session = repo.session('world', 'reader', 'evaluation');
    }
    const runtime = new Runtime({ repo, session, lexicon, schema: lexicon?.predicates ?? null, now: Date.parse(verificationContext(row).now), policy: { allowWrite: false, reinforce: false } });
    const result = await runtime.run(target, { origin: 'model', inputText: row.question, language: row.language });
    return summarize(result);
  } catch (error) {
    return { status: 'error', error: String(error.message ?? error).slice(0, 300) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
