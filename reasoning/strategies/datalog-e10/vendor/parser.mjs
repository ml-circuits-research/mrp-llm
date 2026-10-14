// VENDORED: copied verbatim from sop_reasoner_e10.zip (sop-verified-reasoner 0.3.0) src/parser.mjs
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {term, variable, vars} from './terms.mjs';

function tokens(line) {
  const out=[]; let i=0;
  while(i<line.length) {
    if(/\s/.test(line[i])) {i++;continue;}
    if(line[i]==='#') break;
    if(line[i]==='"') {
      const start=i++; let escaped=false,closed=false;
      for(;i<line.length;i++) {
        if(!escaped && line[i]==='"') {i++;closed=true;break;}
        if(!escaped && line[i]==='\\') escaped=true; else escaped=false;
      }
      if(!closed) throw new SyntaxError('Unclosed string');
      out.push(line.slice(start,i));
    } else {
      const start=i; while(i<line.length && !/\s/.test(line[i]) && line[i]!=='#') i++;
      out.push(line.slice(start,i));
    }
  }
  return out;
}
function pred(name) {
  if(name.startsWith('$')) {
    if(!/^\$[A-Za-z_][\w-]*$/.test(name)) throw new SyntaxError('Bad wire reference');
    return `wire:${name.slice(1)}`;
  }
  if(!/^[A-Za-z][\w.-]*$/.test(name)) throw new SyntaxError(`Bad relation name: ${name}`);
  return name;
}
function atom(ts) {
  let explicit=false;
  if(ts[0]==='NOT') {explicit=true;ts=ts.slice(1);}
  if(!ts.length) throw new SyntaxError('Missing relation');
  return {kind:'atom',pred:(explicit?'negative:':'')+pred(ts[0]),terms:ts.slice(1).map(term)};
}
function literal(ts) {
  const op=ts[0];
  if(['MATCH','WHEN','AND','USE'].includes(op)) return atom(ts.slice(1));
  if(op==='NONE') return {...atom(ts.slice(1)),kind:'none'};
  if(op==='NOT') return atom(ts);
  if(op==='TEST') {
    if(ts.length!==4 || !['==','!=','<','<=','>','>='].includes(ts[2])) throw new SyntaxError('TEST ?a comparator value');
    return {kind:'test',terms:[term(ts[1]),term(ts[3])],op:ts[2]};
  }
  throw new SyntaxError(`Unknown condition: ${op}`);
}

export class SOPParser {
  constructor(source='<memory>') {this.source=source;this.line=0;this.block=null;this.names=new Set();this.program={facts:[],rules:[],queries:[],source};}
  feed(line) {
    this.line++;
    try {this.consume(tokens(line));}
    catch(e) {e.message=`${this.source}:${this.line}: ${e.message}`;throw e;}
  }
  consume(ts) {
    if(!ts.length) return;
    if(ts[0]==='END') {if(ts.length!==1) throw new SyntaxError('END takes no arguments');this.flush();return;}
    if(ts[0].startsWith('@')) {
      this.flush();
      if(ts.length!==2 || !/^@[A-Za-z_][\w-]*$/.test(ts[0]) || !['facts','rule','all','any','query'].includes(ts[1].toLowerCase())) throw new SyntaxError('@name facts|rule|all|any|query');
      const name=ts[0].slice(1);if(this.names.has(name)) throw new SyntaxError(`Duplicate wire ${name}`);this.names.add(name);
      this.block={name,type:ts[1].toLowerCase(),branches:[[]],gives:null,head:null,source:this.source,line:this.line};return;
    }
    if(!this.block) throw new SyntaxError('A wire block must start with @name type');
    const b=this.block;
    if(ts[0]==='SOURCE') {
      if(ts.length!==2 || b.type!=='facts') throw new SyntaxError('SOURCE takes one string inside facts');
      b.source=term(ts[1]);if(typeof b.source!=='string') throw new SyntaxError('SOURCE must be a string');return;
    }
    if(ts[0]==='FACT') {
      if(b.type!=='facts') throw new SyntaxError('FACT only allowed in a facts wire');
      const a=atom(ts.slice(1));if(a.terms.some(variable)) throw new SyntaxError('Facts must be ground');
      this.program.facts.push({...a,source:b.source,line:this.line,wire:b.name});return;
    }
    if(b.type==='facts') throw new SyntaxError('Only FACT and SOURCE allowed in facts wire');
    if(ts[0]==='GIVES') {
      if(b.type==='rule'||b.gives) throw new SyntaxError('Unexpected or duplicate GIVES');
      b.gives=ts.slice(1).map(term);if(b.gives.some(t=>!variable(t))||new Set(vars(b.gives)).size!==b.gives.length) throw new SyntaxError('GIVES requires distinct variables');return;
    }
    if(ts[0]==='THEN') {
      if(b.type!=='rule'||b.head) throw new SyntaxError('THEN only once in a rule');
      b.head=atom(ts.slice(1));return;
    }
    if(ts[0]==='OR') {
      if(!b.branches.at(-1).length) throw new SyntaxError('Empty OR branch');
      b.branches.push([]);
      if(ts.length>1) b.branches.at(-1).push(['MATCH','USE','NONE','TEST','NOT'].includes(ts[1])?literal(ts.slice(1)):atom(ts.slice(1)));
      return;
    }
    const l=literal(ts);
    if(b.type==='any' && b.branches.at(-1).length && ts[0]!=='AND') b.branches.push([]);
    b.branches.at(-1).push(l);
  }
  flush() {
    const b=this.block;if(!b)return;this.block=null;
    if(b.type==='facts')return;
    if(b.branches.some(x=>!x.length))throw new SyntaxError(`Empty body in ${b.name}`);
    if(b.type==='rule'&&!b.head)throw new SyntaxError(`Missing THEN in ${b.name}`);
    if(!b.gives && b.type!=='rule') {
      if(b.type!=='query')throw new SyntaxError(`Missing GIVES in ${b.name}`);
      b.gives=[...new Set(b.branches[0].filter(l=>l.kind==='atom').flatMap(l=>vars(l.terms)))].map(v=>({var:v}));
    }
    const head=b.head || {kind:'atom',pred:`${b.type==='query'?'query':'wire'}:${b.name}`,terms:b.gives};
    b.branches.forEach((body,j)=>this.program.rules.push({id:`${b.name}#${j}`,wire:b.name,head,body,source:b.source,line:b.line}));
    if(b.type==='query')this.program.queries.push({name:b.name,pred:head.pred,terms:b.gives});
  }
  finish(){this.flush();validateProgram(this.program);return this.program;}
}
export function validateProgram(p) {
  const arities=new Map();
  const check=a=>{if(a.kind==='test')return;const n=a.terms.length;if(arities.has(a.pred)&&arities.get(a.pred)!==n)throw new SyntaxError(`Arity mismatch ${a.pred}`);arities.set(a.pred,n);};
  for(const f of p.facts)check(f);
  for(const r of p.rules) {
    check(r.head);r.body.forEach(check);
    const bound=new Set(r.body.filter(l=>l.kind==='atom').flatMap(l=>vars(l.terms)));
    for(const v of [...vars(r.head.terms),...r.body.filter(l=>l.kind!=='atom').flatMap(l=>vars(l.terms))]) {
      if(!bound.has(v))throw new SyntaxError(`Unsafe variable ?${v} in ${r.id}; bind it in MATCH/USE first`);
    }
  }
  p.arities=arities;
  return p;
}
export function parseSOP(text,source='<memory>'){const p=new SOPParser(source);for(const l of text.split(/\r?\n/))p.feed(l);return p.finish();}
export async function loadSOP(path){const p=new SOPParser(path);const lines=createInterface({input:createReadStream(path),crlfDelay:Infinity});for await(const l of lines)p.feed(l);return p.finish();}
