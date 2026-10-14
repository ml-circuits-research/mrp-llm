/** HoloMemory SOP fact adapter over the signed-counter kernel (DS017).
 * For argument i: key = predicate + polarity + all OTHER arguments; value = arg i.
 * Candidate dictionaries and SHA-256 receipts are explicit, separately measured.
 * This adapter is not the still-experimental, fully bounded cue/content-plane
 * architecture that DS017 lists as future work. No exact atom bodies are read during recall.
 */
import {HoloKernel} from './holo-kernel.mjs';
import {atom,atomKey} from '../../lib/types.mjs';
import {assert,digest,stable,variable} from '../../lib/util.mjs';
import {groups,checkBudget} from './common.mjs';
// Frozen hash-domain tag of the field keys: changing it would re-address every stored trace,
// so it keeps its historical spelling (DS017, "Persisted identifiers").
const FIELD_TAG='h7-field-v1';
const keyFor=(a,i)=>stable([FIELD_TAG,a.p,a.neg,i,a.a.map((v,j)=>j===i?null:v)]);
/** Snapshot format written by this adapter, followed by the legacy format it still reads. */
export const HOLO_FORMATS=['holo-fact-bank-v1','h7-fact-bank-v1'];
/** HoloMemory parameters: `memory.holoMemory`, with the legacy `memory.holo` block as a fallback. */
export const holoSettings=(config={})=>({...config.holo,...config.holoMemory});
export class HoloBank {
 constructor(config={},state=null){
  this.config={...config,...state?.config,engine:'holo-memory'};
  this.kernel=state?HoloKernel.from(state.kernel):new HoloKernel({seed:this.config.seed??1234567,...holoSettings(this.config)});
  this.domains=structuredClone(state?.domains??{});this.receipts=structuredClone(state?.receipts??{});this.writes=state?.writes??0;
  this.metrics={novelFacts:0,repeatedFacts:0,...state?.metrics};this.domainSets=new Map();
  const settings=holoSettings(this.config);this.minSignal=settings.minSignal??.35;this.minCorrelation=settings.minCorrelation??.15;
  this.config.verification??='receipt';assert(this.config.verification==='receipt','HoloMemory SOP adapter requires integrity receipts');
 }
 _domainAdd(a){const pkey=a.p+'/'+a.a.length;if(!Object.hasOwn(this.domains,pkey))this.domains[pkey]=a.a.map(()=>[]);
  a.a.forEach((v,i)=>{const k=pkey+':'+i;let set=this.domainSets.get(k);if(!set){set=new Set(this.domains[pkey][i].map(stable));this.domainSets.set(k,set);}const s=stable(v);if(!set.has(s)){set.add(s);this.domains[pkey][i].push(v);}});
 }
 _evidence(a){return a.a.map((v,i)=>this.kernel.score(this.kernel.signal(keyFor(a,i)),v));}
 add(input,meta={}){
  const a=atom(input,{ground:true}),id=digest(atomKey(a)),previous=this.receipts[id],strength=meta.strength??1;
  assert(Number.isInteger(strength)&&strength>=1&&strength<=15,'strength must be 1..15');
  // A receipt alone does not establish that the trace is still remembered.
  const repeated=!!previous&&this._evidence(a).every(e=>e.signal>=this.minSignal&&e.correlation>=this.minCorrelation);
  const isUse=meta.reinforcement===true||meta.reason==='proof-use';
  if(!isUse){if(repeated)this.metrics.repeatedFacts++;else{this.metrics.novelFacts++;this.kernel.age(this.kernel.config.ageStepsPerNovel);}}
  for(let i=0;i<a.a.length;i++)this.kernel.write(keyFor(a,i),a.a[i],{strength});
  this._domainAdd(a);this.receipts[id]={...previous,...meta,strength:Math.min(15,(previous?.strength??0)+strength),seen:(previous?.seen??0)+1};this.writes++;return id;
 }
 reinforce(a,{strength=1,touchedAt=Date.now(),reason='use'}={}){return this.add(a,{strength,touchedAt,reason,reinforcement:true});}
 recall(pattern,options={}){
  const p=atom(pattern),{maxProbes,limit}=checkBudget(options),now=options.now??Date.now(),blocked=options.blocked??new Set();
  const d=this.domains[p.p+'/'+p.a.length];if(!d)return {rows:[],probes:0,complete:true};
  if(!maxProbes||!limit)return {rows:[],probes:0,complete:false};
  const unknown=groups(p,d),a=structuredClone(p),rows=[];let probes=0,complete=true;
  const accept=(knownEvidence=null)=>{
   if(probes>=maxProbes){complete=false;return;}probes++;
   const scores=knownEvidence?[knownEvidence]:this._evidence(a);
   if(scores.some(e=>e.signal<this.minSignal||e.correlation<this.minCorrelation))return;
   const id=digest(atomKey(a)),receipt=this.receipts[id];
   if(!receipt||blocked.has(id)||(receipt.expiresAt&&receipt.expiresAt<=now))return;
   if(rows.length>=limit){complete=false;return;}
   rows.push({atom:structuredClone(a),id,source:receipt.source??null,
    evidence:{verification:'holo-receipt',receipt:true,support:Math.min(...scores.map(x=>x.correlation)),
     signal:Math.min(...scores.map(x=>x.signal)),scoreIsProbability:false}});
  };
  const visit=depth=>{
   if(!complete)return;
   if(depth===unknown.length){accept();return;}
   const g=unknown[depth],last=depth===unknown.length-1;
   // For a single unknown occurrence the key is fixed: reconstruct a signal
   // once, then correlate all candidates. Multiple occurrences keep equality.
   const signal=last&&g.positions.length===1?this.kernel.signal(keyFor(a,g.positions[0])):null;
   for(const v of g.values){
    if(probes>=maxProbes){complete=false;break;}
    for(const pos of g.positions)a.a[pos]=v;
    if(last)accept(signal?this.kernel.score(signal,v):null);else{probes++;visit(depth+1);}
    if(!complete)break;
   }
   for(const pos of g.positions)a.a[pos]=p.a[pos];
  };
  if(unknown.length)visit(0);else accept();
  return {rows,probes,complete,coverage:'retained-holo-candidates',exhaustiveOriginalMemory:false};
 }
 decay(steps=1){assert(Number.isInteger(steps)&&steps>=0,'Invalid decay');this.kernel.decay(steps);for(const [id,r] of Object.entries(this.receipts)){r.strength=Math.max(0,(r.strength??1)-steps);if(!r.strength)delete this.receipts[id];}}
 maintain({mode='none',safeOccupancy=.55,targetOccupancy=.45,step=1,maxSweeps=15,at=Date.now()}={}){
  assert(['none','adaptive'].includes(mode),'Invalid maintenance mode');const before=this.occupancy();let sweeps=0;
  if(mode==='adaptive'&&before>safeOccupancy)while(this.occupancy()>targetOccupancy&&sweeps<maxSweeps){this.decay(step);sweeps++;}
  return {triggered:sweeps>0,mode,before,after:this.occupancy(),sweeps,at};
 }
 occupancy(){return this.kernel.occupancy();}
 peakOccupancy(){return this.occupancy();}
 bankBytes(){return this.kernel.counters.byteLength;}
 export(){return {format:HOLO_FORMATS[0],config:this.config,kernel:this.kernel.export(),domains:this.domains,receipts:this.receipts,writes:this.writes,metrics:this.metrics};}
 static from(s){return new HoloBank(s.config,s);}
 stats(){return {...this.kernel.stats(),engine:'holo-memory',writes:this.writes,...this.metrics,receipts:Object.keys(this.receipts).length,
  metadataBytes:Buffer.byteLength(JSON.stringify({domains:this.domains,receipts:this.receipts})),
  domainCacheEntries:[...this.domainSets.values()].reduce((n,s)=>n+s.size,0),boundedKernel:true,boundedTotal:false};}
}
