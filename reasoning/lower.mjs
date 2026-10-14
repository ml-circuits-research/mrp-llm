/** First-class epistemic objects. A hypothesis/pattern is NEVER a fact. */
import {one,many,words,unquote} from '../sop/parser.mjs';
import {resolveAtom} from '../sop/lower.mjs';
import {rule,variable,inferVariableTypes} from '../lib/types.mjs';
import {interval,instant} from '../lib/time.mjs';
import {assert} from '../lib/util.mjs';
export const DECLARATIONS=new Set(['pattern','hypothesis','action','goal','trace','policy','theory']);
export const OPERATIONS=new Set(['abduce','diagnose','associate','induce','analogize','plan','simulate','temporal']);
export const LIBRARY_TYPES=new Set(['rule','template','procedure','pattern','hypothesis','action','goal','trace','policy','theory']);
export function lowerDeclaration(w,values={},schema=null){
 const atoms=(k,ground=false)=>many(w,k).map(s=>resolveAtom(s,values,schema,{ground}));
 const common={kind:w.type,id:w.id,source:unquote(one(w,'source','provided'))};
 const number=(key,fallback,min=0,max=Number.MAX_SAFE_INTEGER)=>{const x=Number(one(w,key,String(fallback)));assert(Number.isFinite(x)&&x>=min&&x<=max,'Invalid '+key);return x;};
 switch(w.type){
 case 'pattern':{const candidate=rule({id:w.id,if:atoms('when'),then:resolveAtom(one(w,'then'),values,schema)},schema);const status=one(w,'status','candidate');assert(['candidate','validated','rejected'].includes(status),'Invalid pattern status');return {...common,...candidate,kind:'pattern',status,support:number('support',0,0,1),coverage:number('coverage',0,0,1),samples:number('samples',0),counterexamples:number('counterexamples',0),scoreMeaning:'empirical support, not probability or logical implication'};}
 case 'hypothesis':{const assumptions=[...(w.fields.holds?[resolveAtom(one(w,'holds'),values,schema,{ground:true})]:[]),...atoms('assume',true)];const status=one(w,'status','untested');assert(['untested','supported','rejected'].includes(status),'Invalid hypothesis status');return {...common,assumptions,cost:number('cost',1),status};}
 case 'action':{const requires=atoms('requires'),adds=atoms('adds'),removes=atoms('removes'),params=words(one(w,'params',''));assert(params.every(variable)&&new Set(params).size===params.length,'Unique ?params required');const bound=new Set(requires.flatMap(a=>a.a.filter(variable)));assert(params.every(v=>bound.has(v)),'Action parameters must occur in preconditions');assert([...adds,...removes].flatMap(a=>a.a.filter(variable)).every(v=>bound.has(v)),'Action effects must be range-restricted');inferVariableTypes([...requires,...adds,...removes],schema);return {...common,params,requires,adds,removes,cost:number('cost',1),valid:interval(one(w,'valid','timeless'))};}
 case 'goal':return {...common,where:atoms('where')};
 case 'trace':{const closed=one(w,'closed','false');assert(['true','false'].includes(closed),'trace closed must be true/false');return {...common,text:unquote(one(w,'text','')),features:atoms('feature',true),closed:closed==='true',knownAt:w.fields.known?instant(one(w,'known')):null};}
 case 'policy':{const limits={};for(const key of Object.keys(w.fields)){const n=number(key,0,1,10000000);assert(Number.isSafeInteger(n),'Integer budget expected');limits[key]=n;}return {...common,limits};}
 case 'theory':return {...common,dialect:unquote(one(w,'dialect')),body:one(w,'body'),required:true};
 default:throw Error('Not a declarative research wire: '+w.type);
 }
}
