#!/usr/bin/env node
/** Identical existing SOP circuits over four independently populated backends. */
import {demoLexicon} from '../lib/knowledge-seeds.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {Repository} from '../memory/repository.mjs';import {Runtime} from '../sop/runtime.mjs';
import {Lexicon} from '../sop/lexicon.mjs';import {publishKnowledge} from '../sop/ingest.mjs';import {saveJSON} from '../lib/util.mjs';
const schema=demoLexicon().predicates,fixture=fs.readFileSync(new URL('../tests/fixtures/bootstrap.sop',import.meta.url),'utf8'),runs=[];
const names=['auto-link','auto-mixed','auto-cascade','auto-ambiguous','auto-rows','auto-template'];
const strategies={'recall-memory':'recall-memory','holo-memory':'holo-memory',sqlite:'sqlite',scan:'scan'};
for(const [engine,strategy] of Object.entries(strategies))for(const sharded of [false,true]){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'memory-demo-'));
 try{
  const repo=new Repository(root,{memory:{engine,power:10,verification:'receipt',holoMemory:{rows:512,banks:4,dimension:64},...(sharded?{sharding:{enabled:true,mode:'archive',maxClaimsPerShard:2,gcEveryWrites:0}}:{})}});
  publishKnowledge(repo,'demo',fixture,{schema,reviewed:true,knownAt:Date.parse('2024-01-01')});
  for(const name of names){
   const s=repo.session('demo','u',name),r=await new Runtime({repo,session:s,schema,now:Date.parse('2026-09-26'),policy:{retrievalStrategy:strategy}}).run(fs.readFileSync(new URL(name+'.sop',import.meta.url),'utf8'));
   if(name==='auto-link')assert.equal(r.values.bunica,'ana');
   if(name==='auto-mixed'){assert.equal(r.values.duration,70);assert.equal(r.values.arrival,840);}
   if(name==='auto-cascade'){assert.equal(r.values.bunica,'ana');assert.deepEqual(r.values.copii,['bogdan']);}
   if(name==='auto-ambiguous'){assert.equal(r.outputs.stramos.status,'ambiguous');assert.ok(r.blocked.would_guess);}
   if(name==='auto-rows')assert.deepEqual(r.values.families.map(x=>[x['?parent'],x['?child']]).sort(),[['ana','bogdan'],['bogdan','carina']]);
   if(name==='auto-template'){assert.equal(r.values.answer__duration,70);assert.equal(r.values.answer__arrival,840);}
   runs.push({engine,strategy,sharded,example:name,passed:true,outputs:r.outputs});
  }
  console.log(engine+' '+(sharded?'shards':'layers')+': 6/6');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
saveJSON(new URL('../eval/reports/current/memory/sop-conformance.json',import.meta.url),{runs,passed:runs.length,neuralModelTested:false});
