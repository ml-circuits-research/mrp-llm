#!/usr/bin/env node
/** End-to-end SOP proof, cold promotion, protected history and physical GC.
 * Synthetic fixtures; no LLM, external solver, or dependency is required. */
import {demoLexicon} from '../lib/knowledge-seeds.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import assert from 'node:assert/strict';
import {Repository} from '../memory/repository.mjs';import {Runtime} from '../sop/runtime.mjs';
import {publishKnowledge} from '../sop/ingest.mjs';import {Lexicon} from '../sop/lexicon.mjs';
import {saveJSON,cliArgs} from '../lib/util.mjs';
const args=cliArgs(),root=fs.mkdtempSync(path.join(os.tmpdir(),'sop-shards-demo-'));
const config={power:9,arity:3,verification:'receipt',retention:{writeStrength:2,useStrength:1,reinforceOnUse:true},
 sharding:{enabled:true,mode:'bounded',maxClaimsPerShard:2,maxColdShards:2,safeOccupancy:.9,gcEveryWrites:0}};
const schema=demoLexicon().predicates;
const fixture='@kinship rule\n  when parent ?x ?y\n  when parent ?y ?z\n  then grandparent ?x ?z';
const query='@q query\n  where grandparent ana carina\n@r solve\n  query $q\n@answer cnl\n  result $r\n  language en';
const fact=(i)=>({kind:'fact',atom:{p:'likes',a:['person_'+i,'org_'+i],neg:false},valid:{from:-Infinity,until:Infinity},source:'demo'});
const at=Date.parse('2026-09-26T12:00:00Z'),q={at,asof:at};
try{
 const repo=new Repository(root,{memory:config});publishKnowledge(repo,'demo',fixture,{schema,reviewed:true,knownAt:1});
 const s=repo.session('demo','alice','current'),run=source=>new Runtime({repo,session:s,schema,now:at,policy:{retrievalStrategy:'recall-memory'}}).run(source);
 await run('@a fact\n  holds parent ana bogdan\n  valid timeless\n@b fact\n  holds parent bogdan carina\n  valid timeless\n@p fact\n  holds likes ana lab_alpha\n  valid timeless\n  retention pinned\n@s remember\n  input $a $b $p');
 for(let i=0;i<3;i++)repo.apply(s,[fact(i)],{knownAt:1});
 repo.commit(s);const frozen=repo.session('demo','alice','frozen');
 const before=s.live.stats(),answer=await run(query);
 assert.equal(answer.values.r.status,'supported');assert.equal(s.live.maintenance.promotions,2);
 repo.apply(s,[fact(3),fact(4)],{knownAt:1});
 assert.equal(repo.recall(s,fact(0).atom,q).rows.length,0);
 const second=await run(query);assert.equal(second.values.r.status,'supported');repo.commit(s);
 const coldStillInFrozen=repo.recall(frozen,fact(0).atom,q).rows.length===1;
 assert.ok(coldStillInFrozen);assert.equal(repo.recall(s,{p:'likes',a:['ana','lab_alpha'],neg:false},q).rows.length,1);
 const whileFrozen=repo.gc({dryRun:false});
 repo.closeSession(frozen);const eligible=repo.gc(),afterGc=repo.gc({dryRun:false});assert.ok(eligible.shards>0);
 const restarted=new Repository(root,{memory:config}),resumed=restarted.session('demo','alice','current'),bob=restarted.session('demo','bob','first');
 const final=await new Runtime({repo:restarted,session:resumed,schema,now:at}).run(query);
 assert.equal(final.values.r.status,'supported');assert.equal(restarted.recall(bob,{p:'parent',a:['ana','bogdan'],neg:false},q).rows.length,0);
 const stats=s.live.stats(),report={experiment:'local-shards-sop-v1',node:process.version,config,
  before:{normalShards:before.normalShards,claims:before.claims},
  checks:{twoHopProof:true,promotedProofFacts:true,unusedFactForgotten:true,pinnedSurvives:true,frozenSessionRetainsHistory:coldStillInFrozen,restart:true,userIsolation:true},
  answer:final.result.text,normalShards:stats.normalShards,normalBankBytes:stats.normalBankBytes,pinnedBankBytes:stats.pinnedBankBytes,
  promotions:stats.maintenance.promotions,evictedShards:stats.maintenance.evictedShards,
  garbageCollection:{whileFrozen,afterClose:afterGc},shardStats:stats};
 const out=args.out??new URL('../eval/reports/current/shards/demo.json',import.meta.url);saveJSON(out,report);
 console.log(JSON.stringify(report,null,2));
}finally{if(!args.keep)fs.rmSync(root,{recursive:true,force:true});else console.log('Repository retained at '+root);}
