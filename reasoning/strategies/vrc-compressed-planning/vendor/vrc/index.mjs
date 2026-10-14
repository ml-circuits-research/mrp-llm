// VENDORED: copied verbatim from vrc03r.zip vendor/vrc/src/index.mjs
import {parseSOP,selectGoal,contract,hash,stateFacts,resolveState,resolveModelState,transitionSOP,PROFILE} from './sop.mjs';
import {RuleOracle,SampleOracle} from './oracle.mjs';
import {discover} from './learner.mjs';
import {certify,modelJSON,modelFromJSON} from './certificate.mjs';
import {ReducedRuntime,batchModule,predictExact} from './runtime.mjs';
import {Poly} from './poly.mjs';
export {parseSOP,selectGoal,stateFacts,certify,discover,RuleOracle,SampleOracle,modelJSON,modelFromJSON,ReducedRuntime,batchModule};
export {enumeratePlans} from './runtime.mjs';
export function learnSOP(text,{goal,source='memory.sop',...options}={}){
 const program=parseSOP(text,{source}),spec=selectGoal(program,goal),model=discover(new RuleOracle(spec.actions),spec.H,options);
 if(!model.success)return {status:'NO_MODEL',program,model};const certificate=certify(program,spec.goal.id,model);if(!certificate.verified)throw new Error('Internal error: exact-rule candidate failed verification');
 return {status:'VERIFIED',program,goal:spec.goal.id,model,certificate,runtime:new ReducedRuntime(model)};
}
export function fitTransitions(datasets,H,options={}){const oracle=new SampleOracle(datasets,options),model=discover(oracle,H,options);return {status:model.success?'CANDIDATE':'NO_MODEL',model};}
export function exportArtifact(result){if(result.status!=='VERIFIED'||!result.certificate.verified)throw new Error('Only verified artifacts can be exported');return {format:'vrc-model/1',model:modelJSON(result.model),certificate:result.certificate,contract:contract(result.program,result.goal)};}
export function importArtifact(artifact,program,goal){if(artifact.format!=='vrc-model/1')throw new TypeError('Unsupported artifact format');const expected=hash(contract(program,goal));if(expected!==artifact.certificate.contractHash)throw new Error('Stale artifact: rules, actions, guards or observables differ');const model=modelFromJSON(artifact.model),certificate=certify(program,goal,model);if(!certificate.verified)throw new Error('Artifact verification failed');return {model,certificate,runtime:new ReducedRuntime(model)};}
/** Host-facing producer: bindings + evidence, never a naked boolean named "proved". */
export function createBindingProvider(result){if(result.status!=='VERIFIED')throw new Error('Verified result required');return {
 name:'vrc.predict',
 invoke({program=result.program,entity,steps,sequence,action,world='base',epoch='0',arithmetic='float64'}={}){
  const spec=selectGoal(program,result.goal);if(hash(contract(program,result.goal))!==result.certificate.contractHash)return {status:'STALE',bindings:[],evidence:[],reason:'semantic-contract-changed'};
  const facts=resolveModelState(program,result.goal,entity,result.model);if(facts.status!=='OK')return {...facts,bindings:[],evidence:[]};if(!['float64','exact'].includes(arithmetic))throw new TypeError('Unknown arithmetic mode');const prediction=arithmetic==='exact'?predictExact(result.model,facts.exactState,{steps:steps??spec.goal.horizon,sequence,action}):result.runtime.predict(facts.state,{steps:steps??spec.goal.horizon,sequence,action});if(prediction.status!=='OK')return {...prediction,bindings:[],evidence:facts.evidence};
  return {status:'OK',bindings:[{entity,value:prediction.value,world,epoch}],evidence:[{type:'verified-reduction',certificate:result.certificate.modelHash,contract:result.certificate.contractHash,sourceRules:spec.actions.map(a=>({wire:a.id,source:a.source,line:a.line})),sourceFacts:facts.evidence,snapshot:facts.snapshotHash,world,epoch,sequence:sequence??{action:action??spec.actions[0].id,steps:steps??spec.goal.horizon},numericSemantics:arithmetic==='exact'?'exact-rational':'float64; algebraic identity exact, rounded execution not an exact numerical proof',inputEncoding:facts.encoding??null,unneededVariables:facts.unneededVariables}]};
 }};}
export function exportLearnedSOP(result){
 if(result.status!=='VERIFIED')throw new Error('Need verified result');const spec=selectGoal(result.program,result.goal),vars=Array.from({length:result.model.dimension},(_,i)=>`z${i}`),existing=spec.goal.encoder,sourceVars=existing?existing.variables:spec.variables,E=existing?result.model.E.map(p=>p.compose(existing.E)):result.model.E;
 let name='vrc_encoding';while(result.program.facts.some(f=>f.id===name)||result.model.actions.some(a=>a.id===name))name+='_';
 let text=`# Verified reduced SOP model. Contract ${result.certificate.contractHash}\n`;
 for(const f of result.program.facts)text+=`@${f.id} claim\nVALUE state ${JSON.stringify(f.entity)} ${f.variable} ${f.value}\nSOURCE ${JSON.stringify(f.source)}\n`;
 text+=`\n@${name} vrc.encode\nINTERPRETER ${PROFILE}\nSTATE ${sourceVars.join(' ')}\nGIVES ${vars.join(' ')}\n`+E.map((p,i)=>`BIND ${vars[i]} ${p.toString(sourceVars)}\n`).join('');
 text+='\n'+result.model.actions.map(a=>transitionSOP(a.id,vars,a.G,a.guards)).join('\n');
 text+=`\n@reduced_goal goal\nINTERPRETER ${PROFILE}\nENCODE $${name}\nUSING ${result.model.actions.map(a=>'$'+a.id).join(' ')}\n`+result.model.D.map(p=>`OBSERVE ${p.toString(vars)}\n`).join('')+`HORIZON ${spec.goal.horizon}\n`+(spec.goal.entity?`ENTITY ${spec.goal.entity}\n`:'');return text;
}
export {predictExact}from'./runtime.mjs';
export {loadStateBatch}from'./stream.mjs';
export {samplesFromSOP,sampleSOP}from'./samples.mjs';
export {certifyRing,ringModule}from'./composition.mjs';
