import test from 'node:test';
import assert from 'node:assert/strict';
import {parse,canonical,parseAtom} from '../../sop/parser.mjs';
import {lowerQuery,lowerConstraint} from '../../sop/lower.mjs';
import {solveConstraint} from '../../reasoning/bridge/solve.mjs';
import {evaluate,reason} from '../../reasoning/bridge/index.mjs';
import {interval} from '../../lib/time.mjs';

const query=body=>lowerQuery(parse('@q query\n'+body).wires[0]);
const fact=(text,id,valid='timeless')=>({atom:parseAtom(text),id,valid:interval(valid)});
const group=`  where any\n    p a\n    q a\n  end`;

test('Boolean numeric groups preserve alternatives, nesting and correlated base assignments',()=>{
 const source=`@c constraint
  var ?xx int 0 3
  var ?yy int 0 3
  require any
    ?xx + ?yy == 3
    all
      ?xx == 3
      ?yy == 3
    end
  end
  claim all
    ?xx >= 0
    any
      ?yy <= 2
      ?xx == 0
    end
  end
  task possible`;
 const p=parse(source),problem=lowerConstraint(p.wires[0]);
 assert.deepEqual(lowerConstraint(parse(canonical(p)).wires[0]),problem);
 const result=solveConstraint(problem,{backend:'js',project:[{name:'solutions',mode:'rows'}]});
 assert.equal(result.status,'possible');
 assert.deepEqual(result.outputProjection['?solutions'].value,[{xx:0,yy:3},{xx:1,yy:2},{xx:2,yy:1},{xx:3,yy:0},{xx:3,yy:3}]);
 assert.equal(result.checks.claimModels,4);
 assert.equal(result.checks.negatedClaimModels,1);
});

test('selected and filtered variables cannot be optional branch bindings',()=>{
 const body='  where any\n    p ?x\n    q ?y\n  end';
 assert.throws(()=>query(body+'\n  select ?x'),/Unbound selected variable/);
 assert.throws(()=>query(body+'\n  filter ?x > 0'),/Unbound filter variable/);
 const q=query(body+'\n  where r ?x\n  select ?x');
 const result=evaluate(q,[fact('q b','q'),fact('r a','r')]);
 assert.deepEqual(result.answers.map(a=>a.binding),[{'?x':'a'}]);
});

test('a clean alternative is not contaminated by a contradicted sibling',()=>{
 const q=query(group),facts=[fact('p a','p'),fact('not p a','np'),fact('q a','q')];
 const result=evaluate(q,facts);
 assert.equal(result.status,'supported');
 assert.deepEqual(result.conflictedAnswers,[]);
 assert.equal(evaluate(q,[...facts,fact('not q a','nq')]).status,'both');
});

test('explicit opposite evidence refutes conjunction but missing evidence does not',()=>{
 const q=query(group.replace('any','all'));
 assert.equal(evaluate(q,[fact('not p a','np'),fact('q a','q')]).status,'refuted');
 assert.equal(evaluate(q,[fact('q a','q')]).status,'unknown');
});

test('nested joins require simultaneous validity; the probe ceiling stops the closure that feeds them',()=>{
 const q=query('  where all\n    p a\n    any\n      q a\n      r a\n    end\n  end\n  during 2026-01-01 2026-03-01');
 const facts=[fact('p a','p','2026-01-01 2026-02-01'),fact('q a','q','2026-02-01 2026-03-01')];
 assert.equal(evaluate(q,facts).status,'unknown');
 // the oracle counts the probes of the closure, not of the reading of its result: a rule join over the ceiling is incomplete
 const rule={id:'both',kind:'rule',if:[parseAtom('p ?x'),parseAtom('q ?x')],then:parseAtom('pq ?x'),valid:interval('timeless')};
 const cut=reason(query('  where pq a'),{facts:[fact('p a','p'),fact('q a','q')],rules:[rule],complete:true},{maxJoins:1});
 assert.equal(cut.complete,false);
 assert.notEqual(cut.status,'refuted');
});

test('empty, unclosed and excessive groups are rejected rather than weakened',()=>{
 assert.throws(()=>parse('@q query\n  where any\n  end'),/Empty any/);
 assert.throws(()=>parse('@q query\n  where all\n    p a'),/Unclosed condition/);
 assert.throws(()=>parse('@q query\n  where all\n'+'    all\n'.repeat(32)+'    p a\n'+'  end\n'.repeat(33)),/Condition nesting limit/);
});
