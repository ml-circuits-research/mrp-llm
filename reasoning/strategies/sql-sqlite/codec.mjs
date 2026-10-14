/**
 * Value codecs of the sql-sqlite strategy: how a SOP term is stored in a SQLite column and read back.
 *
 *   native  integers are INTEGER, text and symbols are TEXT (SQLite keeps `1` and `'1'` apart, so the SOP rule "an integer never equals
 *           a string" holds without any conversion). Used for the strategy's own in-memory database.
 *   json    every value is its JSON text (`5`, `"ann"`), the encoding of the SQLite memory bank (`atoms.v0..v3`, DS018). Used when the
 *           rules run directly against a bank, so that joins and constants hit the bank's own indexes on the stored text.
 *
 * `lit` gives a SQL literal in the STORED form (what a column compares to); `natLit` and `native(expr)` give the NATIVE value
 * (what `compare` and `compute` need); `store(expr)` turns a native expression into the stored form.
 */
import {NotExpressibleError} from '../js-reference/values.mjs';

/** A SQL text literal. A NUL character cannot be written in SQL text (SQLite stops at it), so such a value is not expressible here. */
export const sqlString = s => {
  if (String(s).includes('\0')) throw new NotExpressibleError(['nul_in_text'], 'a text value with a NUL character cannot be written as a SQL literal');
  return "'" + String(s).replaceAll("'", "''") + "'";
};

const natLit = v => (typeof v === 'number' ? String(v) : sqlString(v));

export const nativeCodec = {
  id: 'native',
  natLit,
  lit: natLit,
  native: expr => expr,
  store: expr => expr,
  /** A JS value as a statement parameter: node:sqlite binds a JS number as REAL, a BigInt as INTEGER. A NUL in text would be cut by SQLite when read back. */
  bind: v => {
    if (typeof v === 'string' && v.includes('\0')) throw new NotExpressibleError(['nul_in_text'], 'a text value with a NUL character cannot be stored in a SQLite TEXT column without being cut');
    return typeof v === 'number' ? BigInt(v) : v;
  },
  decode: v => v
};

export const jsonCodec = {
  id: 'json',
  natLit,
  lit: v => sqlString(JSON.stringify(v)),
  native: expr => `json_extract(${expr},'$')`,
  store: expr => `json_quote(${expr})`,
  bind: v => JSON.stringify(v),
  decode: v => JSON.parse(v)
};
