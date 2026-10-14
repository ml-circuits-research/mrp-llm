import {demoLexicon} from '../lib/knowledge-seeds.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Repository} from '../memory/repository.mjs';import {Runtime} from '../sop/runtime.mjs';import {Lexicon} from '../sop/lexicon.mjs';import {publishKnowledge} from '../sop/ingest.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'chatsop-demo-'));const ontology=demoLexicon(),repo=new Repository(root),now=Date.parse('2026-09-26T12:00:00Z');
try{publishKnowledge(repo,'demo',fs.readFileSync(new URL('../tests/fixtures/bootstrap.sop',import.meta.url),'utf8'),{schema:ontology.predicates,reviewed:true,knownAt:Date.parse('2024-01-01')});
 for(const name of ['query','mixed','expand','strings','remember','temporal','hypothesis']){const session=repo.session('demo','alice',name),runtime=new Runtime({repo,session,schema:ontology.predicates,now});const result=await runtime.run(fs.readFileSync(new URL('./'+name+'.sop',import.meta.url),'utf8'));console.log('\n=== '+name+' ===');console.log(result.result.text??JSON.stringify(result.result));console.log('wires='+result.wireCount+' epochs='+result.epochs);}
 console.log('\nNo neural model was used in this deterministic kernel demonstration.');
}finally{fs.rmSync(root,{recursive:true,force:true});}
