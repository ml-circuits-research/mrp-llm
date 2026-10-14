/** Internal AST helpers. SOP is the only authored knowledge/command syntax. */
import {assert,stable} from './util.mjs';
export {variable} from './util.mjs';
import {variable} from './util.mjs';
// An integer place also takes a computed decimal: it is still a number (DS004 "Exact arithmetic").
export function atom(x,{ground=false,schema=null}={}){
 assert(x&&/^[a-z][a-z0-9_]{0,47}$/.test(x.p),'Invalid predicate');assert(Array.isArray(x.a)&&x.a.length>=1&&x.a.length<=4,'Arity must be 1..4');
 // Numbers are safe integers or finite decimals (DS004 "Exact arithmetic").
 assert(x.a.every(v=>Number.isSafeInteger(v)||Number.isFinite(v)&&!Number.isInteger(v)||typeof v==='string'&&v.length>0&&v.length<=256),'Terms must be strings, safe integers or decimals');
 assert(x.a.every(v=>typeof v!=='string'||!v.startsWith('?')||variable(v)),'Invalid logic variable');assert(!ground||x.a.every(v=>!variable(v)),'Ground fact required');
 if(schema){assert(Object.hasOwn(schema,x.p),'Unknown predicate '+x.p);assert(schema[x.p].arity===x.a.length,'Wrong arity for '+x.p);for(let i=0;i<x.a.length;i++){const t=schema[x.p].args?.[i];if(variable(x.a[i]))continue;if(t==='integer')assert(Number.isSafeInteger(x.a[i])||Number.isFinite(x.a[i]),'Number expected');else if(t&&t!=='value')assert(typeof x.a[i]==='string','Symbol expected');}}
 return {p:x.p,a:[...x.a],neg:x.neg===true};
}
export const atomKey=a=>stable(atom(a));
export function rule(x,schema=null){assert(x&&/^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(x.id),'Invalid rule ID');assert(Array.isArray(x.if)&&x.if.length>0&&x.if.length<=16,'Rule needs 1..16 conditions');const body=x.if.map(a=>atom(a,{schema})),head=atom(x.then,{schema});const bound=new Set(body.flatMap(a=>a.a.filter(variable)));assert(head.a.filter(variable).every(v=>bound.has(v)),'Unsafe head variable');inferVariableTypes([...body,head],schema);return {id:x.id,if:body,then:head};}

/** Types used to link local logical variables across predicate occurrences. */
/** `related(a, b)` (optional) tells that two role classes are one class and a subclass of it (country and place): the variable then has the more specific class. */
export function inferVariableTypes(atoms,schema=null,related=null){
 const types={};if(!schema)return types;
 for(const a of atoms)for(let i=0;i<a.a.length;i++){const name=a.a[i];if(!variable(name))continue;
  const next=schema[a.p]?.args?.[i]??'value',old=types[name];
  if(!old||old==='value'){types[name]=next;continue;}if(next==='value'||next===old)continue;
  if(old==='entity'&&next!=='integer'){types[name]=next;continue;}if(next==='entity'&&old!=='integer')continue;
  const sub=related?.(old,next);if(sub){if(sub==='next')types[name]=next;continue;}
  assert(false,'Incompatible types for '+name+': '+old+' and '+next);
 }return types;
}
