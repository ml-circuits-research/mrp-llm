import {atom,atomKey} from '../lib/types.mjs';
import {digest,stable,variable,assert} from '../lib/util.mjs';
const nil={nil:true};
const fields=a=>[a.p+'/'+a.a.length,...Array.from({length:4},(_,i)=>i<a.a.length?a.a[i]:nil),a.neg?'negative':'positive'];
function combinations(n,k,start=0,prefix=[],out=[]){if(!k){out.push(prefix);return out;}for(let i=start;i<=n-k;i++)combinations(n,k-1,i+1,[...prefix,i],out);return out;}
function hash(values,seed){let h=seed>>>0;for(const c of Buffer.from(stable(values))){h=Math.imul(h^c,16777619)>>>0;}h^=h>>>16;h=Math.imul(h,0x85ebca6b);h^=h>>>13;return h>>>0;}
/** RecallMemory (DS016): multi-view associative bank inspired by the column-voting idea of
 * "A Thousand Brains". Each view (column) hashes a different subset of the six tuple fields;
 * a candidate survives only when every fully known view supports it. Cells are 4-bit
 * saturating counters. The file keeps its historical name `weaver.mjs`.
 * Tuple receipts verify reconstructed tuples; they are not a truth database.
 * Decay is deliberately cell-level: overlapping facts share support and forgetting
 * is approximate rather than tuple deletion.
 */
export class RecallMemory {
 constructor({power=13,arity=3,seed=1234567,verification='receipt',views=null}={},state=null){
  assert(Number.isInteger(power)&&power>=7&&power<=24,'power must be 7..24');assert([2,3,4,5,6].includes(arity),'view arity must be 2..6');
  assert(['receipt','associative'].includes(verification),'Invalid verification mode');
  this.config={power,arity,seed,verification,views};this.views=views??combinations(6,arity);
  assert(Array.isArray(this.views)&&this.views.length>0&&this.views.length<=128&&this.views.every(v=>Array.isArray(v)&&v.length>=2&&v.length<=6&&new Set(v).size===v.length&&v.every(i=>Number.isInteger(i)&&i>=0&&i<6)),'Invalid column views');
  this.cells=2**power;this.mask=this.cells-1;
  this.banks=this.views.map((_,i)=>state?Uint8Array.from(Buffer.from(state.banks[i],'base64')):new Uint8Array(this.cells/2));
  assert(this.banks.every(b=>b.length===this.cells/2),'Corrupt bank length');
  this.domains=structuredClone(state?.domains??{});this.receipts=structuredClone(state?.receipts??{});this.writes=state?.writes??0;
  this.nonzero=this.banks.map(b=>{let n=0;for(const v of b)n+=(v&15?1:0)+(v>>>4?1:0);return n;});
  this.domainSets=new Map();
  this.maintenance={decaySweeps:state?.maintenance?.decaySweeps??0,receiptsPruned:state?.maintenance?.receiptsPruned??0,lastDecayAt:state?.maintenance?.lastDecayAt??null,lastOccupancyBefore:state?.maintenance?.lastOccupancyBefore??null,lastOccupancyAfter:state?.maintenance?.lastOccupancyAfter??null};
 }
 get(i,h){const byte=this.banks[i][(h&this.mask)>>>1];return h&1?byte>>>4:byte&15;}
 set(i,h,n){h&=this.mask;const j=h>>>1,b=this.banks[i][j],old=h&1?b>>>4:b&15;this.nonzero[i]+=(n>0?1:0)-(old>0?1:0);this.banks[i][j]=h&1?(b&15)|(n<<4):(b&240)|n;}
 addresses(input){const a=atom(input,{ground:true}),f=fields(a);return this.views.map((v,i)=>hash(v.map(j=>f[j]),this.config.seed+i*2654435761)&this.mask);}
 add(input,meta={}){
  const a=atom(input,{ground:true}),f=fields(a),key=digest(atomKey(a)),strength=meta.strength??1;
  assert(Number.isInteger(strength)&&strength>=1&&strength<=15,'strength must be 1..15');
  this.views.forEach((v,i)=>{const h=hash(v.map(j=>f[j]),this.config.seed+i*2654435761);this.set(i,h,Math.min(15,this.get(i,h)+strength));});
  const dkey=a.p+'/'+a.a.length;if(!this.domains[dkey])this.domains[dkey]=Array.from({length:a.a.length},()=>[]);
  a.a.forEach((v,i)=>{const d=this.domains[dkey][i],key=dkey+':'+i;let set=this.domainSets.get(key);if(!set){set=new Set(d.map(stable));this.domainSets.set(key,set);}const code=stable(v);if(!set.has(code)){set.add(code);d.push(v);}});
  const previous=this.receipts[key],receiptStrength=Math.min(15,(previous?.strength??0)+strength);this.receipts[key]={...previous,...meta,strength:receiptStrength,seen:(previous?.seen??0)+1,lastTouchedAt:meta.touchedAt??previous?.lastTouchedAt??null};this.writes++;
  return key;
 }
 /** Reinforcement is a fresh write of the same projections. It deliberately
  * creates a receipt in the hot layer so a fact recalled from an older layer
  * can be promoted without copying an exact fact table.
  */
 reinforce(input,{strength=1,touchedAt=Date.now(),reason='use'}={}){return this.add(input,{strength,touchedAt,reason,reinforcement:true});}
 support(f){let hits=0,total=0;this.views.forEach((v,i)=>{if(v.some(j=>f[j]===undefined))return;total++;if(this.get(i,hash(v.map(j=>f[j]),this.config.seed+i*2654435761))>0)hits++;});return {hits,total};}
 recall(pattern,{maxProbes=50000,limit=1000,now=Date.now(),blocked=new Set()}={}){
  const p=atom(pattern),d=this.domains[p.p+'/'+p.a.length];if(!d)return {rows:[],probes:0,complete:true};
  const f=fields(p);const groups=new Map();p.a.forEach((v,i)=>{if(variable(v)){f[i+1]=undefined;if(!groups.has(v))groups.set(v,[]);groups.get(v).push(i+1);}});
  const unknown=[...groups].map(([v,positions])=>({v,positions,domain:positions.length===1?d[positions[0]-1]:d[positions[0]-1].filter(t=>positions.every(pos=>d[pos-1].some(w=>stable(w)===stable(t))))})).sort((a,b)=>a.domain.length-b.domain.length);
  const rows=[];let probes=0,complete=true;
  const visit=depth=>{
   if(probes>=maxProbes||rows.length>=limit){complete=false;return;}probes++;
   const support=this.support(f);if(support.hits!==support.total)return;
   if(depth<unknown.length){const u=unknown[depth];for(const v of u.domain){for(const pos of u.positions)f[pos]=v;visit(depth+1);if(!complete)break;}for(const pos of u.positions)f[pos]=undefined;return;}
   const candidate={p:p.p,a:f.slice(1,1+p.a.length),neg:p.neg},id=digest(atomKey(candidate));
   if(blocked.has(id))return;const receipt=this.receipts[id];
   if(receipt?.expiresAt&&receipt.expiresAt<=now)return;
   if(this.config.verification==='receipt'&&!receipt)return;
   rows.push({atom:candidate,id,evidence:{support:1,receipt:!!receipt,verification:this.config.verification},source:receipt?.source??null});
  };visit(0);return {rows,probes,complete};
 }
 /** One global cooling sweep. A counter at 1 disappears; reinforced/shared
  * support survives proportionally longer. Pinned memory lives in another bank
  * and TemporalLayer never calls this method on it automatically.
  */
 decay(steps=1,{at=Date.now()}={}){assert(Number.isInteger(steps)&&steps>=0,'Invalid decay');if(!steps)return;for(const bank of this.banks)for(let j=0;j<bank.length;j++){const byte=bank[j],lo=Math.max(0,(byte&15)-steps),hi=Math.max(0,(byte>>>4)-steps);bank[j]=lo|(hi<<4);}let pruned=0;for(const [key,r] of Object.entries(this.receipts)){r.strength=Math.max(0,(r.strength??1)-steps);if(r.strength===0){delete this.receipts[key];pruned++;}}this.nonzero=this.banks.map(b=>{let n=0;for(const v of b)n+=(v&15?1:0)+(v>>>4?1:0);return n;});this.maintenance.decaySweeps+=steps;this.maintenance.receiptsPruned+=pruned;this.maintenance.lastDecayAt=at;}
 /** Pressure-triggered forgetting. Nothing happens below safeOccupancy.
  * Once crossed, repeated cooling sweeps run until targetOccupancy is reached
  * or maxSweeps is exhausted. This is intentionally approximate/cache-like.
  */
 maintain({mode='none',safeOccupancy=.55,targetOccupancy=.45,step=1,maxSweeps=15,at=Date.now()}={}){
  assert(['none','adaptive'].includes(mode),'Unknown forgetting mode');assert(safeOccupancy>0&&safeOccupancy<1,'safeOccupancy must be 0..1');assert(targetOccupancy>=0&&targetOccupancy<safeOccupancy,'targetOccupancy must be below safeOccupancy');assert(Number.isInteger(step)&&step>=1&&step<=15,'decay step must be 1..15');assert(Number.isInteger(maxSweeps)&&maxSweeps>=1&&maxSweeps<=100,'maxSweeps must be 1..100');
  const before=this.occupancy();if(mode==='none'||before<=safeOccupancy)return {triggered:false,mode,before,after:before,sweeps:0,safeOccupancy,targetOccupancy};
  let after=before,sweeps=0;while(after>targetOccupancy&&sweeps<maxSweeps){this.decay(step,{at});sweeps++;after=this.occupancy();}
  this.maintenance.lastOccupancyBefore=before;this.maintenance.lastOccupancyAfter=after;
  return {triggered:true,mode,before,after,sweeps,step,safeOccupancy,targetOccupancy,exhausted:after>targetOccupancy};
 }
 occupancy(){return this.nonzero.reduce((a,b)=>a+b,0)/(this.cells*this.banks.length);}
 columnOccupancies(){return this.nonzero.map(n=>n/this.cells);}
 peakOccupancy(){return Math.max(...this.columnOccupancies());}
 export(){return {config:this.config,banks:this.banks.map(b=>Buffer.from(b).toString('base64')),domains:this.domains,receipts:this.receipts,writes:this.writes,maintenance:this.maintenance};}
 static from(state){return new RecallMemory(state.config,state);}
 stats(){return {banksBytes:this.banks.length*this.cells/2,metadataBytes:Buffer.byteLength(JSON.stringify({domains:this.domains,receipts:this.receipts})),views:this.views.length,writes:this.writes,receipts:Object.keys(this.receipts).length,occupancy:this.occupancy(),maintenance:{...this.maintenance}};}
}
/** Legacy export name of RecallMemory, kept for existing imports (DS016). */
export const Weaver=RecallMemory;
