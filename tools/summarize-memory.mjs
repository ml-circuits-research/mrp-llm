#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cliArgs,saveJSON} from '../lib/util.mjs';
const args=cliArgs(),dir=path.resolve(args.dir??fileURLToPath(new URL('../eval/reports/current/memory/',import.meta.url)));
const files=fs.readdirSync(dir).filter(n=>/^(recall-memory|holo-memory|sqlite|scan)-\d+-\d+\.json$/.test(n));
const runs=files.map(file=>({file,...JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'))}));
const median=a=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)]??0;};
const groups=[];
for(const count of [...new Set(runs.map(r=>r.count))].sort((a,b)=>a-b))for(const engine of ['recall-memory','holo-memory','sqlite','scan']){
 const rs=runs.filter(r=>r.count===count&&r.engine===engine);if(!rs.length)continue;
 const tasks={};for(const type of ['completion','absent','reverse']){
  const qs=rs.flatMap(r=>r.queries.filter(q=>q.type===type)),sum=k=>qs.reduce((s,q)=>s+q[k],0),tp=sum('tp'),fp=sum('fp'),fn=sum('fn');
  tasks[type]={queries:qs.length,tp,fp,fn,precision:tp+fp?tp/(tp+fp):null,recall:tp+fn?tp/(tp+fn):null,exactQueries:qs.filter(q=>q.fp===0&&q.fn===0).length,medianMs:median(qs.map(q=>q.ms)),budgetComplete:qs.filter(q=>q.complete).length};
 }
 groups.push({engine,count,seeds:rs.map(r=>r.seed),buildMedianMs:median(rs.map(r=>r.buildMs)),banksMiB:median(rs.map(r=>r.stats.banksBytes/1048576)),
  metadataMiB:median(rs.map(r=>(r.stats.metadataBytes??0)/1048576)),snapshotMiB:median(rs.map(r=>r.snapshotBytes/1048576)),tasks});
}
const summary={experiment:'sop-bank-comparison-v1',groups,runs:files,scope:'bank-only timing, retained typed tuples, synthetic data; not full conversational throughput',
 memoryNote:'HoloMemory and RecallMemory array bytes match exactly. Domains/receipts are added separately. SQLite sizes are actual database pages including B-trees and FTS. Scan is serialized payload, not heap. Snapshot includes transport overhead.',
 seeds:[...new Set(runs.map(r=>r.seed))].sort((a,b)=>a-b),neuralModelTested:false};saveJSON(path.join(dir,'summary.json'),summary);
const rows=groups.map(g=>`| ${g.count.toLocaleString('en-US')} | ${g.engine} | ${(100*g.tasks.completion.recall).toFixed(2)}% | ${g.tasks.completion.medianMs.toFixed(3)} | ${(100*g.tasks.reverse.recall).toFixed(2)}% | ${g.banksMiB.toFixed(2)} | ${g.metadataMiB.toFixed(2)} |`).join('\n');
const md=`# Rezultate comparative\n\nMăsurători noi. Seed-uri prezente: ${summary.seeds.join(", ")}. Numărul de interogări din fiecare categorie este consemnat în summary.json; rularea livrată folosește 80 directe, 20 pentru chei absente și 2 inverse largi per seed. Ground truth este accesibil evaluatorului, nu memoriei.\n\n| Fapte | Motor | Recall completări | Mediană ms | Recall invers | Bănci/SQL/payload MiB | Metadate extra MiB |\n|---:|---|---:|---:|---:|---:|---:|\n${rows}\n\nRecall numără faptele recuperate / faptele așteptate, nu numai interogările rezolvate integral. Nu au fost acceptate tuple inexistente în aceste teste; HoloMemory și RecallMemory folosesc verificare SHA-256 prin receipts. Aceasta nu echivalează cu probabilitate 100% de adevăr sau cu garanția că au fost recuperate toate alternativele.\n\nTimpii sunt pentru nucleele de memorie, nu includ parserul SOP, timpul LLM, construirea întregului context temporal sau snapshot-urile repository-ului. Doi timpi de citire SQL nu înseamnă că un dialog complet durează atât. Latențele de mai sus sunt cache-warm, locale.\n\nAmbele memorii asociative au exact același buget de tablouri de 2,5 MiB; dicționarele și amprentele sunt suplimentare. SQLite include patru indici de argumente și FTS. Scan raportează reprezentarea serializată, nu memoria V8. RAM/RSS și dimensiunea snapshot-ului sunt disponibile în fiecare raport individual.\n\nTabelul istoric al HoloMemory nu a fost reprodus și nu este citat (vezi DS017). Raportul holo-memory-kernel.json conține măsurătorile noului nucleu, separat de comparația pe fapte.\n`;
fs.writeFileSync(path.join(dir,'RESULTS.md'),md);console.log(JSON.stringify(summary,null,2));
