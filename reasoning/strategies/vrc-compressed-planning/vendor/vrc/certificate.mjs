// VENDORED: copied verbatim from vrc03r.zip vendor/vrc/src/certificate.mjs
import {Poly} from './poly.mjs';
import {hash,contract,selectGoal} from './sop.mjs';
import {rng} from './linalg.mjs';
export function modelJSON(model){if(!model.success)return model;return {...model,E:model.E.map(p=>p.toJSON()),D:model.D.map(p=>p.toJSON()),actions:model.actions.map(a=>({...a,G:a.G.map(p=>p.toJSON()),guards:a.guards.map(g=>({op:g.op,poly:g.poly.toJSON()}))}))};}
export function modelFromJSON(j){if(!j?.success)throw new TypeError('A successful model is required');return {...j,E:j.E.map(Poly.fromJSON),D:j.D.map(Poly.fromJSON),actions:j.actions.map(a=>({...a,G:a.G.map(Poly.fromJSON),guards:a.guards.map(g=>({op:g.op,poly:Poly.fromJSON(g.poly)}))}))};}
function witness(p){const r=rng(19881);for(let i=0;i<100;i++){const x=Array.from({length:p.n},()=>Math.floor(r()*7)-3),v=p.evaluateExact(x);if(!v.zero)return {state:x,residual:v.toString()};}return null;}
/** Recompute exact identities; never trust a stored boolean or just a model checksum. */
export function certify(program,goalName,model){
 const failures=[],checks=[];if(!model?.success)return {verified:false,reason:'no-model'};const {actions,H,variables}=selectGoal(program,goalName);
 if(model.E.some(p=>p.n!==variables.length)||model.D.length!==H.length||model.actions.length!==actions.length)return {verified:false,reason:'interface-mismatch'};
 for(const a of actions){const reduced=model.actions.find(r=>r.id===a.id);if(!reduced||reduced.G.length!==model.E.length||reduced.guards.length!==a.guards.length)return {verified:false,reason:'action-or-guard-mismatch'};
  for(let i=0;i<model.E.length;i++){const r=model.E[i].compose(a.T).sub(reduced.G[i].compose(model.E));checks.push({kind:'transition',action:a.id,coordinate:i,zero:r.zero});if(!r.zero)failures.push({kind:'transition',action:a.id,coordinate:i,residual:r.toString(variables),witness:witness(r)});}
  for(let i=0;i<a.guards.length;i++){const r=a.guards[i].poly.sub(reduced.guards[i].poly.compose(model.E)),ok=r.zero&&a.guards[i].op===reduced.guards[i].op;checks.push({kind:'guard',action:a.id,index:i,zero:ok});if(!ok)failures.push({kind:'guard',action:a.id,index:i,residual:r.toString(variables),witness:r.zero?null:witness(r)});}}
 for(let i=0;i<H.length;i++){const r=H[i].sub(model.D[i].compose(model.E));checks.push({kind:'observation',index:i,zero:r.zero});if(!r.zero)failures.push({kind:'observation',index:i,residual:r.toString(variables),witness:witness(r)});}
 const semantic=contract(program,goalName),compiled={E:model.E,D:model.D,actions:model.actions.map(a=>({id:a.id,G:a.G,guards:a.guards}))};return {verified:failures.length===0,scope:'rational polynomial identities; all real states; exactly the listed actions, guards and observables',contractHash:hash(semantic),modelHash:hash(compiled),checks,failures,kernel:'vrc sparse BigInt rational polynomial checker (not Lean/Coq)',source:actions.map(a=>({wire:a.id,source:a.source,line:a.line}))};
}
