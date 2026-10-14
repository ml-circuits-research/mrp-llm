import {assert,stable,digest} from '../lib/util.mjs';
import {atomKey,variable} from '../lib/types.mjs';
import {definitelyBound} from '../lib/conditions.mjs';
import {contains,intersect} from '../lib/time.mjs';
export const flat=x=>Array.isArray(x)?x.flatMap(flat):x==null?[]:[x];
export const opposite=a=>({...a,neg:!a.neg});
export const substitute=(a,binding)=>({...a,a:a.a.map(v=>variable(v)?binding[v]??v:v)});
export const ground=a=>a.a.every(x=>!variable(x));
export const timeless={from:-Infinity,until:Infinity};
export function asFact(a,id,kind='assumed'){return {id,atom:a,valid:{...timeless},kind,source:kind,evidence:{local:true},knownAt:0};}
export function partitions(input=[],memory=null,q=null){
 const items=[...flat(input),...(memory?.facts??[]),...(memory?.rules??[])],out={facts:[],rules:[],patterns:[],hypotheses:[],actions:[],goals:[],traces:[],policies:[],theories:[],ignored:[],complete:memory?.complete!==false};
 const map={rule:'rules',pattern:'patterns',hypothesis:'hypotheses',action:'actions',goal:'goals',trace:'traces',policy:'policies',theory:'theories'};
 for(const [i,x]of items.entries()){
  assert(x&&typeof x==='object','Typed SOP inputs required');
  if(x.kind==='retrieval'){const sub=partitions([],x,q);for(const key of ['facts','rules'])out[key].push(...sub[key]);out.complete&&=sub.complete;continue;}
  if(x.atom&&['fact','observed','assumed','derived'].includes(x.kind)){
   // Derived caches must be recomputed from current facts after an intervention.
   if(x.kind==='derived'){out.ignored.push({kind:x.kind,id:x.id,reason:'recomputed-from-facts'});continue;}
   if(q?.asof!==undefined&&(x.knownAt??0)>q.asof)continue;
   let valid=x.valid??timeless;if(q?.at!==undefined&&!contains(valid,q.at))continue;if(q?.during){valid=intersect(valid,q.during);if(!valid)continue;}
   out.facts.push({...x,id:x.id??'local_'+i+'_'+digest(atomKey(x.atom)).slice(0,10),valid,kind:x.kind==='fact'?'observed':x.kind});
  }else if(map[x.kind])out[map[x.kind]].push(x);else throw Error('Unsupported typed knowledge object '+x.kind);
 }
 out.facts=[...new Map(out.facts.map(f=>[stable([atomKey(f.atom),f.valid]),f])).values()];
 out.rules=[...new Map(out.rules.filter(r=>q?.at===undefined||contains(r.valid??timeless,q.at)).map(r=>[r.id,r])).values()];
 return out;
}
export function conflicts(facts){const keys=new Set(facts.map(f=>atomKey(f.atom)));return facts.filter(f=>keys.has(atomKey(opposite(f.atom)))).map(f=>atomKey(f.atom));}
export function queryFor(where,base={}){return {kind:'query',mode:'select',where,select:[...definitelyBound(where)],filters:[],limit:10000,at:Date.now(),asof:Infinity,...base};}
/** Rule 8 (AGENTS.md): an explicit request the route cannot honour is `unsupported`, in the native envelope, and nothing is substituted. */
export function unsupported(code,detail){return {status:'unsupported',code,detail,complete:false,guarantee:'exact',used:[],notes:[],ignored:[],strategy:'js-reference'};}
