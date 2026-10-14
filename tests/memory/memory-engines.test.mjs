import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createBank} from '../../memory/banks/factory.mjs';
import {HoloKernel} from '../../memory/banks/holo-kernel.mjs';
import {SQLiteBank} from '../../memory/banks/sqlite.mjs';
import {Repository} from '../../memory/repository.mjs';
import {Runtime} from '../../sop/runtime.mjs';
import {publishKnowledge} from '../../sop/ingest.mjs';
import {demoLexicon} from '../../lib/knowledge-seeds.mjs';
import {atomKey} from '../../lib/types.mjs';

const engines=['recall-memory','holo-memory','sqlite','scan'];
const config=engine=>({engine,power:10,holoMemory:{rows:256,dimension:64,banks:4},verification:'receipt'});
const a=(p,...args)=>({p,a:args,neg:false});
const keys=rows=>rows.map(r=>atomKey(r.atom)).sort();
for(const engine of engines){
 test(engine+': exact typed completion and multiple answers',()=>{
  const b=createBank(config(engine));try{for(const x of [a('rel','ana','cern'),a('rel','ana','eth'),a('rel','bob','cern'),a('rel','num',1),a('rel','num','1')])b.add(x);
   assert.deepEqual(keys(b.recall(a('rel','ana','?x')).rows),[atomKey(a('rel','ana','cern')),atomKey(a('rel','ana','eth'))].sort());
   assert.equal(b.recall(a('rel','num',1)).rows.length,1);assert.equal(b.recall(a('rel','num','1')).rows.length,1);
  }finally{b.close?.();}
 });
 test(engine+': absent fact and explicit negation',()=>{
  const b=createBank(config(engine));try{b.add(a('rel','ana','cern'));b.add({...a('rel','ana','eth'),neg:true});
   assert.equal(b.recall(a('rel','nobody','?x')).rows.length,0);assert.equal(b.recall(a('rel','ana','eth')).rows.length,0);
   assert.equal(b.recall({...a('rel','ana','eth'),neg:true}).rows.length,1);
  }finally{b.close?.();}
 });
 test(engine+': repeated logical variable is an equality constraint',()=>{
  const b=createBank(config(engine));try{b.add(a('rel','x','x'));b.add(a('rel','x','y'));b.add(a('rel','y','y'));
   assert.deepEqual(keys(b.recall(a('rel','?x','?x')).rows),[atomKey(a('rel','x','x')),atomKey(a('rel','y','y'))].sort());
  }finally{b.close?.();}
 });
 test(engine+': four arguments, Unicode and bounded absence',()=>{
  const b=createBank(config(engine));try{b.add(a('rel','Ștefan','Zürich',17,'astăzi'));assert.equal(b.recall(a('rel','Ștefan','?city',17,'astăzi')).rows[0].atom.a[1],'Zürich');
   assert.equal(b.recall(a('rel','?a','?b','?c','?d'),{maxProbes:0}).complete,false);
   assert.equal(b.recall(a('rel','?a','?b','?c','?d'),{limit:0}).rows.length,0);
  }finally{b.close?.();}
 });
 test(engine+': budget truncation never claims exhaustive answers',()=>{
  const b=createBank(config(engine));try{for(let i=0;i<10;i++)b.add(a('rel','ana','v'+i));
   const r=b.recall(a('rel','ana','?v'),{maxProbes:10000,limit:2});assert.equal(r.complete,false);assert.equal(r.rows.length,2);
  }finally{b.close?.();}
 });
 test(engine+': snapshot, fork isolation and reinforcement survival',()=>{
  const b=createBank(config(engine));b.add(a('rel','hot','value'));b.add(a('rel','cold','value'));const state=b.export(),child=createBank({},state);
  try{for(let i=0;i<3;i++)child.reinforce(a('rel','hot','value'));child.decay(2);
   assert.equal(child.recall(a('rel','hot','?v')).rows.length,1);assert.equal(child.recall(a('rel','cold','?v')).rows.length,0);
   assert.equal(b.recall(a('rel','cold','?v')).rows.length,1);
  }finally{b.close?.();child.close?.();}
 });
 test(engine+': blocked and expired tuples are not returned',()=>{
  const b=createBank(config(engine));try{const id=b.add(a('rel','ana','x'));b.add(a('rel','ana','y'),{expiresAt:10});
   assert.equal(b.recall(a('rel','ana','?v'),{blocked:new Set([id]),now:11}).rows.length,0);
  }finally{b.close?.();}
 });
}

const fixture=`@g rule
  when parent ?x ?y
  when parent ?y ?z
  then grandparent ?x ?z
@a fact
  holds parent ana bogdan
  valid timeless
@b fact
  holds parent bogdan carina
  valid timeless`;
const schema=demoLexicon().predicates;
const instant=Date.parse('2026-09-26T12:00:00Z');
const fact=(s,o)=>({kind:'fact',atom:a('likes',s,o),valid:{from:-Infinity,until:Infinity},source:'test'});
const strategy={'recall-memory':'recall-memory','holo-memory':'holo-memory',sqlite:'sqlite',scan:'scan'};
for(const engine of engines)for(const sharded of [false,true]){
 test(engine+(sharded?' sharded':' layered')+': same SOP, proof, time, fork and restart',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sop-engines-'));
  const memory={...config(engine),retention:{reinforceOnUse:true},...(sharded?{sharding:{enabled:true,mode:'archive',maxClaimsPerShard:2,maxColdShards:3,gcEveryWrites:0}}:{})};
  try{
   const repo=new Repository(root,{memory});publishKnowledge(repo,'base',fixture,{schema,reviewed:true,knownAt:1});
   const s=repo.session('base','alice','s1');
   const runtime=new Runtime({repo,session:s,schema,now:instant,policy:{retrievalStrategy:strategy[engine]}});
   const r=await runtime.run('@q query\n  select ?who\n  where grandparent ?who carina\n@r solve\n  query $q\n  output ?who one\n@c cnl\n  result $r\n  language ro');
   assert.equal(r.values.who,'ana');assert.equal(r.values.r.status,'supported');
   const ids=repo.apply(s,[fact('ana','cern')],{knownAt:10}),frozen=repo.session('base','alice','before_commit');
   assert.equal(repo.recall(frozen,a('likes','ana','cern'),{asof:Infinity}).rows.length,0);
   repo.commit(s);
   const s2=repo.session('base','alice','new'),bob=repo.session('base','bob','new');
   assert.equal(repo.recall(s2,a('likes','ana','cern'),{asof:Infinity}).rows.length,1);
   assert.equal(repo.recall(bob,a('likes','ana','cern'),{asof:Infinity}).rows.length,0);
   repo.apply(s2,[{kind:'event',action:'end',target:ids[0],effective:20}],{knownAt:30});
   assert.equal(repo.recall(s2,a('likes','ana','cern'),{asof:29,at:25}).rows.length,1);
   assert.equal(repo.recall(s2,a('likes','ana','cern'),{asof:31,at:25}).rows.length,0);
   assert.equal(repo.recall(s2,a('likes','ana','cern'),{asof:31,at:15}).rows.length,1);
   repo.commit(s2);const restart=new Repository(root,{memory}),s3=restart.session('base','alice','reload');
   assert.equal(restart.recall(s3,a('likes','ana','cern'),{asof:31,at:25}).rows.length,0);
   repo.fork('base','other');const f=repo.session('other','alice','f');
   assert.equal(repo.recall(f,a('parent','ana','bogdan'),{asof:Infinity}).rows.length,1);
   assert.equal(repo.recall(f,a('likes','ana','cern'),{asof:Infinity}).rows.length,0);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 });
}
for(const engine of engines)test(engine+': bounded shards evict unused data but keep pinned',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sop-evict-'));
 try{const memory={...config(engine),sharding:{enabled:true,mode:'bounded',maxClaimsPerShard:2,maxColdShards:1,gcEveryWrites:0}};
  const repo=new Repository(root,{memory});repo.init('base');const s=repo.session('base','u','s');repo.apply(s,[{...fact('pinned','x'),retention:'pinned'}],{knownAt:1});
  for(let i=0;i<12;i++)repo.apply(s,[fact('p'+i,'v'+i)],{knownAt:i+2});
  assert.ok(s.live.stats().normalShards<=2);assert.equal(repo.recall(s,a('likes','p0','v0'),{asof:Infinity}).rows.length,0);
  assert.equal(repo.recall(s,a('likes','pinned','x'),{asof:Infinity}).rows.length,1);
  repo.commit(s);repo.gc({dryRun:false});assert.equal(repo.recall(s,a('likes','pinned','x'),{asof:Infinity}).rows.length,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('SQLite: file reopen, indexed plan, FTS terms and hostile syntax',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sop-sqlite-')),file=path.join(dir,'facts.sqlite');let b;
 try{b=new SQLiteBank({},null,{path:file});b.add(a('works_at','Ștefan','cern'));b.add(a('works_at','alt','eth'));b.close();
  b=new SQLiteBank({},null,{path:file});assert.equal(b.recall(a('works_at','Ștefan','?org')).rows.length,1);
  assert.ok(b.explain(a('works_at','Ștefan','?org')).some(r=>r.detail.includes('INDEX')));
  assert.equal(b.search('Stefan CERN').rows.length,1);assert.equal(b.recall(a('works_at',"' OR 1=1 --",'?x')).rows.length,0);
  assert.doesNotThrow(()=>b.search('" OR 1=1 --'));assert.equal(b.count(),2);
 }finally{b?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('SQLite: transaction rollback does not publish partial facts',()=>{
 const b=new SQLiteBank();try{assert.throws(()=>b.transaction(()=>{b.add(a('rel','a','b'));throw Error('abort');}),{message:'abort'});assert.equal(b.count(),0);}finally{b.close();}
});
test('HoloMemory: one-shot, deterministic restore and no external key list',()=>{
 const k=new HoloKernel({rows:128,dimension:64,banks:4});const values=Array.from({length:32},(_,i)=>i);
 for(let i=0;i<100;i++)k.remember('key'+i,i%32,{novelty:'new'});
 assert.equal(k.read('key7',values).value,7);const next=HoloKernel.from(k.export());assert.deepEqual(next.read('key7',values),k.read('key7',values));
 assert.equal(next.counters.byteLength,32768);assert.deepEqual(Object.keys(k.export()).sort(),['config','counters','format','metrics','rng']);
});
test('HoloMemory: repetition does not trigger global ageing',()=>{
 const k=new HoloKernel({rows:64,dimension:64,banks:4,ageStepsPerNovel:256}),values=Array.from({length:32},(_,i)=>i);
 k.remember('same',7,{novelty:'auto',candidates:values});const count=k.metrics.ageVisits;
 for(let i=0;i<8;i++)assert.equal(k.remember('same',7,{novelty:'auto',candidates:values}).novel,false);
 assert.equal(k.metrics.ageVisits,count);k.remember('other',9,{novelty:'new'});assert.equal(k.metrics.ageVisits,count+256);
});
test('HoloMemory: empty memory abstains, random damage and complete erasure',()=>{
 const k=new HoloKernel({rows:64,banks:6,dimension:64}),values=Array.from({length:16},(_,i)=>i);assert.equal(k.read('x',values).status,'not_remembered');
 k.write('x',7,{strength:3});const child=k.fork();child.eraseFraction(.3,77);assert.equal(child.read('x',values).value,7);
 child.eraseFraction(1);assert.equal(child.read('x',values).status,'not_remembered');assert.equal(k.read('x',values).value,7);
});
test('HoloMemory: same key, changed value has competing traces, not a silent retraction',()=>{
 const k=new HoloKernel({rows:32,dimension:64,banks:4});k.write('x',1);k.write('x',2);const r=k.read('x',[1,2]);assert.equal(r.status,'uncertain');
});
test('HoloMemory: counter bounds survive repeated writes and cooling',()=>{
 const k=new HoloKernel({rows:8,banks:2,dimension:16,maxCounter:7});for(let i=0;i<50;i++)k.write('x',1);assert.ok(k.counters.every(v=>v>=-7&&v<=7));k.decay(7);assert.ok(k.counters.every(v=>v===0));
});
test('HoloMemory: fact adapter integrity gate refuses erased body even with receipt',()=>{
 const b=createBank(config('holo-memory'));b.add(a('rel','ana','cern'));assert.equal(b.recall(a('rel','ana','?x')).rows.length,1);b.kernel.eraseFraction(1);
 assert.ok(Object.keys(b.receipts).length);assert.equal(b.recall(a('rel','ana','?x')).rows.length,0);
});
test('HoloMemory: pinned memory does not age when new pinned facts arrive',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'holo-pin-'));
 try{const repo=new Repository(root,{memory:{...config('holo-memory'),holoMemory:{rows:128,dimension:64,ageStepsPerNovel:1000}}});repo.init('base');const s=repo.session('base','u','s');
  repo.apply(s,[{...fact('one','v'),retention:'pinned'},{...fact('two','v'),retention:'pinned'}],{knownAt:1});assert.equal(s.live.pinned.kernel.metrics.ageVisits,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('single-file SQLite: temporal claims, rule ingestion, fork and reopen',async()=>{
 const {SimpleSQLiteMemory}=await import('../../memory/sqlite-simple.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'single-sql-'));let db,child;
 try{
  db=new SimpleSQLiteMemory(path.join(dir,'facts.sqlite'));db.ingest(fixture,{reviewed:true,knownAt:1});
  assert.equal(db.rules().length,1);assert.equal(db.recall(a('parent','ana','?child'),{asof:2}).rows[0].atom.a[1],'bogdan');
  const id=db.add(fact('ana','cern'),{knownAt:10});child=db.fork(path.join(dir,'fork.sqlite'));
  db.event({action:'end',target:id,effective:20},{knownAt:30});
  assert.equal(db.recall(a('likes','ana','cern'),{asof:29,at:25}).rows.length,1);
  assert.equal(db.recall(a('likes','ana','cern'),{asof:31,at:25}).rows.length,0);
  assert.equal(child.recall(a('likes','ana','cern'),{asof:31,at:25}).rows.length,1);
  db.close();db=new SimpleSQLiteMemory(path.join(dir,'facts.sqlite'));assert.equal(db.recall(a('likes','ana','cern'),{asof:31,at:25}).rows.length,0);
  assert.equal(db.recall(a('likes','ana','cern'),{asof:31,at:15}).rows.length,1);
  db.event({action:'retract',target:id},{knownAt:40});assert.equal(db.recall(a('likes','ana','cern'),{asof:41,at:15}).rows.length,0);
 }finally{db?.close();child?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('HoloMemory content plane: complete SOP bytes from handle without an item table',async()=>{
 const {HoloWireMemory}=await import('../../tools/holo-wire.mjs');
 const m=new HoloWireMemory({kernel:{rows:1024,banks:4,dimension:64}}),wire='@f fact\n  holds parent ana bogdan\n  valid timeless';
 const h=m.remember(wire),r=m.recall(h.handle);assert.equal(r.status,'remembered');assert.ok(r.sop.includes('parent ana bogdan'));
 const fork=m.fork();fork.kernel.eraseFraction(1);assert.notEqual(fork.recall(h.handle).status,'remembered');assert.equal(m.recall(h.handle).status,'remembered');
 assert.deepEqual(Object.keys(m.export()).sort(),['config','format','kernel']);assert.throws(()=>m.recall('invalid'),/Expected a SHA-256 wire handle/);
});

test('HoloMemory: archive mode disables novelty ageing, even if a positive rate was requested',async()=>{
 const {createLayer}=await import('../../memory/factory.mjs');
 for(const sharded of [false,true]){
  const m=createLayer({engine:'holo-memory',holoMemory:{rows:128,ageStepsPerNovel:1000},retention:{mode:'none'},...(sharded?{sharding:{enabled:true,mode:'archive',maxClaimsPerShard:20}}:{})});
  for(let i=0;i<5;i++)m.add(fact('p'+i,'v'+i),{knownAt:1});
  const b=sharded?m.hot.bank:m.normal;assert.equal(b.kernel.metrics.ageVisits,0);
 }
});

test('legacy engine names, hint-bank names and snapshot formats still load under the canonical names',async()=>{
 const {bankEngine,canonicalEngine,MEMORY_ENGINES}=await import('../../memory/banks/factory.mjs');
 assert.deepEqual(MEMORY_ENGINES,['recall-memory','holo-memory','sqlite','scan','hybrid']);
 assert.equal(canonicalEngine('weaver'),'recall-memory');assert.equal(canonicalEngine('holo'),'holo-memory');
 const recall=createBank({engine:'weaver',power:9});recall.add(a('rel','ana','cern'));
 assert.equal(bankEngine(recall.export()),'recall-memory');assert.equal(createBank({},recall.export()).recall(a('rel','ana','?x')).rows.length,1);
 const holo=createBank({engine:'holo',holo:{rows:128,dimension:64,banks:4}});holo.add(a('rel','ana','cern'));
 const state=holo.export();assert.equal(state.format,'holo-fact-bank-v1');assert.equal(holo.stats().engine,'holo-memory');
 const legacy={...state,format:'h7-fact-bank-v1',kernel:{...state.kernel,format:'h7-kernel-v1'}};
 assert.equal(bankEngine(legacy),'holo-memory');assert.equal(createBank({},legacy).recall(a('rel','ana','?x')).rows.length,1);
 const hybrid=createBank({engine:'hybrid',power:9,hybrid:{associative:'weaver'}});hybrid.add(a('rel','ana','cern'));
 assert.equal(hybrid.hints(a('rel','ana','?x')).rows.length,1);hybrid.close();
 const {StrategyRegistry}=await import('../../memory/strategies.mjs');const registry=new StrategyRegistry();
 assert.equal(registry.strategies.get('recall-weaver'),registry.strategies.get('recall-memory'));
});
