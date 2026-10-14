import {createBank} from './banks/factory.mjs';
import {holoSettings} from './banks/holo.mjs';
import {atomKey} from '../lib/types.mjs';
import {digest,assert} from '../lib/util.mjs';
import {serialInterval,readInterval,contains,intersect} from '../lib/time.mjs';

const RETENTION_DEFAULTS={
 mode:'none',                 // none | adaptive
 safeOccupancy:.55,          // trigger pressure maintenance above this fraction
 targetOccupancy:.45,        // cool until at or below this fraction
 writeStrength:2,            // support added by a normal observation
 useStrength:1,              // support added when a fact is actually used in a proof
 decayStep:1,
 maxSweeps:15,
 reinforceOnUse:false,
 pruneMetadata:false
};
function retentionConfig(config={}){
 const r={...RETENTION_DEFAULTS,...(config.retention??{})};
 assert(['none','adaptive'].includes(r.mode),'memory.retention.mode must be none|adaptive');
 assert(r.safeOccupancy>0&&r.safeOccupancy<1,'safeOccupancy must be 0..1');
 assert(r.targetOccupancy>=0&&r.targetOccupancy<r.safeOccupancy,'targetOccupancy must be below safeOccupancy');
 assert(Number.isInteger(r.writeStrength)&&r.writeStrength>=1&&r.writeStrength<=15,'writeStrength must be 1..15');
 assert(Number.isInteger(r.useStrength)&&r.useStrength>=0&&r.useStrength<=15,'useStrength must be 0..15');
 assert(Number.isInteger(r.decayStep)&&r.decayStep>=1&&r.decayStep<=15,'decayStep must be 1..15');
 assert(Number.isInteger(r.maxSweeps)&&r.maxSweeps>=1&&r.maxSweeps<=100,'maxSweeps must be 1..100');
 return r;
}
/** Tuple bodies are reconstructed from the selected bank (RecallMemory by default), not read from an exact fact table.
 * Exact claim metadata and update events qualify time, identity and provenance.
 * A source journal is optional and is NEVER read by recall().
 *
 * Retention is approximate. Normal memory is a bank of saturating counters.
 * Observation/use increases counters; pressure maintenance decreases every normal
 * counter. Pinned memory is a physically separate bank and is never cooled by
 * automatic maintenance.
 */
export class TemporalLayer{
 constructor(config={},state=null){
  const source=state?.config??config;
  this.config={power:12,arity:3,verification:'receipt',journal:false,exact:false,...source,retention:retentionConfig(source)};
  this.normal=createBank(this.config,state?.normal??null);
  this.pinned=createBank({...this.config,holoMemory:{...holoSettings(this.config),ageStepsPerNovel:0}},state?.pinned??null);
  for(const bank of [this.pinned,this.pinned.associative])if(bank?.kernel)bank.kernel.config.ageStepsPerNovel=0;
  if(this.config.retention.mode==='none')for(const bank of [this.normal,this.normal.associative])if(bank?.kernel)bank.kernel.config.ageStepsPerNovel=0;
  this.claims=structuredClone(state?.claims??{});this.events=structuredClone(state?.events??[]);this.sources=structuredClone(state?.sources??[]);this.exactAtoms=structuredClone(state?.exactAtoms??{});
  this.maintenance=structuredClone(state?.maintenance??{runs:0,triggered:0,last:null});
 }
 retention(){return this.config.retention;}
 maintain({at=Date.now(),force=false}={}){
  const r=this.retention();
  const result=this.normal.maintain({mode:force?'adaptive':r.mode,safeOccupancy:r.safeOccupancy,targetOccupancy:r.targetOccupancy,step:r.decayStep,maxSweeps:r.maxSweeps,at});
  let prunedClaims=0;
  if(result.triggered&&r.pruneMetadata){const removed=new Set();for(const [id,c] of Object.entries(this.claims))if((c.retention??'normal')==='normal'&&!this.normal.receipts[c.tupleHash]){delete this.claims[id];removed.add(id);prunedClaims++;}if(removed.size){/* Never prune retractions here: a retained parent may contain the target. */this.sources=this.sources.filter(x=>!removed.has(x.id));if(this.config.exact){const liveHashes=new Set(Object.values(this.claims).map(c=>c.tupleHash));for(const h of Object.keys(this.exactAtoms))if(!liveHashes.has(h))delete this.exactAtoms[h];}}}
  result.prunedClaims=prunedClaims;this.maintenance.runs++;if(result.triggered)this.maintenance.triggered++;this.maintenance.last={at,...result};return result;
 }
 add(f,{knownAt=Date.now(),sourceSOP=null}={}){
  assert(['normal','pinned'].includes(f.retention??'normal'),'Unknown retention mode');const tupleHash=digest(atomKey(f.atom));const raw={tupleHash,valid:serialInterval(f.valid),source:f.source??'user',quote:f.quote??''};const id='c_'+digest(raw).slice(0,32);
  if(!this.claims[id])this.claims[id]={...raw,id,knownAt,retention:f.retention??'normal',observations:0};
  if(this.config.exact)this.exactAtoms[tupleHash]=structuredClone(f.atom);
  const c=this.claims[id];if(f.retention==='pinned')c.retention='pinned';c.observations++;c.lastObservedAt=knownAt;
  if(c.retention==='pinned')this.pinned.add(f.atom,{strength:1,touchedAt:knownAt,source:c.source});
  else {this.normal.add(f.atom,{strength:this.retention().writeStrength,touchedAt:knownAt,source:c.source});this.maintain({at:knownAt});}
  if(this.config.journal&&sourceSOP)this.sources.push({id,sop:sourceSOP,knownAt});return id;
 }
 /** Reinforce only facts that were actually used by the reasoner. A promoted
  * receipt and metadata copy are written into the hot layer so a useful fact
  * from an older immutable snapshot can survive independently of that snapshot.
  */
 reinforce(f,{usedAt=Date.now(),strength=this.retention().useStrength}={}){
  if(!this.retention().reinforceOnUse||strength<=0||!f?.atom)return {reinforced:false};
  const tupleHash=digest(atomKey(f.atom)),retention=f.retention==='pinned'?'pinned':'normal';
  if(f.id&&/^c_[0-9a-f]{32}$/.test(f.id)&&!this.claims[f.id])this.claims[f.id]={id:f.id,tupleHash,...(f.claim??{}),valid:f.claim?.valid??serialInterval(f.valid??{from:-Infinity,until:Infinity}),source:f.source??'memory',quote:f.quote??'',knownAt:f.knownAt??usedAt,retention,observations:0,promoted:true};
  const target=retention==='pinned'?this.pinned:this.normal;target.reinforce(f.atom,{strength,touchedAt:usedAt,reason:'proof-use'});
  if(this.claims[f.id]){this.claims[f.id].uses=(this.claims[f.id].uses??0)+1;this.claims[f.id].lastUsedAt=usedAt;}
  const maintenance=retention==='normal'?this.maintain({at:usedAt}):{triggered:false,mode:'pinned'};
  return {reinforced:true,id:f.id??null,retention,strength,maintenance};
 }
 event(e,{knownAt=Date.now()}={}){assert(['end','retract'].includes(e.action),'Unsupported temporal event');assert(/^c_[0-9a-f]{32}$/.test(e.target),'Event target must be a claim ID');if(e.action==='end')assert(Number.isFinite(e.effective),'end needs effective time');const rec={action:e.action,target:e.target,knownAt,source:e.source??'user',...(e.action==='end'?{effective:e.effective}:{})};this.events.push(rec);return 'e_'+digest(rec).slice(0,32);}
 export(){return {config:this.config,normal:this.normal.export(),pinned:this.pinned.export(),claims:this.claims,events:this.events,sources:this.sources,exactAtoms:this.exactAtoms,maintenance:this.maintenance};}
 stats(){return {normal:this.normal.stats(),pinned:this.pinned.stats(),retention:this.retention(),maintenance:this.maintenance,exactAtomsBytes:Buffer.byteLength(JSON.stringify(this.exactAtoms)),claimMetadataBytes:Buffer.byteLength(JSON.stringify(this.claims)),eventsBytes:Buffer.byteLength(JSON.stringify(this.events)),journalBytes:Buffer.byteLength(JSON.stringify(this.sources)),claims:Object.keys(this.claims).length};}
 decay(steps=1){this.normal.decay(steps);}
}
/** Flatten generational layers without conflating their physical banks. */
export function flattenLayers(layers,pattern=null){return layers.flatMap(l=>typeof l.readLayers==='function'?l.readLayers(pattern):[l]);}
const HASH_INDEX=new WeakMap();
function hashIndex(claims){const m=new Map();for(const c of Object.values(claims)){if(!m.has(c.tupleHash))m.set(c.tupleHash,[]);m.get(c.tupleHash).push(c);}return m;}
export function recallLayers(input,pattern,q,{maxProbes=50000,limit=10000,maxShards=Infinity,allowUnverified=false}={}){
 assert(Number.isInteger(maxProbes)&&maxProbes>=0,'Invalid maxProbes');
 assert(Number.isInteger(limit)&&limit>=0,'Invalid result limit');
 assert(maxShards===Infinity||(Number.isInteger(maxShards)&&maxShards>=0),'Invalid maxShards');
 const layers=flattenLayers(input,pattern),asof=q.asof??Infinity;
 const events=layers.flatMap(l=>l.events).filter(e=>e.knownAt<=asof),byTarget=new Map();
 // The claims behind a stored tuple, oldest layer first and the newest version of a claim winning: found through a per-layer index by tuple
 // hash, so a recall costs the rows it matches, not the claims of the layers it reads (a frozen snapshot layer is indexed once).
 const oldestFirst=[...layers].reverse(),local=new Map();
 const index=l=>{if(l.frozen){let m=HASH_INDEX.get(l.claims);if(!m)HASH_INDEX.set(l.claims,m=hashIndex(l.claims));return m;}if(!local.has(l))local.set(l,hashIndex(l.claims));return local.get(l);};
 const claimsOf=hash=>{const found=new Map();for(const l of oldestFirst)for(const c of index(l).get(hash)??[])if(c.knownAt<=asof)found.set(c.id,c);return [...found.values()];};
 for(const e of events){if(!byTarget.has(e.target))byTarget.set(e.target,[]);byTarget.get(e.target).push(e);}
 const rows=new Map();let probes=0,complete=true,shardsVisited=0;
 const pkey=pattern.p+'/'+pattern.a.length;
 const candidates=layers.map(l=>({layer:l,banks:(l.banks??[l.pinned,l.normal]).filter(b=>b&&Object.hasOwn(b.domains,pkey))})).filter(x=>x.banks.length);
 outer:for(const {layer,banks} of candidates){
  if(shardsVisited>=maxShards){complete=false;break;}shardsVisited++;
  for(const bank of banks){
   if(probes>=maxProbes||rows.size>=limit){complete=false;break outer;}
   const r=bank.recall(pattern,{maxProbes:maxProbes-probes,limit});probes+=r.probes;complete&&=r.complete;
   for(const hit of r.rows){const metas=claimsOf(hit.id);
    for(const c of metas){const changes=byTarget.get(c.id)??[];if(changes.some(e=>e.action==='retract'))continue;
     const span=readInterval(c.valid);for(const e of changes)if(e.action==='end')span.until=Math.min(span.until,e.effective);if(!(span.from<span.until))continue;
     let valid=span;if(q.at!==undefined&&!contains(span,q.at))continue;if(q.during){valid=intersect(span,q.during);if(!valid)continue;}
     rows.set(c.id,{id:c.id,atom:hit.atom,valid,source:c.source,quote:c.quote,knownAt:c.knownAt,retention:c.retention??'normal',kind:'observed',
      claim:structuredClone(c),shardId:layer.shardId??null,evidence:{...hit.evidence,metadataVerified:true}});
    }
    if(!metas.length&&allowUnverified)rows.set('h_'+hit.id,{id:'h_'+hit.id,atom:hit.atom,valid:q.during??{from:-Infinity,until:Infinity},kind:'hypothesis',evidence:{support:hit.evidence.support,metadataVerified:false}});
   }
  }
 }
 return {rows:[...rows.values()].slice(0,limit),complete:complete&&rows.size<=limit,probes,shardsVisited,shardsRouted:candidates.length};
}
