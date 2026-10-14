/**
 * The host-side records of dreaming (proposal 5.6; E10 `EpisodeJournal`, `VerifiedSkillStore`, VRC `LearnedRegistry`):
 *
 *   episode      {id, task, family, schema, status, cost, ms, plan}            nothing about the content of the answer
 *   skill        {id, kind, scope, contract, certificateKind, semanticContract, evidence, objective, status, history}
 *                status: candidate | promoted | rejected | quarantined | revoked | advisory
 *   certificate  {skill, kind, verified, tasks, referenceScore, candidateScore, contract, at}
 *   plan         {id, family, schema, skills, settings, status: active | retired, frozen: true}   the deployment plan
 *   negative     key = kind + scope + learner version + budget -> what was tried and failed
 *   advisory     an empirical invariant (for example a functional dependency): suggests, never prunes
 *
 * Status rules (VRC): a shadow disagreement REVOKES, and a revoked skill is not promoted again by dreaming (only an explicit
 * `allowRevoked`); a contract that no longer matches QUARANTINES the skill for its scope (it may be re-certified later).
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export const SKILL_STATUS = ['candidate', 'promoted', 'rejected', 'quarantined', 'revoked', 'advisory'];
export const hash = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const now = () => new Date().toISOString();

const ALLOWED = {
  candidate: ['promoted', 'rejected', 'revoked'],
  promoted: ['quarantined', 'revoked'],
  quarantined: ['candidate', 'promoted', 'revoked'],
  rejected: ['candidate'],
  revoked: [],
  advisory: ['revoked']
};

export class DreamStore {
  constructor(dir = null) {
    this.dir = dir;
    this.episodes = []; this.skills = []; this.certificates = []; this.plans = []; this.negative = {}; this.tasks = {};
    this.serial = 0;
    if (dir && fs.existsSync(path.join(dir, 'dream-store.json'))) Object.assign(this, JSON.parse(fs.readFileSync(path.join(dir, 'dream-store.json'), 'utf8')), {dir});
  }

  save() {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, {recursive: true});
    const tmp = path.join(this.dir, `.dream-store.${randomUUID()}.tmp`);
    const {dir, ...data} = this;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n');
    fs.renameSync(tmp, path.join(this.dir, 'dream-store.json'));
  }

  addEpisode(e) { const rec = {id: `ep${++this.serial}`, at: now(), ...e}; this.episodes.push(rec); return rec; }

  /** Keep the text of a task so that dreaming can replay it (VRC: the contract file next to the trace). Small tasks only. */
  keepTask(id, task) { this.tasks[id] = task; }

  addSkill({kind, scope, contract, certificateKind = 'shadow-equivalence', semanticContract = 'exact answer preservation', evidence = [], objective = 'probes', artifact, status = 'candidate'}) {
    const rec = {id: `sk${++this.serial}-${hash({kind, scope, artifact}).slice(0, 8)}`, kind, scope, contract, certificateKind, semanticContract, evidence, objective, artifact, status, at: now(), history: [{event: 'created', status}]};
    this.skills.push(rec);
    return rec;
  }

  skill(id) { const s = this.skills.find(x => x.id === id); if (!s) throw new Error(`unknown skill ${id}`); return s; }

  setStatus(id, status, note = '', {allowRevoked = false} = {}) {
    const s = this.skill(id);
    if (s.status === 'revoked' && !allowRevoked) throw new Error(`skill ${id} is revoked: only an explicit operator approval re-opens it`);
    if (!(s.status === 'revoked' && allowRevoked) && !ALLOWED[s.status].includes(status)) throw new Error(`skill ${id}: ${s.status} -> ${status} is not a legal transition`);
    s.status = status;
    s.history.push({event: 'status', status, note, at: now()});
    return s;
  }

  addCertificate(c) { const rec = {at: now(), ...c}; this.certificates.push(rec); return rec; }

  addPlan({family, schema, skills, settings = {}}) {
    for (const p of this.plans) if (p.family === family && p.status === 'active') { p.status = 'retired'; p.retiredFor = 'replaced'; }
    const rec = {id: `plan${++this.serial}`, family, schema, skills, settings, frozen: true, status: 'active', at: now()};
    this.plans.push(rec);
    return rec;
  }

  activePlan(family) { return this.plans.find(p => p.family === family && p.status === 'active') ?? null; }

  retirePlan(id, why) { const p = this.plans.find(x => x.id === id); p.status = 'retired'; p.retiredFor = why; return p; }

  static negativeKey(kind, scope, learner, budget) { return hash({kind, scope, learner, budget}); }
  hasNegative(key) { return key in this.negative; }
  addNegative(key, detail) { this.negative[key] = {at: now(), ...detail}; }

  /** The journal groups of a family: its episodes (with kept tasks) for dreaming. */
  familyEpisodes(family) { return this.episodes.filter(e => e.family === family); }
}
