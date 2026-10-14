/** Answer cache of the llm-agent strategy: one JSON file per selected backend settings, model, presentation and prompt. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const cacheKey = ({model, presentation, prompt, version, settings = ''}) => crypto.createHash('sha256').update([model, presentation, version, prompt, ...(settings ? [settings] : [])].join('\u0000')).digest('hex');
export const caseHash = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

export function readCache(dir, key) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, key + '.json'), 'utf8')); } catch { return null; }
}

export function writeCache(dir, key, entry) {
  try { fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify(entry)); } catch { /* a read-only cache dir only costs a rerun */ }
}

/** Paid spending ledger (models that are not on a subscription), persisted next to the cache so the cap survives processes. */
export function readLedger(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8')); } catch { return {paid_usd: 0, calls: 0}; }
}
export function addPaid(dir, usd) {
  const l = readLedger(dir);
  l.paid_usd += usd; l.calls += 1;
  try { fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(l)); } catch { /* ignore */ }
  return l;
}
