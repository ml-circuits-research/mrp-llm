/** Small, interpreted expression language with JavaScript spelling.
 * There is no eval(), Function(), vm context, dynamic import, or host-object call.
 * Every operation is dispatched below and charged to a finite budget.
 *
 * Bounded functional operations (proposal P-6, owner decision 2026-10-03): `range`, `sum`, `count`, `min`, `max` and the array
 * methods `map`, `filter`, `reduce`, `sort` (with a comparator) and `includes`. Their function arguments are pure arrow functions with
 * an expression body (`x => x * 2`, `(a, b) => a - b`): an arrow exists only as the argument of one of these operations, it has no name
 * and cannot be stored, returned or called directly, so there is no recursion; every call of its body is charged to the same operation
 * budget, and every whole-array step is charged per item. Recursion, graphs, paths and search belong to SOP rules and constraints.
 */
import {assert} from '../lib/util.mjs';
const bad=new Set(['__proto__','prototype','constructor','caller','callee','arguments']);
const infix={'??':1,'||':2,'&&':3,'===':4,'!==':4,'==':4,'!=':4,'<':5,'<=':5,'>':5,'>=':5,'+':6,'-':6,'*':7,'/':7,'%':7};
/** Names an arrow parameter may not take (callable names of the language and literal words). */
const RESERVED_PARAMS=new Set(['Math','String','Number','only','range','sum','count','min','max','true','false','null','undefined','eval','Function','globalThis','this']);
/** The callable vocabulary, for documentation and the capability inventory (tools/capabilities/inventory.mjs). */
export const EXPRESSION_FUNCTIONS=Object.freeze(['String','Number','only','range','sum','count','min','max']);
export const EXPRESSION_MATH=Object.freeze(['abs','min','max','floor','ceil','round','pow']);
export const EXPRESSION_STRING_METHODS=Object.freeze(['trim','toLowerCase','toUpperCase','normalize','slice','substring','includes','startsWith','endsWith','replaceAll','split']);
export const EXPRESSION_ARRAY_METHODS=Object.freeze(['slice','join','map','filter','reduce','sort','includes']);
/** Operations whose argument may be an arrow function, with the number of parameters the arrow may take. */
const HIGHER_ORDER={map:2,filter:2,reduce:3,sort:2,count:2};
export function tokenize(source){
 assert(typeof source==='string'&&source.length<=16384,'Expression length limit');
 const out=[];let i=0;
 while(i<source.length){const c=source[i];if(/\s/.test(c)){i++;continue;}
  if(c==='"'){let j=i+1,escape=false;for(;j<source.length;j++){if(!escape&&source[j]==='"')break;if(!escape&&source[j]==='\\')escape=true;else escape=false;}assert(j<source.length,'Unterminated string');out.push({kind:'literal',value:JSON.parse(source.slice(i,j+1))});i=j+1;continue;}
  const s=source.slice(i);let m;
  if((m=s.match(/^\$([A-Za-z][A-Za-z0-9_]*)/))){out.push({kind:'ref',value:m[1]});i+=m[0].length;continue;}
  if((m=s.match(/^\?([A-Za-z][A-Za-z0-9_]*)/))){out.push({kind:'var',value:'?'+m[1]});i+=m[0].length;continue;}
  if((m=s.match(/^(?:\d+\.\d+|\d+)(?:[eE][+-]?\d+)?/))){const n=Number(m[0]);assert(Number.isFinite(n),'Nonfinite number');out.push({kind:'literal',value:n});i+=m[0].length;continue;}
  if((m=s.match(/^[A-Za-z_][A-Za-z0-9_]*/))){const w=m[0];out.push(['true','false','null'].includes(w)?{kind:'literal',value:JSON.parse(w)}:{kind:'name',value:w});i+=w.length;continue;}
  const op=['===','!==','=>','<=','>=','==','!=','&&','||','??','+','-','*','/','%','<','>','!','?',':','(',')','[',']','{','}',',','.'].find(v=>s.startsWith(v));assert(op,'Unsupported expression token near '+s.slice(0,32));out.push({kind:op,value:op});i+=op.length;
  assert(out.length<=4096,'Too many expression tokens');
 }out.push({kind:'eof'});return out;
}
export function parseExpression(source){
 const ts=tokenize(source);let i=0,nodes=0;const node=o=>{assert(++nodes<=2048,'Expression node limit');return o;};
 const peek=()=>ts[i],take=k=>{assert(peek().kind===k,'Expected '+k+', got '+peek().kind);return ts[i++];};
 // An arrow starts here: `x =>`, `() =>` or `(a, b) =>` (names only between the parentheses).
 function arrowAhead(){
  if(peek().kind==='name')return ts[i+1].kind==='=>';
  if(peek().kind!=='(')return false;
  let j=i+1;if(ts[j].kind===')')return ts[j+1].kind==='=>';
  for(;;){if(ts[j].kind!=='name')return false;j++;if(ts[j].kind===')')return ts[j+1].kind==='=>';if(ts[j].kind!==',')return false;j++;}
 }
 function arrow(depth){
  const params=[];
  if(peek().kind==='name')params.push(ts[i++].value);
  else{take('(');if(peek().kind!==')'){do{params.push(take('name').value);if(peek().kind!==',')break;i++;}while(true);}take(')');}
  take('=>');
  for(const p of params){assert(!bad.has(p)&&!RESERVED_PARAMS.has(p),'Arrow parameter name not allowed: '+p);}
  assert(new Set(params).size===params.length,'Duplicate arrow parameter');
  assert(params.length<=3,'An arrow function takes at most 3 parameters');
  assert(peek().kind!=='{','Arrow functions take an expression body, not a block of statements');
  return node({type:'arrow',params,body:expression(0,depth+1)});
 }
 function primary(depth){assert(depth<=64,'Expression depth limit');let x,t=peek();
  if(arrowAhead())return arrow(depth);
  if(t.kind==='literal'||t.kind==='ref'||t.kind==='var'||t.kind==='name'){i++;x=node({type:t.kind,value:t.value});}
  else if(t.kind==='!'||t.kind==='-'){i++;x=node({type:'unary',op:t.kind,arg:primary(depth+1)});}
  else if(t.kind==='('){i++;x=expression(0,depth+1);take(')');}
  else if(t.kind==='['){i++;const items=[];if(peek().kind!==']'){do{items.push(expression(0,depth+1));if(peek().kind!==',')break;i++;}while(true);}take(']');x=node({type:'array',items});}
  else if(t.kind==='{'){i++;const entries=[];if(peek().kind!=='}'){do{const k=ts[i++];assert(k.kind==='name'||k.kind==='literal'&&typeof k.value==='string','Object keys must be names or strings');assert(!bad.has(k.value),'Forbidden object key');take(':');entries.push([k.value,expression(0,depth+1)]);if(peek().kind!==',')break;i++;}while(true);}take('}');x=node({type:'object',entries});}
  else throw Error('Expected expression, got '+t.kind);
  for(;;){if(peek().kind==='.'){i++;const k=take('name').value;assert(!bad.has(k),'Forbidden property');x=node({type:'member',object:x,key:{type:'literal',value:k}});}
   else if(peek().kind==='['){i++;const k=expression(0,depth+1);take(']');x=node({type:'member',object:x,key:k});}
   else if(peek().kind==='('){i++;const args=[];if(peek().kind!==')'){do{args.push(expression(0,depth+1));if(peek().kind!==',')break;i++;}while(true);}take(')');x=node({type:'call',callee:x,args});}
   else break;
  }return x;
 }
 function expression(min,depth){let left=primary(depth);while(peek().kind in infix&&infix[peek().kind]>=min){const op=ts[i++].kind;left=node({type:'binary',op,left,right:expression(infix[op]+1,depth+1)});}if(min===0&&peek().kind==='?'){i++;const yes=expression(0,depth+1);take(':');left=node({type:'conditional',test:left,yes,no:expression(0,depth+1)});}return left;}
 const ast=expression(0,0);take('eof');return ast;
}
export function expressionRefs(ast){const out=new Set();(function walk(n){if(!n||typeof n!=='object')return;if(n.type==='ref')out.add(n.value);for(const v of Object.values(n))if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);})(ast);return [...out];}
export function evaluateExpression(ast,{refs={},variables={},maxOps=10000,maxBytes=65536,maxItems=4096}={}){
 let ops=0;const charge=k=>{ops+=k;assert(ops<=maxOps,'Expression operation budget');};
 const bound=v=>{if(typeof v==='string')assert(Buffer.byteLength(v)<=maxBytes,'String output budget');if(Array.isArray(v))assert(v.length<=maxItems,'Array output budget');if(typeof v==='number')assert(Number.isFinite(v),'Nonfinite result');return v;};
 const own=(v,k)=>{assert(!bad.has(String(k)),'Forbidden property');if((typeof v==='string'||Array.isArray(v))&&k==='length')return v.length;assert(v!==null&&typeof v==='object'||typeof v==='string','Cannot index this value');assert(Object.hasOwn(Object(v),k),'Missing own property '+k);return bound(v[k]);};
 const math=new Set(EXPRESSION_MATH);
 const methods=new Set([...EXPRESSION_STRING_METHODS,...EXPRESSION_ARRAY_METHODS]);
 // A scope is a chain {vars: Map, parent} of arrow parameters; the root has none. Names never reach a host global.
 const lookup=(scope,name)=>{for(let s=scope;s;s=s.parent)if(s.vars.has(name))return s.vars.get(name);throw Error('No global values in jsEval: '+name);};
 // An arrow argument is kept as a closure over its scope; nothing else may hold one.
 // Closures are registered here, so a data value shaped like one (from a $reference) is never taken for a function.
 const closures=new WeakSet();
 const arg=(n,scope)=>{if(n.type!=='arrow')return e(n,scope);charge(1);const f={closure:n,scope};closures.add(f);return f;};
 const isFn=v=>v!==null&&typeof v==='object'&&closures.has(v);
 const apply=(f,args,max)=>{assert(f.closure.params.length<=max,'This operation passes at most '+max+' arguments to its function');const vars=new Map(f.closure.params.map((p,k)=>[p,args[k]]));return e(f.closure.body,{vars,parent:f.scope});};
 const primitive=v=>['number','string','boolean'].includes(typeof v)||v===null;
 const numbers=(v,what)=>{assert(Array.isArray(v)&&v.every(x=>typeof x==='number'),what+' requires an array of numbers');charge(v.length);return v;};
 function sorted(v,f){
  // A stable merge sort; every comparator call is charged, a comparator must return a finite number.
  const cmp=(a,b)=>{const r=apply(f,[a,b],2);assert(typeof r==='number'&&Number.isFinite(r),'sort comparator must return a number');return r;};
  const rec=xs=>{if(xs.length<2)return xs;const m=xs.length>>1,a=rec(xs.slice(0,m)),b=rec(xs.slice(m)),out=[];let i=0,j=0;while(i<a.length&&j<b.length)out.push(cmp(b[j],a[i])<0?b[j++]:a[i++]);while(i<a.length)out.push(a[i++]);while(j<b.length)out.push(b[j++]);return out;};
  return rec(v.slice());
 }
 function call(n,scope){
  const args=n.args.map(x=>arg(x,scope));assert(args.length<=32,'Too many arguments');
  if(n.callee.type==='name'){const name=n.callee.value;
   const fnArgs=args.filter(isFn);assert(!fnArgs.length||name==='count','A function is allowed only as the argument of map, filter, reduce, sort or count');
   if(name==='only'){assert(args.length===1&&Array.isArray(args[0])&&args[0].length===1,'only() requires exactly one result; clarify missing or ambiguous data');return args[0][0];}
   if(name==='range'){assert(args.length>=1&&args.length<=2&&args.every(Number.isSafeInteger),'range(n) or range(start, end) takes integers');const [a,b]=args.length===1?[0,args[0]]:args;const len=Math.max(0,b-a);assert(len<=maxItems,'Array output budget');charge(len);return Array.from({length:len},(_,k)=>a+k);}
   if(name==='sum'){assert(args.length===1,'sum(array) takes one array');return bound(numbers(args[0],'sum').reduce((s,x)=>s+x,0));}
   if(name==='min'||name==='max'){assert(args.length===1,name+'(array) takes one array; Math.'+name+' takes numbers');const v=numbers(args[0],name);assert(v.length>0,name+'() of an empty array');return bound(name==='min'?Math.min(...v):Math.max(...v));}
   if(name==='count'){assert(args.length>=1&&args.length<=2&&Array.isArray(args[0]),'count(array) or count(array, x => test)');charge(args[0].length);if(args.length===1)return args[0].length;assert(isFn(args[1]),'count takes a function as its second argument');let k=0;args[0].forEach((x,i)=>{if(apply(args[1],[x,i],2))k++;});return k;}
   assert(['String','Number'].includes(name),'Only '+EXPRESSION_FUNCTIONS.join('/')+' are callable');assert(args.length===1&&['number','boolean','string'].includes(typeof args[0]),'Primitive conversion expected');return bound(name==='String'?String(args[0]):Number(args[0]));}
  assert(n.callee.type==='member','Unsupported call');const key=e(n.callee.key,scope);assert(typeof key==='string'&&!bad.has(key),'Invalid method');
  if(n.callee.object.type==='name'&&n.callee.object.value==='Math'){assert(math.has(key)&&args.length>0&&args.every(x=>typeof x==='number'),'Math operation not allowed');return bound(Math[key](...args));}
  assert(methods.has(key),'Method not allowed: '+key);const v=e(n.callee.object,scope);
  const fnArgs=args.filter(isFn);assert(!fnArgs.length||Object.hasOwn(HIGHER_ORDER,key)&&Array.isArray(v),'A function is allowed only as the argument of map, filter, reduce, sort or count');
  if(Array.isArray(v)&&Object.hasOwn(HIGHER_ORDER,key)){
   charge(v.length);
   if(key==='map'){assert(args.length===1&&isFn(args[0]),'map takes one function');return bound(v.map((x,i)=>bound(apply(args[0],[x,i],2))));}
   if(key==='filter'){assert(args.length===1&&isFn(args[0]),'filter takes one function');return v.filter((x,i)=>apply(args[0],[x,i],2));}
   if(key==='sort'){assert(args.length===1&&isFn(args[0]),'sort takes a comparator function (a, b) => a - b');return sorted(v,args[0]);}
   if(key==='reduce'){assert((args.length===1||args.length===2)&&isFn(args[0])&&!isFn(args[1]),'reduce takes a function and an initial value');assert(args.length===2||v.length>0,'reduce of an empty array needs an initial value');
    let acc=args.length===2?args[1]:v[0];for(let i=args.length===2?0:1;i<v.length;i++)acc=bound(apply(args[0],[acc,v[i],i],3));return acc;}
  }
  if(key==='includes'&&Array.isArray(v)){assert(args.length===1&&primitive(args[0]),'includes takes one number, string or yes/no value');charge(v.length);return v.includes(args[0]);}
  if(key==='join'){assert(Array.isArray(v)&&v.every(x=>['string','number','boolean'].includes(typeof x))&&args.length<=1&&(args[0]===undefined||typeof args[0]==='string'),'join requires primitive array');charge(v.length);const size=v.reduce((s,x)=>s+String(x).length,0)+(args[0]?.length??1)*v.length;assert(size<=maxBytes,'join output budget');return bound(v.join(args[0]));}
  if(key==='slice'&&Array.isArray(v)){assert(args.length<=2&&args.every(Number.isSafeInteger),'Integer indices expected');charge(v.length);return bound(v.slice(...args));}
  assert(typeof v==='string','String method requires string');
  if(['trim','toLowerCase','toUpperCase'].includes(key)){assert(!args.length,'Method takes no arguments');return bound(String.prototype[key].call(v));}
  if(key==='normalize'){assert(args.length<=1&&['NFC','NFD','NFKC','NFKD',undefined].includes(args[0]),'Invalid normalization');return bound(v.normalize(args[0]));}
  if(['slice','substring'].includes(key)){assert(args.length<=2&&args.every(Number.isSafeInteger),'Integer indices expected');return bound(String.prototype[key].call(v,...args));}
  if(['includes','startsWith','endsWith'].includes(key)){assert(args.length===1&&typeof args[0]==='string','One string expected');return v[key](args[0]);}
  if(key==='replaceAll'){assert(args.length===2&&args.every(x=>typeof x==='string'),'Literal replacement only');const max=(v.length+1)*(args[1].length+1)+v.length;assert(max<=maxBytes*8,'Replacement allocation budget');return bound(v.replaceAll(...args));}
  if(key==='split'){assert(args.length===1&&typeof args[0]==='string','Literal delimiter expected');const r=v.split(args[0],maxItems+1);return bound(r);}
  throw Error('Unknown operation');
 }
 function e(n,scope=null){charge(1);switch(n.type){
  case 'literal':return bound(n.value);case 'ref':assert(Object.hasOwn(refs,n.value),'Unknown value $'+n.value);return bound(refs[n.value]);case 'var':assert(Object.hasOwn(variables,n.value),'Unbound '+n.value);return bound(variables[n.value]);
  case 'name':return lookup(scope,n.value);
  case 'arrow':throw Error('A function is allowed only as the argument of map, filter, reduce, sort or count');
  case 'array':return bound(n.items.map(x=>e(x,scope)));case 'object':{const o=Object.create(null);for(const [k,v]of n.entries)o[k]=e(v,scope);return o;}
  case 'member':return own(e(n.object,scope),e(n.key,scope));case 'call':return call(n,scope);
  case 'conditional':return e(n.test,scope)?e(n.yes,scope):e(n.no,scope);
  case 'unary':{const v=e(n.arg,scope);if(n.op==='!')return !v;assert(typeof v==='number','Unary minus needs number');return bound(-v);}
  case 'binary':{const l=e(n.left,scope);if(n.op==='&&')return l&&e(n.right,scope);if(n.op==='||')return l||e(n.right,scope);if(n.op==='??')return l??e(n.right,scope);const r=e(n.right,scope);
   if(['==','==='].includes(n.op))return l===r;if(['!=','!=='].includes(n.op))return l!==r;
   if(['<','<=','>','>='].includes(n.op)){assert(typeof l===typeof r&&['number','string'].includes(typeof l),'Comparison types differ');return {'<':l<r,'<=':l<=r,'>':l>r,'>=':l>=r}[n.op];}
   if(n.op==='+'&&typeof l==='string'&&typeof r==='string'){assert(l.length+r.length<=maxBytes,'Concatenation budget');return l+r;}
   assert(typeof l==='number'&&typeof r==='number','Arithmetic requires numbers');let v;switch(n.op){case '+':v=l+r;break;case '-':v=l-r;break;case '*':v=l*r;break;case '/':v=l/r;break;case '%':v=l%r;break;default:throw Error('Unknown binary op');}return bound(v);}
  default:throw Error('Unknown expression node');
 }}
 const value=e(ast);assert(!isFn(value),'A function is allowed only as the argument of map, filter, reduce, sort or count');assert(Buffer.byteLength(JSON.stringify(value)??'null')<=maxBytes,'Expression serialized output budget');return {value,operations:ops};
}
export function runExpression(text,options){return evaluateExpression(parseExpression(text),options);}
