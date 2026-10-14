/** Output ports belong to one solve wire. Logical variables remain local.
 * Declaring `output ?x one` reserves @x; it does NOT assert a value for x.
 */
import {assert,stable} from '../lib/util.mjs';
import {OUTPUT_MODES} from './enums.mjs';
export function outputSpecs(wire) {
  if (!['solve','abduce','diagnose','associate','induce','analogize','plan','simulate','temporal'].includes(wire.type)) return [];
  return (wire.fields.output ?? []).map(text => {
    const match = text.match(/^\?([A-Za-z][A-Za-z0-9_]*)(?:\s+(\S+))?$/);
    assert(match && (match[2] === undefined || OUTPUT_MODES.includes(match[2])), 'output syntax: ?name [' + OUTPUT_MODES.join('|') + ']');
    assert(!['constructor','prototype','__proto__'].includes(match[1]), 'Reserved output name');
    return {name:match[1], variable:'?'+match[1], mode:match[2]??'one', owner:wire.id};
  });
}
export function outputRegistry(program, {allowMaterialized=false}={}) {
  const outputs = new Map(), defined=new Map(program.wires.map(w=>[w.id,w]));
  for (const wire of program.wires) for (const spec of outputSpecs(wire)) {
    assert(!outputs.has(spec.name),'Multiple producers for output ?'+spec.name);
    const existing=defined.get(spec.name);
    assert(!existing || (allowMaterialized && existing.type==='binding' && existing.fields.owner?.[0]===spec.owner),
      'Output ?'+spec.name+' conflicts with an explicit @'+spec.name);
    outputs.set(spec.name,spec);
  }
  return outputs;
}
/** Materialize only permitted cardinalities. No arbitrary first answer. */
export function selectOutput(result, {variable,mode}) {
  const base={valueType:result.kind==='constraint'?'integer':result.query?.variableTypes?.[variable]??'value',complete:result.complete===true, sourceStatus:result.status,
    ...(result.hypothetical?{hypothetical:true}:{}),assurance:'Result relative to admitted facts and the explored memory view, not a probability.'};
  if (mode==='status') return {...base,status:'bound',value:result.status};
  if (['unsupported','inconsistent','both','mixed_temporal'].includes(result.status))
    return {...base,status:result.status};
  if (!result.complete) return {...base,status:'incomplete'};
  if (mode==='count') {
    assert(result.kind==='count','count output requires a count query');
    return {...base,status:'bound',value:result.count};
  }
  if (result.kind==='constraint') {
    const item=result.outputProjection?.[variable];
    return item ? {...base,...item} : {...base,status:'unsupported_projection'};
  }
  if(result.outputProjection?.[variable]) return {...base,...result.outputProjection[variable]};
  assert(result.query,'A relational output needs a query result');
  if (mode==='rows') return {...base,status:'bound',value:result.answers.map(r=>({...r.binding}))};
  assert(result.query.select.includes(variable),'Output '+variable+' is not selected by the query');
  // A selected candidate with explicit contrary evidence is not silently accepted.
  if ((result.conflictedAnswers??[]).length) return {...base,status:'conflict'};
  const values=[...new Map(result.answers.map(r=>[stable(r.binding[variable]),r.binding[variable]])).values()];
  if (mode==='many') return {...base,status:'bound',value:values};
  return values.length===1 ? {...base,status:'bound',value:values[0]} :
    {...base,status:values.length?'ambiguous':'no_answer',candidates:values.length};
}
