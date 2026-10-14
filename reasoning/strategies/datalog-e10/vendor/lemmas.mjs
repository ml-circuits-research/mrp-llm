// VENDORED: copied verbatim from sop_reasoner_e10.zip (sop-verified-reasoner 0.3.0) src/lemmas.mjs
import {digest,schemaHash,sliceRules} from './analyze.mjs';
import {variable} from './terms.mjs';
import {validateProgram} from './parser.mjs';

const cloneTerm=t=>variable(t)?{var:t.var}:t;
const cloneLiteral=l=>({...l,terms:l.terms.map(cloneTerm)});
const allVars=rule=>new Set([rule.head,...rule.body].flatMap(l=>l.terms.filter(variable).map(t=>t.var)));
const safeName=s=>s.replace(/[^A-Za-z0-9_]/g,'_');

function freshen(rule,prefix){
  const map=new Map();
  const tr=t=>{if(!variable(t))return t;if(!map.has(t.var))map.set(t.var,{var:`${prefix}${t.var}`});return map.get(t.var);};
  const lit=l=>({...l,terms:l.terms.map(tr)});
  return {...rule,head:lit(rule.head),body:rule.body.map(lit)};
}
function resolve(t,subst){
  let x=t,seen=new Set();
  while(variable(x)&&subst.has(x.var)&&!seen.has(x.var)){seen.add(x.var);x=subst.get(x.var);}return x;
}
function bind(v,t,subst){
  const rv=resolve(v,subst),rt=resolve(t,subst);
  if(!variable(rv))return Object.is(rv,rt)||rv===rt;
  if(variable(rt)&&rv.var===rt.var)return true;
  subst.set(rv.var,rt);return true;
}
function unifyPair(a,b,subst,producerPrefix){
  a=resolve(a,subst);b=resolve(b,subst);
  if(!variable(a)&&!variable(b))return Object.is(a,b)||a===b;
  if(variable(a)&&variable(b)){
    const ap=a.var.startsWith(producerPrefix),bp=b.var.startsWith(producerPrefix);
    if(ap&&!bp)return bind(a,b,subst);if(bp&&!ap)return bind(b,a,subst);return bind(a,b,subst);
  }
  return variable(a)?bind(a,b,subst):bind(b,a,subst);
}
function applyTerm(t,subst){let x=resolve(t,subst);return variable(x)?{var:x.var}:x;}
function applyLiteral(l,subst){return {...l,terms:l.terms.map(t=>applyTerm(t,subst))};}
function literalKey(l){return JSON.stringify({kind:l.kind,pred:l.pred,op:l.op,terms:l.terms});}

/** Construct a sound redundant Horn shortcut by one resolution/composition step.
 * producer: H :- B. consumer: G :- ..., H', ... . If H unifies with H', add
 * G :- ..., B, ... . This can change cost/round depth but not add false answers.
 * Version 1 deliberately accepts pure positive Horn rules only.
 */
export function composeLemma(program,producerId,consumerId,bodyIndex){
  const producer=program.rules.find(r=>r.id===producerId),consumer=program.rules.find(r=>r.id===consumerId);
  if(!producer||!consumer)return {valid:false,reason:'RULE_NOT_FOUND'};
  if(producer.body.some(l=>l.kind!=='atom')||consumer.body.some(l=>l.kind!=='atom'))return {valid:false,reason:'PURE_POSITIVE_ONLY'};
  const target=consumer.body[bodyIndex];if(!target||target.kind!=='atom'||target.pred!==producer.head.pred)return {valid:false,reason:'PREDICATE_MISMATCH'};
  const prefix=`__dream_${safeName(producerId)}_${safeName(consumerId)}_${bodyIndex}_`;
  const p=freshen(producer,prefix),subst=new Map();
  for(let i=0;i<p.head.terms.length;i++)if(!unifyPair(p.head.terms[i],target.terms[i],subst,prefix))return {valid:false,reason:'UNIFICATION_FAILED'};
  const head=applyLiteral(consumer.head,subst);
  const expanded=[...consumer.body.slice(0,bodyIndex),...p.body,...consumer.body.slice(bodyIndex+1)].map(l=>applyLiteral(l,subst));
  const seen=new Set(),body=[];for(const l of expanded){const k=literalKey(l);if(!seen.has(k)){seen.add(k);body.push(l);}}
  const raw={id:'',wire:'dream',head,body,source:'dream://resolution',line:0};
  const id=`dream_${digest({producerId,consumerId,bodyIndex,head,body}).slice(0,16)}`;const rule={...raw,id};
  try{validateProgram({...program,rules:[...program.rules,rule]});}catch(e){return {valid:false,reason:`INVALID_DERIVED_RULE:${e.message}`};}
  const certificate={kind:'horn-resolution-lemma-v1',schema:schemaHash(program),producer:producerId,consumer:consumerId,bodyIndex,producerHash:digest(producer),consumerHash:digest(consumer),lemmaHash:digest(rule),semanticContract:'answer-set preserving redundant consequence'};
  return {valid:true,rule,certificate};
}

export function synthesizeCompositionLemmas(program,query,{maxBody=6,maxCandidates=256}={}){
  const goal=program.queries.find(q=>q.name===query)?.pred;if(!goal)throw new Error(`Unknown query ${query}`);
  const rules=sliceRules(program.rules,goal),out=[],seen=new Set();
  outer: for(const consumer of rules){
    for(let i=0;i<consumer.body.length;i++){
      const target=consumer.body[i];if(target.kind!=='atom')continue;
      for(const producer of rules){if(producer.head.pred!==target.pred)continue;
        const c=composeLemma(program,producer.id,consumer.id,i);if(!c.valid||c.rule.body.length>maxBody)continue;
        const k=digest({head:c.rule.head,body:c.rule.body});
        if(seen.has(k)||program.rules.some(r=>digest({head:r.head,body:r.body})===k))continue;seen.add(k);
        out.push({kind:'verified-composition-lemma-v1',schema:schemaHash(program),query,rule:c.rule,certificate:c.certificate,status:'candidate'});
        if(out.length>=maxCandidates)break outer;
      }
    }
  }
  return out;
}

export function verifyLemmaSkill(program,skill,query=skill?.query){
  if(!skill||skill.kind!=='verified-composition-lemma-v1')return {valid:false,reason:'INVALID_LEMMA_KIND'};
  if(skill.schema!==schemaHash(program))return {valid:false,reason:'STALE_SCHEMA'};
  if(skill.query!==undefined&&query!==undefined&&skill.query!==query)return {valid:false,reason:'STALE_QUERY'};
  const c=skill.certificate||{},rebuilt=composeLemma(program,c.producer,c.consumer,c.bodyIndex);
  if(!rebuilt.valid)return rebuilt;
  if(digest(rebuilt.rule)!==digest(skill.rule)||digest(rebuilt.rule)!==c.lemmaHash)return {valid:false,reason:'LEMMA_CERTIFICATE_MISMATCH'};
  return {valid:true,certificate:c,rule:rebuilt.rule};
}
export function verifyLemmaBundle(program,bundle,query){
  if(!bundle||bundle.kind!=='verified-lemma-bundle-v1')return {valid:false,reason:'INVALID_LEMMA_BUNDLE_KIND'};
  if(bundle.schema!==schemaHash(program))return {valid:false,reason:'STALE_SCHEMA'};
  if(bundle.query!==undefined&&bundle.query!==query)return {valid:false,reason:'STALE_QUERY'};
  const rules=[];for(const skill of bundle.skills||[]){const v=verifyLemmaSkill(program,skill,query);if(!v.valid)return v;rules.push(v.rule);}return {valid:true,rules,certificate:{kind:'verified-lemma-bundle-v1',count:rules.length}};
}

export function makeLemmaBundle(program,query,skills){
  const bundle={kind:'verified-lemma-bundle-v1',version:1,schema:schemaHash(program),query,skills:skills.map(s=>structuredClone(s))};
  const v=verifyLemmaBundle(program,bundle,query);if(!v.valid)throw new Error(v.reason);return bundle;
}
