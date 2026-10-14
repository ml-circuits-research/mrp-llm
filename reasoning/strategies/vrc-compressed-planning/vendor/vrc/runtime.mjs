// VENDORED: copied verbatim from vrc03r.zip vendor/vrc/src/runtime.mjs
import {Poly,parseKey} from './poly.mjs';
/** Safe arithmetic DAG with structural sharing, no eval/Function. */
export function compilePolynomials(polys){
 const nodes=[],memo=new Map(),n=polys[0].n;const addNode=(key,node)=>{if(memo.has(key))return memo.get(key);const id=nodes.length;nodes.push(node);memo.set(key,id);return id;};
 const constant=c=>addNode('c:'+c,{op:'const',value:c}),variable=i=>addNode('v:'+i,{op:'var',index:i});
 const bin=(op,a,b)=>{if(op==='add'){if(nodes[a].op==='const'&&nodes[a].value===0)return b;if(nodes[b].op==='const'&&nodes[b].value===0)return a;}if(op==='mul'){if(nodes[a].op==='const'){if(nodes[a].value===0)return a;if(nodes[a].value===1)return b;}if(nodes[b].op==='const'){if(nodes[b].value===0)return b;if(nodes[b].value===1)return a;}}if(a>b)[a,b]=[b,a];return addNode(op+':'+a+':'+b,{op,a,b});};
 function power(i,k){if(!k)return constant(1);if(k===1)return variable(i);if(k%2)return bin('mul',power(i,k-1),variable(i));const p=power(i,k/2);return bin('mul',p,p);}
 function horner(p){const key='p:'+p.key();if(memo.has(key))return memo.get(key);let id;if(p.zero)id=constant(0);else if(p.constant)id=constant(p.t.values().next().value.toNumber());else{
   const vars=p.variables();let best=vars[0],score=-Infinity;for(const i of vars){let s=0;for(const k of p.t.keys())s+=parseKey(k)[i];if(s>score){score=s;best=i;}}
   const groups=new Map();for(const[k,c]of p.t){const e=parseKey(k),d=e[best];e[best]=0;if(!groups.has(d))groups.set(d,[]);groups.get(d).push([e,c]);}const degs=[...groups.keys()].sort((a,b)=>b-a);id=horner(new Poly(n,groups.get(degs[0])));for(let j=1;j<degs.length;j++)id=bin('add',bin('mul',id,power(best,degs[j-1]-degs[j])),horner(new Poly(n,groups.get(degs[j]))));if(degs.at(-1))id=bin('mul',id,power(best,degs.at(-1)));}
  memo.set(key,id);return id;}
 const outputs=polys.map(horner),scratch=new Float64Array(nodes.length);
 function evaluate(state,out=new Float64Array(outputs.length)){if(state.length!==n)throw new TypeError('Input dimension mismatch');for(let i=0;i<nodes.length;i++){const a=nodes[i];scratch[i]=a.op==='const'?a.value:a.op==='var'?state[a.index]:a.op==='add'?scratch[a.a]+scratch[a.b]:scratch[a.a]*scratch[a.b];}for(let i=0;i<outputs.length;i++){const v=scratch[outputs[i]];if(!Number.isFinite(v))throw new RangeError('Nonfinite arithmetic result');out[i]=v;}return out;}
 return {n,nodes,outputs,evaluate,operations:nodes.filter(n=>n.op==='add'||n.op==='mul').length};
}
export function relation(op,value){switch(op){case'>=':return value>=0;case'<=':return value<=0;case'>':return value>0;case'<':return value<0;case'==':return value===0;default:throw new TypeError('Unknown comparator');}}
export class ReducedRuntime {
 constructor(model){if(!model.success)throw new TypeError('Successful model needed');this.model=model;this.encoder=compilePolynomials(model.E);this.decoder=compilePolynomials(model.D);this.actions=new Map(model.actions.map(a=>[a.id,{...a,compiled:compilePolynomials(a.G),guardComp:a.guards.map(g=>compilePolynomials([g.poly]))}]));}
 encode(x){if([...x].some(v=>!Number.isFinite(v)))throw new TypeError('Nonfinite state');return this.encoder.evaluate(x);}
 observe(z){return this.decoder.evaluate(z);}
 enabled(z,action){const a=this.actions.get(action);if(!a)throw new Error(`Action not certified: ${action}`);return a.guards.every((g,i)=>relation(g.op,a.guardComp[i].evaluate(z)[0]));}
 advance(z,action){if(!this.enabled(z,action))return {status:'BLOCKED',reason:'guard-false'};return {status:'OK',state:this.actions.get(action).compiled.evaluate(z)};}
 predict(x,{steps=1,action,sequence}={}){if(!Number.isSafeInteger(steps)||steps<0||steps>1000000)throw new RangeError('Horizon budget');const ids=[...this.actions.keys()];if(!sequence&&!action){if(ids.length!==1)throw new Error('Choose an action or sequence for a multi-action model');action=ids[0];}const seq=sequence||Array(steps).fill(action);if(!Array.isArray(seq)||seq.length>1000000)throw new RangeError('Sequence budget');let z=this.encode(x);for(let i=0;i<seq.length;i++){const r=this.advance(z,seq[i]);if(r.status!=='OK')return {...r,at:i,action:seq[i]};z=r.state;}return {status:'OK',value:[...this.observe(z)],latent:[...z],steps:seq.length};}
}
/** Enumerates finite action sequences; no claim of discovering pruning or an optimal planner. */
export function enumeratePlans(runtime,x,{horizon=6,maxNodes=100000}={}){if(!Number.isSafeInteger(horizon)||horizon<0||horizon>25)throw new RangeError('Planning horizon budget');const ids=[...runtime.actions.keys()],leaves=[],stack=[{state:runtime.encode(x),path:[]}];let expanded=0,blocked=0;
 while(stack.length){const node=stack.pop();if(++expanded>maxNodes)return {status:'BUDGET',expanded,blocked,leaves};if(node.path.length===horizon){leaves.push({sequence:node.path,value:[...runtime.observe(node.state)]});continue;}for(const id of ids){const r=runtime.advance(node.state,id);if(r.status==='OK')stack.push({state:r.state,path:[...node.path,id]});else blocked++;}}
 return {status:'OK',expanded,blocked,leaves};}
function emitGraph(g,inputs,prefix){const lines=[],refs=[];g.nodes.forEach((node,i)=>{if(node.op==='const')refs[i]=String(node.value);else if(node.op==='var')refs[i]=inputs[node.index];else{refs[i]=prefix+i;lines.push(`const ${refs[i]} = ${refs[node.a]} ${node.op==='add'?'+':'*'} ${refs[node.b]};`);}});return {lines,outputs:g.outputs.map(i=>refs[i])};}
/** Generates a stand-alone batch kernel. The caller imports this module normally, not from SOP code. */
export function batchModule(E,G,D,{contractHash='uncertified',ring=false}={}){
 const n=E[0].n,k=E.length;const enc=emitGraph(compilePolynomials(E),Array.from({length:n},(_,i)=>`x${i}`),'e');const step=emitGraph(compilePolynomials(G),Array.from({length:k},(_,i)=>`z${i}`),'t');const dec=emitGraph(compilePolynomials(D),Array.from({length:k},(_,i)=>`z${i}`),'d');
 const source=[`// Generated arithmetic only. Source contract: ${contractHash}`,`export const inputDimension=${n};`,`export const stateDimension=${k};`,`export function predictBatch(data, count, horizon) {`,`if (!(data instanceof Float64Array) || !Number.isSafeInteger(count) || count<0 || data.length!==count*${n} || !Number.isSafeInteger(horizon) || horizon<0 || horizon>1000000) throw new TypeError('Invalid batch');`,`const output = new Float64Array(count*${D.length});`,`for(let row=0;row<count;row++){`,...Array.from({length:n},(_,i)=>`const x${i}=data[row*${n}+${i}];`),...enc.lines,...enc.outputs.map((r,i)=>`let z${i}=${r};`),`for(let time=0;time<horizon;time++){`,...step.lines,...step.outputs.map((r,i)=>`const next${i}=${r};`),...step.outputs.map((r,i)=>`z${i}=next${i};`),`}`,...dec.lines,...dec.outputs.map((r,i)=>`output[row*${D.length}+${i}]=${r};`),`}`,`for(const v of output) if(!Number.isFinite(v)) throw new RangeError('Nonfinite prediction');`,`return output;`,`}`].join('\n')+'\n';
 return {source,operations:{encoding:compilePolynomials(E).operations,step:compilePolynomials(G).operations,decoding:compilePolynomials(D).operations},dimension:k};
}

/** Mathematical exact replay (potentially expensive); no float64 guard decisions. */
export function predictExact(model,input,{steps=1,action,sequence}={}){
 if(!Number.isSafeInteger(steps)||steps<0||steps>4096)throw new RangeError('Exact replay horizon budget');if(input.length!==model.E[0].n)throw new TypeError('Input arity');const actions=new Map(model.actions.map(a=>[a.id,a]));if(!action&&!sequence){if(actions.size!==1)throw new Error('Choose exact replay action/sequence');action=model.actions[0].id;}const seq=sequence||Array(steps).fill(action);if(!Array.isArray(seq)||seq.length>4096)throw new RangeError('Exact sequence budget');
 let z=model.E.map(p=>p.evaluateExact(input));for(let i=0;i<seq.length;i++){const a=actions.get(seq[i]);if(!a)throw new Error('Uncertified action');for(const g of a.guards){const v=g.poly.evaluateExact(z);if(!relation(g.op,v.n<0n?-1:v.n>0n?1:0))return {status:'BLOCKED',at:i,action:seq[i]};}z=a.G.map(p=>p.evaluateExact(z));if(z.some(v=>v.n.toString().length+v.d.toString().length>100000))throw new RangeError('Exact replay coefficient-size budget');}
 return {status:'OK',value:model.D.map(p=>p.evaluateExact(z).toString()),latent:z.map(String),steps:seq.length,numericSemantics:'exact-rational'};
}
