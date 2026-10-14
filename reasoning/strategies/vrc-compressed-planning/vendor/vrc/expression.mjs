// VENDORED: copied verbatim from vrc03r.zip vendor/vrc/src/expression.mjs
import {Poly} from './poly.mjs';
/** Polynomial expression parser. Never evaluates JavaScript. */
export function parseExpression(text,names){
  if(text.length>200000)throw new RangeError('Expression size budget');const tokens=[];let at=0;
  while(at<text.length){if(/\s/.test(text[at])){at++;continue;}const s=text.slice(at),m=s.match(/^(?:\?[A-Za-z_][A-Za-z0-9_]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[()+\-*\/^])/);if(!m)throw new SyntaxError(`Invalid expression token at ${at}: ${s.slice(0,24)}`);tokens.push(m[0]);at+=m[0].length;}
  const n=names.length;let i=0,depth=0;const fragments=[];
  function atom(){if(++depth>128)throw new RangeError('Expression nesting budget');const t=tokens[i++];let p;
    if(t==='('){p=expr();if(tokens[i++]!==')')throw new SyntaxError('Missing )');}
    else if(t?.startsWith('?')){const j=names.indexOf(t.slice(1));if(j<0)throw new SyntaxError(`Unknown state variable ${t}`);p=Poly.variable(n,j);}
    else if(t&&/^(?:\d|\.)/.test(t))p=Poly.constant(n,t);else throw new SyntaxError(`Expected variable or number, got ${t}`);
    depth--;return p;
  }
  function power(){let p=atom();if(tokens[i]==='^'){i++;const k=tokens[i++];if(!/^\d+$/.test(k||''))throw new SyntaxError('Power must be a nonnegative integer');p=p.pow(Number(k));fragments.push(p);}return p;}
  function unary(){if(tokens[i]==='-'){i++;return unary().scale(-1);}if(tokens[i]==='+'){i++;return unary();}return power();}
  function term(){let p=unary();while(tokens[i]==='*'||tokens[i]==='/'){const op=tokens[i++],q=unary();if(op==='/'){if(!q.constant||q.zero)throw new SyntaxError('Only division by a nonzero rational constant is supported');p=p.scale(Poly.constant(n,1).t.values().next().value.div(q.t.values().next().value));}else p=p.mul(q);fragments.push(p);}return p;}
  function expr(){let p=term();while(tokens[i]==='+'||tokens[i]==='-'){const op=tokens[i++],q=term();p=op==='+'?p.add(q):p.sub(q);fragments.push(p);}return p;}
  const polynomial=expr();if(i!==tokens.length)throw new SyntaxError(`Unexpected token ${tokens[i]}`);return {polynomial,fragments};
}
