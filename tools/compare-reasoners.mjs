#!/usr/bin/env node
/** Explicit backend×memory matrix: never relabel JS fallback as an external solver. */
import {demoLexicon} from '../lib/knowledge-seeds.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Repository} from '../memory/repository.mjs';
import {publishKnowledge} from '../sop/ingest.mjs';
import {Runtime} from '../sop/runtime.mjs';
import {Lexicon} from '../sop/lexicon.mjs';
import {solverAvailable} from '../reasoning/registry.mjs';
import {cliArgs,digest,saveJSON} from '../lib/util.mjs';
const args=cliArgs(),out=path.resolve(args.out??new URL('../eval/reports/current/comparisons/reasoners.json',import.meta.url).pathname);
const engines=['recall-memory','holo-memory','sqlite','scan','hybrid'],backends=['js','prolog','z3'];
const setup='@f1 fact\n  holds parent ana bogdan\n  valid timeless\n@f2 fact\n  holds parent bogdan carina\n  valid timeless\n@rule rule\n  when parent ?x ?y\n  when parent ?y ?z\n  then grandparent ?x ?z';
const schema=demoLexicon().predicates,available={js:true,prolog:solverAvailable('prolog'),z3:solverAvailable('z3')};
const cells=[];
const query=backend=>'@q query\n  where grandparent ana carina\n  at 2026-09-26\n@r solve\n  query $q\n'+(backend==='js'?'  reasoning reference\n':'')+'  backend '+backend;
for(const engine of engines){const root=fs.mkdtempSync(path.join(os.tmpdir(),'comparison-reason-'));try{
 const memory={engine,power:10,verification:'receipt',holoMemory:{rows:256,banks:4,dimension:64,ageStepsPerNovel:0}},repo=new Repository(root,{memory});
 publishKnowledge(repo,'base',setup,{schema,reviewed:true,knownAt:1});const session=repo.session('base','alice','comparison');
 for(const backend of backends){
  if(backend==='z3'){cells.push({engine,backend,status:'unsupported',reason:'Z3 finite arithmetic does not implement the Horn query; a memory-free numeric problem is not a memory comparison'});continue;}
  if(!available[backend]){cells.push({engine,backend,status:'skipped',reason:'native '+backend+' binary unavailable; no JS fallback is counted'});continue;}
  const start=performance.now(),result=await new Runtime({repo,session,schema,now:Date.parse('2026-09-26T12:00:00Z')}).run(query(backend));
  const elapsedMs=performance.now()-start,answer=result.values.r;
  if(answer.backend!==backend)throw Error('Backend mismatch: '+backend+' returned '+answer.backend);
  cells.push({engine,backend,status:'observed',queryStatus:answer.status,complete:answer.complete,reportedBackend:answer.backend,answerCount:answer.answers?.length??null,memoryProbes:answer.diagnostics?.memoryProbes??null,elapsedMs});
 }
}finally{fs.rmSync(root,{recursive:true,force:true});}}
const selectedSolvers={prolog:process.env.SWIPL_BIN??'swipl',z3:process.env.Z3_BIN??'z3'};
const envPrefix=[process.env.SWIPL_BIN&&'SWIPL_BIN='+process.env.SWIPL_BIN,process.env.Z3_BIN&&'Z3_BIN='+process.env.Z3_BIN].filter(Boolean).join(' ');
saveJSON(out,{experiment:'reasoning-memory-v1',command:(envPrefix?envPrefix+' ':'')+'node tools/compare-reasoners.mjs'+(process.argv.length>2?' '+process.argv.slice(2).join(' '):''),node:process.version,setupHash:digest(setup),queryHash:digest(query('js').replace('  reasoning reference\n','').replace('js','backend-placeholder')),selectedSolvers,available,scope:'Same reviewed SOP and query on each engine; JS Horn vs native SWI Horn; no fallback counted as second backend; Z3 Horn unsupported',cells});
console.log(JSON.stringify({available,observed:cells.filter(c=>c.status==='observed').length,skipped:cells.filter(c=>c.status==='skipped').length,unsupported:cells.filter(c=>c.status==='unsupported').length,cells:cells.map(c=>`${c.engine}/${c.backend}:${c.status}${c.queryStatus?'='+c.queryStatus:''}`)},null,2));
