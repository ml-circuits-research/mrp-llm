// VENDORED: copied verbatim from sop_reasoner_e10.zip (sop-verified-reasoner 0.3.0) src/reference.mjs
/** Intentionally independent evaluator: typed raw values, nested loops, synchronous
 * fixpoint, no optimized relation store, optimizer, joins, or SCC implementation. */
export function reference(program,queryName,{maxWork=10_000_000,maxRounds=2000}={}){
  const isVar=t=>t&&typeof t==='object'&&typeof t.var==='string';
  const tupleKey=t=>JSON.stringify(t),tables=new Map(),levels=new Map();let visits=0,rounds=0;
  function table(p){if(!tables.has(p))tables.set(p,new Map());if(!levels.has(p))levels.set(p,0);return tables.get(p);}
  for(const f of program.facts)table(f.pred).set(tupleKey(f.terms),f.terms);
  for(const r of program.rules){table(r.head.pred);for(const l of r.body)if(l.kind!=='test')table(l.pred);}
  let changed=true;for(let step=0;step<=levels.size&&changed;step++){changed=false;for(const r of program.rules)for(const l of r.body)if(l.kind!=='test'){const required=levels.get(l.pred)+(l.kind==='none'?1:0);if(levels.get(r.head.pred)<required){levels.set(r.head.pred,required);changed=true;}}if(step===levels.size&&changed)throw new Error('Unstratified negation');}
  function match(ts,vs,env){const out={...env};for(let i=0;i<ts.length;i++){const t=ts[i];if(isVar(t)){if(Object.hasOwn(out,t.var)&&out[t.var]!==vs[i])return null;out[t.var]=vs[i];}else if(t!==vs[i])return null;}return out;}
  function ground(ts,env){return ts.map(t=>isVar(t)?env[t.var]:t);}
  function* join(body,env,snapshot){if(!body.length){yield env;return;}
    // Safety: positive atoms first, then ground filters and closed-world anti-joins.
    const [l,...tail]=body;
    if(l.kind==='atom'){for(const row of snapshot.get(l.pred).values()){if(++visits>maxWork)throw new Error('REFERENCE_BUDGET');const e=match(l.terms,row,env);if(e)yield* join(tail,e,snapshot);}return;}
    const v=ground(l.terms,env);
    if(l.kind==='none'){visits++;if(!snapshot.get(l.pred).has(tupleKey(v)))yield* join(tail,env,snapshot);return;}
    if(['<','<=','>','>='].includes(l.op)&&v.some(x=>typeof x!=='number'))throw new TypeError('Ordered TEST requires integers');
    let ok;switch(l.op){case '==':ok=v[0]===v[1];break;case '!=':ok=v[0]!==v[1];break;case '<':ok=v[0]<v[1];break;case '<=':ok=v[0]<=v[1];break;case '>':ok=v[0]>v[1];break;case '>=':ok=v[0]>=v[1];break;default:throw new Error('comparison');}
    if(ok)yield* join(tail,env,snapshot);
  }
  for(let level=0;level<=Math.max(0,...levels.values());level++){
    const rules=program.rules.filter(r=>levels.get(r.head.pred)===level);let added=true;
    while(added){if(++rounds>maxRounds)throw new Error('REFERENCE_ROUNDS');added=false;const snapshot=new Map([...tables].map(([p,t])=>[p,new Map(t)]));
      for(const r of rules){const body=[...r.body.filter(l=>l.kind==='atom'),...r.body.filter(l=>l.kind!=='atom')];for(const e of join(body,{},snapshot)){const row=ground(r.head.terms,e),k=tupleKey(row);if(!table(r.head.pred).has(k)){table(r.head.pred).set(k,row);added=true;}}}
    }
  }
  const query=program.queries.find(q=>q.name===queryName);if(!query)throw new Error('Unknown query');
  const rows=[...table(query.pred).values()].sort((a,b)=>tupleKey(a).localeCompare(tupleKey(b)));
  return {status:'COMPLETE',rows,count:rows.length,stats:{candidateVisits:visits,rounds}};
}
