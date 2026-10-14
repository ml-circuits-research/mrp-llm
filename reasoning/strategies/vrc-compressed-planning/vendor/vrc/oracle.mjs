// VENDORED: copied verbatim from vrc03r.zip vendor/vrc/src/oracle.mjs
import {Poly,exponents} from './poly.mjs';
import {approximate} from './rational.mjs';
import {LeastSquares} from './linalg.mjs';
/** Exact known-rule mode: appropriate when SOP contains the rules, not data-only ML. */
export class RuleOracle {
 constructor(actions){this.actions=actions;this.n=actions[0].T.length;this.cache=new Map();this.log=[];this.mode='known-rules';}
 pullback(p,action){const key=action.id+'|'+p.key();if(!this.cache.has(key)){const r=p.compose(action.T);this.cache.set(key,r);this.log.push({action:action.id,sourceDegree:p.degree,resultDegree:r.degree});}return this.cache.get(key);}
}
function design(X,d){return exponents(X[0].length,d).map(e=>Float64Array.from(X,x=>e.reduce((p,k,i)=>k?p*x[i]**k:p,1)));}
function error(c,B,y){let max=0,norm=0;for(let i=0;i<y.length;i++){let s=0;for(let j=0;j<c.length;j++)s+=c[j]*B[j][i];max=Math.max(max,Math.abs(s-y[i]));norm+=y[i]*y[i];}return max/Math.max(1,Math.sqrt(norm/y.length));}
/** Optional data-only proposal mode. Source T is not exposed to this class. */
export class SampleOracle {
 constructor(datasets,{maxFitDegree=6,tolerance=1e-8}={}){
  this.datasets=datasets;this.maxFitDegree=maxFitDegree;this.tolerance=tolerance;this.cache=new Map();this.designs=new Map();this.log=[];this.mode='data-only';
  const first=datasets[0];this.n=first.X[0].length;for(const ds of datasets)for(const k of ['X','Y','V','W'])if(!Array.isArray(ds[k])||!ds[k].length||ds[k].some(r=>r.length!==this.n||r.some(v=>!Number.isFinite(v))))throw new TypeError('Finite numeric state-transition matrices required');
  for(const ds of datasets)if(ds.X.length!==ds.Y.length||ds.V.length!==ds.W.length)throw new TypeError('Transition pair counts differ');
  this.actions=datasets.map(d=>({id:d.id,guards:[]}));
 }
 pullback(p,action){const ck=action.id+'|'+p.key();if(this.cache.has(ck))return this.cache.get(ck);const ds=this.datasets.find(d=>d.id===action.id);const y=ds.Y.map(x=>p.evaluate(x)),w=ds.W.map(x=>p.evaluate(x));
  for(let d=1;d<=this.maxFitDegree;d++){const key=action.id+':'+d;let spec=this.designs.get(key);if(!spec){const A=design(ds.X,d),B=design(ds.V,d);if(A.length>ds.X.length)continue;spec={solver:new LeastSquares(A),B,es:exponents(this.n,d)};this.designs.set(key,spec);}if(spec.solver.rank<spec.es.length)continue;const c=spec.solver.solve(y);if(error(c,spec.B,w)>this.tolerance)continue;
   for(const den of [16,64,256,1024,10000,1000000]){const q=[...c].map(v=>Math.abs(v)<1e-9?approximate(0):approximate(v,den)),cf=q.map(a=>a.toNumber());if(error(cf,spec.B,w)<=this.tolerance){const result=new Poly(this.n,spec.es.map((e,i)=>[e,q[i]]));this.cache.set(ck,result);this.log.push({action:action.id,sourceDegree:p.degree,fittedDegree:d,terms:result.t.size,validationError:error(cf,spec.B,w)});return result;}}
  }this.cache.set(ck,null);this.log.push({action:action.id,failure:'fit-budget-or-validation'});return null;
 }
}
