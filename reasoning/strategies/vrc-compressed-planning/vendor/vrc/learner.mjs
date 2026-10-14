// VENDORED: copied verbatim from vrc03r.zip vendor/vrc/src/learner.mjs
import {Poly,latentLibrary} from './poly.mjs';
import {Proposer} from './proposals.mjs';
import {performance} from 'node:perf_hooks';
export const DEFAULTS=Object.freeze({maxLatent:4,maxEncoderDegree:4,latentDegree:2,maxStates:128,maxMilliseconds:30000,factorize:true,additive:true});
/** Same constructive closure search for exact-rule and sample-estimated pullbacks. */
export function discover(oracle,H,options={}){
 const cfg={...DEFAULTS,...options};const start=performance.now(),n=oracle.n;const proposer=new Proposer(cfg);if(!H.length||H.some(p=>p.n!==n||p.degree>cfg.maxEncoderDegree))return {success:false,reason:'observable-outside-encoder-budget'};
 const initial=[...new Map(H.map(p=>[p.key(),p])).values()],queue=[initial],seen=new Set(),trace=[];let expanded=0,last='no-closed-model';
 const cost=E=>E.reduce((s,p)=>s+p.t.size+p.degree,0);
 while(queue.length&&expanded<cfg.maxStates){if(performance.now()-start>cfg.maxMilliseconds){last='time-budget';break;}queue.sort((a,b)=>a.length-b.length||cost(a)-cost(b));const E=queue.shift();if(E.length>cfg.maxLatent)continue;const key=E.map(p=>p.normalize().key()).sort().join('|');if(seen.has(key))continue;seen.add(key);expanded++;
  let residual=null,fail=null;const lib=latentLibrary(E,cfg.latentDegree),reduced=[];
  const express=p=>{const r=lib.basis.reduce(p);return r.residual.zero?new Poly(E.length,lib.exponents.map((e,i)=>[e,r.coefficients[i]])):null;};
  for(const a of oracle.actions){const G=[];for(let i=0;i<E.length;i++){const target=oracle.pullback(E[i],a);if(!target){fail='fit-budget';break;}const r=lib.basis.reduce(target);if(!r.residual.zero){residual=r.residual;fail=`dynamics:${a.id}:${i}`;break;}G.push(new Poly(E.length,lib.exponents.map((e,j)=>[e,r.coefficients[j]])));}if(fail)break;
    const guards=[];for(const g of a.guards||[]){const q=express(g.poly);if(!q){residual=lib.basis.reduce(g.poly).residual;fail=`guard:${a.id}`;break;}guards.push({op:g.op,poly:q});}if(fail)break;reduced.push({id:a.id,G,guards});}
  if(!fail){const D=H.map(express);if(D.some(p=>p===null))throw new Error('Internal observation span error');return {success:true,E,actions:reduced,D,dimension:E.length,mode:oracle.mode,elapsedMs:performance.now()-start,expanded,trace,proposalLog:proposer.log,fitLog:oracle.log,configuration:cfg};}
  last=fail;if(residual){const proposals=proposer.propose(E,residual).filter(ps=>latentLibrary([...E,...ps],cfg.latentDegree).basis.reduce(residual).residual.zero);trace.push({dimension:E.length,failure:fail,residual:residual.toString(),proposals:proposals.length});for(const ps of proposals)queue.push([...E,...ps]);}else trace.push({dimension:E.length,failure:fail,proposals:0});
 }
 return {success:false,reason:expanded>=cfg.maxStates?'search-budget':last,mode:oracle.mode,elapsedMs:performance.now()-start,expanded,trace,proposalLog:proposer.log,fitLog:oracle.log,configuration:cfg};
}
