import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ShardedLayer} from '../../memory/sharded.mjs';
import {createLayer} from '../../memory/factory.mjs';
import {TemporalLayer,recallLayers} from '../../memory/temporal.mjs';
import {RecallMemory} from '../../memory/weaver.mjs';
import {Repository} from '../../memory/repository.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {StrategyRegistry} from '../../memory/strategies.mjs';
import {context,queryProgram,schema,day} from '../helpers.mjs';
import {loadJSON,digest,stable} from '../../lib/util.mjs';

const config=(s={},extra={})=>({power:9,arity:3,verification:'receipt',retention:{writeStrength:2,useStrength:1,reinforceOnUse:true},
 sharding:{enabled:true,mode:'bounded',maxClaimsPerShard:2,maxColdShards:2,safeOccupancy:.9,...s},...extra});
const fact=(i,more={})=>({kind:'fact',atom:{p:'likes',a:['person'+i,'org'+i],neg:false},valid:{from:-Infinity,until:Infinity},source:'fixture',...more});
const q={at:100,asof:Infinity};
const all={p:'likes',a:['?p','?o'],neg:false};
const add=(l,i,options={})=>l.add(fact(i),{knownAt:1,at:i+1,...options});
const recall=(l,p=all,opts={})=>recallLayers([l],p,q,opts);
function temp(memory=config()){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shard-test-')),repo=new Repository(root,{memory});repo.init('base');
 return {root,repo,s:repo.session('base','alice','one'),dispose:()=>fs.rmSync(root,{recursive:true,force:true})};
}
const write=(repo,s,i)=>repo.apply(s,[fact(i)],{knownAt:1,at:i+1})[0];

test('shards: rotate and evict entire normal generations at a fixed bound',()=>{
 const l=new ShardedLayer(config());for(let i=0;i<8;i++)add(l,i);
 assert.equal(l.stats().normalShards,3);assert.equal(l.cold.length,2);assert.equal(Object.keys(l.claims).length,6);
 assert.equal(recall(l,fact(0).atom).rows.length,0);assert.equal(recall(l,fact(7).atom).rows.length,1);
 assert.equal(l.maintenance.evictedShards,1);assert.equal(recall(l).rows.length,6);
});
test('shards: sealed bank, receipts and metadata do not change on another write',()=>{
 const l=new ShardedLayer(config());for(let i=0;i<3;i++)add(l,i);
 const before=stable(l.export().cold[0]);add(l,3);assert.equal(stable(l.export().cold[0]),before);
});
test('shards: occupancy trigger uses the most occupied column',()=>{
 const safe=.07,l=new ShardedLayer(config({safeOccupancy:safe,maxClaimsPerShard:10000,maxColdShards:100},{power:7}));
 for(let i=0;i<120;i++)l.add({...fact(i),atom:{p:'quad',a:['a'+i,'b'+i,'c'+i,'d'+i],neg:false}},{knownAt:1,at:i});
 assert.ok(l.cold.length>0);
 for(const p of l.allParts())assert.ok(p.bank.peakOccupancy()<=safe+1/128+1e-9);
});
test('shards: metadata size is also a rotation trigger',()=>{
 const l=new ShardedLayer(config({maxClaimsPerShard:1000,maxShardMetadataBytes:1000}));l.add(fact(0,{quote:'x'.repeat(2000)}));add(l,1);
 assert.equal(l.cold.length,1);
});
test('shards: empty maintenance allocates no banks',()=>{
 const l=new ShardedLayer(config());assert.equal(l.maintain({force:true,at:10}).triggered,false);assert.equal(l.stats().normalBankBytes,0);
});
test('shards: time rotation and cold TTL can be driven by an injected clock',()=>{
 const l=new ShardedLayer(config({maxHotAgeMs:10,maxColdAgeMs:20,maxColdShards:100}));
 add(l,0,{at:0});add(l,1,{at:11});assert.equal(l.cold.length,1);
 l.maintain({at:40});assert.equal(recall(l,fact(0).atom).rows.length,0);assert.equal(recall(l,fact(1).atom).rows.length,1);
});
test('shards: normal bank byte budget is enforced independently of count',()=>{
 const one=20*512/2,l=new ShardedLayer(config({maxClaimsPerShard:1,maxColdShards:100,maxNormalBankBytes:one*2}));
 for(let i=0;i<10;i++)add(l,i);assert.equal(l.stats().normalShards,2);assert.equal(l.stats().normalBankBytes,one*2);
});
test('shards: pinned capacity grows separately and survives normal eviction',()=>{
 const l=new ShardedLayer(config({maxColdShards:0}));
 for(let i=0;i<5;i++)l.add(fact(i,{retention:'pinned'}),{knownAt:1,at:i});
 for(let i=5;i<25;i++)add(l,i);
 assert.equal(l.stats().pinnedShards,3);
 for(let i=0;i<5;i++)assert.equal(recall(l,fact(i).atom).rows.length,1);
});
test('shards: pinning an older normal claim keeps its retention across promotion',()=>{
 const l=new ShardedLayer(config());add(l,0);add(l,1);add(l,2);
 l.add(fact(0,{retention:'pinned'}),{knownAt:2,at:4});
 const f=recall(l,fact(0).atom).rows[0];assert.equal(f.retention,'pinned');assert.equal(l.claims[f.id].retention,'pinned');
 l.reinforce(f,{usedAt:5});for(let i=3;i<20;i++)add(l,i);
 assert.equal(recall(l,fact(0).atom).rows[0].retention,'pinned');
});
test('shards: explicit pinned quota fails instead of evicting protected facts',()=>{
 const l=new ShardedLayer(config({maxClaimsPerShard:1,maxPinnedBankBytes:20*512/2}));
 l.add(fact(0,{retention:'pinned'}));assert.throws(()=>l.add(fact(1,{retention:'pinned'})),/Pinned capacity/);
 assert.equal(recall(l,fact(0).atom).rows.length,1);
});
test('shards: archive grows without automatic forgetting',()=>{
 const l=new ShardedLayer(config({mode:'archive',maxColdShards:0,maxColdAgeMs:1}));
 for(let i=0;i<24;i++)add(l,i);l.maintain({at:1000});
 assert.equal(recall(l).rows.length,24);assert.equal(l.maintenance.evictedShards,0);
});
test('shards: archive hard limit rejects growth rather than losing data',()=>{
 const l=new ShardedLayer(config({mode:'archive',maxClaimsPerShard:1,maxArchiveShards:2}));add(l,0);add(l,1);
 assert.throws(()=>add(l,2),/Archive shard limit/);assert.equal(recall(l).rows.length,2);
});
test('shards: unused candidate retrieval is read-only',()=>{
 const l=new ShardedLayer(config());for(let i=0;i<3;i++)add(l,i);const state=stable(l.export());recall(l);assert.equal(stable(l.export()),state);
});
test('shards: proof use promotes a cold fact and lets its neighbors expire',()=>{
 const l=new ShardedLayer(config());for(let i=0;i<5;i++)add(l,i);
 const f=recall(l,fact(0).atom).rows[0];assert.ok(f);l.reinforce(f,{usedAt:6});add(l,5);
 assert.equal(recall(l,fact(0).atom).rows.length,1);assert.equal(recall(l,fact(1).atom).rows.length,0);
});
test('shards: hypotheses cannot reinforce themselves',()=>{
 const l=new ShardedLayer(config());add(l,0);const f=recall(l,fact(0).atom).rows[0];
 assert.throws(()=>l.reinforce({...f,kind:'hypothesis'}),/verified observed/);
});
test('shards: query-clipped validity is not permanently copied during promotion',()=>{
 const l=new ShardedLayer(config());l.add(fact(0,{valid:{from:10,until:200}}),{knownAt:1,at:1});add(l,1);add(l,2);
 const f=recallLayers([l],fact(0).atom,{asof:Infinity,during:{from:50,until:60}}).rows[0];
 assert.equal(f.valid.from,50);l.reinforce(f,{usedAt:4});
 assert.equal(recallLayers([l],fact(0).atom,{asof:Infinity,at:100}).rows.length,1);
});
test('shards: end/retract journals survive target-shard eviction and reobservation',()=>{
 const l=new ShardedLayer(config({maxClaimsPerShard:1,maxColdShards:1})),id=add(l,0);
 l.event({action:'retract',target:id},{knownAt:20});for(let i=1;i<6;i++)add(l,i);
 add(l,0,{knownAt:30,at:40});
 assert.equal(recall(l,fact(0).atom).rows.length,0);assert.equal(l.events.length,1);
});
test('shards: bitemporal answers still work after promotion',()=>{
 const l=new ShardedLayer(config()),id=add(l,0);add(l,1);add(l,2);
 l.event({action:'end',target:id,effective:50},{knownAt:200});
 const old=recallLayers([l],fact(0).atom,{at:100,asof:100}).rows[0];l.reinforce(old,{usedAt:300});
 assert.equal(recallLayers([l],fact(0).atom,{at:100,asof:100}).rows.length,1);
 assert.equal(recallLayers([l],fact(0).atom,{at:100,asof:300}).rows.length,0);
});
test('shards: duplication is removed by claim ID, not by ignoring provenance',()=>{
 const l=new ShardedLayer(config({mode:'archive'}));add(l,0);add(l,1);add(l,2);add(l,0);
 l.add(fact(0,{source:'independent'}),{knownAt:1});assert.equal(recall(l,fact(0).atom).rows.length,2);
});
test('shards: hash consensus must not splice different shards into a tuple',()=>{
 const l=new ShardedLayer(config({maxClaimsPerShard:1,mode:'archive'}));
 l.add({...fact(0),atom:{p:'triple',a:['a','b','c'],neg:false}});
 l.add({...fact(1),atom:{p:'triple',a:['a','d','e'],neg:false}});
 assert.equal(recall(l,{p:'triple',a:['a','b','e'],neg:false}).rows.length,0);
});
test('shards: predicate router skips only irrelevant generations',()=>{
 const l=new ShardedLayer(config({mode:'archive',maxClaimsPerShard:1}));
 for(let i=0;i<20;i++)l.add({...fact(i),atom:{p:'p'+i,a:['a','b'],neg:false}});
 const r=recall(l,{p:'p4',a:['?x','?y'],neg:false});assert.equal(r.shardsVisited,1);assert.equal(r.rows.length,1);assert.equal(r.complete,true);
});
test('shards: global probe budget is never exceeded',()=>{
 const l=new ShardedLayer(config({mode:'archive',maxClaimsPerShard:1}));for(let i=0;i<10;i++)add(l,i);
 for(const maxProbes of [0,1,3,9]){const r=recall(l,all,{maxProbes});assert.ok(r.probes<=maxProbes);assert.equal(r.complete,false);}
});
test('shards: fan-out budget reports incomplete instead of a false unique answer',()=>{
 const l=new ShardedLayer(config({mode:'archive',maxClaimsPerShard:1}));for(let i=0;i<3;i++)add(l,i);
 const r=recall(l,all,{maxShards:1});assert.equal(r.rows.length,1);assert.equal(r.shardsVisited,1);assert.equal(r.complete,false);
});
test('shards: zero result limit is handled conservatively',()=>{
 const l=new ShardedLayer(config());add(l,0);const r=recall(l,all,{limit:0});assert.equal(r.rows.length,0);assert.equal(r.complete,false);
});
test('shards: export/import is independent of the original objects',()=>{
 const l=new ShardedLayer(config());for(let i=0;i<5;i++)add(l,i);
 const before=stable(l.export()),copy=createLayer({},JSON.parse(JSON.stringify(l.export())));add(copy,8);
 assert.equal(stable(l.export()),before);assert.equal(recall(l,fact(8).atom).rows.length,0);
});
test('shards: legacy import needs neither tuple journal nor exact storage',()=>{
 const old=new TemporalLayer({power:9,verification:'receipt'});old.add(fact(0),{knownAt:1});old.add(fact(1,{retention:'pinned'}),{knownAt:1});
 const l=new ShardedLayer(config()).importLayers([old],{at:100});assert.equal(recall(l).rows.length,2);assert.equal(l.sources.length,0);
});
test('shards: supplied geometry changes apply only to new generations',()=>{
 const l=new ShardedLayer(config({mode:'archive',maxClaimsPerShard:1}));add(l,0);add(l,1);
 const state=l.export();state.config.power=10;const copy=createLayer({},state);add(copy,2);
 assert.equal(copy.hot.bank.config.power,10);assert.equal(copy.cold[0].bank.config.power,9);assert.equal(recall(copy).rows.length,3);
});
test('shards: invalid capacity configuration fails early',()=>{
 const cases=[
  [config({mode:'unknown'}),/sharding\.mode must be bounded\|archive/],
  [config({maxColdShards:-1}),/Invalid maxColdShards/],
  [config({safeOccupancy:1}),/Invalid sharding\.safeOccupancy/],
  [config({maxNormalBankBytes:1}),/maxNormalBankBytes must fit at least one bank set/],
 ];
 for(const [cfg,message] of cases)assert.throws(()=>new ShardedLayer(cfg),message);
});
test('bank clone: failed batches cannot leak domains or receipts into the original',()=>{
 const w=new RecallMemory({power:9});w.add(fact(0).atom);const s=stable(w.export()),copy=RecallMemory.from(w.export());copy.add(fact(1).atom);copy.decay(1);assert.equal(stable(w.export()),s);
});

test('repository shards: persisted manifests reuse immutable shard blobs',()=>{
 const c=temp();try{for(let i=0;i<3;i++)write(c.repo,c.s,i);
  const before=loadJSON(c.s.file),ref=before.layer.cold[0].$shard,file=path.join(c.root,'shards',ref+'.json'),mtime=fs.statSync(file).mtimeMs;
  write(c.repo,c.s,3);const after=loadJSON(c.s.file);assert.equal(after.layer.cold[0].$shard,ref);assert.equal(fs.statSync(file).mtimeMs,mtime);
  assert.equal(after.layer.cold[0].bank,undefined);
 }finally{c.dispose();}
});
test('repository shards: commit checkpoints do not reconnect evicted ancestors',()=>{
 const c=temp();try{
  for(let i=0;i<12;i++){write(c.repo,c.s,i);if(i%3===2)c.repo.commit(c.s);}
  const head=c.repo.read(c.s.userHead);assert.deepEqual(head.parents,[]);assert.equal(c.repo.recall(c.s,fact(0).atom,q).rows.length,0);
  const next=c.repo.session('base','alice','next');assert.equal(c.repo.recall(next,fact(0).atom,q).rows.length,0);assert.equal(c.repo.recall(next,fact(11).atom,q).rows.length,1);
 }finally{c.dispose();}
});
test('repository shards: restart preserves banks, claims and control events',()=>{
 const c=temp();try{const id=write(c.repo,c.s,0);write(c.repo,c.s,1);c.repo.apply(c.s,[{kind:'event',action:'retract',target:id}],{knownAt:5});c.repo.commit(c.s);
  const repo=new Repository(c.root,{memory:config()}),s=repo.session('base','alice','restart');
  assert.equal(repo.recall(s,fact(0).atom,q).rows.length,0);assert.equal(repo.recall(s,fact(1).atom,q).rows.length,1);
 }finally{c.dispose();}
});
test('repository shards: user isolation and immutable fork',()=>{
 const c=temp();try{write(c.repo,c.s,0);c.repo.commit(c.s);const bob=c.repo.session('base','bob','one');
  assert.equal(c.repo.recall(bob,fact(0).atom,q).rows.length,0);const old=c.repo.meta.bases.base;c.repo.fork('base','clone');
  const base=new ShardedLayer(config({mode:'archive'}));base.add(fact(20),{knownAt:1});c.repo.publish('base',base);
  const clone=c.repo.session('clone','alice','one');assert.equal(c.repo.meta.bases.clone,old);assert.equal(c.repo.recall(clone,fact(20).atom,q).rows.length,0);
 }finally{c.dispose();}
});
test('repository shards: frozen sessions retain forgotten facts until explicitly closed',()=>{
 const c=temp();try{write(c.repo,c.s,0);c.repo.commit(c.s);const frozen=c.repo.session('base','alice','frozen');
  for(let i=1;i<16;i++)write(c.repo,c.s,i);c.repo.commit(c.s);
  assert.equal(c.repo.recall(c.s,fact(0).atom,q).rows.length,0);c.repo.gc({dryRun:false});
  const repo=new Repository(c.root,{memory:config()}),old=repo.session('base','alice','frozen');assert.equal(repo.recall(old,fact(0).atom,q).rows.length,1);
  c.repo.closeSession(frozen);const dry=c.repo.gc();assert.ok(dry.shards>0);c.repo.gc({dryRun:false});
  assert.equal(new Repository(c.root,{memory:config()}).session('base','alice','one').userHead,c.s.userHead);
 }finally{c.dispose();}
});
test('repository shards: discard restores the same committed private snapshot',()=>{
 const c=temp();try{write(c.repo,c.s,0);c.repo.commit(c.s);for(let i=1;i<12;i++)write(c.repo,c.s,i);
  assert.equal(c.repo.recall(c.s,fact(0).atom,q).rows.length,0);c.repo.discard(c.s);
  assert.equal(c.repo.recall(c.s,fact(0).atom,q).rows.length,1);assert.equal(c.repo.recall(c.s,fact(11).atom,q).rows.length,0);
 }finally{c.dispose();}
});
test('repository shards: stale sessions and advanced user heads are rejected',()=>{
 const c=temp();try{const stale=c.repo.session('base','alice','one'),other=c.repo.session('base','alice','other');write(c.repo,c.s,0);
  assert.throws(()=>c.repo.commit(stale),/Session changed/);c.repo.commit(c.s);assert.throws(()=>c.repo.commit(other),/User head advanced/);
 }finally{c.dispose();}
});
test('repository shards: failure within a write batch is atomic in memory and disk',()=>{
 const c=temp();try{write(c.repo,c.s,0);const state=stable(c.s.live.export()),file=fs.readFileSync(c.s.file,'utf8');
  assert.throws(()=>c.repo.apply(c.s,[fact(1),{kind:'event',action:'retract',target:'c_'+'0'.repeat(32)}]),/unknown/);
  assert.equal(stable(c.s.live.export()),state);assert.equal(fs.readFileSync(c.s.file,'utf8'),file);
 }finally{c.dispose();}
});
test('repository shards: GC is a dry run by default and reclaims orphan blobs',()=>{
 const c=temp();try{for(let i=0;i<5;i++)write(c.repo,c.s,i);const dry=c.repo.gc();assert.ok(dry.shards>0);assert.equal(dry.deletedFiles,0);
  const done=c.repo.gc({dryRun:false});assert.equal(done.shards,dry.shards);assert.equal(done.reclaimableBytes,dry.reclaimableBytes);
  assert.equal(c.repo.gc().reclaimableBytes,0);assert.equal(c.repo.recall(c.s,fact(4).atom,q).rows.length,1);
 }finally{c.dispose();}
});
test('repository shards: explicit snapshot pins protect an otherwise obsolete checkpoint',()=>{
 const c=temp();try{write(c.repo,c.s,0);const head=c.repo.commit(c.s);c.repo.pinSnapshot('experiment',head);
  for(let i=1;i<12;i++)write(c.repo,c.s,i);c.repo.commit(c.s);c.repo.gc({dryRun:false});assert.ok(fs.existsSync(path.join(c.root,'snapshots',head+'.json')));
  c.repo.unpinSnapshot('experiment');c.repo.gc({dryRun:false});assert.equal(fs.existsSync(path.join(c.root,'snapshots',head+'.json')),false);
 }finally{c.dispose();}
});
test('repository shards: corrupt reachable blob stops GC before deleting anything',()=>{
 const c=temp();try{for(let i=0;i<3;i++)write(c.repo,c.s,i);const manifest=loadJSON(c.s.file),id=manifest.layer.cold[0].$shard;
  const blob=path.join(c.root,'shards',id+'.json'),original=fs.readFileSync(blob,'utf8');
  const count=fs.readdirSync(path.join(c.root,'shards')).length;
  // Trailing garbage is caught while parsing the blob, before any deletion.
  fs.appendFileSync(blob,'broken');
  assert.throws(()=>c.repo.gc({dryRun:false}),{name:'SyntaxError'});assert.equal(fs.readdirSync(path.join(c.root,'shards')).length,count);
  assert.throws(()=>new Repository(c.root,{memory:config()}).session('base','alice','one'),{name:'SyntaxError'});
  // A well-formed but altered blob is caught by the content-address checksum.
  const altered=JSON.parse(original);altered.tampered=true;fs.writeFileSync(blob,JSON.stringify(altered));
  assert.throws(()=>c.repo.gc({dryRun:false}),/Shard checksum mismatch or missing shard/);assert.equal(fs.readdirSync(path.join(c.root,'shards')).length,count);
  assert.throws(()=>new Repository(c.root,{memory:config()}).session('base','alice','one'),/Shard checksum mismatch or missing shard/);
 }finally{c.dispose();}
});
test('repository shards: migration preserves legacy user history and pinned memory',()=>{
 const c=temp({power:9});try{write(c.repo,c.s,0);c.repo.commit(c.s);c.repo.apply(c.s,[fact(1,{retention:'pinned'})],{knownAt:1});c.repo.commit(c.s);
  write(c.repo,c.s,2);const repo=new Repository(c.root,{memory:config()}),s=repo.session('base','alice','one');repo.migrate(s);
  assert.equal(repo.recall(s,all,q).rows.length,3);repo.commit(s);assert.deepEqual(repo.read(s.userHead).parents,[]);
  for(let i=3;i<12;i++)write(repo,s,i);assert.equal(repo.recall(s,fact(1).atom,q).rows.length,1);
 }finally{c.dispose();}
});
test('repository shards: forged candidate objects are ignored for reinforcement',()=>{
 const c=temp();try{write(c.repo,c.s,0);const f=c.repo.recall(c.s,fact(0).atom,q).rows[0];
  assert.deepEqual(c.repo.reinforce(c.s,[{...f,atom:fact(9).atom}]),[]);assert.equal(c.repo.recall(c.s,fact(9).atom,q).rows.length,0);
 }finally{c.dispose();}
});
test('repository shards: exact and hybrid retrieve across all retained generations',()=>{
 const c=temp(config({mode:'archive'},{exact:true}));try{for(let i=0;i<8;i++)write(c.repo,c.s,i);
  const registry=new StrategyRegistry();for(const strategy of ['exact','hybrid','recall-memory']){
   const r=registry.retrieve(strategy,{repo:c.repo,session:c.s,pattern:all,query:q,limits:{maxProbes:50000,maxFacts:10000}});
   assert.equal(r.rows.length,8);assert.equal(r.complete,true);
  }
 }finally{c.dispose();}
});
test('SOP shards: an actual proof promotes only its observed facts',async()=>{
 const memory=config({maxClaimsPerShard:1,maxColdShards:2}),c=context({bootstrap:false,memory});try{
  await c.run('@a fact\n  holds likes ana lab_alpha\n  valid timeless\n@b fact\n  holds likes ana lab_beta\n  valid timeless\n@s remember\n  input $a $b');
  const r=await c.run(queryProgram('likes ana lab_alpha'));assert.equal(r.result.status,'supported');assert.equal(c.session.live.maintenance.promotions,1);
 }finally{c.dispose();}
});
test('SOP shards: truncated fan-out prevents materializing a scalar output',async()=>{
 const c=context({bootstrap:false,memory:config({mode:'archive',maxClaimsPerShard:1})});try{
  await c.run('@a fact\n  holds likes ana lab_alpha\n  valid timeless\n@b fact\n  holds likes ana lab_beta\n  valid timeless\n@s remember\n  input $a $b');
  const runtime=new Runtime({repo:c.repo,session:c.session,schema,policy:{maxShards:1,retrievalStrategy:'recall-memory'}});
  const r=await runtime.run('@q query\n  select ?org\n  where likes ana ?org\n@r solve\n  query $q\n  output ?org one');
  assert.equal(r.result.complete,false);assert.equal(r.values.org,undefined);
 }finally{c.dispose();}
});

test('repository shards: automatic GC runs after configured save cadence',()=>{
 const c=temp(config({gcEveryWrites:2}));try{write(c.repo,c.s,0);write(c.repo,c.s,1);
  assert.equal(c.repo.lastGc.status,'passed');assert.ok(c.repo.lastGc.deletedFiles>0);assert.equal(c.repo.gc().reclaimableBytes,0);
  assert.equal(c.repo.recall(c.s,fact(1).atom,q).rows.length,1);
 }finally{c.dispose();}
});
test('repository shards: checkpointing a base preserves knowledge and its forks',()=>{
 const c=temp(config({mode:'archive'}));try{
  for(let i=0;i<3;i++){const layer=new ShardedLayer(config({mode:'archive'}));layer.add(fact(i),{knownAt:1});c.repo.publish('base',layer);}
  c.repo.fork('base','before');const checkpoint=c.repo.checkpointBase('base');assert.deepEqual(c.repo.read(checkpoint.head).parents,[]);
  c.repo.closeSession(c.s);c.repo.gc({dryRun:false});
  for(const base of ['base','before']){const s=c.repo.session(base,'bob','test');assert.equal(c.repo.recall(s,all,q).rows.length,3);}
 }finally{c.dispose();}
});
test('repository shards: exact coverage survives migration from exact legacy layers',()=>{
 const c=temp({power:9,exact:true});try{write(c.repo,c.s,0);c.repo.commit(c.s);
  const repo=new Repository(c.root,{memory:config({mode:'archive'})}),s=repo.session('base','alice','new');
  const r=new StrategyRegistry().retrieve('exact',{repo,session:s,pattern:all,query:q,limits:{maxProbes:50000,maxFacts:1000}});
  assert.equal(r.rows.length,1);assert.equal(r.complete,true);
 }finally{c.dispose();}
});
test('repository shards: another process lock prevents writes and GC',()=>{
 const c=temp();try{const file=path.join(c.root,'.write.lock');fs.writeFileSync(file,'test');
  assert.throws(()=>write(c.repo,c.s,0),/lock exists/);assert.throws(()=>c.repo.gc(),/lock exists/);fs.unlinkSync(file);
  assert.equal(c.repo.recall(c.s,all,q).rows.length,0);
 }finally{c.dispose();}
});
test('SOP shards: a two-hop Horn rule joins facts across separate generations',async()=>{
 const c=context({bootstrap:false,memory:config({mode:'archive',maxClaimsPerShard:1})});try{
  await c.run('@a fact\n  holds parent ana bogdan\n  valid timeless\n@b fact\n  holds parent bogdan carina\n  valid timeless\n@s remember\n  input $a $b');
  const r=await c.run('@rr rule\n  when parent ?x ?y\n  when parent ?y ?z\n  then grandparent ?x ?z\n@d pack\n  items $rr\n@q query\n  where grandparent ana carina\n@r solve\n  query $q\n  data $d');
  assert.equal(r.result.status,'supported');assert.equal(c.session.live.maintenance.promotions,2);
 }finally{c.dispose();}
});

test('repository shards: base checkpoint preserves historical library versions for asof',()=>{
 const c=temp(config({mode:'archive'}));try{
  for(const knownAt of [10,20]){const sop='@r rule\n  when parent ?x ?y\n  then parent ?x ?y\n# version '+knownAt;
   c.repo.publish('base',new ShardedLayer(config({mode:'archive'})),[{id:'r',sop,hash:digest(sop),wireType:'rule',knownAt}]);}
  c.repo.checkpointBase('base');const s=c.repo.session('base','bob','new');
  assert.equal(c.repo.library(s,{asof:15})[0].knownAt,10);assert.equal(c.repo.library(s,{asof:25})[0].knownAt,20);
 }finally{c.dispose();}
});
test('repository shards: temporal negation survives routing and never becomes absence-as-false',async()=>{
 const c=context({bootstrap:false,memory:config({mode:'archive',maxClaimsPerShard:1})});try{
  await c.run('@a fact\n  holds parent ana bogdan\n  valid timeless\n@b fact\n  holds not parent ana bogdan\n  valid timeless\n@s remember\n  input $a $b');
  assert.equal((await c.run(queryProgram('parent ana bogdan'))).result.status,'both');
  assert.equal((await c.run(queryProgram('likes ana lab_beta'))).result.status,'unknown');
 }finally{c.dispose();}
});
