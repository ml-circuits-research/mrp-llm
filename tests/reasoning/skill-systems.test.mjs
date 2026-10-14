import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime} from '../../sop/runtime.mjs';
import {ReasoningRegistry} from '../../reasoning/registry.mjs';
import {classifyFailure} from '../../skills/failure-classifier/classify.mjs';
import {proposeMicroTheories} from '../../skills/semantic-gap-resolver/resolve.mjs';
import {ImplicitSopRegistry} from '../../skills/implicit-sop-registry/registry.mjs';

const runtime = new Runtime({now:Date.parse('2026-09-27'), policy:{allowWrite:false}});
const run = source => runtime.run(source);
const fact = '@f fact\n  holds parent mara sorin\n  valid timeless\n';
const query = atom => `@q query\n  where ${atom}\n@r reason\n  query $q\n  data $f`;
const known = fact + query('parent mara sorin');
const wrong = fact + query('parent mara dana');
const missing = '@q query\n  where parent mara sorin\n@r reason\n  query $q';
const proposal = () => proposeMicroTheories({gap:{question:'May a guest enter?',evidenceId:'gap-1'}, candidates:[{
  scope:{domain:'visitor-access',population:'registered guests',validity:'during staffed hours'}, status:'HARD',
  conditions:['guest ?person','escort_present ?person'], conclusion:'may_enter ?person',
  exceptions:[{when:['access_revoked ?person'],reason:'Revocation overrides ordinary guest access'}],
  provenance:{sourceId:'policy-1',quote:'Registered guests may enter with an escort unless access is revoked.',reviewer:'policy-steward'}
}]})[0];

test('failure classification uses executed counterexample and declines an unattributed difference', async () => {
  const [goldExecution,candidateExecution] = await Promise.all([run(known),run(wrong)]);
  assert.equal(goldExecution.result.status,'supported');assert.equal(candidateExecution.result.status,'unknown');
  const observation = {question:'Is Sorin a child of Mara?',goldSop:known,candidateSop:wrong,goldExecution,candidateExecution};
  assert.equal(classifyFailure(observation).classification,'insufficient_evidence');
  const result = classifyFailure({...observation,diagnostics:{sameInputDigest:'fixture-world-1'}});
  assert.equal(result.classification,'semantic_gap');
  assert.equal(result.component,'SOP formalization / reviewed semantic mapping');
  assert.equal(result.evidence.candidateStatus,'unknown');
});

test('identical circuit and world reveal a complete faulty-backend reasoning gap', async () => {
  const faulty = new ReasoningRegistry();
  // Deliberately drop an admitted fact at the strategy boundary; both outcomes
  // are actual Runtime executions, not invented result packets.
  faulty.register('faulty', request => faulty.builtin({...request, data:[], memory:{...request.memory, facts:[]}}, false));
  const goldExecution = await run(known);
  const candidateExecution = await new Runtime({now:Date.parse('2026-09-27'),policy:{reasoningStrategy:'faulty',allowWrite:false},reasoningStrategies:faulty}).run(known);
  assert.equal(candidateExecution.result.status,'unknown');
  const classified = classifyFailure({question:'Is Sorin a child of Mara?',goldSop:known,candidateSop:known,goldExecution,candidateExecution,
    diagnostics:{sameInputDigest:'fixture-world-1'}});
  assert.equal(classified.classification,'reasoning_gap');
  assert.equal(classified.evidence.sameCircuit,true);
});

test('source gap requires reviewed source attribution; ambiguity needs independently recorded alternatives', async () => {
  const [goldExecution,candidateExecution,other] = await Promise.all([run(missing),run(missing),run(known)]);
  const source = classifyFailure({question:'Is Sorin a child of Mara?',goldSop:missing,candidateSop:missing,goldExecution,candidateExecution,
    diagnostics:{source:{id:'source-1',quote:'Mara is a parent of Sorin.',reviewer:'source-steward',reviewed:true,assertedAtom:'parent mara sorin'}}});
  assert.equal(source.classification,'source_gap');
  assert.equal(source.evidence.source.assertedAtom,'parent mara sorin');
  const ambiguity = classifyFailure({question:'Does "Mara" mean the parent or unrelated person?',goldSop:missing,candidateSop:missing,goldExecution,candidateExecution,
    diagnostics:{interpretations:[
      {meaning:'The known parent',sop:known,execution:other,sourceQuote:'Mara can refer to the parent.',reviewer:'editor'},
      {meaning:'The unrelated person',sop:missing,execution:goldExecution,sourceQuote:'Mara can refer to another person.',reviewer:'editor'}
    ]}});
  assert.equal(ambiguity.classification,'ambiguity');
  assert.deepEqual(ambiguity.evidence.alternatives.map(x=>x.status),['supported','unknown']);
});

test('an unsupported assumption is over-inference, not a sourced fact', async () => {
  const candidate = '@p fact\n  holds parent mara sorin\n  valid timeless\n  source assumption\n@q query\n  where parent mara sorin\n@r solve\n  query $q\n  assume $p';
  const [goldExecution,candidateExecution] = await Promise.all([run(missing),run(candidate)]);
  assert.equal(goldExecution.result.status,'unknown');
  assert.equal(candidateExecution.result.status,'supported');
  assert.equal(candidateExecution.result.hypothetical,true);
  const result = classifyFailure({question:'Is Sorin a child of Mara?',goldSop:missing,candidateSop:candidate,goldExecution,candidateExecution,
    diagnostics:{sameInputDigest:'fixture-world-2',unreviewedExtraAssumption:{atom:'parent mara sorin',sourceId:'source-2',reviewedAsUnsupported:true}}});
  assert.equal(result.classification,'over_inference');
});

test('micro-theories preserve the exception, its probe and non-production boundary', () => {
  const p = proposal();
  assert.equal(p.status,'HARD');
  assert.deepEqual(p.exceptions[0].when,['access_revoked ?person']);
  assert.deepEqual(p.validation.exceptions[0].exceptionWhen,p.exceptions[0].when);
  assert.equal(p.execution,'proposal-only');
  for (const status of ['DEFAULT','PLAUSIBLE']) {
    const draft = proposeMicroTheories({gap:{question:'May a guest enter?',evidenceId:'gap-2'},candidates:[{...p,status}]})[0];
    assert.equal(draft.status,status);
    assert.equal(draft.execution,'proposal-only');
  }
  assert.equal(p.validation.exceptions[0].expected,'Conclusion must not be derived under this exception');
  assert.throws(() => proposeMicroTheories({gap:{question:'q',evidenceId:'e'},candidates:[{...p,exceptions:undefined}]}),/exceptions array/);
});

test('registry deduplicates alpha-equivalent conditions, versions, requires host authorization and rolls back on evidence', () => {
  const authorize = (credential,action) => credential?.principal === 'steward' && credential?.grants?.includes(action) === true;
  const registry = new ImplicitSopRegistry({authorize});
  const p = proposal();
  const first = registry.register(p);
  const equivalent = {...p, conditions:['escort_present ?guest','guest ?guest'],conclusion:'may_enter ?guest',exceptions:[{when:['access_revoked ?guest'],reason:'Same exception'}]};
  assert.deepEqual(registry.register(equivalent),{...first,duplicate:true});
  const changed = {...p, scope:{...p.scope,validity:'weekdays during staffed hours'}};
  const revision = registry.revise(first.id,changed);
  assert.equal(revision.version,2);
  assert.equal(registry.lookup(p),null);
  const validation = {positive:'probe:positive:passed',negative:'probe:negative:passed',boundary:'probe:boundary:passed',exceptions:['probe:revoked:passed']};
  assert.throws(() => registry.decide(first.id,1,{action:'accept',rationale:'Reviewed',validation}),/authorization/);
  const authorization = {principal:'steward',grants:['accept','reject','retract']};
  assert.throws(() => registry.decide(first.id,1,{action:'accept',rationale:'Reviewed',validation:{...validation,exceptions:[]},authorization}),/every exception/);
  registry.decide(first.id,1,{action:'accept',rationale:'Reviewed with scoped probes',validation,authorization});
  assert.equal(registry.lookup(equivalent)?.version,1);
  registry.decide(first.id,2,{action:'reject',rationale:'New scope not reviewed',authorization});
  assert.equal(registry.get(first.id).versions[1].state,'rejected');
  assert.equal(registry.lookup(p)?.version,1);
  const defeasible = registry.register({...p,status:'DEFAULT',conclusion:'may_visit ?person'});
  assert.throws(() => registry.decide(defeasible.id,1,{action:'accept',rationale:'Insufficient',authorization,validation}),/DEFAULT and PLAUSIBLE/);
  const restored = new ImplicitSopRegistry({authorize,state:registry.exportState()});
  assert.equal(restored.lookup(p)?.state,'accepted');
  restored.retract(first.id,{authorization,evidence:{sourceId:'policy-2',observation:'New revocation case contradicts the previously accepted rule'}});
  assert.equal(restored.lookup(p),null);
  assert.equal(restored.get(first.id).versions[0].state,'retracted');
  assert.equal(restored.lookup(changed),null);
});
