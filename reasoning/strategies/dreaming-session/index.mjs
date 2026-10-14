/**
 * dreaming-session: NOT a strategy. A wrapper around any exact strategy that consolidates experience offline ("dreaming", E10
 * `Dreamer` and VRC `consolidate`) and deploys a frozen plan online. It has no coverage of its own: it inherits the wrapped
 * strategy's declared capabilities, and its smoke adapter runs the wrapped strategy.
 *
 *   ask(problem, budget, options)   problem = {theory: text | {knowledge}, query}. Looks up the active deployment plan of the query
 *                                   family; applies it only if the schema cone still matches its contract (otherwise the plan is
 *                                   retired, its skills quarantined or revoked, and the wrapped strategy answers plainly); records
 *                                   an episode; with options.shadow (or shadowEvery) also runs the reference and REVOKES on a
 *                                   disagreement, returning the reference answer.
 *   dream(budget)                   offline: replay the journal of hot families, propose skills (join order; `propose` takes any
 *                                   candidate skill), certify each by shadow replay on training and held-out tasks, promote the
 *                                   verified ones, compose ONE deployment plan per family (a skill that passed alone is deployed
 *                                   only if the composition does not cost more), keep failures in the negative cache.
 *   revoke(skillId, why), quarantine(skillId, why), state()   the lifecycle.
 *
 * Learned parts only choose among legal plans and never decide an answer. The gain is reported honestly: probes (the wrapped
 * engine's units) fall by the ratio the certificate records, wall clock by less (E10: probe gains far larger than wall gains).
 */
import {performance} from 'node:perf_hooks';
import {DreamStore, hash} from './records.mjs';
import {familyOf, coneOf, joinCandidates, applySkills, readWires, StaleSkillError} from './rewrite.mjs';
import {certify, score, probesOf, sameAnswer} from './gate.mjs';
import {NotExpressibleError} from '../js-reference/values.mjs';

export {NotExpressibleError};
export {DreamStore};

export const LEARNER_VERSION = 'dream/1';

const knowledgeText = theory => (typeof theory === 'string' ? theory : theory?.knowledge ?? null);

/** Capabilities of the wrapper: the wrapped strategy's, plus the wrapper marker. */
export function wrapCapabilities(inner) {
  const c = inner.capabilities ?? inner;
  return {...c, id: 'dreaming-session', wrapper: true, wraps: c.id, provides: [...new Set([...(c.provides ?? []), 'dream'])]};
}

export function dreamingSession(inner, {store = new DreamStore(), shadowEvery = 0, roundWeight = 32, minGain = 0.03, learner = LEARNER_VERSION} = {}) {
  let asks = 0;

  const innerAsk = (theoryText, query, budget) => inner.ask({theory: {knowledge: theoryText}, query}, budget);

  const skillsOf = plan => plan.skills.map(id => store.skill(id));

  /** Re-certify on load: the cone contract of the current circuits must equal the contract of every skill of the plan. */
  function loadPlan(plan, cone) {
    const stale = skillsOf(plan).filter(s => s.contract !== cone.contract);
    if (!stale.length) return {ok: true};
    for (const s of stale) if (s.status === 'promoted') store.setStatus(s.id, 'quarantined', 'schema cone changed');
    store.retirePlan(plan.id, 'schema_change');
    return {ok: false, why: 'schema_change', stale: stale.map(s => s.id)};
  }

  function revokePlan(plan, why) {
    for (const s of skillsOf(plan)) if (!['revoked', 'rejected'].includes(s.status)) store.setStatus(s.id, 'revoked', why);
    store.retirePlan(plan.id, why);
    store.save();
  }

  function ask(problem, budget = {}, options = {}) {
    const t0 = performance.now();
    const text = knowledgeText(problem.theory);
    asks++;
    if (text === null || problem.handle) return {...inner.ask(problem, budget), dream: {plan: null, why: 'handle or non-text theory: passed through'}};
    const family = familyOf(problem.query);
    const cone = coneOf(text, problem.query);
    let plan = family && cone ? store.activePlan(family) : null;
    let event = null;
    if (plan) {
      const loaded = loadPlan(plan, cone);
      if (!loaded.ok) { event = loaded.why; plan = null; }
    }
    let deployedText = text;
    if (plan) {
      try { deployedText = applySkills(cone.wires, skillsOf(plan)); } catch (e) {
        if (!(e instanceof StaleSkillError)) throw e;
        for (const s of skillsOf(plan)) if (s.status === 'promoted') store.setStatus(s.id, 'quarantined', e.message);
        store.retirePlan(plan.id, 'inapplicable');
        event = 'inapplicable'; plan = null;
      }
    }
    const t1 = performance.now();
    let packet = innerAsk(deployedText, problem.query, budget);
    const wall = performance.now() - t1;
    let reference = null;
    const wantShadow = plan && (options.shadow || (shadowEvery > 0 && asks % shadowEvery === 0));
    if (wantShadow) {
      const t2 = performance.now();
      reference = innerAsk(text, problem.query, budget);
      reference._wall = performance.now() - t2;
      const same = sameAnswer(reference, packet);
      if (!same.ok && reference.complete !== false) {
        revokePlan(plan, `shadow disagreement: ${same.why.join('; ')}`);
        event = 'shadow_revoked';
        packet = reference;
        plan = null;
      }
    }
    const taskId = hash({text, q: problem.query});
    if (family && cone) {
      store.keepTask(taskId, {id: taskId, knowledge: text, query: problem.query});
      store.addEpisode({task: taskId, family, schema: cone.contract, status: packet.status, cost: {probes: probesOf(packet), rounds: packet.budget?.used?.maxRounds ?? 0}, ms: Math.round(wall), plan: plan?.id ?? null, ...(event ? {event} : {})});
    }
    return {
      ...packet,
      dream: {family, plan: plan?.id ?? null, ...(event ? {event} : {}), probes: probesOf(packet), ms: Math.round(wall), ...(reference ? {reference: {probes: probesOf(reference), ms: Math.round(reference._wall)}} : {})},
      timings: {...(packet.timings ?? {}), total: Math.round(performance.now() - t0)}
    };
  }

  /** Certify a candidate skill (alone) on training tasks and held-out tasks; returns the certificate record. */
  function certifySkill(skill, tasks) {
    const cut = tasks.length < 3 ? tasks.length : Math.max(1, Math.floor(tasks.length * 2 / 3));
    const train = tasks.slice(0, cut), holdout = tasks.length < 3 ? tasks : tasks.slice(cut);
    const run = (task, rewritten) => innerAsk(rewritten ? applySkills(readWires(task.knowledge), [skill]) : task.knowledge, task.query, {});
    const a = certify(run, train, {roundWeight}), b = certify(run, holdout, {roundWeight});
    const verified = a.verified && b.verified;
    const refScore = (a.referenceScore ?? 0) + (b.referenceScore ?? 0), candScore = (a.candidateScore ?? 0) + (b.candidateScore ?? 0);
    return store.addCertificate({skill: skill.id, kind: skill.certificateKind, verified, tasks: (a.tasks ?? 0) + (b.tasks ?? 0), referenceScore: refScore, candidateScore: candScore, gain: refScore ? 1 - candScore / refScore : 0, contract: skill.contract, ms: {reference: (a.ms?.reference ?? 0) + (b.ms?.reference ?? 0), candidate: (a.ms?.candidate ?? 0) + (b.ms?.candidate ?? 0)}, ...(verified ? {} : {disagreement: a.disagreement ?? b.disagreement})});
  }

  /** Offer an externally proposed candidate skill (for example a learned lemma): it passes the same gate or is rejected. */
  function propose(family, {kind, artifact, scope = null}) {
    const eps = store.familyEpisodes(family);
    const tasks = [...new Map(eps.map(e => [e.task, store.tasks[e.task]]).filter(([, t]) => t)).values()];
    const cone = tasks.length ? coneOf(tasks[0].knowledge, tasks[0].query) : null;
    if (!cone) return {status: 'rejected', why: 'no replayable task'};
    const negKey = DreamStore.negativeKey(kind, hash(artifact), learner, {minGain});
    if (store.hasNegative(negKey)) return {status: 'rejected', why: 'negative cache'};
    const skill = store.addSkill({kind, scope: scope ?? [...cone.preds], contract: cone.contract, evidence: eps.map(e => e.id), artifact});
    const cert = certifySkill(skill, tasks);
    if (!cert.verified) { store.setStatus(skill.id, 'rejected', `gate: ${cert.disagreement?.why?.join('; ')}`); store.addNegative(negKey, {skill: skill.id, why: cert.disagreement}); store.save(); return {status: 'rejected', skill: skill.id, certificate: cert}; }
    if (cert.gain < minGain) { store.setStatus(skill.id, 'rejected', `gain ${cert.gain.toFixed(3)} below ${minGain}`); store.addNegative(negKey, {skill: skill.id, why: 'no gain'}); store.save(); return {status: 'rejected', skill: skill.id, certificate: cert}; }
    store.setStatus(skill.id, 'promoted', `verified, gain ${(cert.gain * 100).toFixed(1)}%`);
    store.save();
    return {status: 'promoted', skill: skill.id, certificate: cert};
  }

  /** The offline pass. `minTasks`, `minScore`: a family is hot enough to dream about. */
  function dream({minTasks = 3, minScore = 200, maxFamilies = 8} = {}) {
    const report = {learner, promoted: [], rejected: [], skipped: [], plans: [], advisories: []};
    const families = [...new Set(store.episodes.map(e => e.family))];
    const hot = families.map(f => ({f, eps: store.familyEpisodes(f)})).sort((a, b) => b.eps.reduce((s, e) => s + e.cost.probes, 0) - a.eps.reduce((s, e) => s + e.cost.probes, 0));
    let n = 0;
    for (const {f, eps} of hot) {
      const total = eps.reduce((s, e) => s + e.cost.probes + roundWeight * e.cost.rounds, 0);
      const tasks = [...new Map(eps.map(e => [e.task, store.tasks[e.task]]).filter(([, t]) => t)).values()];
      if (eps.length < minTasks || total < minScore || !tasks.length) { report.skipped.push({family: f, episodes: eps.length, why: 'not hot enough'}); continue; }
      if (++n > maxFamilies) { report.skipped.push({family: f, why: 'pass budget'}); continue; }
      const cone = coneOf(tasks[0].knowledge, tasks[0].query);
      if (!cone) { report.skipped.push({family: f, why: 'outside the core'}); continue; }
      const promoted = [];
      for (const c of joinCandidates(cone)) {
        const negKey = DreamStore.negativeKey('join_order', hash(c), learner, {minGain});
        if (store.hasNegative(negKey)) { report.skipped.push({family: f, rule: c.rule, why: 'negative cache'}); continue; }
        const r = propose(f, {kind: 'join_order', artifact: c, scope: [c.rule]});
        (r.status === 'promoted' ? (promoted.push(r.skill), report.promoted) : report.rejected).push({family: f, rule: c.rule, skill: r.skill, gain: r.certificate?.gain});
      }
      advisories(cone, f, report);
      if (promoted.length) {
        const composed = compose(f, cone, tasks, promoted);
        if (composed) report.plans.push(composed);
      }
    }
    store.save();
    return report;
  }

  /** SkillComposer (E10 Z16): deploy the subset of promoted skills whose composition does not cost more than the best part alone. */
  function compose(family, cone, tasks, skillIds) {
    const skills = skillIds.map(id => store.skill(id));
    const costOf = set => tasks.reduce((s, t) => { try { return s + score(innerAsk(applySkills(readWires(t.knowledge), set), t.query, {}), roundWeight); } catch { return Infinity; } }, 0);
    const base = costOf([]);
    let chosen = [], best = base;
    for (const s of [...skills].sort((a, b) => costOf([a]) - costOf([b]))) {
      const trial = costOf([...chosen, s]);
      if (trial < best) { chosen = [...chosen, s]; best = trial; }
    }
    if (!chosen.length) return null;
    const plan = store.addPlan({family, schema: cone.contract, skills: chosen.map(s => s.id), settings: {learner}});
    return {plan: plan.id, family, skills: chosen.map(s => s.id), baseScore: base, plannedScore: best};
  }

  /** Z17: an empirical functional dependency is an ADVISORY record, never deployed and never pruning. */
  function advisories(cone, family, report) {
    const byPred = new Map();
    for (const f of cone.program.facts) if (f.args.length === 2 && !f.neg) { const m = byPred.get(f.p) ?? new Map(); m.set(f.args[0], (m.get(f.args[0]) ?? 0) + 1); byPred.set(f.p, m); }
    for (const [p, m] of byPred) if (m.size >= 20 && [...m.values()].every(n => n === 1) && !store.skills.some(s => s.status === 'advisory' && s.artifact?.predicate === p && s.contract === cone.contract)) {
      const rec = store.addSkill({kind: 'functional_dependency', scope: [p], contract: cone.contract, certificateKind: 'observed', semanticContract: 'suggests a `key` declaration; never prunes', artifact: {predicate: p, position: 1}, status: 'advisory'});
      report.advisories.push({family, skill: rec.id, predicate: p});
    }
  }

  const revoke = (id, why = 'operator') => { store.setStatus(id, 'revoked', why); for (const p of store.plans) if (p.status === 'active' && p.skills.includes(id)) store.retirePlan(p.id, 'skill_revoked'); store.save(); };
  const quarantine = (id, why = 'operator') => { store.setStatus(id, 'quarantined', why); for (const p of store.plans) if (p.status === 'active' && p.skills.includes(id)) store.retirePlan(p.id, 'skill_quarantined'); store.save(); };
  const state = () => ({episodes: store.episodes.length, skills: store.skills.map(s => ({id: s.id, kind: s.kind, status: s.status})), plans: store.plans.map(p => ({id: p.id, status: p.status, skills: p.skills, retiredFor: p.retiredFor})), negative: Object.keys(store.negative).length});

  const capabilities = wrapCapabilities(inner);
  return {...capabilities, capabilities, store, available: () => inner.available?.() ?? {ok: true}, ask, dream, propose, revoke, quarantine, state};
}

export default dreamingSession;
