// VENDORED: copied verbatim from vrc03r.zip vendor/vrc/src/poly.mjs
import {Rat,ZERO,ONE} from './rational.mjs';
export const LIMITS=Object.freeze({maxTerms:30000,maxDegree:64,maxVariables:32});
const cacheExp=new Map();
export const exponentKey=e=>e.join(',');
export const parseKey=k=>k.split(',').map(Number);
export const monomialCompare=(a,b)=>{a=Array.isArray(a)?a:parseKey(a);b=Array.isArray(b)?b:parseKey(b);let d=a.reduce((s,v)=>s+v,0)-b.reduce((s,v)=>s+v,0);if(d)return d;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;};
export function exponents(n,d) {
  const key=`${n}:${d}`;if(cacheExp.has(key))return cacheExp.get(key);
  const out=[]; const e=Array(n).fill(0);
  function rec(at,left){if(at===n-1){e[at]=left;if(out.length>=20000)throw new RangeError('Monomial library budget');out.push([...e]);return;} for(let k=left;k>=0;k--){e[at]=k;rec(at+1,left-k);}}
  for(let degree=0;degree<=d;degree++)rec(0,degree);cacheExp.set(key,out);return out;
}
export class Poly {
  constructor(n,terms=[]) {
    if(!Number.isInteger(n)||n<1||n>LIMITS.maxVariables)throw new RangeError('Polynomial variable budget');this.n=n;this.t=new Map();
    for(const [k0,c0] of terms){const k=Array.isArray(k0)?exponentKey(k0):k0,e=parseKey(k),c=Rat.of(c0);
      if(e.length!==n||e.some(v=>!Number.isSafeInteger(v)||v<0)||e.reduce((s,v)=>s+v,0)>LIMITS.maxDegree)throw new RangeError('Polynomial exponent budget');
      const sum=(this.t.get(k)||ZERO).add(c);if(sum.zero)this.t.delete(k);else this.t.set(k,sum);}
    if(this.t.size>LIMITS.maxTerms)throw new RangeError('Polynomial term budget');
  }
  static zero(n){return new Poly(n);}
  static constant(n,c){return new Poly(n,[[Array(n).fill(0),c]]);}
  static variable(n,i){if(i<0||i>=n)throw new RangeError('Invalid variable');const e=Array(n).fill(0);e[i]=1;return new Poly(n,[[e,ONE]]);}
  static fromJSON(j){if(!j||!Array.isArray(j.terms))throw new TypeError('Invalid polynomial JSON');return new Poly(j.n,j.terms);}
  toJSON(){return {n:this.n,terms:[...this.t].sort(([a],[b])=>-monomialCompare(a,b)).map(([k,c])=>[parseKey(k),c.toString()])};}
  add(b){this.compat(b);const t=new Map(this.t);for(const[k,c]of b.t){const v=(t.get(k)||ZERO).add(c);if(v.zero)t.delete(k);else t.set(k,v);}return new Poly(this.n,t);}
  sub(b){return this.add(b.scale(-1));}
  scale(c){c=Rat.of(c);if(c.zero)return Poly.zero(this.n);return new Poly(this.n,[...this.t].map(([k,v])=>[k,v.mul(c)]));}
  mul(b){this.compat(b);if(this.zero||b.zero)return Poly.zero(this.n);if(this.degree+b.degree>LIMITS.maxDegree)throw new RangeError('Polynomial degree budget');const t=new Map();
    const bt=[...b.t].map(([k,c])=>[parseKey(k),c]);for(const[ak,av]of this.t){const a=parseKey(ak);for(const[bv,bc]of bt){const k=exponentKey(a.map((v,i)=>v+bv[i])),c=(t.get(k)||ZERO).add(av.mul(bc));if(c.zero)t.delete(k);else t.set(k,c);}}
    return new Poly(this.n,t);}
  pow(k){if(!Number.isSafeInteger(k)||k<0||k>LIMITS.maxDegree)throw new RangeError('Power budget');let r=Poly.constant(this.n,1),a=this;for(;k;k=Math.floor(k/2)){if(k%2)r=r.mul(a);if(k>1)a=a.mul(a);}return r;}
  compose(ps){if(ps.length!==this.n||!ps.every(p=>p.n===ps[0].n))throw new TypeError('Composition arity');const n=ps[0].n,powers=ps.map(p=>[Poly.constant(n,1)]);let r=Poly.zero(n);
    for(const[k,c]of this.t){let t=Poly.constant(n,c);const e=parseKey(k);for(let i=0;i<e.length;i++)if(e[i]){while(powers[i].length<=e[i])powers[i].push(powers[i].at(-1).mul(ps[i]));t=t.mul(powers[i][e[i]]);}r=r.add(t);}return r;}
  derivative(i){const out=[];for(const[k,c]of this.t){const e=parseKey(k);if(e[i]){const a=e[i];e[i]--;out.push([e,c.mul(a)]);}}return new Poly(this.n,out);}
  evaluate(xs){if(xs.length!==this.n)throw new TypeError('State dimension');let s=0;for(const[k,c]of this.t){let p=c.toNumber(),e=parseKey(k);for(let i=0;i<e.length;i++)if(e[i])p*=xs[i]**e[i];s+=p;}return s;}
  evaluateExact(xs){if(xs.length!==this.n)throw new TypeError('State dimension');let s=ZERO;const x=xs.map(Rat.of);for(const[k,c]of this.t){let p=c,e=parseKey(k);for(let i=0;i<e.length;i++)if(e[i])p=p.mul(x[i].pow(e[i]));s=s.add(p);}return s;}
  get degree(){let d=0;for(const k of this.t.keys())d=Math.max(d,parseKey(k).reduce((s,v)=>s+v,0));return d;}
  get zero(){return this.t.size===0;}
  get constant(){return this.degree===0;}
  get leading(){let lead=null;for(const k of this.t.keys())if(lead===null||monomialCompare(k,lead)>0)lead=k;return lead===null?null:[lead,this.t.get(lead)];}
  normalize(){const l=this.leading;return l?this.scale(ONE.div(l[1])):this;}
  key(){return JSON.stringify(this.toJSON());}
  eq(b){return this.sub(b).zero;}
  variables(){const r=new Set();for(const k of this.t.keys())parseKey(k).forEach((v,i)=>{if(v)r.add(i);});return [...r].sort((a,b)=>a-b);}
  homogeneous(){const m=new Map();for(const[k,c]of this.t){const d=parseKey(k).reduce((s,v)=>s+v,0);if(!m.has(d))m.set(d,[]);m.get(d).push([k,c]);}return [...m].sort(([a],[b])=>a-b).map(([d,ts])=>[d,new Poly(this.n,ts)]);}
  compat(b){if(!(b instanceof Poly)||b.n!==this.n)throw new TypeError('Polynomial dimensions differ');}
  toString(names=Array.from({length:this.n},(_,i)=>`x${i}`),prefix='?'){
    if(this.zero)return '0';return [...this.t].sort(([a],[b])=>-monomialCompare(a,b)).map(([k,c],j)=>{
      const e=parseKey(k),terms=[];e.forEach((p,i)=>{if(p)terms.push(prefix+names[i]+(p===1?'':`^${p}`));});
      const neg=c.n<0n,a=neg?c.neg():c;if(!terms.length||!a.eq(1))terms.unshift(a.toString());return (j?(neg?' - ':' + '):(neg?'-':''))+terms.join(' * ');
    }).join('');}
}
/** Exact sparse linear elimination; certificates retain coefficients of the original basis. */
export class LinearBasis {
  constructor(polys){this.polys=polys;this.rows=[];const m=polys.length;
    for(let i=0;i<m;i++){let r=polys[i],c=Array(m).fill(ZERO);c[i]=ONE;
      for(const row of this.rows){const a=r.t.get(row.pivot)||ZERO;if(!a.zero){r=r.sub(row.p.scale(a));c=c.map((x,j)=>x.sub(a.mul(row.c[j])));}}
      if(!r.zero){const [pivot,a]=r.leading;r=r.scale(ONE.div(a));c=c.map(x=>x.div(a));this.rows.push({pivot,p:r,c});this.rows.sort((a,b)=>-monomialCompare(a.pivot,b.pivot));}
    }
  }
  reduce(p){let r=p,c=Array(this.polys.length).fill(ZERO);for(const row of this.rows){const a=r.t.get(row.pivot)||ZERO;if(!a.zero){r=r.sub(row.p.scale(a));c=c.map((x,j)=>x.add(a.mul(row.c[j])));}}return {residual:r,coefficients:c};}
}
export function latentLibrary(E,d=2){const es=exponents(E.length,d),n=E[0].n;const ps=es.map(e=>e.reduce((p,k,i)=>k?p.mul(E[i].pow(k)):p,Poly.constant(n,1)));return {exponents:es,polys:ps,basis:new LinearBasis(ps)};}
export function divideExact(p,q){p.compat(q);if(q.zero)throw new RangeError('Division by zero polynomial');let r=p,out=Poly.zero(p.n);const [lk,lc]=q.leading,le=parseKey(lk);let it=0;
  while(!r.zero){if(++it>LIMITS.maxTerms)return null;const [rk,rc]=r.leading,re=parseKey(rk),e=re.map((v,i)=>v-le[i]);if(e.some(v=>v<0))return null;const term=new Poly(p.n,[[e,rc.div(lc)]]);out=out.add(term);r=r.sub(term.mul(q));}return out;}
