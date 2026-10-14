// VENDORED: copied verbatim from soplab-v0.4.0.zip src/metrics.mjs
export class Metrics {
  constructor(seed = {}) {
    this.counters = new Map(Object.entries(seed));
    this.startedAt = process.hrtime.bigint();
    this.finishedAt = null;
  }
  inc(name, by = 1) { this.counters.set(name, (this.counters.get(name) ?? 0) + by); return this; }
  set(name, value) { this.counters.set(name, value); return this; }
  get(name) { return this.counters.get(name) ?? 0; }
  finish() { if (!this.finishedAt) this.finishedAt = process.hrtime.bigint(); return this; }
  snapshot() {
    const end = this.finishedAt ?? process.hrtime.bigint();
    return {
      ...Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b))),
      elapsedMs: Number(end - this.startedAt) / 1e6,
    };
  }
  clone() { return new Metrics(Object.fromEntries(this.counters)); }
}
