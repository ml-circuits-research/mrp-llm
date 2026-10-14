/** The shared SOP highlighter (server/pages/sop-code.mjs) renders the structural grammar words as syntax
 * keywords linked to docs/wire_typs/syntax.html, never as "undocumented" fields (DS009 "SOP code"). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {SOP_SYNTAX, renderSopHtml, sopCodeScript} from '../../server/pages/sop-code.mjs';
import {SYNTAX_WORDS, ATOM_NEGATION} from '../../sop/parser.mjs';

const MODEL_QUERY = `@q query
  where all
    match
      relation "works at"
      role subject ?who
      role object "Alpha Lab"
      polarity affirmed
    end
    any
      match
        relation "member of project"
        role subject ?who
        polarity affirmed
      end
    end
  end
  select ?who
@q2 query
  where match
    relation "cost"
    role subject "Delta"
    role object ?price
    polarity affirmed
  end
  compare any
    ?price equal 3
    ?price equal 4
  end
  select ?price
@c constraint
  var ?v int
  require all
    ?v equal 2380 times 19
  end
  select ?v
  task possible
@r rule
  when all
    not a ?x
  end
  then b ?x
`;

test('the syntax words come from the parser grammar', () => {
  assert.deepEqual([...SOP_SYNTAX.openers, SOP_SYNTAX.closer].sort(), [...SYNTAX_WORDS].sort());
  assert.equal(SOP_SYNTAX.negation, ATOM_NEGATION);
  for (const word of ['all', 'any', 'match', 'end']) assert.ok(SYNTAX_WORDS.includes(word), word);
});

test('end, match, all and any are never flagged as undocumented', () => {
  const html = renderSopHtml(MODEL_QUERY);
  assert.doesNotMatch(html, /sop-undoc/);
  for (const word of ['all', 'any', 'match', 'end', 'not']) {
    assert.match(html, new RegExp(`<a class="sop-syntax" href="/docs/wire_typs/syntax\\.html#syntax-${word}"[^>]*>${word}</a>`), word);
  }
  // A stray closer at field level (malformed model output) is still grammar, not a field.
  assert.doesNotMatch(renderSopHtml('@q query\n  where p ?x\n  end\n  match\n  all\n  any\n'), /sop-undoc/);
  // Match-block keyword lines link to their definitions; an unknown one is flagged.
  assert.match(html, /href="\/docs\/wire_typs\/stated\.html#field-relation"/);
  assert.match(renderSopHtml('@q query\n  where match\n    predicate "x"\n  end\n'), /<span class="sop-undoc"[^>]*>predicate<\/span>/);
  // The same spelling as an ordinary value stays a value.
  const values = renderSopHtml('@q query\n  where p ?x\n  mode every\n  quantifier all\n  measure end\n');
  assert.doesNotMatch(values, /sop-syntax|sop-undoc/);
});

test('the browser copy renders the same and every syntax anchor exists', () => {
  const scope = {};
  new Function('window', sopCodeScript)(scope);
  assert.equal(scope.ChatSopCode.render(MODEL_QUERY), renderSopHtml(MODEL_QUERY));
  const page = fs.readFileSync(new URL('../../docs/wire_typs/syntax.html', import.meta.url), 'utf8');
  for (const word of [...SYNTAX_WORDS, ATOM_NEGATION]) assert.match(page, new RegExp(`id="syntax-${word}"`), word);
});
