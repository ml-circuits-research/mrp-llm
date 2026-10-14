// VENDORED: copied verbatim from sop_reasoner_e10.zip (sop-verified-reasoner 0.3.0) src/database.mjs
import {key} from './terms.mjs';
export class SymbolTable {
  constructor(){this.ids=new Map();this.values=[];}
  intern(value){const k=key(value);let id=this.ids.get(k);if(id===undefined){id=this.values.length;this.values.push(value);this.ids.set(k,id);}return id;}
  decode(id){return this.values[id];}
}
export class Relation {
  constructor(pred,arity){this.pred=pred;this.arity=arity;this.rows=[];this.keys=new Map();this.indexes=new Map();this.proofs=[];}
  add(tuple,proof=null){
    if(tuple.length!==this.arity)throw new Error(`Arity mismatch ${this.pred}`);
    const k=tuple.join(',');if(this.keys.has(k))return -1;
    const id=this.rows.length;this.rows.push(tuple);this.keys.set(k,id);this.proofs.push(proof);
    for(const idx of this.indexes.values()){const ik=idx.positions.map(i=>tuple[i]).join(',');let ids=idx.map.get(ik);if(!ids)idx.map.set(ik,ids=[]);ids.push(id);}
    return id;
  }
  has(tuple){return this.keys.has(tuple.join(','));}
  index(positions,stats){
    const signature=positions.join(',');let idx=this.indexes.get(signature);
    if(!idx){idx={positions,map:new Map()};for(let id=0;id<this.rows.length;id++){const k=positions.map(i=>this.rows[id][i]).join(',');let ids=idx.map.get(k);if(!ids)idx.map.set(k,ids=[]);ids.push(id);}this.indexes.set(signature,idx);if(stats)stats.indexBuildRows+=this.rows.length;}
    return idx;
  }
  lookup(pattern,indexed=true,stats=null){
    const pos=[];for(let i=0;i<pattern.length;i++)if(pattern[i]!==undefined)pos.push(i);
    if(!indexed||!pos.length)return this.rows.keys();
    if(pos.length===this.arity){const id=this.keys.get(pattern.join(','));return id===undefined?[]:[id];}
    return this.index(pos,stats).map.get(pos.map(i=>pattern[i]).join(','))||[];
  }
  estimate(pattern,indexed,stats){if(!indexed)return this.rows.length;const ids=this.lookup(pattern,true,stats);return Array.isArray(ids)?ids.length:this.rows.length;}
}
export class Database {
  constructor(pool=new SymbolTable()){this.pool=pool;this.relations=new Map();}
  relation(pred,arity){let r=this.relations.get(pred);if(!r){r=new Relation(pred,arity);this.relations.set(pred,r);}else if(r.arity!==arity)throw new Error('Relation arity mismatch');return r;}
  add(pred,values,proof=null){return this.relation(pred,values.length).add(values.map(v=>this.pool.intern(v)),proof);}
  static fromProgram(p,{provenance=false}={}){
    const db=new Database();for(const [name,n]of p.arities)db.relation(name,n);
    for(const f of p.facts)db.add(f.pred,f.terms,provenance?{kind:'fact',source:f.source,line:f.line,wire:f.wire}:null);
    return db;
  }
  decoded(pred){const r=this.relations.get(pred);return r?r.rows.map(t=>t.map(v=>this.pool.decode(v))):[];}
  clearIndexes(){for(const r of this.relations.values())r.indexes.clear();}
}
