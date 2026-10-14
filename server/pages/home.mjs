/** Server home page: sign-in state, whether the administrator password exists, the state of the formalizer (step by step, with its tier ladder) and large links
 * to the chat, the experiments, the admin page and the documentation. */
import {escapeHtml, layout} from './layout.mjs';

export function homePage({signedIn, configured, passwordStore = true, ready, codingAgent = null}) {
  const account = !passwordStore
    ? '<li>Browser sign-in is not enabled on this server instance (bearer tokens only).</li>'
    : signedIn
      ? '<li><b class="ok">Signed in</b> as administrator.</li>'
      : configured
        ? '<li><b class="bad">Not signed in.</b> <a href="/login?next=%2F">Sign in</a> to use the chat and the admin page.</li>'
        : '<li><b class="bad">No administrator password yet.</b> <a href="/login?next=%2F">Choose it now</a>; until then the chat API stays locked.</li>';
  const password = passwordStore ? `<li>Administrator password: ${configured ? '<span class="ok">set</span>' : '<span class="bad">not set</span>'}</li>` : '';
  const chain = codingAgent?.models?.length ? ` Tier ladder: <code>${codingAgent.models.map(escapeHtml).join('</code>, <code>')}</code>.` : '';
  const model = ready
    ? `<li>Formalizer (${escapeHtml(codingAgent?.strategy ?? 'LocalLLMStepByStep')}): <b class="ok">ready</b>.${chain} Chat answers are available.</li>`
    : `<li>Formalizer (${escapeHtml(codingAgent?.strategy ?? 'LocalLLMStepByStep')}): <b class="bad">not available</b>${codingAgent?.reason ? ' (' + escapeHtml(codingAgent.reason) + ')' : ''}.${chain} Without it the chat answers "parse_unavailable" (HTTP 503); documentation, admin and the experiments pages work regardless.</li>`;
  const tile = (href, title, text) => `<a class="tile" href="${href}"><b>${title}</b><span>${text}</span></a>`;
  const body = `<main class="wrap"><h1>MRP-LLM server</h1>
<section class="card" aria-label="Status"><ul class="plain">${account}${password}${model}</ul></section>
<div class="grid">
${tile('/chat', 'Chat', 'Talk to a model in any language; every answer shows how it was made: translation, reflex, formalization, linking, retrieval, route, verification, voice and latency.')}
${tile('/models', 'Symbolic Models', 'Symbolic Models (a knowledge base plus one strategy per pipeline slot), their FAQ and review queue, and the model gateway: API keys, Ploinky tiers and the real models behind them.')}
${tile('/experiments', 'Experiments', 'Project history: every task and experiment, topic notes, reports, the live journal and gates, open questions.')}
${tile('/admin', 'Admin', 'Server status, API tokens for scripts and SDKs.')}
${tile('/docs/', 'Documentation', 'Runtime, wiki and the design specifications.')}
</div></main>`;
  return layout({title: 'MRP-LLM', active: 'home', signedIn, body});
}
