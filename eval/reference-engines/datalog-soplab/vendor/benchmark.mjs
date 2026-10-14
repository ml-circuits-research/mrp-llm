// VENDORED: copied verbatim from soplab-v0.4.0.zip src/benchmark.mjs
export async function benchmark(name, fn, { warmup = 1, iterations = 5 } = {}) {
  for (let i = 0; i < warmup; i++) await fn();
  const samples = [];
  let last;
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    last = await fn();
    const end = process.hrtime.bigint();
    samples.push(Number(end - start) / 1e6);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    name, iterations, meanMs: mean, minMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1), last,
  };
}

export function printBenchmarkTable(rows) {
  const header = ['name', 'mean ms', 'median', 'min', 'max'];
  const data = rows.map((r) => [r.name, r.meanMs.toFixed(3), r.medianMs.toFixed(3), r.minMs.toFixed(3), r.maxMs.toFixed(3)]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((r) => r[i].length)));
  const line = (r) => r.map((x, i) => x.padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  data.forEach((r) => console.log(line(r)));
}
