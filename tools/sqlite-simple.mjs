#!/usr/bin/env node
/** Single-file, exact SOP knowledge base. Runtime/source formats are unchanged. */
import fs from 'node:fs';
import {SimpleSQLiteMemory} from '../memory/sqlite-simple.mjs';
import {cliArgs} from '../lib/util.mjs';
import {parse} from '../sop/parser.mjs';
import {lowerQuery} from '../sop/lower.mjs';
import {planGoals} from '../reasoning/linker.mjs';
import {reason} from '../reasoning/bridge/index.mjs';
import {cnl} from '../sop/cnl.mjs';
const args=cliArgs(),cmd=args._[0];
if(args.help||!cmd){console.log(`node tools/sqlite-simple.mjs ingest --db demo.sqlite --file examples/memory-knowledge.sop --reviewed
node tools/sqlite-simple.mjs query --db demo.sqlite --file examples/memory-query.sop
node tools/sqlite-simple.mjs search --db demo.sqlite --text "ana"
node tools/sqlite-simple.mjs fork --db demo.sqlite --to copy.sqlite
node tools/sqlite-simple.mjs stats --db demo.sqlite
Ingestion accepts reviewed fact/rule declarations. Query input contains one @q query, not arbitrary executable SOP. This baseline uses one SQL file and full-copy forks.`);}
else{
 const db=new SimpleSQLiteMemory(args.db??'simple.sqlite');
 try{
  if(cmd==='ingest'){if(!args.file)throw Error('--file required');console.log(JSON.stringify({ids:db.ingest(fs.readFileSync(args.file,'utf8'),{reviewed:args.reviewed===true}),stats:db.stats()},null,2));}
  else if(cmd==='query'){
   const p=parse(fs.readFileSync(args.file,'utf8'));if(p.wires.length!==1||p.wires[0].type!=='query')throw Error('Expected one @q query declaration');
   const q=lowerQuery(p.wires[0]),rules=db.rules({asof:q.asof}),plan=planGoals(q,rules),facts=new Map();let probes=0,complete=plan.complete;
   const maxProbes=Number(args.maxProbes??100000),maxFacts=Number(args.maxFacts??10000);
   for(const g of plan.goals){if(probes>=maxProbes){complete=false;break;}const r=db.recall(g,q,{maxProbes:maxProbes-probes,limit:maxFacts});probes+=r.probes;complete&&=r.complete;for(const f of r.rows)facts.set(f.id,f);}
   const result=reason(q,{facts:[...facts.values()],rules:plan.rules,complete,probes},{maxFacts});console.log(JSON.stringify({result,cnl:cnl(result,args.language??'ro')},null,2));
  }else if(cmd==='search')console.log(JSON.stringify(db.search(args.text??'',{limit:Number(args.limit??20)}),null,2));
  else if(cmd==='fork'){const child=db.fork(args.to);console.log(JSON.stringify({file:child.file,stats:child.stats()},null,2));child.close();}
  else if(cmd==='stats')console.log(JSON.stringify(db.stats(),null,2));
  else throw Error('Unknown command '+cmd);
 }finally{db.close();}
}
