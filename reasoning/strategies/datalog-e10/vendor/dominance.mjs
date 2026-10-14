// VENDORED: copied verbatim from sop_reasoner_e10.zip (sop-verified-reasoner 0.3.0) src/dominance.mjs
import {variable} from './terms.mjs';
import {digest} from './analyze.mjs';

/** Recognize the complete two-dimensional strict Pareto definition, irrespective
 * of predicate/variable names. This is a verified template compiler, not an
 * unrestricted theorem prover and not a newly invented algorithm.
 * The entire query slice must consist of one anti-join query and two dominance rules.
 */
export function recognizeDominance(rules,goal,db){
  const qs=rules.filter(r=>r.head.pred===goal);if(qs.length!==1)return null;
  const q=qs[0];if(q.body.length!==2)return null;
  const src=q.body.find(l=>l.kind==='atom'),neg=q.body.find(l=>l.kind==='none');
  if(!src||!neg||src.terms.length!==3||src.terms.some(t=>!variable(t))||new Set(src.terms.map(t=>t.var)).size!==3||JSON.stringify(src.terms)!==JSON.stringify(neg.terms))return null;
  const defs=rules.filter(r=>r.head.pred===neg.pred);
  if(rules.length!==3||defs.length!==2||db.relations.get(neg.pred)?.rows.length||rules.some(r=>r.head.pred===src.pred))return null;
  for(let group=0;group<3;group++){
    const metrics=[0,1,2].filter(i=>i!==group),matches=[];let compatible=true;
    for(const d of defs){
      if(d.head.terms.length!==3||d.head.terms.some(t=>!variable(t))||new Set(d.head.terms.map(t=>t.var)).size!==3){compatible=false;break;}
      const positives=d.body.filter(l=>l.kind==='atom'),tests=d.body.filter(l=>l.kind==='test');
      if(d.body.length!==4||positives.length!==2||tests.length!==2||positives.some(l=>l.pred!==src.pred||l.terms.length!==3)){compatible=false;break;}
      const B=positives.find(l=>JSON.stringify(l.terms)===JSON.stringify(d.head.terms)),A=positives.find(l=>l!==B);
      if(!B||!A||A.terms.some(t=>!variable(t))||A.terms[group].var!==B.terms[group].var||new Set([...A.terms,...B.terms].map(t=>t.var)).size!==5){compatible=false;break;}
      const direction=[],strict=[];
      for(const m of metrics){const t=tests.find(t=>variable(t.terms[0])&&variable(t.terms[1])&&t.terms[0].var===A.terms[m].var&&t.terms[1].var===B.terms[m].var);
        if(!t||!['<','<=','>','>='].includes(t.op)){compatible=false;break;}
        direction.push(t.op.startsWith('<')?1:-1);strict.push(t.op.length===1);
      }
      if(!compatible)break;matches.push({rule:d,direction,strict,A,B});
    }
    if(compatible&&JSON.stringify(matches[0].direction)===JSON.stringify(matches[1].direction)&&matches.every(m=>m.strict.filter(Boolean).length===1)&&matches[0].strict[0]!==matches[1].strict[0]){
      const relation=db.relation(src.pred,3);
      if(relation.rows.some(t=>metrics.some(i=>typeof db.pool.decode(t[i])!=='number')))return null;
      return {source:src.pred,dominated:neg.pred,query:q,definitions:defs,group,metrics,direction:matches[0].direction,matches,
        certificate:{kind:'pareto-2d-antijoin-v1',scope:'exact Boolean answer set only',guards:['complete-two-branch-strict-Pareto','extensional-source','no-base-dominated-facts','same-control-group','numeric-objectives'],ruleHashes:defs.map(digest)}};
    }
  }
  return null;
}
export function executeDominance(plan,db,stats,provenance=false){
  const rel=db.relation(plan.source,3),dom=db.relation(plan.dominated,3),[a,b]=plan.metrics,[sa,sb]=plan.direction;
  const records=rel.rows.map((t,id)=>({id,group:t[plan.group],x:sa*db.pool.decode(t[a]),y:sb*db.pool.decode(t[b])}));
  records.sort((p,q)=>p.group-q.group||p.x-q.x||p.y-q.y);
  let current=null,best=null;
  for(const r of records){stats.candidateVisits++;if(r.group!==current){current=r.group;best=null;}
    if(best&&best.y<=r.y){
      const match=plan.matches.find(m=>m.strict.every((strict,i)=>!strict||(i===0?best.x<r.x:best.y<r.y)));
      if(!match)throw new Error('Pareto compiler invariant broken');
      const proof=provenance?{kind:'rule',rule:match.rule.id,premises:[{kind:'tuple',pred:plan.source,row:best.id},{kind:'tuple',pred:plan.source,row:r.id}]}:null;
      if(dom.add(rel.rows[r.id],proof)>=0)stats.derived++;
    }else best=r;
  }
  stats.paretoRows=records.length;stats.paretoDominated=dom.rows.length;
}
