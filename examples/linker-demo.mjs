#!/usr/bin/env node
/** Fully offline demonstration. No LLM outputs are fabricated. */
import {demoLexicon} from '../lib/knowledge-seeds.mjs';
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Repository} from '../memory/repository.mjs';import {Runtime} from '../sop/runtime.mjs';
import {publishKnowledge} from '../sop/ingest.mjs';import {Lexicon} from '../sop/lexicon.mjs';
import {compileProlog,compileSMT} from '../reasoning/bridge/export.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'chatsop-link-'));
const reportDir=new URL('../eval/reports/current/linker/',import.meta.url);fs.mkdirSync(reportDir,{recursive:true});
const lex=demoLexicon();
const repo=new Repository(root,{memory:{power:10,exact:true}}),fixture=fs.readFileSync(new URL('../tests/fixtures/bootstrap.sop',import.meta.url),'utf8');
publishKnowledge(repo,'demo',fixture,{schema:lex.predicates,reviewed:true,knownAt:Date.parse('2024-01-01')});
const runs=[];
try {
 for(const name of ['auto-link','auto-mixed','auto-cascade','auto-ambiguous','auto-rows','auto-template'])for(const strategy of ['recall-memory','exact','hybrid']){
  const session=repo.session('demo','alice',name+'_'+strategy),source=fs.readFileSync(new URL('./'+name+'.sop',import.meta.url),'utf8');
  const r=await new Runtime({repo,session,schema:lex.predicates,now:Date.parse('2026-09-26'),policy:{retrievalStrategy:strategy}}).run(source);
  if(name==='auto-link')assert.equal(r.values.bunica,'ana');
  if(name==='auto-mixed'){assert.equal(r.values.duration,70);assert.equal(r.values.arrival,840);}
  if(name==='auto-cascade'){assert.equal(r.values.bunica,'ana');assert.deepEqual(r.values.copii,['bogdan']);}
  if(name==='auto-ambiguous'){assert.equal(r.outputs.stramos.status,'ambiguous');assert.ok(r.blocked.would_guess);assert.ok(!Object.hasOwn(r.values,'stramos'));}
  if(name==='auto-rows')assert.deepEqual(r.values.families.map(x=>[x['?parent'],x['?child']]).sort(),[['ana','bogdan'],['bogdan','carina']]);
  if(name==='auto-template'){assert.equal(r.values.answer__duration,70);assert.equal(r.values.answer__arrival,840);}
  const record={example:name,strategy,neuralModelTested:false,...r};
  fs.writeFileSync(new URL(name+'-'+strategy+'.json',reportDir),JSON.stringify(record,(_k,v)=>v===Infinity?'open':v===-Infinity?'beginning':v,2)+'\n');
  if(strategy==='hybrid'){
   fs.writeFileSync(new URL(name+'-expansions.sop',reportDir),r.generated.map(g=>'# Epoch '+g.epoch+'; this is a trace fragment, not a standalone program.\n'+g.source).join('\n'));
   const linked=Object.values(r.values).find(v=>v?.kind==='retrieval');
   if(linked)fs.writeFileSync(new URL(name+'.pl',reportDir),compileProlog(linked.facts.map(f=>f.atom),linked.rules));
   const numeric=Object.values(r.values).find(v=>v?.kind==='constraint'&&v.vars);
   if(numeric){const smt=compileSMT(numeric);fs.writeFileSync(new URL(name+'.smt2',reportDir),smt.prefix+'\n; Base facts and rules\n(check-sat)\n(get-model)\n; Is the claim possible?\n(push)\n(assert '+smt.claim+')\n(check-sat)\n(pop)\n; Is its negation possible?\n(push)\n(assert (not '+smt.claim+'))\n(check-sat)\n(pop)\n');}
  }
  const summary={example:name,strategy,status:r.result?.packet?.status,epochs:r.epochs,
    outputs:Object.fromEntries(Object.entries(r.outputs).map(([k,v])=>[k,{status:v.status,...(v.status==='bound'?{value:v.value}:{})}])),blocked:Object.keys(r.blocked)};
  runs.push(summary);console.log(JSON.stringify(summary));
 }
 fs.writeFileSync(new URL('summary.json',reportDir),JSON.stringify({runs,neuralModelTested:false},null,2)+'\n');
}finally{fs.rmSync(root,{recursive:true,force:true});}
