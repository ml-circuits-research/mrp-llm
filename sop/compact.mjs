/**
 * The compact surface of SOP Lang (DS024 "Two surfaces"): `key=value` pairs are accepted next to the canonical `  key value` field
 * lines, on the header line of a wire or on its own indented lines, and both forms may be mixed inside one wire:
 *
 *   @order entity name="Order 17" kind=order            @order entity
 *     owner=$customer                          ==        name "Order 17"
 *     where works_at ?who "Acme"                          kind order
 *                                                         owner $customer
 *                                                         where works_at ?who "Acme"
 *
 * A compact pair carries one term: a canonical symbol, an integer or decimal, a JSON string, a `$wire` reference, a `?variable` or a
 * `~id` handle. A value of several terms (an atom, a condition, a list) uses the line form. `expandCompact` rewrites a source to the
 * canonical surface before anything else reads it (sop/parser.mjs `parse` calls it); the canonical surface is the only one stored,
 * hashed and compared. `compactSource` renders a canonical program back in the compact surface where every value of a wire is one
 * term (an output option; the result parses to the same program).
 */

const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
// One term: a JSON string, or a token without spaces or quotes.
const TERM = /^(?:"(?:\\.|[^"\\])*"|[^\s"=]+)$/;

/** The tokens of a line, keeping JSON strings (and `key="..."`) whole. */
function tokens(text) {
  return text.match(/(?:[A-Za-z_][A-Za-z0-9_-]*=)?"(?:\\.|[^"\\])*"|\S+/g) ?? [];
}

/** `[key, value]` when every token of `text` is a compact pair, else null. */
function pairsOf(text) {
  const parts = tokens(text);
  if (!parts.length) return null;
  const out = [];
  for (const part of parts) {
    const at = part.indexOf('=');
    if (at < 1) return null;
    const key = part.slice(0, at), value = part.slice(at + 1);
    if (!KEY.test(key) || !value || !TERM.test(value)) return null;
    out.push([key, value]);
  }
  return out;
}

/** Whether a source uses the compact surface anywhere (cheap check before rewriting). */
export function hasCompact(source) {
  return /^@[A-Za-z][A-Za-z0-9_]*[ \t]+[A-Za-z][A-Za-z0-9_]*[ \t]+\S/m.test(source) || /^ {2}[A-Za-z_][A-Za-z0-9_-]*=/m.test(source);
}

/**
 * The canonical surface of a source that may use compact pairs. Lines inside a `|` block are kept as they are. A header line with
 * trailing text that is not made of compact pairs is left for the parser to reject with its usual message.
 */
export function expandCompact(source) {
  if (typeof source !== 'string' || !hasCompact(source)) return source;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (inBlock) {
      if (!line.trim() || line.startsWith('    ')) { out.push(line); continue; }
      inBlock = false;
    }
    const header = /^(@[A-Za-z][A-Za-z0-9_]*[ \t]+[A-Za-z][A-Za-z0-9_]*)[ \t]+(\S.*)$/.exec(line);
    if (header) {
      const pairs = pairsOf(header[2]);
      if (pairs) { out.push(header[1], ...pairs.map(([k, v]) => `  ${k} ${v}`)); continue; }
      out.push(line); continue;
    }
    const field = /^ {2}(\S.*)$/.exec(line);
    if (field && /^[A-Za-z_][A-Za-z0-9_-]*=/.test(field[1])) {
      const pairs = pairsOf(field[1]);
      if (pairs) { out.push(...pairs.map(([k, v]) => `  ${k} ${v}`)); continue; }
    }
    if (/^ {2}\S+\s+\|\s*$/.test(line)) inBlock = true;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * A parsed program (`{wires: [{id, type, fields}]}`) in the compact surface: a wire whose values are all single terms becomes one
 * header line; any other wire keeps its canonical lines.
 */
export function compactSource(program) {
  return program.wires.map(w => {
    const fields = Object.entries(w.fields).flatMap(([k, vs]) => vs.map(v => [k, v]));
    const single = fields.every(([, v]) => !v.includes('\n') && TERM.test(v) && !v.includes('='));
    if (single) return `@${w.id} ${w.type}${fields.map(([k, v]) => ` ${k}=${v}`).join('')}`;
    return `@${w.id} ${w.type}\n` + fields.map(([k, v]) => v.includes('\n') ? `  ${k} |\n${v.split('\n').map(l => '    ' + l).join('\n')}` : `  ${k}${v ? ' ' + v : ''}`).join('\n');
  }).join('\n\n') + '\n';
}
