/** Backward relevance search proposes missing ground leaf conditions.
 * Constants come only from the supplied finite model. No new entity is invented.
 * These are candidates; forward validation still decides whether they explain
 * the target. A truncated generator makes the final explanation set incomplete.
 */
import {unify} from '../lib/unify.mjs';import {atomKey,variable,inferVariableTypes} from '../lib/types.mjs';
import {conditionAtoms} from '../lib/conditions.mjs';
import {digest} from '../lib/util.mjs';import {substitute,ground,opposite} from './common.mjs';
import {step} from './bridge/packet.mjs';
export function generateAbducibles(query,base,rules,budget,schema=null){
 const targets=conditionAtoms(query.where),known=new Set(base.map(f=>atomKey(f.atom))),all=[...base.map(f=>f.atom),...targets,...rules.flatMap(r=>[...r.if,r.then])];
 const domain=[...new Set(all.flatMap(a=>a.a.filter(x=>!variable(x))))];const todo=targets.map(a=>({a,depth:0})),seen=new Set(),candidates=new Map();let complete=true,expanded=0;
 while(todo.length&&step(budget)){
  const {a,depth}=todo.shift(),key=atomKey(a);if(seen.has(key)||known.has(key)||known.has(atomKey(opposite(a))))continue;seen.add(key);expanded++;
  const matching=rules.flatMap(r=>{const binding=unify(r.then,a);return binding?[{r,binding}]:[];});
  if(!matching.length){candidates.set(key,{kind:'hypothesis',id:'missing_'+digest(key).slice(0,16),status:'untested',assumptions:[a],cost:1,source:'backward-missing-condition'});if(candidates.size>=budget.limits.maxCandidates){complete=false;break;}continue;}
  if(depth>=budget.limits.maxDepth){complete=false;continue;}
  for(const {r,binding}of matching){
   const vars=[...new Set(r.if.flatMap(p=>p.a.filter(variable)))].filter(v=>!Object.hasOwn(binding,v));
   const types=inferVariableTypes([...r.if,r.then],schema),env={...binding};
   const enumerate=i=>{if(!step(budget)){complete=false;return;}if(i<vars.length){const v=vars[i],choices=domain.filter(x=>types[v]==='integer'?Number.isSafeInteger(x):types[v]&&types[v]!=='value'?typeof x==='string':true);if(!choices.length)complete=false;for(const value of choices){env[v]=value;enumerate(i+1);if(budget.stop!==null)break;}delete env[v];return;}
    for(const condition of r.if){const p=substitute(condition,env);if(!ground(p))throw Error('Abducible grounding failed');if(todo.length>=budget.limits.maxNodes){complete=false;return;}todo.push({a:p,depth:depth+1});}
   };
   enumerate(0);if(budget.stop!==null)break;
  }
 }
 return {candidates:[...candidates.values()],complete:complete&&budget.stop===null,expanded,domainSize:domain.length,semantics:'ground missing leaves of retrieved rules; no invented constants; forward-tested, not asserted'};
}
