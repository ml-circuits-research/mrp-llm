/** Parse -> validate -> typed objects. Only these objects reach solvers. */
import {one,many,parseAtom,scalar,words,unquote,sampledOrder} from './parser.mjs';
import {parseExpression,evaluateExpression} from './expression.mjs';
import {atom,rule,variable,inferVariableTypes} from '../lib/types.mjs';
import {interval,instant} from '../lib/time.mjs';
import {assert} from '../lib/util.mjs';
import {ENUMS,ORDER_SAMPLING_MODES} from './enums.mjs';
import {parseCondition,parseBooleanCondition,isWordForm,wordsToExpression} from './conditions.mjs';
import {conditionAtoms,definitelyBound} from '../lib/conditions.mjs';
export function resolveAtom(text,values={},schema=null,{ground=false,absence=false}={}){const a=parseAtom(text,{absence});a.a=a.a.map(v=>v&&typeof v==='object'&&v.ref?scalar('$'+v.ref,values):v);const result=atom(a,{ground,schema});return a.neg==='absent'?{...result,neg:'absent'}:result;}
export function lowerFact(w,values={},schema=null){return {kind:'fact',atom:resolveAtom(one(w,'holds'),values,schema,{ground:true}),valid:interval(one(w,'valid')),source:unquote(one(w,'source','user')),quote:unquote(one(w,'quote','')),retention:one(w,'retention','normal')};}
export function lowerRule(w,values={},schema=null){const r=rule({id:w.id,if:many(w,'when').map(x=>resolveAtom(x,values,schema)),then:resolveAtom(one(w,'then'),values,schema)},schema);return {...r,kind:'rule',mode:one(w,'mode','logical'),source:unquote(one(w,'source','approved-library')),valid:interval(one(w,'valid','timeless'))};}
export function lowerQuery(w,values={},schema=null,{now=Date.now(),related=null}={}){
 const where=many(w,'where').map(s=>parseCondition(s,leaf=>resolveAtom(leaf,values,schema,{absence:true})));const selected=words(one(w,'select',''));assert(selected.every(variable),'select contains only ?variables');
 const kind=one(w,'mode',selected.length?'select':'exists');assert(ENUMS.query.mode.includes(kind),'Invalid query mode');if(kind==='select')assert(selected.length>0,'select mode needs variables');
 // `scope` (mode every) is checked for each binding of the `where` restriction; `span` names the validity interval.
 const scope=w.fields.scope?[parseCondition(one(w,'scope'),leaf=>resolveAtom(leaf,values,schema,{absence:true}))]:undefined;
 const span=one(w,'span');if(span!==undefined)assert(variable(span),'span takes one ?variable');
 const measure=one(w,'measure');if(measure!==undefined){assert(ENUMS.query.measure.includes(measure),'Invalid time measure');assert(span!==undefined&&selected.length===1&&selected[0]===span,'measure needs the selected span variable');}
 const bound=definitelyBound(where);if(span)bound.add(span);if(w.fields.order&&!sampledOrder(w)){const [a,,b]=words(one(w,'order'));bound.add(a);bound.add(b);}assert(selected.every(v=>bound.has(v)),'Unbound selected variable: every alternative must bind selected variables');
 const absences=conditionAtoms([...where,...(scope??[])]).filter(a=>a.neg==='absent');
 for(const a of absences)assert(schema?.[a.p]?.closed===true,'absent_needs_closed: '+a.p+' is not declared closed true in the retained view');
 const closed=[...new Map(absences.map(a=>[a.p,{id:a.p,args:schema[a.p].valueTypes ?? schema[a.p].args}])).values()];
 const filters=many(w,'filter').map(parseBooleanCondition);const varsIn=n=>{if(!n||typeof n!=='object')return [];return [...(n.type==='var'?[n.value]:[]),...Object.values(n).flatMap(v=>Array.isArray(v)?v.flatMap(varsIn):varsIn(v))];};for(const f of filters)assert(varsIn(f).every(v=>bound.has(v)),'Unbound filter variable');
 // Words-only fields (DS014): `except ?x "v"` is the filter ?x != "v"; `compare`, `rank`, `quantifier` and
 // `order` are evaluated by the reasoner with numeric coercion (a value it cannot read as a number is not computable).
 for(const line of many(w,'except')){const [name,value]=words(line);assert(bound.has(name),'Unbound except variable');filters.push(parseBooleanCondition(name+' != '+value));}
 const term=token=>variable(token)?token:/^-?\d+$/.test(token)?Number(token):scalar(token,values);
 const compares=many(w,'compare').map(text=>parseCondition(text,line=>{const [left,op,right]=words(line);assert(bound.has(left)&&(!variable(right)||bound.has(right)),'Unbound compare variable');return {left,op,right:term(right)};}));
 const rank=w.fields.rank?(([direction,name,cut,n])=>{assert(bound.has(name),'Unbound rank variable');return {direction,variable:name,...(cut?{cut,n:Number(n)}:{})};})(words(one(w,'rank'))):undefined;
 const quantifier=w.fields.quantifier?(([word,count])=>({word,...(count?{count:Number(count)}:{})}))(words(one(w,'quantifier'))):undefined;
 // `order random` (ORDER_SAMPLING): the answers in a seeded random order, cut by limit; the seed is the turn time.
 const sample=sampledOrder(w)?{order:sampledOrder(w),seed:now}:undefined;
 if(sample)assert(ORDER_SAMPLING_MODES.includes(kind),'order_random_mode: order random samples the answers of mode '+ORDER_SAMPLING_MODES.join('|')+', not mode '+kind);
 const order=w.fields.order&&!sample?(parts=>{assert(parts.length===6,'order needs the host leaves; a model order is compiled by the host (sop/declarative.mjs)');return {left:parts[0],relation:parts[1],right:parts[2],leaves:[Number(parts[4]),Number(parts[5])]};})(words(one(w,'order'))):undefined;
 assert(!w.fields.fragment,'fragment_needs_context: a follow-up fragment is completed by the host from the conversation before execution');
 const limit=Number(one(w,'limit','100'));assert(Number.isSafeInteger(limit)&&limit>=1&&limit<=10000,'Invalid result limit');
 // A time question without at/during looks at the whole timeline rather than at the present instant.
 const time=w.fields.during?{during:interval(one(w,'during'))}:w.fields.at||(!span&&!order)?{at:one(w,'at')?instant(scalar(one(w,'at'),values)):now}:{during:{from:-Infinity,until:Infinity}};
 const asof=one(w,'asof')?instant(scalar(one(w,'asof'),values)):now;
 return {kind:'query',variableTypes:inferVariableTypes(conditionAtoms([...where,...(scope??[])]),schema,related),mode:kind,where,...(scope?{scope}:{}),...(closed.length?{closed}:{}),...(span?{span}:{}),...(measure?{measure}:{}),select:selected,filters,...(compares.length?{compares}:{}),...(rank?{rank}:{}),...(quantifier?{quantifier}:{}),...(order?{order}:{}),...(sample?{sample}:{}),limit,...time,asof,...(measure==="duration"?{now}:{})};
}
function numericAST(n,vars,values,type){
 if(n.type==='ref')return numericAST({type:'literal',value:values[n.value]},vars,values,type);
 if(n.type==='literal'){assert(type==='Int'&&Number.isSafeInteger(n.value),'Integer expression expected');return n.value;}
 if(n.type==='var'){assert(type==='Int'&&Object.hasOwn(vars,n.value.slice(1)),'Undeclared variable '+n.value);return n.value.slice(1);}
 if(n.type==='unary'){if(n.op==='-')return {op:'sub',a:[0,numericAST(n.arg,vars,values,'Int')]};assert(type==='Bool'&&n.op==='!','Unsupported unary constraint');return {op:'not',a:[numericAST(n.arg,vars,values,'Bool')]};}
 assert(n.type==='binary','Constraints support integer linear arithmetic and Boolean combinations');
 const map={'+':['add','Int','Int'],'-':['sub','Int','Int'],'*':['mul','Int','Int'],'===':['eq','Int','Bool'],'==':['eq','Int','Bool'],'!==':['ne','Int','Bool'],'!=':['ne','Int','Bool'],'<':['lt','Int','Bool'],'<=':['le','Int','Bool'],'>':['gt','Int','Bool'],'>=':['ge','Int','Bool'],'&&':['and','Bool','Bool'],'||':['or','Bool','Bool']};
 const spec=map[n.op];assert(spec&&spec[2]===type,'Unsupported constraint operator/type '+n.op);const a=[numericAST(n.left,vars,values,spec[1]),numericAST(n.right,vars,values,spec[1])];if(spec[0]==='mul')assert(a.some(Number.isSafeInteger),'Only constant multiplication is in the portable constraint profile');return {op:spec[0],a};
}
export function lowerConstraint(w,values={}){
 const vars={};for(const l of many(w,'var')){const p=words(l);assert((p.length===2||p.length===4)&&/^\?[a-z][a-z0-9_]*$/.test(p[0])&&p[1]==='int','var ?name int [min max]');const name=p[0].slice(1);assert(!Object.hasOwn(vars,name),'Duplicate constraint variable');vars[name]={sort:'Int'};if(p.length===4){const min=Number(scalar(p[2],values)),max=Number(scalar(p[3],values));assert(Number.isSafeInteger(min)&&Number.isSafeInteger(max)&&min<=max,'Invalid finite domain');Object.assign(vars[name],{min,max});}}
 const selected=words(one(w,'select',''));assert(selected.every(v=>variable(v)&&Object.hasOwn(vars,v.slice(1)))&&new Set(selected).size===selected.length,'select needs distinct declared constraint variables');
 // Arithmetic (DS014 Q-LANG-7): `require ?v equal 2380 times 19` fixes ?v to the computed value, so the model never
 // chooses a domain for a computed number; an integer result is required (a fraction is not computable).
 const ground=n=>n.type==='literal'?Number.isSafeInteger(n.value):n.type==='binary'&&['+','-','*'].includes(n.op)&&ground(n.left)&&ground(n.right)||n.type==='unary'&&n.op==='-'&&ground(n.arg);
 for(const text of many(w,'require')){const ast=parseBooleanCondition(text);if(ast.type==='binary'&&['==','==='].includes(ast.op)&&ast.left.type==='var'&&Object.hasOwn(vars,ast.left.value.slice(1))&&ground(ast.right)){const value=evaluateExpression(ast.right).value;assert(Number.isSafeInteger(value),'Integer arithmetic expected');const v=vars[ast.left.value.slice(1)];assert(v.min===undefined||(value>=v.min&&value<=v.max),'Computed value outside the declared domain');Object.assign(v,{min:value,max:value});}}
 const convert=s=>numericAST(parseBooleanCondition(s),vars,values,'Bool');const task=one(w,'task','prove');assert(ENUMS.constraint.task.includes(task),'constraint task must be prove, possible or optimize');
 const objectiveText=one(w,'objective');const objective=w.fields.objective?numericAST(parseExpression(isWordForm(objectiveText)?wordsToExpression(objectiveText,{comparator:false}):objectiveText),vars,values,'Int'):undefined;const direction=one(w,'direction','min');assert(ENUMS.constraint.direction.includes(direction),'objective direction must be min or max');assert(task!=='optimize'||objective!==undefined,'optimize needs objective');assert(task==='optimize'||objective===undefined,'objective requires task optimize');
 return {kind:'constraint',vars,...(selected.length?{select:selected}:{}),...(objective===undefined?{}:{objective,direction}),constraints:many(w,'require').map(convert),claim:w.fields.claim?convert(one(w,'claim')):{op:'eq',a:[0,0]},task,unit:one(w,'unit','scalar')};
}
