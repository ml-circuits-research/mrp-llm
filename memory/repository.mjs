/** Local copy-on-write repository. A lock serializes writers; revisions detect
 * stale sessions. Shard blobs are content-addressed and shared by manifests.
 * User checkpoints have no parent chain in sharded mode. Old sessions/forks stay
 * readable until explicitly closed, and therefore remain garbage-collector roots.
 */
import fs from 'node:fs';import path from 'node:path';
import {recallLayers} from './temporal.mjs';
import {ShardedLayer} from './sharded.mjs';
import {createLayer,knowledgeConfig} from './factory.mjs';
import {atomKey} from '../lib/types.mjs';
import {digest,loadJSON,saveJSON,checkName,assert} from '../lib/util.mjs';
const ID=/^[a-f0-9]{64}$/;
/** Decoded snapshots shared by every repository of the process, by snapshot id (least recently used first); read-only. */
const SHARED=new Map();
const SHARED_SNAPSHOTS=Number(process.env.CHATSOP_SHARED_SNAPSHOTS)||512;
export class Repository{
 constructor(root,{memory={},maxCachedSnapshots=16}={}){
  this.root=path.resolve(root);this.memory=memory;this.maxCachedSnapshots=maxCachedSnapshots;
  fs.mkdirSync(this.root,{recursive:true});this.cache=new Map();this.chains=new Map();this.maxCachedChains=8;this.writing=false;this.reload();
 }
 reload(){this.meta=loadJSON(path.join(this.root,'index.json'),{version:1,bases:{},users:{},pins:{}});}
 lock(fn){
  if(this.writing)return fn();const file=path.join(this.root,'.write.lock');let fd;
  try{fd=fs.openSync(file,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error('Repository write lock exists. Verify its process before removing it.');throw e;}
  this.writing=true;
  try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:Date.now()}));this.reload();return fn();}
  finally{this.writing=false;fs.closeSync(fd);fs.unlinkSync(file);}
 }
 saveMeta(){saveJSON(path.join(this.root,'index.json'),this.meta);}
 blob(id){assert(ID.test(id),'Invalid shard ID');const p=path.join(this.root,'shards',id+'.json'),d=loadJSON(p,null);assert(d&&digest(d)===id,'Shard checksum mismatch or missing shard: '+id);return d;}
 encodeLayer(layer){
  const d=layer.export();if(d.format!=='sharded-v1')return d;
  const put=p=>{if(!p)return null;const id=digest(p),file=path.join(this.root,'shards',id+'.json');
   if(!fs.existsSync(file))saveJSON(file,p);return {$shard:id};};
  return {...d,external:true,hot:put(d.hot),cold:d.cold.map(put),pinnedHot:put(d.pinnedHot),pinnedCold:d.pinnedCold.map(put)};
 }
 loadLayer(data){
  if(data.format!=='sharded-v1')return createLayer(data.config,data);
  const get=p=>!p?null:p.$shard?this.blob(p.$shard):p;
  return createLayer(data.config,{...data,hot:get(data.hot),cold:data.cold.map(get),pinnedHot:get(data.pinnedHot),pinnedCold:data.pinnedCold.map(get)});
 }
 snap(layer,library=[],parents=[]){
  const data={version:2,layer:this.encodeLayer(layer),library,parents},id=digest(data);
  const file=path.join(this.root,'snapshots',id+'.json');if(!fs.existsSync(file))saveJSON(file,data);return id;
 }
 /** Forgets the decoded snapshots shared by the repositories of this process (a cold start for a measurement or a test). */
 static clearShared(){SHARED.clear();}
 read(id){
  assert(ID.test(id),'Invalid snapshot ID');
  if(!this.cache.has(id)){
   const file=path.join(this.root,'snapshots',id+'.json');
   // A snapshot id is the digest of its content, so a decoded snapshot is the same whichever repository holds the file (a session clones
   // its base memory by hard links): decoded snapshots are shared by every repository of the process, and a base memory is decoded once.
   // The file must still exist here; its content was verified when it was first decoded.
   let item=fs.existsSync(file)?SHARED.get(id):null;
   if(item){SHARED.delete(id);SHARED.set(id,item);}
   else{
    const d=loadJSON(file,null);assert(d&&digest(d)===id,'Snapshot checksum mismatch or missing snapshot');
    item={...d,layer:this.loadLayer(d.layer)};item.layer.frozen=true;SHARED.set(id,item);
    while(SHARED.size>SHARED_SNAPSHOTS)SHARED.delete(SHARED.keys().next().value);
   }
   this.cache.set(id,item);
   while(this.cache.size>Math.max(1,this.maxCachedSnapshots))this.cache.delete(this.cache.keys().next().value);
  }
  return this.cache.get(id);
 }
 walk(head){const result=[],seen=new Set(),visit=id=>{if(!id||seen.has(id))return;seen.add(id);const d=this.read(id);result.push(d);d.parents.forEach(visit);};visit(head);return result;}
 init(base='demo'){return this.lock(()=>{checkName(base);if(!this.meta.bases[base]){this.meta.bases[base]=this.snap(createLayer(knowledgeConfig(this.memory)));this.saveMeta();}return this.meta.bases[base];});}
 publish(base,layer,library=[]){return this.lock(()=>{checkName(base);const prev=this.meta.bases[base];this.meta.bases[base]=this.snap(layer,library,prev?[prev]:[]);this.saveMeta();return this.meta.bases[base];});}
 fork(source,target){return this.lock(()=>{[source,target].forEach(checkName);assert(this.meta.bases[source],'Missing source base');assert(!this.meta.bases[target],'Target base already exists');this.meta.bases[target]=this.meta.bases[source];this.saveMeta();return this.meta.bases[target];});}
 userKey(base,user){return digest([base,user]);}
 privateState(head,config=this.memory){
  const items=this.walk(head),lib=new Map();for(const item of items)for(const x of item.library)if(!lib.has(digest([x.id,x.hash,x.knownAt??0])))lib.set(digest([x.id,x.hash,x.knownAt??0]),x);
  let layer;
  if(items.length===1&&items[0].layer instanceof ShardedLayer){
   const state=items[0].layer.export();state.config={...state.config,...config,retention:{...state.config.retention,...config.retention},sharding:{...state.config.sharding,...config.sharding}};
   layer=createLayer(state.config,state);
  }else layer=new ShardedLayer(config).importLayers(items.toReversed().map(x=>x.layer));
  return {layer,library:[...lib.values()]};
 }
 session(base,user,name){return this.lock(()=>{
  [base,user,name].forEach(checkName);assert(this.meta.bases[base],'Unknown base');
  const file=path.join(this.root,'sessions',digest([base,user,name])+'.json');let d=loadJSON(file,null);
  if(!d){
   const userHead=this.meta.users[this.userKey(base,user)]??null,own=!!this.memory.sharding?.enabled;
   const state=own?this.privateState(userHead):{layer:createLayer(this.memory),library:[]};
   d={base,user,name,revision:0,baseHead:this.meta.bases[base],userHead,ownsUserHistory:own,layer:this.encodeLayer(state.layer),library:state.library};saveJSON(file,d);
  }
  return {...d,file,live:this.loadLayer(d.layer)};
 });}
 /** Moves a session onto the current head of its base. The session's own layer is kept, so a circuit published to the base after the session
  * opened (a session-local overlay in a cloned repository, DS022) becomes visible to it. */
 rebase(s){return this.lock(()=>{this.check(s);const head=this.meta.bases[s.base];assert(head,'Unknown base');if(head!==s.baseHead){s.baseHead=head;this.save(s);}return head;});}
 check(s){
  assert(s.file===path.join(this.root,'sessions',digest([s.base,s.user,s.name])+'.json'),'Session does not belong to this repository');
  const d=loadJSON(s.file,null);assert(d&&d.revision===s.revision,'Session changed: reopen before writing');
 }
 save(s){
  this.check(s);const {live,file,...d}=s,next=s.revision+1,state=this.encodeLayer(live);
  saveJSON(file,{...d,revision:next,layer:state});s.revision=next;s.layer=state;
  const cadence=live.config.sharding?.gcEveryWrites??0;
  if(live instanceof ShardedLayer&&cadence>0&&next%cadence===0){
   try{this.lastGc={status:'passed',...this.gc({dryRun:false})};}
   catch(e){this.lastGc={status:'failed',error:e.message,note:'Write succeeded; GC stopped without guessing reachability.'};}
   try{saveJSON(path.join(this.root,'maintenance.json'),this.lastGc);}catch(e){this.lastGc.reportWarning=e.message;}
  }
 }
 /** The layers a session reads: its own live layer, then the snapshots reachable from its user head and its base head. Snapshots are content
  * addressed and never change, so the walked chain is cached by its two heads (a base memory published circuit by circuit is a chain of
  * hundreds of snapshots, and walking it through the bounded snapshot cache costs seconds per call). */
 visible(s){
  const heads=[s.ownsUserHistory?null:s.userHead,s.baseHead],key=heads.join('|');
  let chain=this.chains.get(key);
  if(!chain){
   chain=[];const seen=new Set();
   const walk=id=>{if(!id||seen.has(id))return;seen.add(id);const item=this.read(id);chain.push(item);item.parents.forEach(walk);};
   heads.forEach(walk);
   this.chains.set(key,chain);
   while(this.chains.size>this.maxCachedChains)this.chains.delete(this.chains.keys().next().value);
  }
  return [{layer:s.live,library:s.library},...chain];
 }
 library(s,{asof=Infinity}={}){const map=new Map();for(const item of this.visible(s))for(const x of item.library)if((x.knownAt??0)<=asof&&!map.has(x.id))map.set(x.id,x);return [...map.values()];}
 recall(s,pattern,q,options){return recallLayers(this.visible(s).map(x=>x.layer),pattern,q,options);}
 /** Validate all operations on a private working copy before publishing once. */
 apply(s,ops,{knownAt=Date.now(),at=Date.now(),allowRules=false}={}){return this.lock(()=>{
  this.check(s);const scratch=createLayer(s.live.config,s.live.export()),library=[...s.library],results=[];
  const knownClaims=new Set(this.visible(s).flatMap(x=>Object.keys(x.layer.claims)));
  for(const o of ops){
   if(o.kind==='fact'){const id=scratch.add(o,{knownAt,at,sourceSOP:o.sop});knownClaims.add(id);results.push(id);}
   else if(o.kind==='event'){assert(knownClaims.has(o.target),'Cannot update an unknown/nonvisible claim');results.push(scratch.event(o,{knownAt}));}
   else if(o.kind==='library'){assert(allowRules,'Adding executable rules/templates requires reviewed ingestion');assert(!library.some(r=>r.id===o.id&&r.hash!==o.hash),'Library ID conflict');if(!library.some(r=>r.id===o.id))library.push(o);results.push(o.id);}
   else throw Error('Unsupported write kind');
  }
  const prev={live:s.live,library:s.library};s.live=scratch;s.library=library;
  try{this.save(s);}catch(e){Object.assign(s,prev);throw e;}return results;
 });}
 commit(s){return this.lock(()=>{
  this.check(s);const key=this.userKey(s.base,s.user);assert((this.meta.users[key]??null)===s.userHead,'User head advanced: open a fresh session and replay reviewed changes');
  const head=this.snap(s.live,s.library,s.ownsUserHistory?[]:s.userHead?[s.userHead]:[]);
  this.meta.users[key]=head;this.saveMeta();s.userHead=head;
  if(!s.ownsUserHistory){s.live=createLayer(this.memory);s.library=[];}
  this.save(s);return head;
 });}
 discard(s){return this.lock(()=>{
  this.check(s);
  if(s.ownsUserHistory){const state=this.privateState(s.userHead,s.live.config);s.live=state.layer;s.library=state.library;}
  else{s.live=createLayer(this.memory);s.library=[];}
  this.save(s);
 });}
 decay(s,steps){return this.lock(()=>{this.check(s);const next=createLayer(s.live.config,s.live.export());next.decay(steps);s.live=next;this.save(s);});}
 reinforce(s,facts,{usedAt=Date.now()}={}){return this.lock(()=>{
  this.check(s);const known=new Map();for(const x of this.visible(s).toReversed())for(const c of Object.values(x.layer.claims))known.set(c.id,c);
  const unique=new Map();for(const f of facts??[]){
   const c=known.get(f?.id);if(!c||f.kind!=='observed'||f.evidence?.metadataVerified!==true)continue;
   if(c.tupleHash!==digest(atomKey(f.atom)))continue;
   unique.set(f.id,{...f,claim:c,retention:c.retention??'normal'});
  }
  const next=createLayer(s.live.config,s.live.export()),results=[];
  for(const f of unique.values())results.push(next.reinforce(f,{usedAt}));
  if(results.some(x=>x.reinforced)){s.live=next;this.save(s);}return results;
 });}
 maintain(s,{force=false,at=Date.now()}={}){return this.lock(()=>{this.check(s);const next=createLayer(s.live.config,s.live.export()),result=next.maintain({force,at});s.live=next;this.save(s);return result;});}
 migrate(s,{memory=this.memory,at=Date.now()}={}){return this.lock(()=>{
  this.check(s);assert(memory.sharding?.enabled,'Migration requires a sharded configuration');
  const items=s.ownsUserHistory?[]:this.walk(s.userHead),lib=new Map();
  for(const x of [...s.library,...items.flatMap(x=>x.library)])if(!lib.has(digest([x.id,x.hash,x.knownAt??0])))lib.set(digest([x.id,x.hash,x.knownAt??0]),x);
  const layer=new ShardedLayer(memory).importLayers([...items.toReversed().map(x=>x.layer),s.live],{at});
  s.live=layer;s.library=[...lib.values()];s.ownsUserHistory=true;this.save(s);
  return {migrated:true,stats:layer.stats(),note:'No shard evicted by migration; bounded maintenance applies on the next write or maintain.'};
 });}
 closeSession(s){return this.lock(()=>{this.check(s);fs.unlinkSync(s.file);return {closed:true,uncommittedStateReleased:true};});}
 pinSnapshot(name,id){return this.lock(()=>{checkName(name);this.read(id);this.meta.pins??={};this.meta.pins[name]=id;this.saveMeta();return id;});}
 unpinSnapshot(name){return this.lock(()=>{checkName(name);if(this.meta.pins)delete this.meta.pins[name];this.saveMeta();});}
 /** Mark and sweep, dry-run by default. All manifests are validated BEFORE any
  * deletion. Open sessions, named forks, user heads and explicit pins are roots.
  * Corrupt/missing reachable objects stop GC rather than guessing reachability.
  */
 gc({dryRun=true}={}){return this.lock(()=>{
  const markedSnapshots=new Set(),markedShards=new Set();
  const visitLayer=l=>{
   if(l.format!=='sharded-v1')return;
   for(const p of [l.hot,...l.cold,l.pinnedHot,...l.pinnedCold])if(p?.$shard){if(!markedShards.has(p.$shard)){this.blob(p.$shard);markedShards.add(p.$shard);}}
  };
  const visit=id=>{
   if(!id||markedSnapshots.has(id))return;assert(ID.test(id),'Invalid root snapshot ID');
   const d=loadJSON(path.join(this.root,'snapshots',id+'.json'),null);assert(d&&digest(d)===id,'GC stopped: missing/corrupt reachable snapshot');
   markedSnapshots.add(id);visitLayer(d.layer);d.parents.forEach(visit);
  };
  for(const id of [...Object.values(this.meta.bases),...Object.values(this.meta.users),...Object.values(this.meta.pins??{})])visit(id);
  const sessions=path.join(this.root,'sessions');let sessionRoots=0;
  if(fs.existsSync(sessions))for(const name of fs.readdirSync(sessions).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){
   const s=loadJSON(path.join(sessions,name),null);assert(s&&s.layer&&s.baseHead,'GC stopped: invalid session manifest');
   visit(s.baseHead);visit(s.userHead);visitLayer(s.layer);sessionRoots++;
  }
  const removable=[];
  for(const [dir,marked]of [['snapshots',markedSnapshots],['shards',markedShards]]){
   const folder=path.join(this.root,dir);if(!fs.existsSync(folder))continue;
   for(const name of fs.readdirSync(folder).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)))if(!marked.has(name.slice(0,-5))){
    const file=path.join(folder,name);removable.push({kind:dir,id:name.slice(0,-5),bytes:fs.statSync(file).size});
   }
  }
  const result={dryRun,sessionRoots,reachableSnapshots:markedSnapshots.size,reachableShards:markedShards.size,
   snapshots:removable.filter(x=>x.kind==='snapshots').length,shards:removable.filter(x=>x.kind==='shards').length,
   reclaimableBytes:removable.reduce((n,x)=>n+x.bytes,0),deletedFiles:0};
  if(!dryRun)for(const r of removable){fs.unlinkSync(path.join(this.root,r.kind,r.id+'.json'));if(r.kind==='snapshots')this.cache.delete(r.id);result.deletedFiles++;}
  return result;
 });}
 checkpointBase(base){return this.lock(()=>{
  checkName(base);assert(this.meta.bases[base],'Unknown base');const items=this.walk(this.meta.bases[base]),library=new Map();
  for(const item of items)for(const r of item.library)if(!library.has(digest([r.id,r.hash,r.knownAt??0])))library.set(digest([r.id,r.hash,r.knownAt??0]),r);
  const config=knowledgeConfig({...this.memory,sharding:{enabled:true,...this.memory.sharding,mode:'archive'}});
  const layer=new ShardedLayer(config).importLayers(items.toReversed().map(x=>x.layer));
  const head=this.snap(layer,[...library.values()],[]);this.meta.bases[base]=head;this.saveMeta();return {head,parentsRemoved:items.length,stats:layer.stats()};
 });}
 stats(s){return {layers:this.visible(s).map(x=>x.layer.stats()),revision:s.revision,baseHead:s.baseHead,userHead:s.userHead,ownsUserHistory:!!s.ownsUserHistory,lastGc:this.lastGc??loadJSON(path.join(this.root,'maintenance.json'),null)};}
}
