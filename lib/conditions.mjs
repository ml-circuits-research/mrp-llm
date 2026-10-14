import {variable} from './types.mjs';

/** A query's top-level conditions are implicitly conjoined. */
export function conditionAtoms(conditions) {
 const atoms=[];
 const visit=condition=>{
  if(condition.kind==='all'||condition.kind==='any')for(const child of condition.children)visit(child);
  else atoms.push(condition);
 };
 for(const condition of conditions)visit(condition);
 return atoms;
}
/** Render one native condition block, leaving declaration-level indentation to the caller. */
export function emitCondition(condition,emitLeaf) {
 const lines=[];
 const visit=(node,depth)=>{
  const indent='  '.repeat(depth);
  if(node.kind!=='all'&&node.kind!=='any'){lines.push(indent+emitLeaf(node));return;}
  lines.push(indent+node.kind);
  for(const child of node.children)visit(child,depth+1);
  lines.push(indent+'end');
 };
 visit(condition,0);
 return lines.join('\n');
}


/** Variables bound on every successful route through these conditions. */
export function definitelyBound(conditions) {
 const bound=condition=>{
  if(condition.kind==='any'){
   const [first,...rest]=condition.children;
   const common=bound(first);
   for(const child of rest){const available=bound(child);for(const name of common)if(!available.has(name))common.delete(name);}
   return common;
  }
  if(condition.kind==='all')return allBound(condition.children);
  return new Set(condition.a.filter(variable));
 };
 const allBound=items=>{const result=new Set();for(const item of items)for(const name of bound(item))result.add(name);return result;};
 return allBound(conditions);
}
