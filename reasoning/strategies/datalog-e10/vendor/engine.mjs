// VENDORED: copied verbatim from sop_reasoner_e10.zip (sop-verified-reasoner 0.3.0) src/engine.mjs
import {Database,Relation} from './database.mjs';
import {sliceRules,schedule,schemaHash,digest} from './analyze.mjs';
import {bindings,ground,newStats,budgetCheck,BudgetExceeded,quotientOpportunities} from './join.mjs';
import {magicTransform} from './magic.mjs';
import {fuseRules,verifyPlanBundle,verifyExecutionPolicy} from './skills.mjs';
import {recognizeDominance,executeDominance} from './dominance.mjs';
import {verifyLemmaBundle} from './lemmas.mjs';

export const DEFAULTS=Object.freeze({mode:'semi',indexed:true,join:'greedy',factor:true,quotient:false,demand:true,fuse:false,provenance:false,dominance:false,maxWork:100_000_000,maxDerived:2_000_000,maxMs:60_000});
export function reason(program,queryName,settings={}){
  let policyStatus='NONE',policyOptions={};
  if(settings.policy){const check=verifyExecutionPolicy(program,queryName,settings.policy);
    if(!check.valid&&!check.reason.startsWith('STALE'))throw new Error(check.reason);
    policyStatus=check.valid?'APPLIED':check.reason;policyOptions=check.valid?settings.policy.options:{demand:false,factor:false};
  }
  const options={...DEFAULTS,...policyOptions,...settings};
  for(const name of ['maxWork','maxDerived','maxMs'])if(typeof options[name]!=='number'||Number.isNaN(options[name])||options[name]<0)throw new TypeError(`Invalid ${name}`);
  if(!['semi','naive'].includes(options.mode)||!['source','greedy'].includes(options.join))throw new Error('Invalid execution mode');
  const query=program.queries.find(q=>q.name===queryName);if(!query)throw new Error(`Unknown query ${queryName}`);
  // Reject malformed/unsafe global recursion even if the query would not visit it.
  schedule(program.rules);
  if(options.bundle){const v=verifyPlanBundle(program,options.bundle);if(!v.valid)throw new Error(v.reason);options.plans=options.bundle.plans;}
  let lemmaRules=[],lemmaCertificate=null;
  if(options.lemmaBundle){const v=verifyLemmaBundle(program,options.lemmaBundle,queryName);if(!v.valid)throw new Error(v.reason);lemmaRules=v.rules;lemmaCertificate=v.certificate;}
  const loadStart=performance.now();const db=Database.fromProgram(program,options);const loadMs=performance.now()-loadStart;
  let rules=sliceRules([...program.rules,...lemmaRules],query.pred),certificates=[],goal=query.pred;if(lemmaCertificate)certificates.push(lemmaCertificate);
  const compileStart=performance.now();
  if(options.fuse){const f=fuseRules(rules,db);rules=f.rules;certificates.push(...f.certificates);}
  let demand={applied:false,reason:'disabled'};
  if(options.demand){demand=magicTransform(rules,goal,program.arities);rules=demand.rules;goal=demand.goal;for(const f of demand.facts)db.add(f.pred,f.terms,options.provenance?{kind:'seed',source:'query-demand'}:null);if(demand.certificate)certificates.push(demand.certificate);}
  const dominance=options.dominance?recognizeDominance(rules,goal,db):null;
  const proofRules=rules;
  if(dominance){certificates.push(dominance.certificate);rules=rules.filter(r=>!dominance.definitions.includes(r));}
  if(options.quotient){const qs=quotientOpportunities(rules);if(qs.length)certificates.push({kind:'existential-variable-quotient-v1',rules:qs,semanticContract:'set-answer preservation by eliminating variables with no continuation/output use'});}
  const components=schedule(rules);const compileMs=performance.now()-compileStart;
  const stats=newStats(),started=performance.now(),ctx={db,stats,options,started};
  let status='COMPLETE',stopReason=null;
  function apply(rule,delta,next){
    for(const b of bindings(rule,ctx,delta)){
      stats.ruleMatches++;const tuple=ground(rule.head,b.env,db.pool),rel=db.relation(rule.head.pred,tuple.length);
      const proof=options.provenance?{kind:'rule',rule:rule.id,premises:b.proofs}:null;
      const id=rel.add(tuple,proof);
      if(id<0){stats.duplicates++;continue;}
      stats.derived++;if(!next.has(rel.pred))next.set(rel.pred,new Relation(rel.pred,rel.arity));next.get(rel.pred).add(tuple);
      if((stats.derived&1023)===0)budgetCheck(ctx);
    }
  }
  try{
    if(dominance){executeDominance(dominance,db,stats,options.provenance);budgetCheck(ctx);}
    for(const component of components){stats.components++;budgetCheck(ctx);let delta=new Map();stats.rounds++;
      // Initial evaluation sees all input facts and lower completed components.
      for(const r of component.rules)apply(r,null,delta);
      const recursiveRules=component.rules.filter(r=>r.body.some(l=>l.kind==='atom'&&component.preds.has(l.pred)));
      while(delta.size&&recursiveRules.length){budgetCheck(ctx);const next=new Map();stats.rounds++;
        if(options.mode==='naive')for(const r of recursiveRules)apply(r,null,next);
        else for(const r of recursiveRules)for(let i=0;i<r.body.length;i++){const l=r.body[i];if(l.kind==='atom'&&delta.has(l.pred))apply(r,{index:i,relation:delta.get(l.pred)},next);}
        delta=next;
      }
    }
    budgetCheck(ctx);
  }catch(e){if(!(e instanceof BudgetExceeded))throw e;status='INCOMPLETE';stopReason=e.message;}
  const elapsedMs=performance.now()-started;
  const rows=db.decoded(goal);rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {status,stopReason,query:queryName,columns:query.terms.map(t=>`?${t.var}`),rows,count:rows.length,
    stats:{...stats,loadMs,compileMs,solveMs:elapsedMs,totalMs:loadMs+compileMs+elapsedMs},
    plan:{schema:schemaHash(program),inputHash:options.provenance?digest(program.facts):null,policyStatus,demandApplied:demand.applied,demandReason:demand.reason,certificates,rules:rules.length},
    // Non-JSON runtime handles for proof extraction and explicit reuse.
    database:db,executedRules:proofRules,goal,complete:status==='COMPLETE'};
}
export function publicResult(result){const {database,executedRules,goal,...json}=result;return json;}
