// VENDORED: copied verbatim from vrc03r.zip vendor/vrc/src/rational.mjs
/** Exact rational arithmetic. Constants in SOP are decimal strings or integer ratios. */
const abs = x => x < 0n ? -x : x;
export function gcd(a,b) { a=abs(a); b=abs(b); while(b) [a,b]=[b,a%b]; return a; }
export class Rat {
  constructor(n=0n,d=1n) {
    n=BigInt(n); d=BigInt(d); if(!d) throw new RangeError('Zero denominator');
    if(d<0n) { n=-n; d=-d; } const g=gcd(n,d); this.n=n/g; this.d=d/g; Object.freeze(this);
  }
  static of(x) {
    if(x instanceof Rat) return x;
    if(typeof x==='bigint') return new Rat(x);
    if(typeof x==='number') { if(!Number.isFinite(x)) throw new TypeError('Non-finite coefficient'); x=String(x); }
    if(typeof x!=='string') throw new TypeError('Expected rational coefficient');
    x=x.trim(); if(x.includes('/')) { const p=x.split('/'); if(p.length!==2) throw new TypeError('Invalid fraction'); return Rat.of(p[0]).div(Rat.of(p[1])); }
    const m=x.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
    if(!m||!(m[2]||m[3])) throw new TypeError(`Invalid rational: ${x}`);
    let n=BigInt((m[2]||'0')+(m[3]||'')); if(m[1]==='-') n=-n;
    const k=(m[3]||'').length-Number(m[4]||0); if(Math.abs(k)>10000) throw new RangeError('Exponent budget');
    return k>=0?new Rat(n,10n**BigInt(k)):new Rat(n*10n**BigInt(-k));
  }
  add(x) { x=Rat.of(x); return new Rat(this.n*x.d+x.n*this.d,this.d*x.d); }
  sub(x) { return this.add(Rat.of(x).neg()); }
  mul(x) { x=Rat.of(x); if(!this.n||!x.n) return ZERO; return new Rat(this.n*x.n,this.d*x.d); }
  div(x) { x=Rat.of(x); return new Rat(this.n*x.d,this.d*x.n); }
  neg() { return new Rat(-this.n,this.d); }
  eq(x) { x=Rat.of(x); return this.n===x.n&&this.d===x.d; }
  pow(k) { if(!Number.isSafeInteger(k)||k<0) throw new RangeError('Nonnegative integer power required'); return new Rat(this.n**BigInt(k),this.d**BigInt(k)); }
  get zero() { return this.n===0n; }
  toNumber() { const v=Number(this.n)/Number(this.d); if(!Number.isFinite(v)) throw new RangeError('Coefficient exceeds float64 range'); return v; }
  toString() { return this.d===1n?String(this.n):`${this.n}/${this.d}`; }
  toJSON() { return this.toString(); }
}
export const ZERO=new Rat(0n), ONE=new Rat(1n);
/** Continued-fraction approximation, used only to propose; exact checker is separate. */
export function approximate(x,maxDen=10000) {
  if(!Number.isFinite(x)) throw new TypeError('Cannot rationalize non-finite number');
  if(!x) return ZERO; const sign=x<0?-1n:1n; let y=Math.abs(x),p0=0,p1=1,q0=1,q1=0;
  for(let it=0;it<64;it++) {
    const a=Math.floor(y),q2=q0+a*q1; if(q2>maxDen) break;
    const p2=p0+a*p1; if(!Number.isSafeInteger(p2)) break;
    [p0,p1,q0,q1]=[p1,p2,q1,q2]; const r=y-a; if(r<1e-14) return new Rat(sign*BigInt(p1),BigInt(q1)); y=1/r;
  }
  if(!q1) return new Rat(sign*BigInt(Math.round(Math.abs(x))));
  const k=Math.floor((maxDen-q0)/q1),pa=p0+k*p1,qa=q0+k*q1;
  const useA=qa>0&&Number.isSafeInteger(pa)&&Math.abs(pa/qa-Math.abs(x))<Math.abs(p1/q1-Math.abs(x));
  return new Rat(sign*BigInt(useA?pa:p1),BigInt(useA?qa:q1));
}
