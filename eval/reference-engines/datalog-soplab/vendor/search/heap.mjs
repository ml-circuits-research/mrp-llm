// VENDORED: copied verbatim from soplab-v0.4.0.zip src/search/heap.mjs
export class MinHeap {
  constructor(compare = (a, b) => a.priority - b.priority) { this.data = []; this.compare = compare; }
  get size() { return this.data.length; }
  push(x) {
    const a = this.data; a.push(x); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.compare(a[p], a[i]) <= 0) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.data; if (!a.length) return undefined;
    const root = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        let best = i, l = 2 * i + 1, r = l + 1;
        if (l < a.length && this.compare(a[l], a[best]) < 0) best = l;
        if (r < a.length && this.compare(a[r], a[best]) < 0) best = r;
        if (best === i) break;
        [a[i], a[best]] = [a[best], a[i]]; i = best;
      }
    }
    return root;
  }
}
