/** Local generational memory. Each shard owns its hash banks and dictionaries.
 * Retrieval unions reconstructed facts, NEVER ORs banks from different shards.
 * Immutable cold generations can be evicted; pinned generations and corrections
 * are protected. This is an in-process storage layout, not a distributed service.
 */
import {createBank,bankBytes} from './banks/factory.mjs';
import {holoSettings} from './banks/holo.mjs';
import {atom,atomKey} from '../lib/types.mjs';
import {digest,assert,stable} from '../lib/util.mjs';
import {serialInterval} from '../lib/time.mjs';

export const SHARD_DEFAULTS={
 enabled:true, mode:'bounded', safeOccupancy:.55, maxClaimsPerShard:1024,
 maxShardMetadataBytes:2*1024*1024, maxColdShards:8,
 maxHotAgeMs:null, maxColdAgeMs:null, maxNormalBankBytes:null,
 maxPinnedBankBytes:null, maxArchiveShards:null, gcEveryWrites:32
};
function configure(input){
 const s={...SHARD_DEFAULTS,...input.sharding};
 assert(['bounded','archive'].includes(s.mode),'sharding.mode must be bounded|archive');
 assert(Number.isFinite(s.safeOccupancy)&&s.safeOccupancy>0&&s.safeOccupancy<1,'Invalid sharding.safeOccupancy');
 for(const k of ['maxClaimsPerShard','maxShardMetadataBytes'])assert(Number.isSafeInteger(s[k])&&s[k]>0,'Invalid sharding.'+k);
 assert(Number.isSafeInteger(s.maxColdShards)&&s.maxColdShards>=0,'Invalid maxColdShards');
 for(const k of ['maxHotAgeMs','maxColdAgeMs','maxNormalBankBytes','maxPinnedBankBytes','maxArchiveShards'])
  assert(s[k]===null||(Number.isSafeInteger(s[k])&&s[k]>0),'Invalid sharding.'+k);
 assert(Number.isSafeInteger(s.gcEveryWrites)&&s.gcEveryWrites>=0,'Invalid gcEveryWrites');
 const r={mode:'none',writeStrength:2,useStrength:1,reinforceOnUse:true,...input.retention};
 assert(Number.isInteger(r.writeStrength)&&r.writeStrength>=1&&r.writeStrength<=15,'Invalid writeStrength');
 assert(Number.isInteger(r.useStrength)&&r.useStrength>=0&&r.useStrength<=15,'Invalid useStrength');
 return {...input,power:input.power??12,arity:input.arity??3,verification:input.verification??'receipt',journal:input.journal??false,exact:input.exact??false,retention:r,sharding:s};
}
const bytes=p=>bankBytes(p.bank);
const size=p=>Buffer.byteLength(JSON.stringify({claims:p.claims,receipts:p.bank.receipts,domains:p.bank.domains,exactAtoms:p.exactAtoms,sources:p.sources}));
const clone=structuredClone;
function serialize(p){if(!p)return null;return {id:p.id,retention:p.retention,createdAt:p.createdAt,lastWriteAt:p.lastWriteAt,sealedAt:p.sealedAt,exactComplete:p.exactComplete??false,bank:p.bank.export(),claims:p.claims,exactAtoms:p.exactAtoms,sources:p.sources};}
function deserialize(p){if(!p)return null;return {...clone({...p,bank:undefined}),bank:createBank({},p.bank)};}

export class ShardedLayer {
 constructor(config={},state=null){
  this.config=configure(state?.config??config);
  this.nextSerial=state?.nextSerial??0;
  this.hot=deserialize(state?.hot);this.cold=(state?.cold??[]).map(deserialize);
  this.pinnedHot=deserialize(state?.pinnedHot);this.pinnedCold=(state?.pinnedCold??[]).map(deserialize);
  this.events=clone(state?.events??[]);
  for(const part of this.allParts())if(part.bank.kernel&&(this.config.sharding.mode==='archive'||part.retention==='pinned'))part.bank.kernel.config.ageStepsPerNovel=0;
  this.maintenance=clone(state?.maintenance??{rotations:0,evictedShards:0,evictedClaims:0,promotions:0,runs:0,last:null});
  // Validate bank geometry even before the first allocation.
  const geometry=createBank(this.config),b=bankBytes(geometry);geometry.close?.();
  for(const k of ['maxNormalBankBytes','maxPinnedBankBytes'])
   assert(this.config.sharding[k]===null||this.config.sharding[k]>=b,k+' must fit at least one bank set');
 }
 retention(){return this.config.retention;}
 allParts(){return [...this.cold,...(this.hot?[this.hot]:[]),...this.pinnedCold,...(this.pinnedHot?[this.pinnedHot]:[])];}
 get claims(){return Object.assign({},...this.allParts().map(p=>p.claims));}
 lookupClaim(id){let hit;for(const p of this.allParts())if(p.claims[id])hit=p.claims[id];return hit;}
 get sources(){return this.allParts().flatMap(p=>p.sources);}
 get exactAtoms(){return Object.assign({},...this.allParts().map(p=>p.exactAtoms));}
 _new(retention,at){
  const id='s'+(++this.nextSerial),seed=((this.config.seed??1234567)+Math.imul(this.nextSerial,2654435761))>>>0;
  return {id,retention,createdAt:at,lastWriteAt:at,sealedAt:null,exactComplete:this.config.exact,bank:createBank({...this.config,seed,...((retention==='pinned'||this.config.sharding.mode==='archive')?{holoMemory:{...holoSettings(this.config),ageStepsPerNovel:0}}:{})}),claims:{},exactAtoms:{},sources:[]};
 }
 _needsRotation(p,at){
  if(!p||!Object.keys(p.claims).length)return false;
  const s=this.config.sharding;
  return p.bank.peakOccupancy()>=s.safeOccupancy||Object.keys(p.claims).length>=s.maxClaimsPerShard||size(p)>=s.maxShardMetadataBytes||
   (s.maxHotAgeMs!==null&&at-p.createdAt>=s.maxHotAgeMs);
 }
 _seal(retention,at){
  const key=retention==='pinned'?'pinnedHot':'hot',dest=retention==='pinned'?this.pinnedCold:this.cold,p=this[key];
  if(!p)return; p.sealedAt=at;dest.push(p);this[key]=null;this.maintenance.rotations++;
 }
 _target(retention,id,at){
  const key=retention==='pinned'?'pinnedHot':'hot';let p=this[key];
  const expired=p&&this.config.sharding.maxHotAgeMs!==null&&at-p.createdAt>=this.config.sharding.maxHotAgeMs;
  if(p&&((!p.claims[id]&&this._needsRotation(p,at))||expired)){this._seal(retention,at);p=null;}
  if(!p){
   const next=this._new(retention,at),s=this.config.sharding;
   if(retention==='pinned'&&s.maxPinnedBankBytes!==null)
    assert(this.pinnedCold.reduce((n,p)=>n+bytes(p),0)+bytes(next)<=s.maxPinnedBankBytes,'Pinned capacity reached; increase the explicit pinned budget');
   if(s.mode==='archive'&&s.maxArchiveShards!==null)
    assert(this.allParts().length<s.maxArchiveShards,'Archive shard limit reached; increase capacity (nothing was evicted)');
   this[key]=p=next;
  }
  return p;
 }
 _write(f,c,{at,strength,sourceSOP=null,promoted=false}){
  const p=this._target(c.retention,c.id,at),previous=p.claims[c.id];
  p.bank.add(f.atom,{strength,touchedAt:at,source:c.source,reason:promoted?'proof-use':'observation'});
  p.claims[c.id]={...previous,...clone(c),knownAt:Math.min(previous?.knownAt??Infinity,c.knownAt),
   observations:(previous?.observations??0)+(promoted?0:1),uses:(previous?.uses??0)+(promoted?1:0),
   ...(promoted?{promoted:true,lastUsedAt:at}:{lastObservedAt:at})};
  if(this.config.exact)p.exactAtoms[c.tupleHash]=clone(f.atom);
  if(this.config.journal&&sourceSOP&&!p.sources.some(x=>x.id===c.id&&x.sop===sourceSOP))p.sources.push({id:c.id,sop:sourceSOP,knownAt:c.knownAt});
  p.lastWriteAt=at;this._evict(at);return c.id;
 }
 add(f,{knownAt=Date.now(),sourceSOP=null,at=Date.now()}={}){
  atom(f.atom,{ground:true});assert(['normal','pinned'].includes(f.retention??'normal'),'Unknown retention mode');
  const raw={tupleHash:digest(atomKey(f.atom)),valid:serialInterval(f.valid),source:f.source??'user',quote:f.quote??''};
  const id='c_'+digest(raw).slice(0,32),old=this.lookupClaim(id);
  const c={...raw,id,knownAt:Math.min(old?.knownAt??Infinity,knownAt),retention:old?.retention==='pinned'?'pinned':f.retention??'normal'};
  return this._write(f,c,{at,strength:this.retention().writeStrength,sourceSOP});
 }
 reinforce(f,{usedAt=Date.now(),strength=this.retention().useStrength}={}){
  if(!this.retention().reinforceOnUse||strength<=0)return {reinforced:false};
  assert(f?.kind==='observed'&&f.evidence?.metadataVerified===true,'Only verified observed proof facts can be promoted');
  assert(/^c_[0-9a-f]{32}$/.test(f.id??''),'Promotion requires a claim identity');
  const meta=f.claim??{id:f.id,tupleHash:digest(atomKey(f.atom)),valid:serialInterval(f.valid),source:f.source??'memory',quote:f.quote??'',knownAt:f.knownAt??usedAt,retention:f.retention??'normal'};
  assert(meta.tupleHash===digest(atomKey(f.atom)),'Promotion tuple/claim mismatch');
  const pinned=this.lookupClaim(f.id)?.retention==='pinned'||meta.retention==='pinned';
  this._write(f,{...meta,retention:pinned?'pinned':'normal'},{at:usedAt,strength,promoted:true});
  this.maintenance.promotions++;return {reinforced:true,id:f.id,retention:pinned?'pinned':'normal',strength};
 }
 event(e,{knownAt=Date.now()}={}){
  assert(['end','retract'].includes(e.action),'Unsupported temporal event');assert(/^c_[0-9a-f]{32}$/.test(e.target),'Invalid event target');
  if(e.action==='end')assert(Number.isFinite(e.effective),'end needs effective time');
  const rec={action:e.action,target:e.target,knownAt,source:e.source??'user',...(e.action==='end'?{effective:e.effective}:{})};
  const key=digest(rec);if(!this.events.some(x=>digest(x)===key))this.events.push(rec);return 'e_'+key.slice(0,32);
 }
 _evict(at){
  const s=this.config.sharding;if(s.mode==='archive')return [];
  const removed=[];
  const overBytes=()=>s.maxNormalBankBytes!==null&&this.cold.reduce((n,p)=>n+bytes(p),this.hot?bytes(this.hot):0)>s.maxNormalBankBytes;
  while(this.cold.length&&(this.cold.length>s.maxColdShards||overBytes()||
   (s.maxColdAgeMs!==null&&at-this.cold[0].sealedAt>=s.maxColdAgeMs))){
   const p=this.cold.shift();removed.push({id:p.id,claims:Object.keys(p.claims).length,bankBytes:bytes(p)});
   this.maintenance.evictedShards++;this.maintenance.evictedClaims+=Object.keys(p.claims).length;
  }
  return removed;
 }
 maintain({at=Date.now(),force=false}={}){
  const before=this.maintenance.evictedShards,rotations=this.maintenance.rotations;
  for(const key of ['normal','pinned']){
   const p=key==='pinned'?this.pinnedHot:this.hot;
   if(p&&(force||this._needsRotation(p,at)))this._seal(key,at);
  }
  const removed=this._evict(at),result={triggered:this.maintenance.rotations>rotations||this.maintenance.evictedShards>before,
   mode:this.config.sharding.mode,rotations:this.maintenance.rotations-rotations,removed};
  this.maintenance.runs++;this.maintenance.last={at,...result};return result;
 }
 /** Explicit old-style decay is deliberately unavailable: sealed shards and
  * archive promises must not be silently weakened by a legacy command. */
 decay(){throw Error('Sharded memory uses rotation/eviction. Use maintain; legacy cell decay is not applied to immutable shards.');}
 /** Predicate routing is lossless relative to retained shards: skip only when
  * the predicate/arity domain does not exist. No probabilistic top-k routing. */
 readLayers(pattern=null){
  const pkey=pattern?pattern.p+'/'+pattern.a.length:null;
  const order=[...(this.pinnedHot?[this.pinnedHot]:[]),...this.pinnedCold.toReversed(),...(this.hot?[this.hot]:[]),...this.cold.toReversed()];
  return [{config:this.config,claims:{},events:this.events,exactAtoms:{},banks:[],control:true},
   ...order.filter(p=>!pkey||Object.hasOwn(p.bank.domains,pkey)).map(p=>({config:{...this.config,exact:p.exactComplete??this.config.exact},
    shardId:p.id,claims:p.claims,events:[],exactAtoms:p.exactAtoms,sources:p.sources,banks:[p.bank],frozen:this.frozen===true}))];
 }
 /** Keep old banks as opaque generations. No resizing and no replay from an
  * unverified source. Old correction records are kept in the control journal. */
 importLayers(layers,{at=Date.now()}={}){
  const events=new Map(this.events.map(e=>[digest(e),e]));
  for(const l of layers){
   for(const e of l.events??[])events.set(digest(e),clone(e));
   if(l instanceof ShardedLayer){
    for(const p of l.allParts()){
     const copy=deserialize(serialize(p));copy.id='s'+(++this.nextSerial);copy.sealedAt=at;
     (p.retention==='pinned'?this.pinnedCold:this.cold).push(copy);
    }
   }else{
    for(const retention of ['normal','pinned']){
     const claims=Object.fromEntries(Object.entries(l.claims).filter(([,c])=>(c.retention??'normal')===retention));
     if(!Object.keys(claims).length)continue;
     const hashes=new Set(Object.values(claims).map(c=>c.tupleHash));
     const p={id:'s'+(++this.nextSerial),retention,createdAt:at,lastWriteAt:at,sealedAt:at,exactComplete:l.config.exact,bank:createBank({},l[retention].export()),claims:clone(claims),
      exactAtoms:Object.fromEntries(Object.entries(l.exactAtoms??{}).filter(([h])=>hashes.has(h))),sources:clone((l.sources??[]).filter(x=>claims[x.id]))};
     (retention==='pinned'?this.pinnedCold:this.cold).push(p);
    }
   }
  }
  this.events=[...events.values()];return this; // No automatic deletion during migration.
 }
 export(){return {format:'sharded-v1',config:this.config,nextSerial:this.nextSerial,hot:serialize(this.hot),cold:this.cold.map(serialize),
  pinnedHot:serialize(this.pinnedHot),pinnedCold:this.pinnedCold.map(serialize),events:this.events,maintenance:this.maintenance};}
 stats(){
  const info=p=>({id:p.id,retention:p.retention,claims:Object.keys(p.claims).length,bankBytes:bytes(p),metadataBytes:size(p),
   occupancy:p.bank.occupancy(),peakOccupancy:p.bank.peakOccupancy(),createdAt:p.createdAt,sealedAt:p.sealedAt});
  const all=this.allParts(),normal=all.filter(p=>p.retention==='normal'),pinned=all.filter(p=>p.retention==='pinned');
  return {kind:'sharded',mode:this.config.sharding.mode,config:this.config.sharding,normalShards:normal.length,pinnedShards:pinned.length,
   normalBankBytes:normal.reduce((n,p)=>n+bytes(p),0),pinnedBankBytes:pinned.reduce((n,p)=>n+bytes(p),0),
   metadataBytes:all.reduce((n,p)=>n+size(p),0),eventsBytes:Buffer.byteLength(JSON.stringify(this.events)),claims:Object.keys(this.claims).length,
   hot:this.hot?info(this.hot):null,cold:this.cold.map(info),pinned: pinned.map(info),maintenance:clone(this.maintenance)};
 }
}
