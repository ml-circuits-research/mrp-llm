/** Retrieval strategies implement the same request/result contract.
 * A strategy retrieves candidate facts; only the reasoner derives conclusions.
 */
import {assert} from '../lib/util.mjs';
import {flattenLayers} from './temporal.mjs';
import {unify} from '../lib/unify.mjs';
import {readInterval,contains,intersect} from '../lib/time.mjs';
import {canonicalEngine} from './banks/factory.mjs';

function exactRetrieve({repo,session,pattern,query,limits}) {
  const layers=flattenLayers(repo.visible(session).map(x=>x.layer),pattern), events=layers.flatMap(l=>l.events).filter(e=>e.knownAt<=query.asof);
  const candidates=layers.filter(l=>Object.keys(l.claims).length), selected=candidates.slice(0,limits.maxShards??Infinity);
  const claims=new Map(), atoms=new Map();let complete=selected.length===candidates.length;
  for (const l of [...selected].reverse()) {
    if (!l.config.exact && Object.keys(l.claims).length) complete=false;
    for(const [hash,a] of Object.entries(l.exactAtoms??{})) atoms.set(hash,a);
    for(const c of Object.values(l.claims)) if(c.knownAt<=query.asof) claims.set(c.id,c);
  }
  const changes=new Map();for(const e of events){if(!changes.has(e.target))changes.set(e.target,[]);changes.get(e.target).push(e);}
  const rows=[];let probes=0;
  for(const c of claims.values()) {
    if(probes>=limits.maxProbes){complete=false;break;}probes++;
    const atom=atoms.get(c.tupleHash);if(!atom||!unify(pattern,atom))continue;
    const updates=changes.get(c.id)??[];if(updates.some(e=>e.action==='retract'))continue;
    let valid=readInterval(c.valid);for(const e of updates)if(e.action==='end')valid.until=Math.min(valid.until,e.effective);
    if(valid.from>=valid.until)continue;
    if(query.at!==undefined&&!contains(valid,query.at))continue;
    if(query.during){valid=intersect(valid,query.during);if(!valid)continue;}
    if(rows.length>=limits.maxFacts){complete=false;break;}
    rows.push({id:c.id,atom,valid,source:c.source,quote:c.quote,knownAt:c.knownAt,retention:c.retention??'normal',claim:structuredClone(c),kind:'observed',
      evidence:{verification:'exact',metadataVerified:true},retrievalStrategies:['exact']});
  }
  return {rows,complete,probes,shardsVisited:selected.length,shardsRouted:candidates.length,coverage:complete?'visible-exact-snapshot':'partial-exact-snapshot'};
}
// Retrieval strategy per canonical memory.engine (DS005). `recall-weaver` is the legacy
// spelling of `recall-memory` and stays registered as an alias for existing configurations.
const strategyNames={'recall-memory':'recall-memory','holo-memory':'holo-memory',sqlite:'sqlite',scan:'scan',hybrid:'hybrid'};
function storedEngines(request){
 const layers=flattenLayers(request.repo.visible(request.session).map(x=>x.layer),request.pattern);
 return new Set(layers.flatMap(l=>(l.banks??[l.pinned,l.normal]).filter(Boolean)).map(b=>canonicalEngine(b.config.engine??'recall-memory')));
}
function bankRetrieve(request,expected=null){
 const engines=storedEngines(request);
 if(expected&&[...engines].some(e=>e!==expected))throw Error('Retrieval strategy '+strategyNames[expected]+' requires matching memory.engine. Re-ingest into a separate repository, or use auto for mixed snapshots.');
 const {repo,session,pattern,query,limits}=request;
 const r=repo.recall(session,pattern,query,{maxProbes:limits.maxProbes,limit:limits.maxFacts,maxShards:limits.maxShards??Infinity,allowUnverified:false});
 const name=f=>({'sqlite-exact':'sqlite','scan-exact':'scan','hybrid-exact':'hybrid','holo-receipt':'holo-memory'}[f.evidence?.verification]??'recall-memory');
 return {...r,rows:r.rows.map(f=>({...f,retrievalStrategies:[name(f)]})),
  selected:[...engines].map(e=>strategyNames[e]).join('+')||strategyNames[expected]||'auto',
  coverage:[...engines].every(e=>e==='sqlite'||e==='scan'||e==='hybrid')?'retained-exact-records':'retained-associative-candidates'};
}
function recallMemoryRetrieve(request){return bankRetrieve(request,'recall-memory');}
export class StrategyRegistry {
  constructor(){this.strategies=new Map();this.register('recall-memory',recallMemoryRetrieve);this.register('recall-weaver',recallMemoryRetrieve);this.register('exact',exactRetrieve);
    this.register('auto',request=>bankRetrieve(request));
    this.register('holo-memory',request=>bankRetrieve(request,'holo-memory'));
    this.register('sqlite',request=>bankRetrieve(request,'sqlite'));
    this.register('scan',request=>bankRetrieve(request,'scan'));
    this.register('hybrid',request=>{
      if(!flattenLayers(request.repo.visible(request.session).map(x=>x.layer),request.pattern).some(l=>l.config.exact))return {...this.retrieve('auto',request),requested:'hybrid'};
      const exact=this.retrieve('exact',request);
      // Exact coverage is a sufficient fallback; avoid wasting the full budget twice.
      if(exact.complete)return {...exact,selected:'exact',requested:'hybrid'};
      const remaining=Math.max(0,request.limits.maxProbes-exact.probes);
      const approximate=remaining?this.retrieve('auto',{...request,limits:{...request.limits,maxProbes:remaining,maxShards:Math.max(0,(request.limits.maxShards??Infinity)-(exact.shardsVisited??0))}}):{rows:[],complete:false,probes:0};
      const rows=new Map(exact.rows.map(f=>[f.id,f]));for(const f of approximate.rows)if(!rows.has(f.id))rows.set(f.id,f);
      return {rows:[...rows.values()],complete:approximate.complete,probes:exact.probes+approximate.probes,shardsVisited:(exact.shardsVisited??0)+(approximate.shardsVisited??0),
        coverage:'hybrid-retained-view',requested:'hybrid',selected:'exact+recall-memory'};
    });
  }
  register(name,handler){assert(/^[a-z][a-z0-9-]*$/.test(name)&&typeof handler==='function','Invalid retrieval strategy');assert(!this.strategies.has(name),'Strategy already registered');this.strategies.set(name,handler);return this;}
  retrieve(name,request){const fn=this.strategies.get(name);assert(fn,'Unknown retrieval strategy '+name);const r=fn(request);assert(r&&Array.isArray(r.rows)&&typeof r.complete==='boolean'&&Number.isFinite(r.probes),'Invalid strategy result');return r;}
}
