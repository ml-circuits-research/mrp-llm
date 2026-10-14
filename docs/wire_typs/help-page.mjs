const embedded = window.parent !== window;
if (embedded) {
  document.querySelector('[data-include]')?.remove();
} else {
  await import('../partials-loader.mjs');
}
