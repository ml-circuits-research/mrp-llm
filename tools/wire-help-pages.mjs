/** Extraction helpers for the wire help pages under `docs/wire_typs/`, shared by
 * `tests/docs/wire-help.test.mjs` (which executes the examples) and the vocabulary
 * check `tools/datasets/audit/vocabulary.mjs` (which cross-checks the tables
 * against the contract). Pure text processing: nothing here parses or runs SOP.
 *
 * Markup contract (see docs/wire_typs/*.html): examples are
 * `<pre data-sop="current|ontology|invalid" [data-check] [data-error] [data-status]><code>...</code></pre>`,
 * and a wire page documents its keywords in the first column of its `<tbody>` table.
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

/** Strip tags and decode the entities the help pages use. */
export const decode = s => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Value of one `name="..."` attribute in an attribute string. */
export const attr = (attrs, name) => attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];

/** The help pages of a directory (`URL` or path), sorted: `[{name, file, html}]`. */
export function helpPages(dir) {
  const base = dir instanceof URL ? dir : pathToFileURL(path.resolve(String(dir)) + '/');
  return fs.readdirSync(base).filter(f => f.endsWith('.html')).sort().map(file => ({
    name: file.slice(0, -5),
    file,
    html: fs.readFileSync(new URL(file, base), 'utf8'),
  }));
}

/** Examples of one page, with the 1-based line of the example's first source line. */
export function pageExamples(page) {
  return [...page.html.matchAll(/<pre([^>]*)><code>([\s\S]*?)<\/code><\/pre>/g)].map((m, index) => ({
    label: `${page.name}.html example ${index + 1}`,
    kind: attr(m[1], 'data-sop'),
    check: attr(m[1], 'data-check'),
    error: attr(m[1], 'data-error') && decode(attr(m[1], 'data-error')),
    status: attr(m[1], 'data-status'),
    value: attr(m[1], 'data-value') && decode(attr(m[1], 'data-value')),
    source: decode(m[2]),
    line: page.html.slice(0, m.index).split('\n').length,
  }));
}

/** First-column keywords of the page's field table. */
export function tableFields(html) {
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
  return [...body.matchAll(/<tr>\s*<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(m => {
    const cell = m[1];
    return decode(cell.match(/<code>([\s\S]*?)<\/code>/)?.[1] ?? cell).trim().split(/\s/)[0];
  });
}
