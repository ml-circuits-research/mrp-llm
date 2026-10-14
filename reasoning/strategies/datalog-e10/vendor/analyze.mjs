// VENDORED: copied verbatim from sop_reasoner_e10.zip (sop-verified-reasoner 0.3.0) src/analyze.mjs
import {createHash} from 'node:crypto';
export const digest = value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const schemaHash = p=>digest(p.rules.map(r=>({id:r.id,head:r.head,body:r.body})));
export function sliceRules(rules,goal){
  const by=new Map();for(const r of rules){if(!by.has(r.head.pred))by.set(r.head.pred,[]);by.get(r.head.pred).push(r);}
  const needed=new Set([goal]),queue=[goal];
  for(let i=0;i<queue.length;i++)for(const r of by.get(queue[i])||[])for(const l of r.body)if(l.kind!=='test'&&!needed.has(l.pred)){needed.add(l.pred);queue.push(l.pred);}
  return rules.filter(r=>needed.has(r.head.pred));
}
/** Iterative Tarjan SCC schedule: O(predicates + dependencies), dependencies first.
 * Explicit stacks also handle rule chains deeper than the JavaScript call stack.
 */
export function schedule(rules){
  const graph=new Map();const ensure=p=>{if(!graph.has(p))graph.set(p,[]);};
  for(const r of rules){ensure(r.head.pred);for(const l of r.body)if(l.kind!=='test'){ensure(l.pred);graph.get(r.head.pred).push(l.pred);}}
  let serial=0;const index=new Map(),low=new Map(),stack=[],active=new Set(),components=[];
  const enter=(p,parent)=>{index.set(p,serial);low.set(p,serial++);stack.push(p);active.add(p);return {p,parent,next:0};};
  for(const start of graph.keys()){
    if(index.has(start))continue;const calls=[enter(start,null)];
    while(calls.length){const frame=calls.at(-1),{p}=frame,edges=graph.get(p);
      if(frame.next<edges.length){const q=edges[frame.next++];if(!index.has(q))calls.push(enter(q,p));else if(active.has(q))low.set(p,Math.min(low.get(p),index.get(q)));continue;}
      calls.pop();
      if(low.get(p)===index.get(p)){const c=[];let q;do{q=stack.pop();active.delete(q);c.push(q);}while(q!==p);components.push(c);}
      if(frame.parent!==null)low.set(frame.parent,Math.min(low.get(frame.parent),low.get(p)));
    }
  }
  const membership=new Map();components.forEach((ps,i)=>ps.forEach(p=>membership.set(p,i)));
  const scheduled=components.map(preds=>({preds:new Set(preds),rules:[]}));
  for(const r of rules){const ci=membership.get(r.head.pred);scheduled[ci].rules.push(r);for(const l of r.body)if(l.kind==='none'&&membership.get(l.pred)===ci)throw new SyntaxError('Unstratified negation cycle');}
  return scheduled.filter(c=>c.rules.length);
}
