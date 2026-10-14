/** Shared SOP code rendering for the browser pages: lightweight syntax
 * highlighting that links every wire type and wire field to its help page.
 *
 *   @q query                 -> `query` links to /docs/wire_typs/query.html
 *     where parent ?x ?y     -> `where` links to /docs/wire_typs/query.html#field-where
 *
 * The known types and fields come from the parser contract (`SPEC` and, for
 * the lexicon wires, the knowledge grammar `sop/knowledge/grammar.mjs`), never from a list
 * kept here. A type or field that the
 * contract does not know is not linked; it is marked "undocumented", which is
 * a visible hallucination signal in model-authored or generated SOP.
 *
 * Structural grammar words (`all`, `any`, `match`, `end` and the atom prefix
 * `not`) come from sop/conditions.mjs and sop/parser.mjs too. They are
 * rendered as syntax keywords linking to docs/wire_typs/syntax.html#syntax-WORD,
 * never as fields, so they are never flagged. Inside a query `match … end`
 * block the keyword lines (`relation`, `role`, `polarity`) link to their
 * definitions on the `stated` page; any other keyword there is flagged.
 *
 * The renderer is one self-contained function, so the same code runs on the
 * server (`renderSopHtml`) and in the browser (`sopCodeScript` defines
 * `window.ChatSopCode.render`). Pages add `SOP_CODE_STYLE` to their styles.
 */
import * as parser from '../../sop/parser.mjs';
import {GRAMMAR} from '../../sop/knowledge/grammar.mjs';

/** The lexicon wires of the knowledge grammar: the vocabulary of base memories and of the `ontology_sop` of worlds. */
const LEXICON_CONTRACT = Object.fromEntries(['predicate', 'lexeme', 'entity'].map(type => [type, {one: Object.entries(GRAMMAR[type].fields).filter(([, f]) => f.card === 'one').map(([k]) => k), many: Object.entries(GRAMMAR[type].fields).filter(([, f]) => f.card === 'many').map(([k]) => k)}]));

/** `{type: [field, ...]}` from the parser contract: executable wires plus the lexicon wires of the knowledge grammar. */
export const SOP_CONTRACT = Object.fromEntries(Object.entries({...LEXICON_CONTRACT, ...parser.SPEC}).map(([type, spec]) => [type, [...new Set([...(spec.one ?? []), ...(spec.many ?? [])])].sort()]));
export const SOP_DOCS_BASE = '/docs/wire_typs/';
/** Structural grammar words from the parser, and where they are documented. */
export const SOP_SYNTAX = Object.freeze({
  openers: [...parser.BLOCK_OPENERS], match: parser.MATCH_OPENER, closer: parser.BLOCK_CLOSER, negation: parser.ATOM_NEGATION,
  matchKeywords: [...parser.MATCH_KEYWORDS], conditionFields: parser.CONDITION_FIELDS, page: 'syntax.html', matchKeywordPage: 'stated.html',
});

/**
 * Builds the renderer. Must not reference module scope: it is serialised into
 * the browser script with `Function.prototype.toString`.
 * `render(source, {allowTypes})`: `allowTypes` lists extra types the caller
 * parses on purpose although the contract has no page for them; they are shown
 * neutrally, neither linked nor flagged.
 */
function createSopRenderer(contract, docsBase, syntax) {
  const SYNTAX = new Set([...syntax.openers, syntax.closer, syntax.negation]);
  const OPENERS = new Set(syntax.openers);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[ch]);
  const span = (cls, text, title) => '<span class="' + cls + '"' + (title ? ' title="' + escape(title) + '"' : '') + '>' + escape(text) + '</span>';
  const link = (cls, text, href, title) => '<a class="' + cls + '" href="' + escape(href) + '" target="_blank" rel="noopener" title="' + escape(title) + '">' + escape(text) + '</a>';
  const known = type => Object.prototype.hasOwnProperty.call(contract, type);
  const TOKEN = /("(?:\\.|[^"\\])*")|(#.*$)|(\$[A-Za-z][\w]*)|(\?[A-Za-z][\w]*)|(-?\b\d[\d.:TZ+-]*\b)|([A-Za-z_][\w:-]*)/g;
  const syntaxHtml = word => link('sop-syntax', word, docsBase + syntax.page + '#syntax-' + encodeURIComponent(word), 'SOP syntax: ' + word + ' (opens the shared syntax page)');

  /** Terms after a keyword: strings, $refs, ?vars, numbers; `not` before an atom is syntax, other grammar words are values. */
  function terms(text) {
    let out = '';
    let last = 0;
    let first = true;
    for (const match of text.matchAll(TOKEN)) {
      const [whole, string, comment, ref, variable, number, word] = match;
      out += escape(text.slice(last, match.index));
      if (string) out += span('sop-str', string);
      else if (comment) out += span('sop-com', comment);
      else if (ref) out += span('sop-ref', ref);
      else if (variable) out += span('sop-var', variable);
      else if (number) out += span('sop-num', number);
      else if (word && first && word === syntax.negation) out += syntaxHtml(word);
      else if (word && SYNTAX.has(word)) out += span('sop-kw', word);
      else out += escape(whole);
      first = false;
      last = match.index + whole.length;
    }
    return out + escape(text.slice(last));
  }

  function typeHtml(type, allow) {
    if (known(type)) return link('sop-type', type, docsBase + encodeURIComponent(type) + '.html', 'wire type ' + type + ' (opens its documentation)');
    if (allow.has(type)) return span('sop-type', type);
    return span('sop-undoc', type, 'undocumented wire type: "' + type + '" is not in the SOP contract');
  }

  function fieldHtml(type, field, allow) {
    if (SYNTAX.has(field)) return syntaxHtml(field);
    if (known(type)) {
      if (contract[type].includes(field)) return link('sop-field', field, docsBase + encodeURIComponent(type) + '.html#field-' + encodeURIComponent(field), type + '.' + field + ' (opens its documentation)');
      return span('sop-undoc', field, 'undocumented field: "' + field + '" is not a field of ' + type + ' in the SOP contract');
    }
    return span(allow.has(type) ? 'sop-kw' : 'sop-field-unknown', field);
  }

  /** A keyword line inside a `match … end` block. */
  function matchKeywordHtml(word) {
    if (syntax.matchKeywords.includes(word)) return link('sop-field', word, docsBase + syntax.matchKeywordPage + '#field-' + encodeURIComponent(word), 'match-block keyword ' + word + ' (a proposition keyword; opens its documentation)');
    return span('sop-undoc', word, 'undocumented match-block keyword: "' + word + '" is not one of ' + syntax.matchKeywords.join(', '));
  }

  return {
    contract,
    syntax,
    render(source, {allowTypes = []} = {}) {
      const allow = new Set(allowTypes);
      let type = null;
      let block = false;
      // Open condition blocks, innermost last: 'group' (all/any) or 'match'.
      let stack = [];
      const open = word => stack.push(word === syntax.match ? 'match' : 'group');
      return String(source ?? '').replace(/\r\n/g, '\n').split('\n').map(line => {
        if (!line.trim()) return escape(line);
        if (line.trimStart().startsWith('#')) return span('sop-com', line);
        const header = line.match(/^@([A-Za-z][\w]*)(\s+)([A-Za-z][\w]*)?(.*)$/);
        if (header) {
          type = header[3] ?? null;
          block = false;
          stack = [];
          return span('sop-head', '@' + header[1]) + header[2] + (header[3] ? typeHtml(header[3], allow) : '') + terms(header[4]);
        }
        // A `|` block keeps its 4-space-indented lines verbatim.
        if (block && line.startsWith('    ')) return span('sop-block', line);
        block = false;
        // Inside a condition block: nested openers, the closer, match keyword lines, atoms or comparisons.
        if (stack.length > 0) {
          const parts = line.match(/^(\s*)(\S+)(.*)$/);
          const word = parts[2];
          if (OPENERS.has(word) && !parts[3].trim()) {
            open(word);
            return parts[1] + syntaxHtml(word);
          }
          if (word === syntax.closer && !parts[3].trim()) {
            stack.pop();
            return parts[1] + syntaxHtml(word);
          }
          if (stack[stack.length - 1] === 'match') return parts[1] + matchKeywordHtml(word) + terms(parts[3]);
          return terms(line);
        }
        const field = line.match(/^( {2})([^\s]+)(.*)$/);
        if (field && type !== null) {
          const value = field[3].trim();
          block = value === '|';
          if (OPENERS.has(value) && (syntax.conditionFields[type] ?? []).includes(field[2])) {
            open(value);
            return field[1] + fieldHtml(type, field[2], allow) + field[3].slice(0, field[3].indexOf(value)) + syntaxHtml(value);
          }
          return field[1] + fieldHtml(type, field[2], allow) + terms(field[3]);
        }
        // Stray text outside any wire or block.
        const bare = line.trim();
        if (SYNTAX.has(bare)) return line.slice(0, line.indexOf(bare)) + syntaxHtml(bare);
        return terms(line);
      }).join('\n');
    },
  };
}

const renderer = createSopRenderer(SOP_CONTRACT, SOP_DOCS_BASE, SOP_SYNTAX);

/** Server-side: highlighted, linked HTML for an SOP source (no surrounding <pre>). */
export const renderSopHtml = (source, options) => renderer.render(source, options);

/** Browser-side: defines `window.ChatSopCode = {contract, render(source, options)}`. */
export const sopCodeScript = `window.ChatSopCode=(${createSopRenderer})(${JSON.stringify(SOP_CONTRACT)},${JSON.stringify(SOP_DOCS_BASE)},${JSON.stringify(SOP_SYNTAX)});`;

export const SOP_CODE_STYLE = `
.sop-head{color:#8250df;font-weight:600}
.sop-type,.sop-field{color:#0a7d6f;font-weight:600;text-decoration:underline dotted;text-underline-offset:3px}
.sop-field{color:#1f6f9f}
a.sop-type:hover,a.sop-field:hover{text-decoration-style:solid}
.sop-kw{color:#1f6f9f;font-weight:600}
.sop-field-unknown{font-weight:600}
.sop-ref{color:#b35900}
.sop-var{color:#b3261e}
.sop-str,.sop-block{color:#1d7f4e}
.sop-num{color:#6a5acd}
.sop-com{color:var(--muted,#667);font-style:italic}
.sop-undoc{color:#b3261e;font-weight:700;background:#b3261e1f;border-radius:3px;text-decoration:underline wavy #b3261e;text-underline-offset:3px;cursor:help}
.sop-undoc::after{content:" ⚠ undocumented";font-size:11px;font-weight:600;font-family:system-ui,sans-serif;text-decoration:none;display:inline-block;margin-left:2px}
.sop-syntax{color:#9a3412;font-weight:700;text-decoration:underline dotted;text-underline-offset:3px}
a.sop-syntax:hover{text-decoration-style:solid}
@media (prefers-color-scheme:dark){.sop-syntax{color:#ffa657}.sop-head{color:#c297ff}.sop-type{color:#56d4c2}.sop-field,.sop-kw{color:#6cb6ff}.sop-ref{color:#ffab70}.sop-var{color:#ff8b80}.sop-str,.sop-block{color:#7ee2a8}.sop-num{color:#b4a7ff}.sop-undoc{color:#ff8b80;background:#ff8b8022;text-decoration-color:#ff8b80}}
`;

/** ES module served publicly at `/assets/sop-code.mjs` for the documentation
 * pages (docs/partials-loader.mjs): `render(source, options)`, `contract` and
 * `style`, built from the same renderer and parser contract as the server pages. */
export const sopCodeModule = `const renderer=(${createSopRenderer})(${JSON.stringify(SOP_CONTRACT)},${JSON.stringify(SOP_DOCS_BASE)},${JSON.stringify(SOP_SYNTAX)});
export const render=(source,options)=>renderer.render(source,options);
export const contract=renderer.contract;
export const style=${JSON.stringify(SOP_CODE_STYLE)};
`;
