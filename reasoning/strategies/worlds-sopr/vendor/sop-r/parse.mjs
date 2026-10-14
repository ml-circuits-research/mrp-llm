// VENDORED: copied verbatim from sop-r.zip src/ parse.mjs
// Parser: text -> wires.   "@name type" opens a wire, every other non-empty line is "keyword value...".
import { lex, SopError, Quoted } from './lex.mjs';

export class Line {
  constructor(kw, args, n, raw) { this.kw = kw; this.args = args; this.n = n; this.raw = raw; }
}

export class Wire {
  constructor(name, type, origin, n) {
    this.name = name; this.type = type; this.origin = origin; this.n = n; this.lines = [];
  }
  get(...kws) { return this.lines.filter((l) => kws.includes(l.kw)); }
  one(kw) { return this.lines.find((l) => l.kw === kw) || null; }
  where() { return `${this.origin}:${this.n} @${this.name}`; }
}

export function parse(text, origin) {
  const wires = [];
  let cur = null;
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i];
    const toks = lex(line);
    if (!toks.length) continue;
    const head = toks[0];
    if (typeof head === 'string' && head.startsWith('@')) {
      if (toks.length !== 2 || typeof toks[1] !== 'string') throw new SopError(`${origin}:${n}: a wire header is "@name type"`);
      cur = new Wire(head.slice(1), toks[1], origin, n);
      wires.push(cur);
    } else {
      if (cur === null) throw new SopError(`${origin}:${n}: line outside of a wire`);
      if (typeof head !== 'string') throw new SopError(`${origin}:${n}: line must start with a keyword`);
      const st = line.trim();
      const raw = st.toLowerCase().startsWith(head) ? st.slice(head.length).trim() : '';
      cur.lines.push(new Line(head, toks.slice(1), n, raw));
    }
  }
  return wires;
}

export { Quoted };
