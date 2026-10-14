/** Experimental HoloMemory content plane (DS017): exact canonical SOP from a KNOWN SHA-256 handle.
 * Fixed signed arrays, byte alphabet, no per-item body/length table. The handle is
 * also the integrity check. Discovery of handles from vague cues is NOT provided.
 */
import {HoloKernel} from '../memory/banks/holo-kernel.mjs';
import {parse,canonical} from '../sop/parser.mjs';
import {assert,digest} from '../lib/util.mjs';
const alphabet=Array.from({length:256},(_,i)=>i);
export class HoloWireMemory {
 constructor(config={},state=null){
  this.config={maxBytes:4096,...(state?.config??config)};
  assert(Number.isInteger(this.config.maxBytes)&&this.config.maxBytes>=1&&this.config.maxBytes<=65535,'Invalid maxBytes');
  this.kernel=state?HoloKernel.from(state.kernel):new HoloKernel(config.kernel??{rows:4096,dimension:64,banks:4});
 }
 remember(source,{strength=2,reinforce=false}={}){
  const sourceCanonical=canonical(parse(source)),bytes=Buffer.from(sourceCanonical,'utf8');assert(bytes.length<=this.config.maxBytes,'Wire exceeds configured byte budget');
  const handle=digest(sourceCanonical),repeated=reinforce||this.recall(handle).status==='remembered';
  if(!repeated)this.kernel.age(this.kernel.config.ageStepsPerNovel);
  const payload=Buffer.concat([Buffer.from([bytes.length>>>8,bytes.length&255]),bytes]);
  for(let i=0;i<payload.length;i++)this.kernel.write('wire:'+handle+':'+i,payload[i],{strength});
  return {handle,bytes:bytes.length,novel:!repeated};
 }
 recall(handle,{maxBytes=this.config.maxBytes}={}){
  assert(/^[a-f0-9]{64}$/.test(handle),'Expected a SHA-256 wire handle');
  assert(Number.isInteger(maxBytes)&&maxBytes>=1&&maxBytes<=this.config.maxBytes,'Invalid recall byte budget');
  let probes=0,minimumMargin=Infinity;const read=i=>{probes++;const r=this.kernel.read('wire:'+handle+':'+i,alphabet);minimumMargin=Math.min(minimumMargin,r.margin);return r.status==='remembered'?r.value:null;};
  const hi=read(0),lo=read(1);if(hi===null||lo===null)return {status:'not_remembered',sop:null,probes};
  const length=hi*256+lo;if(!length||length>maxBytes)return {status:'uncertain',sop:null,probes,reason:'invalid_or_over_budget_length'};
  const bytes=Buffer.alloc(length);for(let i=0;i<length;i++){const v=read(i+2);if(v===null)return {status:'uncertain',sop:null,probes,reason:'ambiguous_byte'};bytes[i]=v;}
  const source=bytes.toString('utf8');if(digest(source)!==handle)return {status:'uncertain',sop:null,probes,reason:'checksum_mismatch'};
  try{parse(source);}catch{return {status:'uncertain',sop:null,probes,reason:'invalid_sop'};}
  return {status:'remembered',sop:source,handle,probes,minimumMargin,integrity:'sha256-content-address',confidenceIsProbability:false};
 }
 export(){return {format:'holo-wire-v1',config:this.config,kernel:this.kernel.export()};}
 fork(){return new HoloWireMemory({},this.export());}
 stats(){return {...this.kernel.stats(),boundedComponent:true,handleDiscovery:false};}
}
