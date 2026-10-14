/** Exact SQL baseline. Only Node's built-in node:sqlite is used (Node >=22.13).
 * A real SQLite B-tree database, not a scan labelled "SQL". It can run directly
 * against a .sqlite file. Repository snapshots currently export canonical rows
 * and rebuild the private SQL view; those snapshot costs are reported separately.
 */
import {createRequire} from 'node:module';
import {atom,atomKey} from '../../lib/types.mjs';
import {assert,digest,stable,variable} from '../../lib/util.mjs';
import {checkBudget} from './common.mjs';
const require=createRequire(import.meta.url);
export class SQLiteBank {
 constructor(config={},state=null,{path=':memory:'}={}){
  this.config={...config,...state?.config,engine:'sqlite'};this.options={fts:true,maxRecords:1000000,...this.config.sqlite};
  assert(Number.isSafeInteger(this.options.maxRecords)&&this.options.maxRecords>0,'Invalid sqlite.maxRecords');
  try{require('node:sqlite');}catch{throw Error('SQLite strategy requires Node >=22.13 with node:sqlite. No npm package is installed automatically.');}
  this.path=path;this.closed=false;this._db=null;this.domains={};this.writes=state?.writes??0;this._statements=new Map();
  if(state&&path===':memory:'){
   // Lazy rebuild: the stored rows stay as they are until the first read or write needs the database. The predicates and arities the
   // temporal layer routes by are read from the rows, so a layer that no question touches never builds its SQL database.
   this.pending=state.records??[];
   for(const row of this.pending){const a=JSON.parse(row.body);const key=a.p+'/'+a.a.length;if(!this.domains[key])this.domains[key]=Array.from({length:a.a.length},()=>[]);}
  }else{this.pending=null;this._open(state);}
 }
 /** The SQL database: built from the pending rows on first use. */
 get db(){if(!this._db)this._open(this.pending?{records:this.pending}:null);return this._db;}
 get put(){this.db;return this._put_stmt;}
 get getMeta(){this.db;return this._get_meta;}
 get setMeta(){this.db;return this._set_meta;}
 _open(state){
  const {DatabaseSync}=require('node:sqlite');
  const db=this._db=new DatabaseSync(this.path);this.pending=null;
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS atoms (
    id TEXT PRIMARY KEY, p TEXT NOT NULL, n INTEGER NOT NULL, neg INTEGER NOT NULL,
    v0 TEXT, v1 TEXT, v2 TEXT, v3 TEXT, body TEXT NOT NULL, meta TEXT NOT NULL
   ) STRICT;
   CREATE INDEX IF NOT EXISTS atoms_a0 ON atoms(p,n,neg,v0);
   CREATE INDEX IF NOT EXISTS atoms_a1 ON atoms(p,n,neg,v1);
   CREATE INDEX IF NOT EXISTS atoms_a2 ON atoms(p,n,neg,v2);
   CREATE INDEX IF NOT EXISTS atoms_a3 ON atoms(p,n,neg,v3);`);
  if(this.options.fts){
   db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts USING fts5(id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER IF NOT EXISTS atoms_ai AFTER INSERT ON atoms BEGIN
     INSERT INTO atoms_fts(rowid,id,body) VALUES(new.rowid,new.id,new.body); END;
    CREATE TRIGGER IF NOT EXISTS atoms_ad AFTER DELETE ON atoms BEGIN
     DELETE FROM atoms_fts WHERE rowid=old.rowid; END;`);
   // A database initially created without FTS may be reopened with it enabled.
   db.exec('INSERT INTO atoms_fts(rowid,id,body) SELECT rowid,id,body FROM atoms WHERE rowid NOT IN (SELECT rowid FROM atoms_fts)');
  }
  this._put_stmt=db.prepare('INSERT INTO atoms(id,p,n,neg,v0,v1,v2,v3,body,meta) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET meta=excluded.meta');
  this._get_meta=db.prepare('SELECT meta FROM atoms WHERE id=?');this._set_meta=db.prepare('UPDATE atoms SET meta=? WHERE id=?');
  if(state){db.exec('BEGIN');try{for(const row of state.records??[])this._put(atom(JSON.parse(row.body),{ground:true}),JSON.parse(row.meta),row.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');this.close();throw e;}}
  this._refreshDomains();
 }
 _refreshDomains(){this.domains={};for(const r of this.db.prepare('SELECT DISTINCT p,n FROM atoms').iterate())this.domains[r.p+'/'+r.n]=Array.from({length:r.n},()=>[]);}
 _put(a,meta,id=digest(atomKey(a))){
  const args=Array.from({length:4},(_,i)=>i<a.a.length?stable(a.a[i]):null);
  this.put.run(id,a.p,a.a.length,+a.neg,...args,atomKey(a),JSON.stringify(meta));this.domains[a.p+'/'+a.a.length]=a.a.map(()=>[]);return id;
 }
 add(input,meta={}){
  const a=atom(input,{ground:true}),id=digest(atomKey(a)),strength=meta.strength??1;
  assert(Number.isInteger(strength)&&strength>=1&&strength<=15,'strength must be 1..15');
  const old=this.getMeta.get(id),previous=old?JSON.parse(old.meta):{};
  this._put(a,{...previous,...meta,strength:Math.min(15,(previous.strength??0)+strength),seen:(previous.seen??0)+1},id);this.writes++;return id;
 }
 transaction(fn){this.db.exec('BEGIN');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');this._refreshDomains();throw e;}}
 addMany(atoms,meta={}){return this.transaction(()=>atoms.map(a=>this.add(a,meta)));}
 reinforce(a,{strength=1,touchedAt=Date.now(),reason='use'}={}){return this.add(a,{strength,touchedAt,reason,reinforcement:true});}
 _filter(pattern){
  const p=atom(pattern),parts=['p=?','n=?','neg=?'],args=[p.p,p.a.length,+p.neg],vars=new Map();
  p.a.forEach((v,i)=>{if(variable(v)){if(vars.has(v))parts.push('v'+i+'=v'+vars.get(v));else vars.set(v,i);}else{parts.push('v'+i+'=?');args.push(stable(v));}});
  return {where:parts.join(' AND '),args};
 }
 /** Indexed tuple cardinality for retrieval ordering only; never a completeness or temporal answer. */
 estimate(pattern){
  const f=this._filter(pattern),sql='SELECT count(*) n FROM atoms WHERE '+f.where;
  let stmt=this._statements.get(sql);if(!stmt){stmt=this.db.prepare(sql);if(this._statements.size>=256)this._statements.clear();this._statements.set(sql,stmt);}
  return stmt.get(...f.args).n;
 }
 recall(pattern,options={}){
  const {maxProbes,limit}=checkBudget(options),f=this._filter(pattern),now=options.now??Date.now(),blocked=options.blocked??new Set();
  if(!maxProbes||!limit)return {rows:[],probes:0,complete:false};
  const sql='SELECT id,body,meta FROM atoms WHERE '+f.where;
  let stmt=this._statements.get(sql);if(!stmt){stmt=this.db.prepare(sql);if(this._statements.size>=256)this._statements.clear();this._statements.set(sql,stmt);}
  const rows=[];let probes=0,complete=true;
  for(const row of stmt.iterate(...f.args)){
   if(probes>=maxProbes){complete=false;break;}probes++;
   const meta=JSON.parse(row.meta);if(blocked.has(row.id)||(meta.expiresAt&&meta.expiresAt<=now))continue;
   if(rows.length>=limit){complete=false;break;}
   rows.push({id:row.id,atom:JSON.parse(row.body),source:meta.source??null,evidence:{verification:'sqlite-exact',receipt:true,exactMatch:true}});
  }
  return {rows,probes,complete,coverage:complete?'exact-sqlite':'partial-sqlite',probeUnit:'matched SQL rows; B-tree work is not counted'};
 }
 /** Literal terms combined by AND; user input never becomes SQL or raw FTS syntax. */
 search(text,{limit=20}={}){
  assert(this.options.fts,'FTS is disabled');assert(typeof text==='string','Search text must be a string');
  assert(Number.isInteger(limit)&&limit>=0&&limit<=10000,'Invalid lexical limit');
  const tokens=text.normalize('NFC').match(/[\p{L}\p{N}_]+/gu)??[];if(!tokens.length||!limit)return {rows:[],complete:true};
  const expr=tokens.map(t=>'"'+t.replaceAll('"','""')+'"').join(' AND ');
  const found=this.db.prepare('SELECT a.id,a.body,a.meta,bm25(atoms_fts) score FROM atoms_fts JOIN atoms a ON a.rowid=atoms_fts.rowid WHERE atoms_fts MATCH ? ORDER BY score LIMIT ?').all(expr,limit+1);
  return {rows:found.slice(0,limit).map(r=>({id:r.id,atom:JSON.parse(r.body),meta:JSON.parse(r.meta),rank:r.score})),complete:found.length<=limit};
 }
 explain(pattern){const f=this._filter(pattern);return this.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM atoms WHERE '+f.where).all(...f.args);}
 get receipts(){return Object.fromEntries(this.db.prepare('SELECT id,meta FROM atoms').all().map(r=>[r.id,JSON.parse(r.meta)]));}
 decay(steps=1){assert(Number.isInteger(steps)&&steps>=0,'Invalid decay');if(!steps)return;this.transaction(()=>{const remove=this.db.prepare('DELETE FROM atoms WHERE id=?');for(const r of this.db.prepare('SELECT id,meta FROM atoms').all()){const m=JSON.parse(r.meta);m.strength=Math.max(0,(m.strength??1)-steps);if(!m.strength)remove.run(r.id);else this.setMeta.run(JSON.stringify(m),r.id);}});this._refreshDomains();}
 maintain({mode='none',safeOccupancy=.55,targetOccupancy=.45,step=1,maxSweeps=15,at=Date.now()}={}){
  assert(['none','adaptive'].includes(mode),'Invalid maintenance mode');const before=this.occupancy();let sweeps=0;
  if(mode==='adaptive'&&before>safeOccupancy)while(this.occupancy()>targetOccupancy&&sweeps<maxSweeps){this.decay(step);sweeps++;}
  return {triggered:sweeps>0,mode,before,after:this.occupancy(),sweeps,at,occupancyMetric:'rows/maxRecords, not bit density'};
 }
 count(){return this.pending?this.pending.length:this.db.prepare('SELECT count(*) n FROM atoms').get().n;}
 occupancy(){return this.count()/this.options.maxRecords;}
 peakOccupancy(){return this.occupancy();}
 bankBytes(){return this.db.prepare('PRAGMA page_count').get().page_count*this.db.prepare('PRAGMA page_size').get().page_size;}
 export(){return {format:'sqlite-fact-bank-v1',config:this.config,records:this.pending?this.pending:this.db.prepare('SELECT id,body,meta FROM atoms ORDER BY id').all(),writes:this.writes};}
 static from(s){return new SQLiteBank(s.config,s);}
 stats(){return {engine:'sqlite',banksBytes:this.bankBytes(),metadataBytes:0,metadataIncludedInDatabase:true,
  writes:this.writes,receipts:this.count(),occupancy:this.occupancy(),fts:this.options.fts,
  persistence:this.path===':memory:'?'in-memory SQL / repository snapshots':'native SQLite file',
  sqliteVersion:this.db.prepare('SELECT sqlite_version() version').get().version};}
 close(){if(!this.closed){if(this._db)this._db.close();this.closed=true;}}
}
