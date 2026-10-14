const frame = document.getElementById('wire-content');
const links = [...document.querySelectorAll('[data-topic]')];
const topics = new Map(links.map(link => [link.dataset.topic, link]));
const toggle = document.getElementById('toggle-topics');
const state = document.getElementById('help-state');
let selected;

document.querySelector('.skip-help').addEventListener('click', event => {
  event.preventDefault();
  frame.focus();
});

function closeTopics() {
  document.body.classList.remove('topics-open');
  toggle.setAttribute('aria-expanded', 'false');
}

function markTopic(topic) {
  selected = topic;
  for (const link of links) {
    if (link.dataset.topic === topic) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const label = topics.get(topic).textContent;
  frame.title = label + ' — wire help';
  state.textContent = label;
}

function loadTopic() {
  const requested = location.hash.slice(1) || 'overview';
  const topic = topics.has(requested) ? requested : 'overview';
  if (topic !== selected) {
    markTopic(topic);
    frame.src = topics.get(topic).href;
  }
  if (!topics.has(requested)) state.textContent = 'Unknown topic; showing the overview.';
  closeTopics();
}

for (const link of links) {
  link.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    const topic = link.dataset.topic;
    if (location.hash === '#' + topic) loadTopic();
    else location.hash = topic;
  });
}

frame.addEventListener('load', () => {
  const url = new URL(frame.contentWindow.location.href);
  const topic = url.pathname.split('/').pop().replace(/\.html$/, '');
  if (url.origin === location.origin && topics.has(topic)) {
    markTopic(topic);
    if (location.hash !== '#' + topic) history.replaceState(null, '', '#' + topic);
  }
});

toggle.addEventListener('click', () => {
  const open = document.body.classList.toggle('topics-open');
  toggle.setAttribute('aria-expanded', String(open));
  if (open) topics.get(selected)?.focus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('topics-open')) {
    closeTopics();
    toggle.focus();
  }
});
window.addEventListener('hashchange', loadTopic);
loadTopic();
