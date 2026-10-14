// VENDORED: copied verbatim from sop_reasoner_e10.zip (sop-verified-reasoner 0.3.0) src/magic.mjs
import {variable,vars} from './terms.mjs';
import {digest} from './analyze.mjs';

/** Standard positive Datalog demand transformation. No guessed pruning. */
export function magicTransform(rules,goal,arities,{maxVariants=512}={}){
  if(rules.some(r=>r.body.some(l=>l.kind==='none')))return {rules,facts:[],goal,applied:false,reason:'stratified-negation-fallback'};
  const definitions=new Map();for(const r of rules){if(!definitions.has(r.head.pred))definitions.set(r.head.pred,[]);definitions.get(r.head.pred).push(r);}
  const idb=new Set(definitions.keys()),queue=[],seen=new Set(),out=[],extra=[];
  const adorned=(p,mask)=>`adorn:${p}:${mask}`;
  const demand=(p,mask)=>`demand:${p}:${mask}`;
  const atom=(p,terms)=>({kind:'atom',pred:p,terms});
  function request(p,mask){const k=adorned(p,mask);if(!seen.has(k)){seen.add(k);queue.push({p,mask});}return k;}
  const rootMask='f'.repeat(arities.get(goal));request(goal,rootMask);
  extra.push({pred:demand(goal,rootMask),terms:[],kind:'atom',source:'demand-seed',line:0,wire:'demand'});
  for(let qi=0;qi<queue.length;qi++){
    if(queue.length>maxVariants)return {rules,facts:[],goal,applied:false,reason:'variant-budget-fallback'};
    const {p,mask}=queue[qi];const ap=adorned(p,mask),mp=demand(p,mask);
    // EDB+IDB coexistence is handled by a bridge; p itself has no defining rules in the transformed program.
    const bridgeTerms=[...mask].map((_,i)=>({var:`B${i}`}));
    const select=terms=>terms.filter((_,i)=>mask[i]==='b');
    out.push({id:`bridge:${ap}`,head:atom(ap,bridgeTerms),body:[atom(mp,select(bridgeTerms)),atom(p,bridgeTerms)],origin:'edb-bridge'});
    for(const r of definitions.get(p)||[]){
      const magicHead=atom(mp,select(r.head.terms)),boundVars=new Set(vars(magicHead.terms));
      const left=r.body.map((l,index)=>({l,index})),body=[];
      // A fixed legal SIPS: prefer fully-bound filters and positive literals with most bound terms.
      while(left.length){let chosen=-1,best=-Infinity;
        for(let i=0;i<left.length;i++){const l=left[i].l;if(l.kind==='test'&&!vars(l.terms).every(v=>boundVars.has(v)))continue;
          const score=l.kind==='test'?1e6:l.terms.filter(t=>!variable(t)||boundVars.has(t.var)).length*10+(idb.has(l.pred)?0:1);
          if(score>best){best=score;chosen=i;}}
        if(chosen<0)throw new Error('Invalid SIPS');const {l}=left.splice(chosen,1)[0];
        if(l.kind==='test'){body.push(l);continue;}
        if(idb.has(l.pred)){
          const m=l.terms.map(t=>!variable(t)||boundVars.has(t.var)?'b':'f').join('');
          const args=l.terms.filter((_,i)=>m[i]==='b');const name=request(l.pred,m);
          out.push({id:`seed:${r.id}:${ap}:${body.length}`,head:atom(demand(l.pred,m),args),body:[magicHead,...body],origin:r.id});
          body.push({...l,pred:name});
        }else body.push(l);
        vars(l.terms).forEach(v=>boundVars.add(v));
      }
      out.push({...r,id:`adorned:${r.id}:${mask}`,head:{...r.head,pred:ap},body:[magicHead,...body],origin:r.id});
    }
  }
  return {rules:out,facts:extra,goal:adorned(goal,rootMask),applied:true,variants:seen.size,
    certificate:{kind:'positive-demand-transform-v1',source:digest(rules),output:digest(out),assumptions:['finite-function-free','positive','set-semantics']}};
}
