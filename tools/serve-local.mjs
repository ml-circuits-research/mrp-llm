#!/usr/bin/env node
/** Convenience launcher for the local server: documentation site, admin page and
 * the OpenAI-compatible chat API on one port.
 *
 *   npm start                       # 0.0.0.0:9999 (all interfaces) — docs, admin, experiments and chat
 *   MRP_PORT=9000 npm start
 *   MRP_HOST=127.0.0.1 npm start # loopback only
 *
 * Open the home URL in a browser: it links to the chat, the experiments, the
 * admin page and the documentation. On the first run the sign-in page asks for
 * the administrator password; the chat API stays blocked until it is set.
 * `MRP_API_KEY` (or CHATSOP_API_KEY) keeps working as an environment-provided bearer token for
 * scripts and SDKs, and `MRP_CONFIG` selects another runtime configuration.
 * The chat's formalizer is step by step: the system asks short questions to the Ploinky tier ladder `queryParser.local.ladder` of the runtime
 * configuration (DS009 "Request parser").
 */
import '../lib/env-aliases.mjs';
import os from 'node:os';
import {startServer} from '../server/http.mjs';
import {assert} from '../lib/util.mjs';

const host = process.env.CHATSOP_HOST ?? '0.0.0.0';
const port = Number(process.env.CHATSOP_PORT ?? 9999);

const server = await startServer({host, port, ...(process.env.CHATSOP_CONFIG ? {configPath: process.env.CHATSOP_CONFIG} : {})});
const address = server.address();
assert(address && typeof address === 'object', 'Server did not report an address');
const shown = host === '0.0.0.0'
  ? ['127.0.0.1', ...Object.values(os.networkInterfaces()).flat().filter(entry => entry && entry.family === 'IPv4' && !entry.internal).map(entry => entry.address)]
  : [host];

console.log(`\nMRP-LLM server on ${host}:${address.port}`);
console.log('\nOpen the home page in a browser, sign in, then use Chat, Experiments, Admin and Docs:');
for (const base of shown) console.log(`  home          : http://${base}:${address.port}/`);
const [first] = shown;
console.log(`\n  chat          : http://${first}:${address.port}/chat`);
console.log(`  experiments   : http://${first}:${address.port}/experiments`);
console.log(`  admin         : http://${first}:${address.port}/admin`);
console.log(`  documentation : http://${first}:${address.port}/docs/`);
console.log(`  chat API      : http://${first}:${address.port}/v1/chat/completions  (bearer token or session cookie)`);
if (shown.length > 1) console.log('  (the same paths work on every address listed above)');
if (server.auth?.configured) {
  console.log('  authentication: administrator password already set');
} else if (server.auth?.apiKey) {
  console.log('  authentication: open the home URL and choose the administrator password (MRP_API_KEY is accepted meanwhile)');
} else {
  console.log('  authentication: open the home URL in a browser and choose the administrator password');
}
console.log(`\nFormalizer: ${server.queryParser?.settings.strategy ?? 'LocalLLMStepByStep'}, tier ladder ${(server.queryParser?.settings.models ?? []).join(' -> ') || '(none configured)'}; without its first tier the chat answers parse_unavailable (503). The home page shows the state.`);
if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') console.log('Remote binding: the documentation path is unauthenticated, so expose this only on a trusted network.');
console.log('Stop with Ctrl+C.\n');

// A managed local model server (queryParser.local with an endpoint or a GGUF) is a child process: stop it on exit.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await server.queryParser?.stop?.().catch(() => {});
  process.exit(0);
});
