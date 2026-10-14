/** Loads the shared header/footer partials of the documentation pages, wires
 * the shared top menu (generated from server/pages/site-menu.mjs), marks the
 * current page in it and, when the pages are served by the ChatSOP server,
 * highlights SOP code blocks with the same renderer as the server pages. */
async function loadPartials() {
  await Promise.all([...document.querySelectorAll('[data-include]')].map(async (slot) => {
    const response = await fetch(slot.dataset.include);
    if (!response.ok) throw new Error(`Cannot load ${slot.dataset.include}`);
    slot.innerHTML = await response.text();
    if (slot.dataset.linkBase) {
      const base = new URL(slot.dataset.linkBase, document.baseURI);
      for (const link of slot.querySelectorAll('a[href]')) {
        link.href = new URL(link.getAttribute('href'), base).href;
      }
    }
  }));
  markCurrentPage();
  bindMenus();
}

/** The menu entry whose target is this page gets aria-current. */
function markCurrentPage() {
  for (const link of document.querySelectorAll('.site-header a[href]')) {
    const target = new URL(link.href, location.href);
    if (target.origin === location.origin && target.pathname === location.pathname && (target.search === '' || target.search === location.search)) {
      link.setAttribute('aria-current', 'page');
      link.closest('details.menu')?.classList.add('active');
    }
  }
}

/** Same behaviour as SITE_MENU_SCRIPT on the server pages: one dropdown open, closed by outside click or Escape. */
function bindMenus() {
  const menus = () => [...document.querySelectorAll('.site-header details.menu')];
  document.addEventListener('toggle', (event) => {
    if (event.target.matches?.('.site-header details.menu') && event.target.open) for (const menu of menus()) if (menu !== event.target) menu.open = false;
  }, true);
  document.addEventListener('pointerdown', (event) => {
    for (const menu of menus()) if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const menu of menus()) if (menu.open) {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });
}

/** A plain-text block is SOP when it is marked so or its first line is a wire header `@name type`. */
const looksLikeSop = (pre) => pre.dataset.sop !== undefined || pre.classList.contains('sop') || pre.querySelector('code.language-sop') || /^\s*@[A-Za-z]\w*\s+[A-Za-z]\w*/.test(pre.textContent);

/**
 * Highlights SOP blocks with the server's shared renderer (/assets/sop-code.mjs,
 * generated from server/pages/sop-code.mjs). Without the server (file:// or a
 * static host) the blocks simply stay plain text.
 */
async function enhanceSop() {
  if (!/^https?:$/.test(location.protocol)) return;
  const blocks = [...document.querySelectorAll('pre')].filter((pre) => {
    const target = pre.querySelector(':scope > code') ?? pre;
    return !pre.dataset.sopRendered && target.children.length === 0 && looksLikeSop(pre);
  });
  if (!blocks.length) return;
  let module;
  try {
    module = await import('/assets/sop-code.mjs');
  } catch {
    return;
  }
  if (!document.getElementById('chatsop-sop-style')) {
    const style = document.createElement('style');
    style.id = 'chatsop-sop-style';
    style.textContent = module.style;
    document.head.append(style);
  }
  for (const pre of blocks) {
    const target = pre.querySelector(':scope > code') ?? pre;
    target.innerHTML = module.render(target.textContent);
    pre.dataset.sopRendered = 'yes';
  }
}

loadPartials().catch((error) => console.error(error)).finally(() => enhanceSop().catch((error) => console.error(error)));
