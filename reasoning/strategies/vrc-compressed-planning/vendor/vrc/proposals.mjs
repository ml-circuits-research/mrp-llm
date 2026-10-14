// VENDORED: copied verbatim from vrc03r.zip vendor/vrc/src/proposals.mjs
import {Poly,LinearBasis,divideExact,exponents} from './poly.mjs';
import {approximate} from './rational.mjs';
import {symmetricEigen,realEigen,transpose,matmul,inverse,rng} from './linalg.mjs';
/** Known sum-of-powers proposal, verified by an exact polynomial identity. */
export function powerSum(p,{attempts=8}={}){
 const d=p.degree,n=p.n;if(d<3||p.homogeneous().length!==1)return null;const H=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>p.derivative(i).derivative(j)));const random=rng(92417);
 for(let attempt=0;attempt<attempts;attempt++){const a=Array.from({length:n},()=>2.2*random()-1.1),b=Array.from({length:n},()=>2.2*random()-1.1);const H0=H.map(r=>r.map(v=>v.evaluate(a))),H1=H.map(r=>r.map(v=>v.evaluate(b)));const eig=symmetricEigen(H0);const rank=eig.values.filter(v=>Math.abs(v)>Math.abs(eig.values[0])*1e-9).length;if(!rank||Math.abs(eig.values[0])<1e-14)continue;
  const U=eig.vectors.map(r=>r.slice(0,rank)),Ut=transpose(U);let es;try{es=realEigen(matmul(matmul(matmul(Ut,H1),U),inverse(matmul(matmul(Ut,H0),U))));}catch{continue;}
  if(es.values.some((v,i)=>es.values.some((w,j)=>i!==j&&Math.abs(v-w)<1e-7*Math.max(1,Math.abs(v),Math.abs(w)))))continue;const raw=matmul(U,es.vectors);
  for(const den of [16,64,256,1024,10000]){const forms=[];for(let j=0;j<rank;j++){const col=raw.map(r=>r[j]);let k=0;for(let i=1;i<n;i++)if(Math.abs(col[i])>Math.abs(col[k]))k=i;if(Math.abs(col[k])<1e-12)continue;let f=Poly.zero(n);for(let i=0;i<n;i++){const c=approximate(col[i]/col[k],den);if(!c.zero)f=f.add(Poly.variable(n,i).scale(c));}forms.push(f.normalize());}
   if(new Set(forms.map(f=>f.key())).size!==rank)continue;const terms=forms.map(f=>f.pow(d)),result=new LinearBasis(terms).reduce(p);if(result.residual.zero)return {forms,weights:result.coefficients,degree:d,attempt,verified:true};}
 }
 return null;
}
const linearCache=new Map();
function linearCandidates(n,vars){const key=`${n}:${vars}`;if(linearCache.has(key))return linearCache.get(key);const out=[];const coeff=Array(vars.length).fill(0);
 function rec(j){if(j===coeff.length){const first=coeff.find(v=>v!==0);if(first!==1)return;let p=Poly.zero(n);for(let i=0;i<vars.length;i++)if(coeff[i])p=p.add(Poly.variable(n,vars[i]).scale(coeff[i]));out.push(p);return;}for(const c of [0,1,-1,2,-2]){coeff[j]=c;rec(j+1);}}
 if(vars.length<=6)rec(0);linearCache.set(key,out);return out;}
/** Bounded rational linear factoring, not a complete replacement for SymPy factor_list. */
export function boundedFactors(p){let rest=p.normalize();const factors=[];for(const v of p.variables()){const f=Poly.variable(p.n,v);for(;;){const q=divideExact(rest,f);if(!q)break;factors.push(f);rest=q;if(rest.constant)break;}}
 if(!rest.constant){const vars=rest.variables();for(const f of linearCandidates(p.n,vars)){if(rest.degree<2)break;if(f.t.size===1)continue;
   // A hyperplane evaluation cheaply rejects most nonfactors; exact division decides.
   const lead=f.leading,idx=lead[0].split(',').map(Number).findIndex(v=>v);const x=Array.from({length:p.n},(_,i)=>((i*7+3)%11)-4);x[idx]=0;const c=f.t.get(Array.from({length:p.n},(_,i)=>+(i===idx)).join(',')).toNumber();x[idx]=-f.evaluate(x)/c;
   const value=rest.evaluate(x);let scale=0;for(const[k,v]of rest.t){let t=Math.abs(v.toNumber());const e=k.split(',').map(Number);for(let i=0;i<x.length;i++)t*=Math.abs(x[i])**e[i];scale+=t;}if(Math.abs(value)>1e-8*Math.max(1,scale))continue;
   for(;;){const q=divideExact(rest,f);if(!q)break;factors.push(f);rest=q;if(rest.constant)break;}
  }}
 if(!rest.constant)factors.push(rest.normalize());return factors;
}
export class Proposer {
 constructor({maxLatent=4,maxEncoderDegree=4,latentDegree=2,factorize=true,additive=true}={}){Object.assign(this,{maxLatent,maxEncoderDegree,latentDegree,factorize,additive});this.cache=new Map();this.log=[];}
 dedup(options){const m=new Map();for(const opt of options){const uniq=new Map(opt.filter(p=>p.degree>0).map(p=>{p=p.normalize();return [p.key(),p];}));const ps=[...uniq.values()].sort((a,b)=>a.key().localeCompare(b.key()));if(ps.length<=this.maxLatent-1)m.set(ps.map(p=>p.key()).join('|'),ps);}return [...m.values()].sort((a,b)=>a.length-b.length||a.reduce((s,p)=>s+p.t.size+p.degree,0)-b.reduce((s,p)=>s+p.t.size+p.degree,0)).slice(0,48);}
 covers(p){const key=p.key();if(this.cache.has(key))return this.cache.get(key);let opts=[];
  if(p.degree>0&&p.degree<=this.maxEncoderDegree)opts.push([p.normalize()]);
  if(this.factorize&&this.latentDegree>=2){const atoms=boundedFactors(p);if(atoms.length>1&&atoms.length<=8){for(let mask=1;mask<(1<<atoms.length)-1;mask++){let a=Poly.constant(p.n,1),b=a;for(let i=0;i<atoms.length;i++)if(mask>>i&1)a=a.mul(atoms[i]);else b=b.mul(atoms[i]);if(Math.max(a.degree,b.degree)<=this.maxEncoderDegree)opts.push([a,b]);}}
   if(!opts.length&&this.additive){const decomposition=powerSum(p);if(decomposition){for(let k=1;k<=Math.floor(p.degree/2);k++)if(Math.max(k,p.degree-k)<=this.maxEncoderDegree)opts.push(decomposition.forms.flatMap(f=>[f.pow(k),f.pow(p.degree-k)]));this.log.push({operator:'hessian-pencil',degree:p.degree,rank:decomposition.forms.length,exactIdentity:true,forms:decomposition.forms.map(f=>f.toString())});}}
  }
  opts=this.dedup(opts);this.cache.set(key,opts);return opts;
 }
 propose(E,residual){let opts=this.covers(residual);if(this.factorize){const groups=residual.homogeneous().filter(([d])=>d>0).map(([,p])=>p);if(groups.length>1){const parts=groups.map(p=>this.covers(p));if(parts.every(p=>p.length)){let merged=[[]];for(const part of parts)merged=this.dedup(merged.flatMap(a=>part.map(b=>[...a,...b])));opts=[...opts,...merged];}}}
  const exists=new Set(E.map(p=>p.normalize().key()));return this.dedup(opts).map(opt=>opt.filter(p=>!exists.has(p.key()))).filter(ps=>ps.length&&ps.length+E.length<=this.maxLatent);
 }
}
