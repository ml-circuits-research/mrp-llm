import test from 'node:test';
import assert from 'node:assert/strict';
import {parse,parseAtom,emitAtom} from '../../sop/parser.mjs';

test('atoms use whitespace-separated terms, typed integers, references and explicit negation',()=>{
 const atom=parseAtom('not connected $left ?right 17');
 assert.deepEqual(atom,{p:'connected',a:[{ref:'left'},'?right',17],neg:true});
 assert.equal(emitAtom(atom),'not connected $left ?right 17');
 assert.deepEqual(parseAtom('temperature sensor_1 -12'),{p:'temperature',a:['sensor_1',-12],neg:false});
 assert.deepEqual(parseAtom('pair a b c d').a,['a','b','c','d']);
});

test('JSON-quoted terms preserve multiword text, punctuation, parentheses and escapes',()=>{
 const atom=parseAtom('caption "Alpha Lab, (West)" "quote: \\"hi\\"; slash \\\\"');
 assert.deepEqual(atom.a,['Alpha Lab, (West)','quote: "hi"; slash \\']);
 assert.equal(emitAtom(atom),'caption "Alpha Lab, (West)" "quote: \\"hi\\"; slash \\\\"');
 assert.deepEqual(parseAtom(emitAtom(atom)),atom);
 assert.equal(parse('@f fact\n  holds caption "Alpha Lab, (West)"\n  valid timeless').wires[0].fields.holds[0],'caption "Alpha Lab, (West)"');
});

test('legacy parentheses and commas are rejected rather than parsed as terms',()=>{
 for(const text of ['parent(ana, bogdan)','not parent(ana, bogdan)','parent ana, bogdan','parent ana bogdan,','parent(ana)','parent ana (bogdan)']){
  assert.throws(()=>parseAtom(text),undefined,text);
 }
});

test('missing, excess, adjacent or malformed atom terms fail closed',()=>{
 const cases=[
  'parent','not parent','parent ','parent a b c d e',
  'parent "a""b"','parent "unterminated','parent "x"y',
  'parent a\nb','not a','p 9007199254740992',
 ];
 for(const text of cases){
  assert.throws(()=>parseAtom(text),undefined,text);
 }
});

test('query absence preserves an ordinary predicate named absent in evidence',()=>{
 assert.deepEqual(parseAtom('absent worker'),{p:'absent',a:['worker'],neg:false});
 assert.deepEqual(parseAtom('absent worker',{absence:true}),{p:'absent',a:['worker'],neg:false});
 assert.deepEqual(parseAtom('not absent worker'),{p:'absent',a:['worker'],neg:true});
 assert.deepEqual(parseAtom('absent listed worker'),{p:'absent',a:['listed','worker'],neg:false});
 assert.deepEqual(parseAtom('absent listed worker',{absence:true}),{p:'listed',a:['worker'],neg:'absent'});
});
