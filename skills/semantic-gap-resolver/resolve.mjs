import {parseAtom, emitAtom} from '../../sop/parser.mjs';

const check = (ok, message) => { if (!ok) throw Error(message); };
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const atoms = xs => { check(Array.isArray(xs) && xs.length > 0, 'At least one condition is required'); return xs.map(x => emitAtom(parseAtom(x))); };

/** Return inert proposals and validation obligations, never SOP rule wires or runtime calls. */
export function proposeMicroTheories({gap, candidates}) {
  check(nonempty(gap?.question) && nonempty(gap?.evidenceId), 'An identified semantic gap with question and evidenceId is required');
  check(Array.isArray(candidates) && candidates.length > 0, 'Candidate micro-theories are required');
  return candidates.map((candidate, index) => {
    const {scope, status, conditions, exceptions, provenance} = candidate;
    check(scope && nonempty(scope.domain) && nonempty(scope.population) && nonempty(scope.validity), 'Explicit domain, population and validity scope are required');
    check(['HARD','DEFAULT','PLAUSIBLE'].includes(status), 'Status must be HARD, DEFAULT or PLAUSIBLE');
    check(Array.isArray(exceptions), 'Explicit exceptions array is required (possibly empty)');
    check(nonempty(provenance?.sourceId) && nonempty(provenance?.quote) && nonempty(provenance?.reviewer), 'Source, quote and review provenance are required');
    const normalizedExceptions = exceptions.map(item => {
      check(nonempty(item?.reason) && Array.isArray(item?.when) && item.when.length > 0, 'Each exception needs a reason and conditions');
      return {when:atoms(item.when), reason:item.reason};
    });
    const proposal = {
      kind:'micro-theory-proposal', id:`${gap.evidenceId}:${index + 1}`, status,
      scope:{domain:scope.domain, population:scope.population, validity:scope.validity},
      conditions:atoms(conditions), conclusion:emitAtom(parseAtom(candidate.conclusion)),
      exceptions:normalizedExceptions,
      provenance:{sourceId:provenance.sourceId, quote:provenance.quote, reviewer:provenance.reviewer, gapEvidenceId:gap.evidenceId},
      execution:'proposal-only',
      validation:{
        authority:'Human/host must review provenance and authorization; this component never installs or executes rules',
        positive:{conditions:atoms(conditions), expected:emitAtom(parseAtom(candidate.conclusion))},
        negative:{withoutConditions:atoms(conditions), expectation:'Do not derive conclusion when a necessary condition is absent'},
        exceptions:normalizedExceptions.map(x => ({conditions:atoms(conditions), exceptionWhen:x.when, expected:'Conclusion must not be derived under this exception', reason:x.reason})),
        boundary:{scope:{domain:scope.domain, population:scope.population, validity:scope.validity}, expectation:'Do not derive outside the reviewed scope'},
        note:'Finite probes cannot establish source truth or universal validity; HARD requires independent reviewed evidence; DEFAULT/PLAUSIBLE cannot be published as deductive rules.'
      }
    };
    return proposal;
  });
}
