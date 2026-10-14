#!/usr/bin/env node
/** Regenerates or checks `docs/partials/header.html` from the shared menu in
 * `server/pages/site-menu.mjs`, so the documentation site and the server pages
 * show the same top menu.
 *
 *   node tools/site-menu.mjs --write   # rewrite the docs header partial
 *   node tools/site-menu.mjs --check   # exit 1 when the partial is stale
 */
import fs from 'node:fs';
import {docsHeaderHtml} from '../server/pages/site-menu.mjs';

const file = new URL('../docs/partials/header.html', import.meta.url);
const wanted = docsHeaderHtml();
const mode = process.argv[2];
if (mode === '--write') {
  fs.writeFileSync(file, wanted);
  console.log('wrote docs/partials/header.html');
} else if (mode === '--check') {
  const current = fs.readFileSync(file, 'utf8');
  if (current !== wanted) {
    console.error('docs/partials/header.html is stale; run node tools/site-menu.mjs --write');
    process.exitCode = 1;
  } else console.log('docs/partials/header.html matches server/pages/site-menu.mjs');
} else {
  console.log('usage: node tools/site-menu.mjs --write | --check');
}
