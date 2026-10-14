/** Minimal exact reference: one Map, no relational or lexical index. */
import {atom,atomKey} from '../../lib/types.mjs';
import {assert,digest} from '../../lib/util.mjs';
import {matches,checkBudget} from './common.mjs';
export class ScanBank {
 constructor(config={},state=null){this.config={...config,...state?.config,engine:'scan'};this.records=new Map(state?.records??[]);this.writes=state?.writes??0;this.domains={};for(const {atom:a} of this.records.values())this.domains[a.p+'/'+a.a.length]=a.a.map(()=>[]);}
 add(input,meta={}){const a=atom(input,{ground:true}),id=digest(atomKey(a)),old=this.records.get(id)?.meta??{},strength=meta.strength??1;assert(Number.isInteger(strength)&&strength>=1&&strength<=15,'strength must be 1..15');this.records.set(id,{atom:a,meta:{...old,...meta,strength:Math.min(15,(old.strength??0)+strength),seen:(old.seen??0)+1}});this.domains[a.p+'/'+a.a.length]=a.a.map(()=>[]);this.writes++;return id;}
 reinforce(a,{strength=1,touchedAt=Date.now(),reason='use'}={}){return this.add(a,{strength,touchedAt,reason});}
 recall(pattern,options={}){const p=atom(pattern),{maxProbes,limit}=checkBudget(options),blocked=options.blocked??new Set(),now=options.now??Date.now(),rows=[];let probes=0,complete=true;
  for(const [id,r] of this.records){if(probes>=maxProbes){complete=false;break;}probes++;if(!matches(p,r.atom)||blocked.has(id)||(r.meta.expiresAt&&r.meta.expiresAt<=now))continue;if(rows.length>=limit){complete=false;break;}rows.push({id,atom:structuredClone(r.atom),source:r.meta.source??null,evidence:{verification:'scan-exact',receipt:true,exactMatch:true}});}return {rows,probes,complete};}
 get receipts(){return Object.fromEntries([...this.records].map(([id,r])=>[id,r.meta]));}
 decay(steps=1){assert(Number.isInteger(steps)&&steps>=0,'Invalid decay');for(const [id,r] of this.records){r.meta.strength=Math.max(0,(r.meta.strength??1)-steps);if(!r.meta.strength)this.records.delete(id);}this.domains={};for(const {atom:a} of this.records.values())this.domains[a.p+'/'+a.a.length]=a.a.map(()=>[]);}
 maintain({mode='none',safeOccupancy=.55,targetOccupancy=.45,step=1,maxSweeps=15,at=Date.now()}={}){const before=this.occupancy();let sweeps=0;if(mode==='adaptive'&&before>safeOccupancy)while(this.occupancy()>targetOccupancy&&sweeps<maxSweeps){this.decay(step);sweeps++;}return {triggered:sweeps>0,mode,before,after:this.occupancy(),sweeps,at};}
 occupancy(){return this.records.size/(this.config.scan?.maxRecords??1000000);}
 peakOccupancy(){return this.occupancy();}
 bankBytes(){return Buffer.byteLength(JSON.stringify([...this.records]));}
 export(){return {format:'scan-fact-bank-v1',config:this.config,records:structuredClone([...this.records]),writes:this.writes};}
 static from(s){return new ScanBank(s.config,s);}
 stats(){return {engine:'scan',banksBytes:this.bankBytes(),metadataBytes:0,writes:this.writes,receipts:this.records.size,occupancy:this.occupancy(),sizeMetric:'serialized payload bytes, not V8 heap'};}
}
