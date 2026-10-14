/** A small, safe Markdown renderer for the server pages (reports, notes,
 * questions.md, preregistrations). It escapes every character of the source
 * first and only then adds markup, so no HTML in a report reaches the page.
 *
 * Supported: ATX headings, paragraphs, fenced code, blockquotes, horizontal
 * rules, nested bullet and numbered lists, pipe tables, `code`, **bold**,
 * *italic*, [links](target) and <https://autolinks>. Link targets pass through
 * `resolveLink(target)`, which returns a safe href or null (rendered as code);
 * `javascript:` and other schemes are never emitted.
 */
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[ch]);

const SAFE_HREF = /^(https?:\/\/|\/(?!\/)|#|\.{0,2}\/?[A-Za-z0-9_.-])/;
const defaultResolve = target => (SAFE_HREF.test(target) && !/^\s*(javascript|data|vbscript):/i.test(target) ? target : null);

/** Heading id slug (lower-case words joined by hyphens). */
export const slug = value => String(value).toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;|&#\d+;/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';

/** Inline markup on one line of raw text. */
export function inline(raw, {resolveLink = defaultResolve} = {}) {
  const codes = [];
  let text = String(raw).replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
  const links = [];
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, target) => `\u0001${links.push({label, target}) - 1}\u0001`);
  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url) => `\u0001${links.push({label: url, target: url}) - 1}\u0001`);
  text = escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<i>$2</i>');
  text = text.replace(/\u0001(\d+)\u0001/g, (_, index) => {
    const {label, target} = links[Number(index)];
    const href = resolveLink(target);
    const shown = inline(label, {resolveLink}).replace(/<a [^>]*>|<\/a>/g, '');
    return href ? `<a href="${escapeHtml(href)}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}>${shown}</a>` : `${shown} <code>${escapeHtml(target)}</code>`;
  });
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${escapeHtml(codes[Number(index)])}</code>`);
}

const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
const isTableSeparator = line => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

/** Renders Markdown text to HTML. `headingOffset` shifts heading levels (1 → h2 when 1). */
export function renderMarkdown(source, {resolveLink = defaultResolve, headingOffset = 0} = {}) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const opts = {resolveLink};
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(line => inline(line, opts)).join('<br>')}</p>`);
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      flush();
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(6, heading[1].length + headingOffset);
      out.push(`<h${level} id="${escapeHtml(slug(heading[2]))}">${inline(heading[2], opts)}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const body = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote>${renderMarkdown(body.join('\n'), {resolveLink, headingOffset})}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(splitRow(lines[i]));
      i--;
      out.push(`<div class="tablewrap"><table class="t md-table"><thead><tr>${head.map(cell => `<th>${inline(cell, opts)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell, opts)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const items = [];
      for (; i < lines.length; i++) {
        const current = lines[i];
        const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(current);
        if (item) items.push({indent: item[1].replace(/\t/g, '  ').length, ordered: /\d/.test(item[2]), text: [item[3]]});
        else if (current.trim() && /^\s{2,}/.test(current) && items.length) items.at(-1).text.push(current.trim());
        else break;
      }
      i--;
      out.push(renderList(items, opts));
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return out.join('\n');
}

/** Nested lists from items with indentation. */
function renderList(items, opts) {
  let html = '';
  const stack = [];
  for (const item of items) {
    while (stack.length && item.indent < stack.at(-1).indent) html += `</li></${stack.pop().tag}>`;
    if (!stack.length || item.indent > stack.at(-1).indent) {
      const tag = item.ordered ? 'ol' : 'ul';
      stack.push({indent: item.indent, tag});
      html += `<${tag}>`;
    } else html += '</li>';
    html += `<li>${item.text.map(line => inline(line, opts)).join(' ')}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}
