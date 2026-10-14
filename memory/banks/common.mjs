/** Shared scalar-domain operations. Type identity is preserved (1 !== "1"). */
import {stable,variable} from '../../lib/util.mjs';
export function groups(pattern,domains){
 const m=new Map();pattern.a.forEach((v,i)=>{if(variable(v)){if(!m.has(v))m.set(v,[]);m.get(v).push(i);}});
 return [...m].map(([name,positions])=>{
  let values=domains[positions[0]]??[];
  for(const p of positions.slice(1)){const set=new Set(domains[p].map(stable));values=values.filter(v=>set.has(stable(v)));}
  return {name,positions,values};
 }).sort((a,b)=>a.values.length-b.values.length);
}
export function matches(pattern,a){
 if(pattern.p!==a.p||pattern.a.length!==a.a.length||!!pattern.neg!==!!a.neg)return false;
 const vars=new Map();for(let i=0;i<a.a.length;i++){const v=pattern.a[i];if(variable(v)){if(vars.has(v)&&stable(vars.get(v))!==stable(a.a[i]))return false;vars.set(v,a.a[i]);}else if(stable(v)!==stable(a.a[i]))return false;}return true;
}
export function checkBudget({maxProbes=50000,limit=1000}={}){
 if(!Number.isSafeInteger(maxProbes)||maxProbes<0||!Number.isSafeInteger(limit)||limit<0)throw Error('Invalid retrieval budget');
 return {maxProbes,limit};
}
