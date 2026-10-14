import {parseAtom, emitAtom} from '../../sop/parser.mjs';

const check = (ok, message) => { if (!ok) throw Error(message); };
const text = x => typeof x === 'string' && x.trim().length > 0;
const snapshot = x => structuredClone(x);
const shape = proposal => {
  check(proposal?.kind === 'micro-theory-proposal' && proposal.execution === 'proposal-only', 'Only inert micro-theory proposals can be registered');
  check(['HARD','DEFAULT','PLAUSIBLE'].includes(proposal.status), 'Invalid epistemic status');
  check(text(proposal.scope?.domain) && text(proposal.scope?.population) && text(proposal.scope?.validity), 'Explicit scope required');
  check(Array.isArray(proposal.conditions) && proposal.conditions.length > 0 && Array.isArray(proposal.exceptions), 'Conditions and explicit exceptions required');
  check(text(proposal.provenance?.sourceId) && text(proposal.provenance?.quote) && text(proposal.provenance?.reviewer), 'Provenance required');
  const parsed = xs => xs.map(x => emitAtom(parseAtom(x)));
  return {...snapshot(proposal), conditions:parsed(proposal.conditions), conclusion:emitAtom(parseAtom(proposal.conclusion)), exceptions:proposal.exceptions.map(x => {
    check(Array.isArray(x.when) && x.when.length > 0 && text(x.reason), 'Exception conditions and reason required');
    return {when:parsed(x.when), reason:x.reason};
  })};
};

// Conjunction order and variable names are nonsemantic. Scope and exceptions are semantic.
function semanticKey(p) {
  const parsed = xs => xs.map(parseAtom).sort((a,b) => JSON.stringify({p:a.p, neg:a.neg, args:a.a.map(v => typeof v === 'string' && /^\?[A-Za-z]/.test(v) ? '?' : v)}) .localeCompare(JSON.stringify({p:b.p, neg:b.neg, args:b.a.map(v => typeof v === 'string' && /^\?[A-Za-z]/.test(v) ? '?' : v)})));
  const names = new Map();
  const normalized = a => ({predicate:a.p, negative:a.neg, args:a.a.map(v => typeof v === 'string' && /^\?[A-Za-z]/.test(v) ? (names.has(v) ? names.get(v) : (names.set(v, `?v${names.size}`), names.get(v))) : v)});
  const conditions = parsed(p.conditions).map(normalized);
  const conclusion = normalized(parseAtom(p.conclusion));
  const exceptions = p.exceptions.map(x => parsed(x.when).map(normalized)).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({scope:p.scope, conditions, conclusion, exceptions});
}

/** Inert registry: accepting is a host-authorized review decision, never publication. */
export class ImplicitSopRegistry {
  constructor({authorize = () => false, state} = {}) {
    check(typeof authorize === 'function', 'A host authorization callback is required');
    this.authorize = authorize;
    this.entries = new Map();
    if (state) {
      check(Array.isArray(state.entries), 'Invalid registry state');
      for (const entry of state.entries) {
        check(text(entry.id) && Array.isArray(entry.versions) && entry.versions.length && !this.entries.has(entry.id), 'Invalid registry entry');
        const versions = entry.versions.map((v,i) => {
          check(v.version === i + 1 && ['candidate','accepted','rejected','retracted'].includes(v.state), 'Invalid registry version');
          const proposal = shape(v.proposal);
          check(v.key === semanticKey(proposal), 'Registry semantic fingerprint mismatch');
          return {...snapshot(v), proposal};
        });
        check(entry.activeVersion === null || versions[entry.activeVersion - 1]?.state === 'accepted', 'Invalid active version');
        this.entries.set(entry.id, {...snapshot(entry), versions});
      }
    }
  }
  exportState() { return snapshot({entries:[...this.entries.values()]}); }
  get(id) { const entry = this.entries.get(id); return entry ? snapshot(entry) : null; }
  register(proposal) {
    const normalized = shape(proposal), key = semanticKey(normalized);
    for (const entry of this.entries.values()) {
      const existing = entry.versions.find(v => v.key === key);
      if (existing) return {id:entry.id, version:existing.version, duplicate:true};
    }
    const id = `implicit-${this.entries.size + 1}`;
    this.entries.set(id, {id, activeVersion:null, versions:[{version:1, state:'candidate', key, proposal:normalized, decision:null}]});
    return {id, version:1, duplicate:false};
  }
  revise(id, proposal) {
    const entry = this.entries.get(id); check(entry, 'Unknown registry entry');
    const normalized = shape(proposal), key = semanticKey(normalized);
    for (const other of this.entries.values()) for (const version of other.versions) if (version.key === key)
      return {id:other.id, version:version.version, duplicate:true};
    const version = entry.versions.length + 1;
    entry.versions.push({version, state:'candidate', key, proposal:normalized, decision:null});
    return {id, version, duplicate:false};
  }
  decide(id, version, {action, authorization, rationale, validation} = {}) {
    const entry = this.entries.get(id), target = entry?.versions[version - 1];
    check(target?.version === version && target.state === 'candidate', 'Only an existing candidate version can be decided');
    check(['accept','reject'].includes(action) && text(rationale), 'Decision and rationale required');
    check(this.authorize(authorization, action, {id, version}) === true, 'Explicit host authorization required');
    if (action === 'accept') {
      check(target.proposal.status === 'HARD', 'DEFAULT and PLAUSIBLE cannot be accepted as deductive knowledge');
      check(text(validation?.positive) && text(validation?.negative) && text(validation?.boundary) && target.proposal.exceptions.every((_,i) => text(validation?.exceptions?.[i])), 'Positive, negative, boundary and every exception validation receipt required');
      if (entry.activeVersion !== null) {
        const old = entry.versions[entry.activeVersion - 1];
        old.state = 'retracted';old.decision = {...old.decision, supersededBy:version};
      }
      entry.activeVersion = version;
    }
    target.state = action === 'accept' ? 'accepted' : 'rejected';
    target.decision = {action, rationale, principal:authorization?.principal, validation:snapshot(validation ?? null)};
    return this.get(id);
  }
  retract(id, {authorization, evidence} = {}) {
    const entry = this.entries.get(id), active = entry?.versions[entry.activeVersion - 1];
    check(active && text(evidence?.sourceId) && text(evidence?.observation), 'Active entry and new evidence required');
    check(this.authorize(authorization, 'retract', {id, version:active.version}) === true, 'Explicit host authorization required');
    active.state = 'retracted'; active.decision = {...active.decision, retraction:{principal:authorization?.principal, evidence:snapshot(evidence)}};
    entry.activeVersion = null;
    return this.get(id);
  }
  lookup(proposal) {
    const key = semanticKey(shape(proposal));
    for (const entry of this.entries.values()) {
      const active = entry.versions[entry.activeVersion - 1];
      if (active?.key === key && active.state === 'accepted') return snapshot({id:entry.id, version:active.version, state:active.state, proposal:active.proposal});
    }
    return null;
  }
}
