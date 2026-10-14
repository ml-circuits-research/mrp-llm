#!/usr/bin/env node
/** Offline verification of the current chain. Does not install packages, download weights or train.
 *
 *   node tools/verify.mjs [--group core] [--collect]
 *
 * The jobs check the kept product: the unit tests, the reasoning smoke suite, the spec references, the file-size limit, the solver
 * availability, the contracts export and the demos. The verification chain of the frozen small-model branch (datasets, corpus audit,
 * symbolic regression, training dry runs) moved with it to probably_obsolete/tinyLLMExperiments/. The next validation procedure is the
 * symbolic-vs-LLM benchmark (experiments/proposal/symbolic-vs-llm-benchmark.md).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {saveJSON,digest} from '../lib/util.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const reportDir='eval/reports/current';
fs.mkdirSync(reportDir,{recursive:true});
const group=process.argv.includes('--group')?process.argv[process.argv.indexOf('--group')+1]:'all';
const sources=['package.json','lib','sop','memory','reasoning','server','eval','tests','tools','config','examples'];
function fingerprints(location){
 const stat=fs.statSync(location);
 if(stat.isFile())return [[location,crypto.createHash('sha256').update(fs.readFileSync(location)).digest('hex')]];
 return fs.readdirSync(location,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
  if(entry.name==='__pycache__'||entry.name==='.venv'||location==='tools'&&entry.name==='.solvers'||location==='sop'&&entry.name==='contracts'||location==='eval'&&entry.name==='reports')return [];
  return fingerprints(path.join(location,entry.name));
 });
}
const sourceFingerprint=digest(sources.flatMap(fingerprints));
// every test file of tests/ and its component subfolders (tests/<component>/*.test.mjs; fixtures hold no test files)
const testFiles=fs.globSync('tests/**/*.test.mjs').sort();
const jobs=[
 ['node-tests',process.execPath,['--test',...testFiles]],
 ['demo',process.execPath,['examples/demo.mjs']],
 ['declarative-demo',process.execPath,['examples/declarative-demo.mjs']],
 ['research-examples',process.execPath,['examples/research/demo.mjs']],
 ['linker-demo',process.execPath,['examples/linker-demo.mjs']],
 ['forgetting-demo',process.execPath,['examples/forgetting-demo.mjs']],
 ['shards-demo',process.execPath,['examples/shards-demo.mjs']],
 ['shards-benchmark',process.execPath,['tools/bench-shards.mjs']],
 ['smoke-reasoning',process.execPath,['eval/smoke-reasoning/run.mjs']],
 // the offline per-step formalization regression (no model): every recorded case replayed through the current protocol and code; no case of the floor may be lost (tools/eval/formalization/regression/offline.mjs; skipped without the local recordings)
 ['formalization-offline',process.execPath,['tools/eval/formalization/regression/offline.mjs','check']],
 // the no-capability-loss gate (fast tier while the machine serves formalization; --tier full refreshes the ledger by hand): L1, every generated program on every engine against the oracle, the last L3 run (tools/capabilities/check.mjs)
 ['capability-battery',process.execPath,['tools/capabilities/check.mjs','--tier','fast','--report']],
 ['solver-availability',process.execPath,['tools/check-solvers.mjs']],
 ['reasoning-matrix',process.execPath,['examples/reasoning-demo.mjs']],
 ['contracts',process.execPath,['tools/capabilities.mjs']],
 ['spec-refs',process.execPath,['tools/check-spec-refs.mjs']],
 ['file-size-limit',process.execPath,['tools/shard-large-files.mjs','--check']],
 ['memory-demo',process.execPath,['examples/memory-demo.mjs']]
];
const groups={core:jobs};
const report=file=>path.join(reportDir,file);
const metadata={sourceFingerprint,node:process.version,platform:process.platform,arch:process.arch,neuralModelTested:false,trainingExecuted:false};
if(process.argv.includes('--collect')){
 const parts=Object.keys(groups).map(name=>JSON.parse(fs.readFileSync(report('verification-'+name+'.json'),'utf8')));
 if(parts.some(part=>part.sourceFingerprint!==sourceFingerprint||!part.complete))throw Error('Stale/incomplete verification part; re-run changed source');
 const results=parts.flatMap(part=>part.results),summary={...metadata,complete:true,results};
 saveJSON(report('verification.json'),summary);
 console.log(JSON.stringify(summary,null,2));
 process.exit(results.some(result=>result.status==='failed')?1:0);
}
if(group!=='all'&&!groups[group])throw Error('Unknown --group '+group);
const selectedJobs=group==='all'?Object.values(groups).flat():groups[group],results=[],reportPath=report('verification'+(group==='all'?'':'-'+group)+'.json');
for(const [name,command,args] of selectedJobs){
 console.log('START '+name);
 const start=performance.now(),run=spawnSync(command,args,{encoding:'utf8',timeout:name.endsWith('-dry-run')?15000:name==='capability-battery'?900000:180000,maxBuffer:20*1024*1024});
 const log=(run.stdout??'')+(run.stderr??'');
 fs.writeFileSync(report(name+'.log'),log);
 const entry={name,status:run.status===0?'passed':'failed',exitCode:run.status,seconds:Number(((performance.now()-start)/1000).toFixed(3)),error:run.error?.message??null};
 if(name==='node-tests')for(const key of ['tests','pass','fail','skipped']){
  const match=log.match(new RegExp('^# '+key+' (\\d+)$','m'));
  if(match)entry[key]=Number(match[1]);
 }
 results.push(entry);
 console.log(name+': '+entry.status+' ('+entry.seconds+'s)');
 saveJSON(reportPath,{...metadata,complete:false,results});
}
const summary={...metadata,complete:true,results};
saveJSON(reportPath,summary);
console.log(JSON.stringify(summary,null,2));
if(results.some(result=>result.status==='failed'))process.exitCode=1;
