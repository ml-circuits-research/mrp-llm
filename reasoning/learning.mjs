/** Bounded case operations: retrieval scoring, explicit pattern generation and
 * evaluation, and injective structural analogies. No output is admitted as fact.
 */
import {join,unify} from '../lib/unify.mjs';
import {rule,atomKey,variable} from '../lib/types.mjs';
import {conditionAtoms} from '../lib/conditions.mjs';
import {stable,digest} from '../lib/util.mjs';
import {RecallMemory} from '../memory/weaver.mjs';
import {flat,asFact,substitute,ground,opposite} from './common.mjs';
import {operationBudget,operationPacket,step} from './bridge/packet.mjs';
const feats=x=>x?.kind==='trace'?x.features:x?.kind==='fact'?[x.atom]:x?.kind==='query'?conditionAtoms(x.where):[];
const words=x=>new Set((x??'').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu)??[]);
function jaccard(a,b){let n=0;for(const x of a)if(b.has(x))n++;return a.size+b.size-n?n/(a.size+b.size-n):0;}
export function associate({cue,data,mode='relational',...options}){
 const b=operationBudget(options),cases=flat(data);if(!['lexical','relational','recall-memory'].includes(mode))throw Error('Unknown association mode');
 if(cases.some(x=>x.kind!=='trace'))throw Error('Association candidates must be traces');
 const cf=feats(cue),ck=new Set(cf.map(atomKey)),cw=words(cue.text),bank=mode==='recall-memory'?new RecallMemory({power:options.tracePower??10,verification:'associative'}):null;
 const feature=a=>digest(atomKey(a));
 if(bank)for(const c of cases)for(const a of c.features){if(!step(b))break;bank.add({p:'trace_feature',a:[c.id,feature(a)],neg:false});}
 const ranked=[];
 for(const c of cases){if(!step(b))break;let score;
  if(mode==='lexical')score=jaccard(cw,words(c.text));
  else if(mode==='recall-memory'){let sum=0;for(const a of cf){const addresses=bank.addresses({p:'trace_feature',a:[c.id,feature(a)],neg:false});sum+=addresses.reduce((n,h,i)=>n+(bank.get(i,h)>0?1:0),0)/addresses.length;}score=cf.length?sum/cf.length:0;}
  else score=jaccard(ck,new Set(c.features.map(atomKey)));
  ranked.push({id:c.id,score,source:c.source,features:c.features});
 }
 ranked.sort((a,c)=>c.score-a.score||a.id.localeCompare(c.id));const truncated=ranked.length>b.limits.maxCandidates;
 return operationPacket(b,{status:ranked.length?'approximate':'unknown',guarantee:'approximate',candidates:ranked.slice(0,b.limits.maxCandidates),complete:!truncated,mode,score:mode==='recall-memory'?'fraction of occupied projection cells':'Jaccard similarity',notes:['trace ids and candidate features are supplied explicitly; a score is a retrieval hint, not a probability']});
}
function evaluatePattern(p,cases,b){let opportunities=0,support=0,counterexamples=0,unknown=0,conflicts=0,complete=true;const evidence=[];
 for(const c of cases){if(!step(b)){complete=false;break;}const facts=c.features.map((a,i)=>asFact(a,c.id+'_'+i)),j=join(p.if,facts,{maxJoins:b.limits.maxJoins});complete&&=j.complete;
  const rows=[...new Map(j.rows.map(r=>[stable(r.binding),r])).values()];
  for(const row of rows){opportunities++;const target=substitute(p.then,row.binding);const yes=c.features.some(a=>unify(target,a)),no=c.features.some(a=>unify(opposite(target),a));
   if(yes&&no){conflicts++;counterexamples++;}else if(yes)support++;else if(no||c.closed)counterexamples++;else unknown++;
   if(evidence.length<20)evidence.push({trace:c.id,outcome:yes&&no?'both':yes?'supported':no||c.closed?'counterexample':'unknown'});
  }
 }
 return {opportunities,supportCount:support,counterexamples,unknown,conflicts,support:opportunities?support/opportunities:0,coverage:opportunities?(support+counterexamples)/opportunities:0,evidence,complete};
}
function generatePatterns(cases,b){const found=new Map();for(const c of cases)for(const a of c.features)for(const h of c.features){if(!step(b))return [...found.values()];if(a.p===h.p||a.neg||h.neg)continue;
 const map=new Map();const term=v=>{if(typeof v==='number')return v;if(!map.has(v))map.set(v,'?x'+map.size);return map.get(v);};const body={...a,a:a.a.map(term)},head={...h,a:h.a.map(v=>map.get(v)??v)};if(!head.a.some(variable))continue;
 const key=stable([body,head]);if(!found.has(key))found.set(key,{kind:'pattern',id:'pattern_'+digest(key).slice(0,12),if:[body],then:head,status:'candidate'});if(found.size>=b.limits.maxCandidates){b.generationTruncated=true;return [...found.values()];}}
 return [...found.values()];}
export function induce({data,candidates=[],holdout=[],...options}){
 const b=operationBudget(options),cases=flat(data),validation=flat(holdout);if([...cases,...validation].some(x=>x.kind!=='trace'))throw Error('Induction requires trace cases');
 const trainIds=new Set(cases.map(c=>c.id));if(validation.some(c=>trainIds.has(c.id)))throw Error('Held-out traces overlap training IDs');
 const supplied=flat(candidates);if(supplied.some(x=>x.kind!=='pattern'))throw Error('Induction candidate must be pattern, not accepted rule');
 const list=supplied.length?supplied:generatePatterns(cases,b),patterns=[];let complete=list.length<=b.limits.maxCandidates&&!b.generationTruncated;
 for(const p of list.slice(0,b.limits.maxCandidates)){rule(p);const training=evaluatePattern(p,cases,b);complete&&=training.complete;const test=validation.length?evaluatePattern(p,validation,b):null;if(test)complete&&=test.complete;
  patterns.push({...p,kind:'pattern',status:'candidate',training,holdout:test,support:training.support,coverage:training.coverage,source:'case-evaluation',promotion:'requires-reviewed-semantic-validation'});
 }
 patterns.sort((a,c)=>c.support-a.support||c.training.opportunities-a.training.opportunities);
 return operationPacket(b,{status:patterns.length?'approximate':'unknown',guarantee:'approximate',patterns,complete:complete,generator_truncated:!!b.generationTruncated,generator:supplied.length?'provided-pattern-templates':'one-condition-shared-variable',notes:['Counts apply to supplied traces; missing evidence is not a counterexample unless trace.closed=true.']});
}
export function analogize({source,target,transfer=[],...options}){
 const b=operationBudget(options),s=flat(source).flatMap(feats),t=flat(target).flatMap(feats),extra=flat(transfer).flatMap(x=>x.kind==='hypothesis'?x.assumptions:feats(x));
 const ss=[...new Set(s.flatMap(a=>a.a.filter(x=>typeof x==='string'&&!variable(x))))],tt=[...new Set(t.flatMap(a=>a.a.filter(x=>typeof x==='string'&&!variable(x))))],mappings=[];
 if(ss.length>tt.length)return operationPacket(b,{status:'unknown',guarantee:'approximate',mappings:[],complete:true});
 const visit=(i,map,used)=>{if(!step(b))return;if(i<ss.length){for(const v of tt)if(!used.has(v)){map[ss[i]]=v;used.add(v);visit(i+1,map,used);used.delete(v);delete map[ss[i]];if(b.stop!==null)break;}return;}
  const apply=a=>({...a,a:a.a.map(v=>Object.hasOwn(map,v)?map[v]:v)}),matched=s.filter(a=>t.some(x=>atomKey(x)===atomKey(apply(a)))).length;
  if(!matched)return;const proposed=extra.filter(a=>a.a.every(v=>typeof v==='number'||Object.hasOwn(map,v))).map(a=>({kind:'hypothesis',status:'untested',assumptions:[apply(a)],cost:1,source:'structural-analogy'}));
  mappings.push({kind:'analogy',mapping:{...map},matched,sourceEdges:s.length,score:s.length?matched/s.length:0,proposed});};
 visit(0,{},new Set());mappings.sort((a,c)=>c.score-a.score||stable(a.mapping).localeCompare(stable(c.mapping)));
 const truncated=mappings.length>b.limits.maxCandidates;
 return operationPacket(b,{status:mappings.length?'approximate':'unknown',guarantee:'approximate',mappings:mappings.slice(0,b.limits.maxCandidates),complete:!truncated,notes:['injective entity mapping, same predicate and polarity; not unrestricted analogical reasoning']});
}
