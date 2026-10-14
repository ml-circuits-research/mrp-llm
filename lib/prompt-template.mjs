/**
 * The role-prompt template format of config/prompts/*.md, read by product code (the jsEval route, ChatSOPAdapter's direct
 * path) without importing the proxy package: sections `<<<options>>>` (JSON), `<<<system>>>`, `<<<user>>>`, `<<<again>>>`, and
 * `{{name}}` placeholders. The same format as Ploinky/lib/prompted.mjs `parseTemplate`/`fill` (the proxy's own prompted tiers).
 */
export function parseTemplate(text) {
  const out = {options: {}, system: '', user: '', again: ''};
  const parts = String(text).split(/^<<<(\w+)>>>\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i], body = parts[i + 1].replace(/^\n/, '').replace(/\s+$/, '');
    if (name === 'options') out.options = JSON.parse(body || '{}');
    else out[name] = body;
  }
  if (!out.user) throw new Error('template has no <<<user>>> section');
  return out;
}

/** Fills the {{name}} placeholders; a placeholder without a value is an authoring error. */
export const fill = (t, vars) => String(t).replace(/\{\{(\w+)\}\}/g, (_, k) => { if (!(k in vars)) throw new Error(`template variable ${k} has no value`); return String(vars[k]); });
