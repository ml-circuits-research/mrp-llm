#!/usr/bin/env node
/** Summarize ONLY raw comparison records; unobserved cells remain explicit. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {cliArgs,digest,saveJSON} from '../lib/util.mjs';
const engines=['recall-memory','holo-memory','sqlite','scan','hybrid'],backends=['js','prolog','z3'];
const defaultDir=fileURLToPath(new URL('../eval/reports/current/comparisons/',import.meta.url));
const assert=(ok,msg)=>{if(!ok)throw Error(msg);};
export function buildMatrix(engineReport,reasonerReport){
 assert(engineReport?.experiment==='engine-comparison-v1'&&Array.isArray(engineReport.runs)&&Array.isArray(engineReport.lifecycles),'Invalid engine report');
 assert(reasonerReport?.experiment==='reasoning-memory-v1'&&Array.isArray(reasonerReport.cells),'Invalid reasoning report');
 const runs=engineReport.runs, cells=reasonerReport.cells,keys=new Set(),samples=[];
 for(const run of runs){assert(engines.includes(run.engine),'Unexpected engine');const key=[run.engine,run.count,run.seed].join('/');assert(!keys.has(key),'Duplicate bank run '+key);keys.add(key);
  assert(Array.isArray(run.samples)&&run.summary?.uniform&&run.summary?.hotspot&&run.summary?.absent,'Incomplete bank run '+key);
  samples.push({engine:run.engine,count:run.count,seed:run.seed,corpusHash:run.corpusHash,queriesHash:run.queriesHash,budget:run.budget,buildMs:run.buildMs,snapshotBytes:run.snapshotBytes,restartAgreement:run.restartAgreement,bankBytes:run.stats?.banksBytes??null,metadataBytes:run.stats?.metadataBytes??null,distributions:run.summary,hintConsumer:run.hintConsumer});
 }
 for(const count of new Set(runs.map(x=>x.count)))for(const seed of new Set(runs.filter(x=>x.count===count).map(x=>x.seed))){const group=runs.filter(x=>x.count===count&&x.seed===seed);assert(group.every(x=>x.corpusHash===group[0].corpusHash&&x.queriesHash===group[0].queriesHash),'Inconsistent workload '+count+'/'+seed);}
 const lifecycle=engines.map(engine=>engineReport.lifecycles.find(x=>x.engine===engine)??{engine,status:'missing',reason:'No lifecycle record in raw report'});
 const matrix=engines.map(engine=>({engine,cells:backends.map(backend=>{const group=cells.filter(c=>c.engine===engine&&c.backend===backend);assert(group.length<=1,'Duplicate reasoning cell '+engine+'/'+backend);const cell=group[0]??{engine,backend,status:'missing',reason:'No raw comparison cell'};assert(['observed','skipped','unsupported','missing'].includes(cell.status),'Unrecognized status');if(cell.status==='observed')assert(cell.reportedBackend===backend&&typeof cell.complete==='boolean','Observed backend mismatch');return cell;})}));
 return {experiment:'capability-matrix-v1',sources:{engines:{experiment:engineReport.experiment,digest:digest(engineReport)},reasoners:{experiment:reasonerReport.experiment,digest:digest(reasonerReport)}},memoryEngines:engines,reasoningBackends:backends,scope:'JS Horn and SWI Horn are independent implementations; Z3 arithmetic is not a Horn×memory cell',bankRuns:samples,lifecycle,reasoningMatrix:matrix,totals:Object.fromEntries(['observed','skipped','unsupported','missing'].map(status=>[status,matrix.flatMap(row=>row.cells).filter(c=>c.status===status).length]))};
}
export function renderMatrix(report){const status=c=>c.status==='observed'?`observed: ${c.queryStatus}, ${c.reportedBackend}, ${c.complete?'complete':'incomplete'}`:`${c.status}: ${c.reason}`;
 return `# Current reasoning × memory capability matrix\n\nGenerated from raw comparison reports by \`node tools/capability-matrix.mjs\`. Digests bind the source inputs; timings are from the raw runs, not rerun by this generator.\n\n| Memory engine | JS Horn | SWI Horn | Z3 Horn |\n|---|---|---|---|\n${report.reasoningMatrix.map(row=>`| ${row.engine} | ${row.cells.map(status).join(' | ')} |`).join('\n')}\n\nObserved ${report.totals.observed}; skipped ${report.totals.skipped}; unsupported ${report.totals.unsupported}; missing ${report.totals.missing}. Z3 supports numeric constraints, not this Horn task; an unrelated numeric result is not a memory cell.\n`;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=cliArgs(),source=file=>JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));
 const report=buildMatrix(source(args.engines??path.join(defaultDir,'engines.json')),source(args.reasoners??path.join(defaultDir,'reasoners.json')));
 const out=path.resolve(args.out??path.join(defaultDir,'matrix.json'));saveJSON(out,report);
 fs.writeFileSync(out.replace(/\.json$/,'')+'.txt',renderMatrix(report));
 console.log(JSON.stringify({out,bankRuns:report.bankRuns.length,totals:report.totals},null,2));
}
