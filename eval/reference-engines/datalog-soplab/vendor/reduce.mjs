// VENDORED: copied verbatim from soplab-v0.4.0.zip src/reduce.mjs
function valueAt(row, key) { return row.bindings?.[key] ?? row[key]; }

export function reduceRows(rows, { groupBy = [], aggregates = [] } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const values = groupBy.map((k) => valueAt(row, k));
    const key = JSON.stringify(values);
    if (!groups.has(key)) groups.set(key, { values, rows: [] });
    groups.get(key).rows.push(row);
  }
  if (!groupBy.length && !groups.size) groups.set('[]', { values: [], rows: [] });

  const out = [];
  for (const group of groups.values()) {
    const result = Object.fromEntries(groupBy.map((k, i) => [k, group.values[i]]));
    for (const spec of aggregates) {
      const vals = spec.field == null ? [] : group.rows.map((r) => valueAt(r, spec.field));
      let value;
      if (spec.op === 'count') value = group.rows.length;
      else if (spec.op === 'sum') value = vals.reduce((a, b) => a + b, 0);
      else if (spec.op === 'min') value = vals.length ? vals.reduce((a, b) => a < b ? a : b) : undefined;
      else if (spec.op === 'max') value = vals.length ? vals.reduce((a, b) => a > b ? a : b) : undefined;
      else if (spec.op === 'collect') value = vals;
      else if (spec.op === 'set') value = [...new Set(vals)];
      else if (spec.op === 'first') value = vals[0];
      else throw new Error(`Unknown aggregate: ${spec.op}`);
      result[spec.as] = value;
    }
    out.push(result);
  }
  return out;
}
