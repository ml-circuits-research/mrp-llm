// VENDORED: copied verbatim from sop_reasoner_e10.zip (sop-verified-reasoner 0.3.0) src/skills.mjs
import {variable} from './terms.mjs';
import {schemaHash,digest,schedule} from './analyze.mjs';

/** Candidate join plans cannot alter the literal multiset. A permutation has a tiny complete checker. */
export function verifyPermutation(rule,order){
  return Array.isArray(order)&&order.length===rule.body.length&&order.every(Number.isInteger)&&new Set(order).size===order.length&&order.every(i=>i>=0&&i<rule.body.length);
}
export function verifyPlanBundle(program,bundle){
  if(bundle.schema!==schemaHash(program))return {valid:false,reason:'STALE_SCHEMA'};
  for(const [id,order]of Object.entries(bundle.plans||{})){
    const r=program.rules.find(r=>r.id===id);if(!r||!verifyPermutation(r,order))return {valid:false,reason:'INVALID_PERMUTATION'};
  }
  return {valid:true,certificate:'literal-permutation-v1'};
}
export function* permutations(xs){if(xs.length===0){yield [];return;}for(let i=0;i<xs.length;i++)for(const tail of permutations(xs.filter((_,j)=>i!==j)))yield [xs[i],...tail];}

/** Inlining is a constructive equivalence, not a test-based proof.
 * Guard: unique nonrecursive pure-positive definition, distinct variable head, no base facts.
 */
export function fuseRules(rules,db,{maxBody=8,passes=2}={}){
  let current=rules,certificates=[];
  for(let pass=0;pass<passes;pass++){
    const by=new Map();for(const r of current){if(!by.has(r.head.pred))by.set(r.head.pred,[]);by.get(r.head.pred).push(r);}
    const recursive=new Set();for(const c of schedule(current))if(c.preds.size>1||c.rules.some(r=>r.body.some(l=>l.kind==='atom'&&l.pred===r.head.pred)))c.preds.forEach(p=>recursive.add(p));
    let changes=0;
    const next=current.map(r=>{
      if(r.body.some(l=>l.kind!=='atom'))return r;
      const body=[];
      for(let j=0;j<r.body.length;j++){
        const l=r.body[j],defs=by.get(l.pred)||[];const d=defs[0];
        if(defs.length!==1||recursive.has(l.pred)||l.pred===r.head.pred||db.relations.get(l.pred)?.rows.length||!d||d.body.some(x=>x.kind!=='atom')||d.head.terms.some(t=>!variable(t))||new Set(d.head.terms.map(t=>t.var)).size!==d.head.terms.length||body.length+d.body.length+(r.body.length-j-1)>maxBody){body.push(l);continue;}
        const subst=new Map(d.head.terms.map((t,i)=>[t.var,l.terms[i]]));
        const used=new Set([r.head,...r.body,...body].flatMap(a=>a.terms.filter(variable).map(t=>t.var)));
        let serial=0;
        const replace=t=>{if(!variable(t))return t;if(subst.has(t.var))return subst.get(t.var);let v;do{v=`_inline_${pass}_${j}_${serial++}`;}while(used.has(v));used.add(v);const out={var:v};subst.set(t.var,out);return out;};
        body.push(...d.body.map(a=>({...a,terms:a.terms.map(replace)})));changes++;
        certificates.push({kind:'unique-definition-inline-v1',rule:r.id,definition:d.id,predicate:l.pred,guards:['no-base-facts','nonrecursive','pure-positive','head-distinct-variables'],definitionHash:digest(d)});
      }
      return {...r,body};
    });
    current=next;if(!changes)break;
  }
  return {rules:current,certificates};
}
export class SkillLibrary {
  constructor(){this.entries=new Map();}
  register(program,bundle){const v=verifyPlanBundle(program,bundle);if(!v.valid)throw new Error(v.reason);this.entries.set(bundle.schema,structuredClone(bundle));return v;}
  lookup(program){const b=this.entries.get(schemaHash(program));return b?structuredClone(b):null;}
  toJSON(){return [...this.entries.values()];}
  static fromJSON(program,records){const lib=new SkillLibrary();for(const b of records)lib.register(program,b);return lib;}
}

export function verifyExecutionPolicy(program,query,policy){
  if(!policy||policy.kind!=='verified-policy-selection-v1')return {valid:false,reason:'INVALID_POLICY_KIND'};
  if(policy.schema!==schemaHash(program))return {valid:false,reason:'STALE_SCHEMA'};
  if(policy.query!==undefined&&policy.query!==query)return {valid:false,reason:'STALE_QUERY'};
  const allowed=new Set(['demand','factor','quotient','fuse','dominance','indexed','join','mode']);
  for(const [k,v]of Object.entries(policy.options||{})){
    if(!allowed.has(k))return {valid:false,reason:'UNSAFE_POLICY_FIELD'};
    if(k==='join'&&!['source','greedy'].includes(v)||k==='mode'&&!['semi','naive'].includes(v)||!['join','mode'].includes(k)&&typeof v!=='boolean')return {valid:false,reason:'INVALID_POLICY_VALUE'};
  }
  return {valid:true,certificate:'allowlisted-execution-policy-v1'};
}
