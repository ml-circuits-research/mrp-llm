// Tiny SVG diagram helper for docs/architecture.html (build-time only). Colors come from CSS classes of the page,
// which define a light and a dark palette; each diagram draws its own background so it is readable on any page color.
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TW = 7.2, LW = 5.8, MW = 7.0; export const warnings = []; // approx px per char: bold title 13px, line 11.5px, mono 11.5px

export class Svg {
  constructor(id, w, title, desc) {
    this.id = id; this.w = w; this.title = title; this.desc = desc; this.parts = []; this.h = 0; this.nodes = {};
  }
  grow(y) { this.h = Math.max(this.h, y + 14); }
  zone(x, y, w, h, label, cls = 'z-host') {
    this.parts.push(`<rect class="zone ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>` +
      (label ? `<text class="zlabel" x="${x + 12}" y="${y + 18}">${esc(label)}</text>` : ''));
    this.grow(y + h);
  }
  /** A node: title (bold) and lines (regular). Returns its geometry. `lines` entries starting with "~" are muted notes. */
  node(key, x, y, w, title, lines = [], cls = 'n-host', opts = {}) {
    const hasTitle = !!title;
    const h = opts.h ?? (10 + (hasTitle ? 19 : 0) + lines.length * 15 + 6);
    if (hasTitle && title.length * TW > w - 18) warnings.push(`title too long for node ${key}: ${title} (${Math.round(title.length * TW)} > ${w - 18})`);
    for (const l of lines) if (l.length * LW > w - 18) warnings.push(`line too long for node ${key}: ${l} (${Math.round(l.length * LW)} > ${w - 18})`);
    let t = '';
    let ty = y + 17;
    if (hasTitle) { t += `<text class="nt" x="${x + 9}" y="${ty}">${esc(title)}</text>`; ty += 19; }
    for (const l of lines) {
      const muted = l.startsWith('~');
      t += `<text class="nl${muted ? ' muted' : ''}" x="${x + 9}" y="${ty - (hasTitle ? 2 : 0)}">${esc(muted ? l.slice(1) : l)}</text>`;
      ty += 15;
    }
    this.parts.push(`<g class="node ${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>${t}</g>`);
    const g = { x, y, w, h, cx: x + w / 2, cy: y + h / 2, r: x + w, b: y + h };
    this.nodes[key] = g; this.grow(y + h);
    return g;
  }
  badge(x, y, n) {
    this.parts.push(`<g class="badge"><circle cx="${x}" cy="${y}" r="11"/><text x="${x}" y="${y + 4}" text-anchor="middle">${esc(n)}</text></g>`);
  }
  text(x, y, str, cls = 'tl', anchor = 'start') {
    this.parts.push(`<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${esc(str)}</text>`);
    this.grow(y);
  }
  /** Polyline arrow through points [[x,y],...]; opts: dashed, label, lx, ly, anchor, start (arrowhead at start too). */
  arrow(pts, opts = {}) {
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
    this.parts.push(`<path class="edge${opts.dashed ? ' dashed' : ''}" d="${d}" marker-end="url(#ah-${this.id})"${opts.start ? ` marker-start="url(#ah-${this.id})"` : ''}/>`);
    if (opts.label) this.text(opts.lx ?? pts.at(-1)[0] + 6, opts.ly ?? pts.at(-1)[1] - 6, opts.label, 'elabel', opts.anchor ?? 'start');
  }
  /** A boundary line (dashed, accent) with a label. */
  boundary(x1, y1, x2, y2, label, lx, ly, anchor = 'start') {
    this.parts.push(`<line class="boundary" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    if (label) this.text(lx ?? x1 + 6, ly ?? y1 + 14, label, 'blabel', anchor);
    this.grow(Math.max(y1, y2));
  }
  render() {
    const h = Math.ceil(this.h);
    return `<figure class="dgfig"><div class="dg-wrap"><svg class="dg" id="${this.id}" viewBox="0 0 ${this.w} ${h}" width="${this.w}" role="img" aria-labelledby="${this.id}-t ${this.id}-d" xmlns="http://www.w3.org/2000/svg">` +
      `<title id="${this.id}-t">${esc(this.title)}</title><desc id="${this.id}-d">${esc(this.desc)}</desc>` +
      `<defs><marker id="ah-${this.id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ahead" d="M0 0 L10 5 L0 10 z"/></marker></defs>` +
      `<rect class="bgr" x="0" y="0" width="${this.w}" height="${h}" rx="8"/>` + this.parts.join('') + `</svg></div>` +
      `<figcaption>${esc(this.title)}</figcaption></figure>`;
  }
}
export { esc };
