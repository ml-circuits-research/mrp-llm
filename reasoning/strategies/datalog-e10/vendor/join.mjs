// VENDORED: copied verbatim from sop_reasoner_e10.zip (sop-verified-reasoner 0.3.0) src/join.mjs
import {variable, vars, testValues} from './terms.mjs';

export class BudgetExceeded extends Error {constructor(reason){super(reason);this.name='BudgetExceeded';}}
export function newStats(){return {candidateVisits:0,indexBuildRows:0,ruleAttempts:0,ruleMatches:0,derived:0,duplicates:0,rounds:0,existentialShortcuts:0,quotientApplications:0,quotientSkipped:0,components:0};}
export function budgetCheck(ctx){
  if(ctx.stats.candidateVisits>ctx.options.maxWork)throw new BudgetExceeded('maxWork');
  if(ctx.stats.derived>ctx.options.maxDerived)throw new BudgetExceeded('maxDerived');
  if(performance.now()-ctx.started>ctx.options.maxMs)throw new BudgetExceeded('maxMs');
}
const bound=(terms,env)=>terms.every(t=>!variable(t)||Object.hasOwn(env,t.var));
function pattern(terms,env,pool){return terms.map(t=>variable(t)?env[t.var]:pool.intern(t));}
function unify(terms,tuple,env,pool){
  const out={...env};
  for(let i=0;i<terms.length;i++) {
    const t=terms[i],v=tuple[i];
    if(variable(t)){if(Object.hasOwn(out,t.var)){if(out[t.var]!==v)return null;}else out[t.var]=v;}
    else if(pool.intern(t)!==v)return null;
  }
  return out;
}

/*
 * Verified local quotient opportunity.
 * A variable that occurs in exactly one positive atom in the whole rule, does not
 * occur in the head and is not used by a test/negative literal cannot influence
 * any continuation or output. Under set semantics, rows that differ only in such
 * coordinates are existentially equivalent for this rule application.
 */
const quotientCache=new WeakMap();
export function quotientPlan(rule){
  let cached=quotientCache.get(rule);if(cached)return cached;
  const counts=new Map(),headVars=new Set(vars(rule.head.terms));
  for(const l of rule.body)for(const v of vars(l.terms))counts.set(v,(counts.get(v)||0)+1);
  const byIndex=new Map();
  rule.body.forEach((l,index)=>{
    if(l.kind!=='atom')return;
    const dead=[];for(let i=0;i<l.terms.length;i++){const t=l.terms[i];if(variable(t)&&!headVars.has(t.var)&&counts.get(t.var)===1)dead.push(i);}
    if(dead.length){const deadSet=new Set(dead),live=[];for(let i=0;i<l.terms.length;i++)if(!deadSet.has(i)&&variable(l.terms[i]))live.push(i);byIndex.set(index,{dead,live});}
  });
  cached={eligible:byIndex.size>0,byIndex};quotientCache.set(rule,cached);return cached;
}
export function quotientOpportunities(rules){return rules.flatMap(r=>{const q=quotientPlan(r);return q.eligible?[{rule:r.id,literals:[...q.byIndex].map(([index,x])=>({index,...x}))}]:[];});}

function quotientIds(rel,ids,patternValues,plan,stats){
  const list=Array.isArray(ids)?ids:[...ids];if(!list.length)return list;
  // If every semantically-live variable is already bound, any matching witness is enough.
  if(plan.live.every(i=>patternValues[i]!==undefined)){stats.quotientApplications++;stats.quotientSkipped+=Math.max(0,list.length-1);return [list[0]];}
  const seen=new Set(),out=[];
  for(const id of list){const row=rel.rows[id],k=plan.live.map(i=>row[i]).join(',');if(seen.has(k))continue;seen.add(k);out.push(id);}
  if(out.length<list.length){stats.quotientApplications++;stats.quotientSkipped+=list.length-out.length;}
  return out;
}

/** Pure relational joins. Learned ordering is only a permutation, never a filter. */
function* walk(lits,env,proofs,ctx,override,order,quotient){
  if(!lits.length){yield {env,proofs};return;}
  let selected=-1,best=Infinity;
  for(let i=0;i<lits.length;i++) {
    const {l,index}=lits[i];let cost;
    if(l.kind!=='atom') {if(!bound(l.terms,env))continue;cost=-2;}
    else if(order) {cost=order.indexOf(index);if(cost<0)cost=order.length+index;}
    else if(ctx.options.join==='source')cost=index;
    else {
      const rel=override?.index===index?override.relation:ctx.db.relation(l.pred,l.terms.length);
      cost=rel.estimate(pattern(l.terms,env,ctx.db.pool),ctx.options.indexed,ctx.stats);
      if(ctx.options.quotient&&quotient?.byIndex.has(index))cost=Math.min(cost,1);
    }
    if(cost<best){best=cost;selected=i;}
  }
  if(selected<0)throw new Error('Unsafe condition reached; parser/planner bug');
  const {l,index}=lits[selected],rest=lits.filter((_,i)=>i!==selected);
  if(l.kind==='test') {
    const values=pattern(l.terms,env,ctx.db.pool).map(x=>ctx.db.pool.decode(x));
    if(testValues(l.op,...values))yield* walk(rest,env,ctx.options.provenance?[...proofs,{kind:'test',op:l.op,values}]:proofs,ctx,override,order,quotient);
    return;
  }
  const full=ctx.db.relation(l.pred,l.terms.length),rel=override?.index===index?override.relation:full;
  const pat=pattern(l.terms,env,ctx.db.pool);
  if(l.kind==='none') {
    // All variables are bound: absence is an exact tuple lookup in a completed lower SCC.
    ctx.stats.candidateVisits++;budgetCheck(ctx);
    if(!full.has(pat))yield* walk(rest,env,ctx.options.provenance?[...proofs,{kind:'absence',pred:l.pred,tuple:pat}]:proofs,ctx,override,order,quotient);
    return;
  }
  // Lookup buckets can grow during evaluation. Snapshot their length to avoid accidental unbounded scans.
  let ids=rel.lookup(pat,ctx.options.indexed,ctx.stats);
  const qp=ctx.options.quotient?quotient?.byIndex.get(index):null;if(qp)ids=quotientIds(rel,ids,pat,qp,ctx.stats);
  const list=Array.isArray(ids)?ids:[...ids];const length=list.length;
  for(let j=0;j<length;j++) {
    const row=rel.rows[list[j]];ctx.stats.candidateVisits++;
    if((ctx.stats.candidateVisits&1023)===0||ctx.stats.candidateVisits>ctx.options.maxWork)budgetCheck(ctx);
    const next=unify(l.terms,row,env,ctx.db.pool);if(!next)continue;
    const refs=ctx.options.provenance?[...proofs,{kind:'tuple',pred:l.pred,row:full.keys.get(row.join(','))}]:proofs;
    yield* walk(rest,next,refs,ctx,override,order,quotient);
  }
}
const factorCache=new WeakMap();
function factors(rule){
  let cached=factorCache.get(rule);if(cached)return cached;
  const list=rule.body.map((l,index)=>({l,index}));
  const components=[];const unused=new Set(list.map(x=>x.index));
  while(unused.size){const first=unused.values().next().value;unused.delete(first);const component=[list[first]],vs=new Set(vars(list[first].l.terms));
    let changed=true;while(changed){changed=false;for(const j of unused){const lv=vars(list[j].l.terms);if(lv.some(v=>vs.has(v))){unused.delete(j);component.push(list[j]);lv.forEach(v=>vs.add(v));changed=true;}}}
    components.push({lits:component,vars:vs});
  }
  const hv=new Set(vars(rule.head.terms));
  cached={existential:components.filter(c=>![...c.vars].some(v=>hv.has(v))),live:components.filter(c=>[...c.vars].some(v=>hv.has(v))).flatMap(c=>c.lits)};
  factorCache.set(rule,cached);return cached;
}
export function factorOpportunities(rules){return rules.flatMap(r=>{const f=factors(r);return f.existential.length?[{rule:r.id,components:f.existential.length}]:[];});}
export function* bindings(rule,ctx,override=null){
  ctx.stats.ruleAttempts++;const order=ctx.options.plans?.[rule.id]||null,quotient=ctx.options.quotient?quotientPlan(rule):null;
  let env={},proofs=[];let list=rule.body.map((l,index)=>({l,index}));
  if(ctx.options.factor){
    const f=factors(rule);list=f.live;
    for(const c of f.existential){const it=walk(c.lits,{},[],ctx,override,order,quotient);const first=it.next();it.return();if(first.done)return;
      ctx.stats.existentialShortcuts++;env={...env,...first.value.env};proofs.push(...first.value.proofs);
    }
  }
  yield* walk(list,env,proofs,ctx,override,order,quotient);
}
export function ground(head,env,pool){return head.terms.map(t=>variable(t)?env[t.var]:pool.intern(t));}
