/** HoloMemory banked signed-counter key -> value kernel (DS017).
 * Fixed arrays; no key list or exact value table. Codewords and key masks are
 * regenerated from seeded hashes. Scores are signal diagnostics, NOT probabilities.
 */
import {assert, stable} from '../../lib/util.mjs';
/** Snapshot format written by the kernel, followed by the legacy format it still reads. */
export const KERNEL_FORMATS=['holo-kernel-v1','h7-kernel-v1'];
export function mix(x){x=Math.imul(x^(x>>>16),0x85ebca6b);x=Math.imul(x^(x>>>13),0xc2b2ae35);return (x^(x>>>16))>>>0;}
function hash(text,seed){let h=seed>>>0;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619);return mix(h);}
function next(x){x^=x<<13;x^=x>>>17;x^=x<<5;return x>>>0;}

export class HoloKernel {
 constructor(config={},state=null){
  this.config={banks:4,rows:1024,dimension:64,seed:1234567,maxCounter:127,
   ageStepsPerNovel:0,minSignal:.35,minCorrelation:.15,minMargin:.10,maxCachedCodes:512,...(state?.config??config)};
  const c=this.config;
  assert(Number.isInteger(c.banks)&&c.banks>=2&&c.banks<=32,'holoMemory.banks must be 2..32');
  assert(Number.isInteger(c.rows)&&c.rows>=8&&c.rows<=1048576&&(c.rows&(c.rows-1))===0,'holoMemory.rows must be a power of 2 in 8..1048576');
  assert(Number.isInteger(c.dimension)&&c.dimension>=16&&c.dimension<=1024,'holoMemory.dimension must be 16..1024');
  assert(Number.isInteger(c.maxCounter)&&c.maxCounter>=1&&c.maxCounter<=127,'holoMemory.maxCounter must be 1..127 (Int8 storage)');
  assert(Number.isSafeInteger(c.ageStepsPerNovel)&&c.ageStepsPerNovel>=0,'Invalid ageStepsPerNovel');
  assert(Number.isInteger(c.maxCachedCodes)&&c.maxCachedCodes>=0&&c.maxCachedCodes<=65536,'Invalid maxCachedCodes');
  const length=c.banks*c.rows*c.dimension;
  assert(length<=512*1024*1024,'HoloMemory bank set exceeds the 512 MiB safety budget');
  this.counters=new Int8Array(length);
  if(state){const b=Buffer.from(state.counters,'base64');assert(b.length===length,'Corrupt HoloMemory counter length');this.counters.set(new Int8Array(b.buffer,b.byteOffset,b.length));}
  this.nonzero=0;for(const v of this.counters)if(v!==0)this.nonzero++;
  this.rng=(state?.rng??mix(c.seed^0x9e3779b9))||1;
  this.metrics={writes:0,novel:0,repeated:0,ageVisits:0,ageChanges:0,erased:0,...state?.metrics};
  this.codes=new Map();
 }
 code(value){
  const key=stable(value);let code=this.codes.get(key);if(code)return code;
  code=new Int8Array(this.config.dimension);let s=hash(key,this.config.seed^0xa511e9b3)||1;
  for(let d=0;d<code.length;d++){s=next(s);code[d]=(s&1)?1:-1;}
  if(this.config.maxCachedCodes){if(this.codes.size>=this.config.maxCachedCodes)this.codes.delete(this.codes.keys().next().value);this.codes.set(key,code);}
  return code;
 }
 _rows(key,fn){
  const text=typeof key==='string'?key:stable(key),c=this.config;
  for(let b=0;b<c.banks;b++){
   const h=hash(text,(c.seed+Math.imul(b+1,0x9e3779b9))>>>0),offset=(b*c.rows+(h&(c.rows-1)))*c.dimension;
   let s=mix(h^0x27d4eb2d)||1;
   fn(offset,()=>{s=next(s);return s&1?1:-1;});
  }
 }
 _set(i,v){const old=this.counters[i];if(!old&&v)this.nonzero++;else if(old&&!v)this.nonzero--;this.counters[i]=v;}
 write(key,value,{strength=1}={}){
  assert(Number.isInteger(strength)&&strength>=1&&strength<=127,'Invalid write strength');
  const code=this.code(value),limit=this.config.maxCounter;
  this._rows(key,(offset,mask)=>{for(let d=0;d<code.length;d++)this._set(offset+d,Math.max(-limit,Math.min(limit,this.counters[offset+d]+strength*code[d]*mask())));});
  this.metrics.writes++;return this;
 }
 signal(key){
  const out=new Float64Array(this.config.dimension);
  this._rows(key,(offset,mask)=>{for(let d=0;d<out.length;d++)out[d]+=this.counters[offset+d]*mask();});return out;
 }
 score(signal,value){
  const code=this.code(value);let dot=0,norm=0;for(let i=0;i<signal.length;i++){dot+=signal[i]*code[i];norm+=signal[i]*signal[i];}
  return {signal:dot/(this.config.banks*this.config.dimension),correlation:norm?dot/Math.sqrt(norm*signal.length):0};
 }
 rank(key,values){const s=this.signal(key);return values.map(value=>({value,...this.score(s,value)})).sort((a,b)=>b.signal-a.signal||stable(a.value).localeCompare(stable(b.value)));}
 read(key,values,options={}){
  assert(Array.isArray(values)&&values.length>0,'HoloMemory read needs an explicit candidate domain');
  const c={...this.config,...options},ranked=this.rank(key,values),best=ranked[0],margin=best.signal-(ranked[1]?.signal??0);
  const supported=best.signal>=c.minSignal&&best.correlation>=c.minCorrelation;
  return {status:supported&&margin>=c.minMargin?'remembered':supported?'uncertain':'not_remembered',
   value:supported&&margin>=c.minMargin?best.value:null,score:best.signal,correlation:best.correlation,margin,ranked};
 }
 /** Auto detection compares recalled content, not an external list of inserted keys. */
 remember(key,value,{novelty='auto',candidates=null,strength=1}={}){
  assert(['auto','new','repeat'].includes(novelty),'Invalid novelty mode');
  let repeated=novelty==='repeat';
  if(novelty==='auto'){
   assert(Array.isArray(candidates)&&candidates.length,'Auto novelty detection requires candidate values');
   const r=this.read(key,candidates);repeated=r.status==='remembered'&&stable(r.value)===stable(value);
  }
  if(repeated)this.metrics.repeated++;else{this.metrics.novel++;this.age(this.config.ageStepsPerNovel);}
  this.write(key,value,{strength});return {novel:!repeated};
 }
 reinforce(key,value,strength=1){return this.write(key,value,{strength});}
 age(visits=this.config.ageStepsPerNovel){
  assert(Number.isSafeInteger(visits)&&visits>=0,'Invalid ageing visits');let changed=0;
  for(let j=0;j<visits;j++){this.rng=next(this.rng);const i=this.rng%this.counters.length,v=this.counters[i];if(v){this._set(i,v-Math.sign(v));changed++;}}
  this.metrics.ageVisits+=visits;this.metrics.ageChanges+=changed;return changed;
 }
 decay(steps=1){assert(Number.isInteger(steps)&&steps>=0,'Invalid decay');for(let i=0;i<this.counters.length;i++){const v=this.counters[i];this._set(i,Math.sign(v)*Math.max(0,Math.abs(v)-steps));}}
 eraseFraction(fraction,seed=1){assert(fraction>=0&&fraction<=1,'Invalid erasure fraction');let s=mix(seed)||1,n=0;for(let i=0;i<this.counters.length;i++){s=next(s);if(s/4294967296<fraction){if(this.counters[i])n++;this._set(i,0);}}this.metrics.erased+=n;return n;}
 occupancy(){return this.nonzero/this.counters.length;}
 stats(){return {banksBytes:this.counters.byteLength,nonzero:this.nonzero,occupancy:this.occupancy(),
  codeCacheBytes:[...this.codes].reduce((s,[k,v])=>s+Buffer.byteLength(k)+v.byteLength,0),...this.metrics};}
 export(){return {format:KERNEL_FORMATS[0],config:this.config,counters:Buffer.from(this.counters.buffer).toString('base64'),rng:this.rng,metrics:this.metrics};}
 fork(){return new HoloKernel({},this.export());}
 static from(s){assert(KERNEL_FORMATS.includes(s?.format),'Unknown HoloMemory kernel snapshot');return new HoloKernel({},s);}
}
