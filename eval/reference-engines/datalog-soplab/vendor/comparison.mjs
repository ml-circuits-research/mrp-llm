// VENDORED: copied verbatim from soplab-v0.4.0.zip src/comparison.mjs
function normalizeRows(rows) {
  return rows.map((r) => JSON.stringify(r.bindings)).sort();
}

/**
 * Run multiple evaluator/materializer variants against the exact same workload.
 * `build()` must return a fresh { reasoner, goal, select? } object each time.
 */
export async function compareVariants({ build, variants, expectedRows = null }) {
  const results = [];
  for (const variant of variants) {
    const { reasoner, goal, select = null } = await build(variant);
    if (variant.setup) await variant.setup(reasoner);
    const res = reasoner.evaluate(goal, {
      scope: variant.scope ?? 'sliced',
      strategy: variant.strategy ?? 'delta',
      select: variant.select ?? select,
      ...(variant.options ?? {}),
    });
    const normalized = normalizeRows(res.rows);
    results.push({
      name: variant.name,
      rows: res.rows,
      rowSignature: normalized,
      materialization: res.materialization,
      metrics: res.metrics,
      selectedRules: res.selectedRules,
    });
  }
  const reference = expectedRows ? normalizeRows(expectedRows) : results[0]?.rowSignature ?? [];
  for (const r of results) r.matchesReference = JSON.stringify(r.rowSignature) === JSON.stringify(reference);
  return results;
}
