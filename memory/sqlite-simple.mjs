/** The deliberately simple baseline: one SQLite file with exact atoms, claims,
 * temporal updates and approved SOP rules. No associative bank, receipts table
 * outside SQL, hidden record store or vector service is required.
 * Fork copies the database; it is NOT copy-on-write.
 */
import fs from 'node:fs';import path from 'node:path';
import {SQLiteBank} from './banks/sqlite.mjs';
import {digest,assert} from '../lib/util.mjs';
import {atomKey} from '../lib/types.mjs';
import {serialInterval,readInterval,contains,intersect} from '../lib/time.mjs';
import {parse,canonical} from '../sop/parser.mjs';
import {lowerFact,lowerRule} from '../sop/lower.mjs';
export class SimpleSQLiteMemory {
 constructor(file,config={}){
  fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});
  this.file=path.resolve(file);this.bank=new SQLiteBank(config,null,{path:this.file});this.db=this.bank.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS claims(id TEXT PRIMARY KEY, tuple_hash TEXT NOT NULL REFERENCES atoms(id), known_at REAL NOT NULL, body TEXT NOT NULL) STRICT;
   CREATE INDEX IF NOT EXISTS claims_tuple ON claims(tuple_hash,known_at);
   CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY,target TEXT NOT NULL REFERENCES claims(id),known_at REAL NOT NULL,body TEXT NOT NULL) STRICT;
   CREATE INDEX IF NOT EXISTS changes_target ON changes(target,known_at);
   CREATE TABLE IF NOT EXISTS library(id TEXT PRIMARY KEY,known_at REAL NOT NULL,sop TEXT NOT NULL,hash TEXT NOT NULL) STRICT;`);
 }
 add(f,{knownAt=Date.now()}={}){
  const tupleHash=digest(atomKey(f.atom)),raw={tupleHash,valid:serialInterval(f.valid),source:f.source??'user',quote:f.quote??''},id='c_'+digest(raw).slice(0,32);
  const run=()=>{this.bank.add(f.atom);const old=this.db.prepare('SELECT body FROM claims WHERE id=?').get(id),c=old?JSON.parse(old.body):{...raw,id,knownAt,retention:f.retention??'normal',observations:0};
   c.observations++;if(f.retention==='pinned')c.retention='pinned';c.lastObservedAt=knownAt;
   this.db.prepare('INSERT INTO claims(id,tuple_hash,known_at,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,tupleHash,c.knownAt,JSON.stringify(c));return id;};
  return this.inTransaction?run():this.transaction(run);
 }
 transaction(fn){this.inTransaction=true;try{return this.bank.transaction(fn);}finally{this.inTransaction=false;}}
 event(e,{knownAt=Date.now()}={}){
  assert(['end','retract'].includes(e.action),'Unknown update action');assert(this.db.prepare('SELECT 1 FROM claims WHERE id=?').get(e.target),'Unknown claim');
  if(e.action==='end')assert(Number.isFinite(e.effective),'end requires effective time');
  const rec={action:e.action,target:e.target,knownAt,source:e.source??'user',...(e.action==='end'?{effective:e.effective}:{})},id='e_'+digest(rec).slice(0,32);
  this.db.prepare('INSERT OR IGNORE INTO changes(id,target,known_at,body) VALUES(?,?,?,?)').run(id,e.target,knownAt,JSON.stringify(rec));return id;
 }
 recall(pattern,q={},options={}){
  const asof=q.asof??Infinity,tupleHits=this.bank.recall(pattern,{...options,limit:options.limit??10000});let probes=tupleHits.probes,complete=tupleHits.complete;const rows=[];
  for(const hit of tupleHits.rows){
   for(const raw of this.db.prepare('SELECT body FROM claims WHERE tuple_hash=? AND known_at<=?').iterate(hit.id,asof)){
    if(probes>=(options.maxProbes??50000)){complete=false;break;}probes++;
    const c=JSON.parse(raw.body),events=this.db.prepare('SELECT body FROM changes WHERE target=? AND known_at<=?').all(c.id,asof).map(r=>JSON.parse(r.body));
    if(events.some(e=>e.action==='retract'))continue;
    let valid=readInterval(c.valid);for(const e of events)if(e.action==='end')valid.until=Math.min(valid.until,e.effective);
    if(valid.from>=valid.until)continue;if(q.at!==undefined&&!contains(valid,q.at))continue;
    if(q.during){valid=intersect(valid,q.during);if(!valid)continue;}
    if(rows.length>=(options.limit??10000)){complete=false;break;}
    rows.push({id:c.id,atom:hit.atom,valid,source:c.source,quote:c.quote,knownAt:c.knownAt,retention:c.retention,claim:c,kind:'observed',evidence:{...hit.evidence,metadataVerified:true}});
   }
   if(!complete&&probes>=(options.maxProbes??50000))break;
  }
  return {rows,complete,probes};
 }
 ingest(sop,{schema=null,reviewed=false,knownAt=Date.now()}={}){
  assert(reviewed,'Ingestion needs explicit reviewed approval');const program=parse(sop);return this.transaction(()=>program.wires.map(w=>{
   if(w.type==='fact')return this.add(lowerFact(w,{},schema),{knownAt});
   assert(w.type==='rule','Simple SQL ingestion accepts only fact and rule declarations');lowerRule(w,{},schema);
   const source=canonical({wires:[w]}),hash=digest(source),old=this.db.prepare('SELECT hash FROM library WHERE id=?').get(w.id);
   assert(!old||old.hash===hash,'Conflicting rule definition '+w.id);
   this.db.prepare('INSERT OR IGNORE INTO library(id,known_at,sop,hash) VALUES(?,?,?,?)').run(w.id,knownAt,source,hash);return w.id;
  }));
 }
 rules({asof=Infinity,schema=null}={}){return this.db.prepare('SELECT sop FROM library WHERE known_at<=? ORDER BY id').all(asof).map(x=>lowerRule(parse(x.sop).wires[0],{},schema));}
 fork(destination){const dest=path.resolve(destination);assert(dest!==this.file&&!fs.existsSync(dest),'Fork destination must not exist');fs.mkdirSync(path.dirname(dest),{recursive:true});this.db.prepare('VACUUM INTO ?').run(dest);return new SimpleSQLiteMemory(dest,this.bank.config);}
 search(text,options){return this.bank.search(text,options);}
 stats(){return {...this.bank.stats(),claims:this.db.prepare('SELECT count(*) n FROM claims').get().n,events:this.db.prepare('SELECT count(*) n FROM changes').get().n,rules:this.db.prepare('SELECT count(*) n FROM library').get().n};}
 close(){this.bank.close();}
}
