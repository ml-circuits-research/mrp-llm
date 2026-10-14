/** Pattern matching of ground and variable atoms over fact lists: the one matcher shared by retrieval (memory/strategies.mjs) and
 * the bounded controllers (reasoning/controllers/). It derives nothing; deduction is the oracle (reasoning/strategies/js-reference).
 * Validity intervals are intersected along a join, so a row holds only where every matched fact holds.
 */
import {variable} from './types.mjs';
import {intersect} from './time.mjs';

/** Extend `env` so that `pattern` (with ?variables) equals the ground `value`; null on a mismatch of predicate, polarity or terms. */
export function unify(pattern,value,env={}){
 if(pattern.p!==value.p||pattern.neg!==value.neg||pattern.a.length!==value.a.length)return null;
 const next={...env};
 for(let i=0;i<pattern.a.length;i++){const a=pattern.a[i],b=value.a[i];
  if(variable(a)){if(Object.hasOwn(next,a)&&next[a]!==b)return null;next[a]=b;}
  else if(a!==b)return null;}
 return next;
}

/** Conjunction of atoms over `{id, atom, valid}` facts. `complete` is false when `maxJoins` candidate probes were not enough. */
export function join(body,facts,{maxJoins=30000,valid={from:-Infinity,until:Infinity}}={}){
 let rows=[{binding:{},valid,evidence:[]}],complete=true,probes=0;
 for(let stage=0;stage<body.length;stage++){
  const a=body[stage],next=[];
  for(const row of rows){
   for(const f of facts){
    if(++probes>maxJoins){complete=false;break;}
    const env=unify(a,f.atom,row.binding);if(!env)continue;
    const span=intersect(row.valid,f.valid);if(!span)continue;
    next.push({binding:env,valid:span,evidence:[...row.evidence,f.id]});
   }
   if(!complete)break;
  }
  rows=next;
  if(!complete){if(stage<body.length-1)rows=[];break;}
  if(!rows.length)break;
 }
 return {rows,complete,probes};
}
