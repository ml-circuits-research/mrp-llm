/** Minimal DOCX reader with Node built-ins: a zip central-directory reader plus `word/document.xml` to paragraphs. */
import fs from 'node:fs';
import zlib from 'node:zlib';

export function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error(`${file}: not a zip`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28), start = off + 30 + lnlen + lelen;
    const raw = buf.subarray(start, start + csize);
    entries.set(name, () => (method === 0 ? raw : zlib.inflateRawSync(raw)));
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

/** Paragraphs of a DOCX: [{text, style, table}] (table cells of a row are joined with " | "; rows are paragraphs with table: true). */
export function docxParagraphs(file) {
  const xml = readZip(file).get('word/document.xml')().toString('utf8');
  const out = [];
  const text = p => decode([...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map(m => m[1] ?? (m[0] === '<w:tab/>' ? '\t' : '\n')).join(''));
  const style = p => p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? '';
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, t => {
    for (const row of t.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []) {
      const cells = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map(c => (c.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map(text).join(' ').trim());
      out.push({text: cells.join(' | '), style: 'table', table: true, cells});
    }
    return '<!--T-->';
  });
  // Tables were consumed above; paragraphs outside tables keep document order only approximately (tables first), so redo in order.
  out.length = 0;
  const parts = xml.split(/(<w:tbl>[\s\S]*?<\/w:tbl>)/);
  for (const part of parts) {
    if (part.startsWith('<w:tbl>')) {
      for (const row of part.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []) {
        const cells = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map(c => (c.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map(text).join(' ').trim());
        out.push({text: cells.join(' | '), style: 'table', table: true, cells});
      }
    } else for (const p of part.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) out.push({text: text(p).trim(), style: style(p), table: false});
  }
  void body;
  return out.filter(p => p.text);
}
