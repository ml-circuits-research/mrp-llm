/**
 * MRP-LLM environment names: every `MRP_<NAME>` variable is also read as `CHATSOP_<NAME>`, the name the symbolic core uses
 * (for example MRP_PORT, MRP_HOST, MRP_API_KEY, MRP_CONFIG, MRP_CHAT_DATA, MRP_WARMUP). An explicit CHATSOP_ variable wins.
 * Imported first by the entry points (tools/serve-local.mjs, server/http.mjs, server/cli.mjs).
 */
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith('MRP_')) continue;
  const core = 'CHATSOP_' + key.slice(4);
  if (process.env[core] === undefined) process.env[core] = value;
}
