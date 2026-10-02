// The dot and its hover card.
//
// The dot sits in a shadow root pinned over each cover. The card does NOT: it lives in one
// page-level overlay, fixed-positioned and shared by every badge. That keeps it out of reach
// of Goodreads' own `overflow: hidden` containers, which otherwise crop it, and sidesteps
// stacking entirely — one overlay above everything beats 50 competing hosts.

(() => {
  const namespace = (window.__bcw ??= {});

  const DOT = {
    pending: { class: 'bg-slate-300 animate-pulse', label: 'Comprobando disponibilidad…' },
    green: { class: 'bg-emerald-500', label: 'Disponible en tus bibliotecas' },
    yellow: { class: 'bg-amber-400', label: 'Disponible en otras bibliotecas' },
    red: { class: 'bg-rose-500', label: 'No disponible ahora' },
    error: { class: 'bg-slate-400', label: 'No se pudo comprobar' },
  };

  const STATUS_STYLE = {
    available: 'text-emerald-700',
    on_loan: 'text-amber-700',
    unavailable: 'text-slate-500',
    pending: 'text-slate-500',
    unknown: 'text-slate-500',
  };

  const DOT_CLASS = 'js-dot block size-[18px] cursor-help rounded-full border-2 border-white shadow-md';

  const CARD_CLASS = 'pointer-events-auto fixed hidden w-[420px] max-w-[calc(100vw-16px)] '
    + 'rounded-xl border border-slate-200 bg-white p-4 text-sm leading-snug text-slate-700 shadow-2xl';

  // Getting the stylesheet is allowed to fail. A content script's fetch is subject to the
  // page's CSP, and Goodreads' connect-src blocks chrome-extension: on some pages, so the
  // service worker — which has no page CSP — is the reliable source. A failure must never
  // stop the dots appearing, and must never be memoised: one bad moment would otherwise
  // leave the page permanently dotless.
  const FALLBACK_CSS = `
    .js-dot { display:block; width:18px; height:18px; border-radius:9999px;
              border:2px solid #fff; box-shadow:0 1px 3px #0003; cursor:help; }
    .bg-emerald-500{background:#10b981} .bg-amber-400{background:#fbbf24}
    .bg-rose-500{background:#f43f5e} .bg-slate-300{background:#cbd5e1}
    .bg-slate-400{background:#94a3b8}`;

  let sheet = null;

  async function loadCss() {
    if (!namespace.extensionAlive()) return FALLBACK_CSS;
    try {
      const response = await fetch(chrome.runtime.getURL('dist/ui.css'));
      if (response.ok) return await response.text();
    } catch {
      // Page CSP blocked it; ask the worker instead.
    }
    const reply = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'styles' }, (value) => resolve(
        chrome.runtime.lastError ? null : value,
      ));
    });
    return reply?.ok ? reply.value : FALLBACK_CSS;
  }

  async function stylesheet() {
    if (sheet) return sheet;
    let css = FALLBACK_CSS;
    try {
      css = await loadCss();
    } catch {
      // Keep the fallback.
    }
    const loaded = new CSSStyleSheet();
    try {
      loaded.replaceSync(css);
    } catch {
      loaded.replaceSync(FALLBACK_CSS);
    }
    sheet = loaded;
    return sheet;
  }

  const escape = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]
  ));

  function copyRow(copy, preferred) {
    const mine = preferred.has(copy.code) || preferred.has(copy.networkCode);
    return `
      <li class="flex gap-2 border-b border-slate-100 py-1.5 last:border-0 ${mine ? 'font-semibold' : ''}">
        <span class="mt-1.5 size-2 shrink-0 rounded-full ${copy.status === 'available' ? 'bg-emerald-500' : 'bg-slate-300'}"></span>
        <span class="min-w-0 flex-1">
          <span class="block text-slate-800">${escape(copy.branchName)}${mine ? ' ★' : ''}</span>
          <span class="block text-xs ${STATUS_STYLE[copy.status] ?? ''}">${escape(copy.statusText)}</span>
          ${copy.signature ? `<span class="block text-xs text-slate-400">${escape(copy.signature)}</span>` : ''}
        </span>
      </li>`;
  }

  function cardMarkup(verdict, preferred) {
    if (!verdict) return '<p class="text-slate-500">Comprobando disponibilidad…</p>';
    if (verdict.failed) {
      return `<p class="text-slate-600">No se pudo consultar el catálogo.</p>
              <p class="mt-1 text-xs text-slate-400">${escape(verdict.error ?? '')}</p>`;
    }

    const copies = verdict.copies ?? [];
    const uncertain = verdict.confidence && verdict.confidence !== 'high';
    return `
      <p class="text-base font-semibold text-slate-900">${escape(DOT[verdict.colour]?.label ?? '')}</p>
      <p class="mt-1 text-slate-600">${escape(verdict.reason)}</p>
      ${verdict.matchedTitle ? `
        <p class="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-500">
          Ficha: <span class="text-slate-700">${escape(verdict.matchedTitle)}</span>
          ${uncertain ? '<span class="ml-1 rounded bg-amber-100 px-1 text-amber-800">coincidencia probable</span>' : ''}
        </p>` : ''}
      ${copies.length ? `
        <ul class="mt-2 max-h-[420px] overflow-y-auto border-t border-slate-200 pt-1">
          ${copies.map((copy) => copyRow(copy, preferred)).join('')}
        </ul>
        ${verdict.hidden ? `<p class="pt-1 text-xs text-slate-400">y ${verdict.hidden} ejemplares más</p>` : ''}
      ` : ''}
      ${verdict.titn ? `
        <button type="button" data-action="open"
          class="mt-3 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
          Ver en el catálogo
        </button>` : ''}`;
  }

  // ---- the shared overlay -------------------------------------------------------------

  let overlay = null;

  async function cardLayer() {
    if (overlay) return overlay;

    const host = document.createElement('div');
    host.dataset.bcwLayer = '';
    // inset:0 with no pointer events: an invisible sheet that only the card itself catches.
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
    document.body.append(host);

    const root = host.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [await stylesheet()];
    const card = document.createElement('div');
    card.className = CARD_CLASS;
    root.append(card);

    overlay = { card, owner: null, closing: null };

    card.addEventListener('mouseenter', () => keepOpen());
    card.addEventListener('mouseleave', () => closeSoon());
    card.addEventListener('click', (event) => {
      if (!event.target.closest('[data-action="open"]') || !overlay.owner?.verdict?.titn) return;
      if (!namespace.extensionAlive()) return;
      try {
        chrome.runtime.sendMessage({ type: 'openRecord', titn: overlay.owner.verdict.titn });
      } catch {
        // The extension was reloaded under us; the page refresh will restore it.
      }
    });
    return overlay;
  }

  /** Below the dot and right-aligned to it, flipped above when there is no room. */
  function place(card, anchor) {
    const dot = anchor.getBoundingClientRect();
    card.classList.remove('hidden');
    const { offsetWidth: width, offsetHeight: height } = card;

    const left = Math.min(Math.max(8, dot.right - width), window.innerWidth - width - 8);
    const below = dot.bottom + 6;
    const top = below + height > window.innerHeight - 8
      ? Math.max(8, dot.top - height - 6)
      : below;

    card.style.left = `${Math.max(8, left)}px`;
    card.style.top = `${top}px`;
  }

  function keepOpen() {
    if (!overlay) return;
    clearTimeout(overlay.closing);
    overlay.closing = null;
  }

  function closeSoon() {
    if (!overlay) return;
    keepOpen();
    // Give the pointer time to travel from the dot to the card, which cancels this.
    overlay.closing = setTimeout(hideCard, 220);
  }

  function hideCard() {
    if (!overlay) return;
    keepOpen();
    overlay.card.classList.add('hidden');
    overlay.owner = null;
    window.removeEventListener('scroll', reposition, true);
  }

  function reposition() {
    if (overlay?.owner) place(overlay.card, overlay.owner.dot);
  }

  async function showCard(owner) {
    const { card } = await cardLayer();
    keepOpen();
    overlay.owner = owner;
    card.innerHTML = cardMarkup(owner.verdict, new Set(namespace.preferred ?? []));
    place(card, owner.dot);
    window.addEventListener('scroll', reposition, true);
  }

  // ---- the dot ------------------------------------------------------------------------

  /** Ensure the cover's container can position our absolutely-placed host element. */
  function anchorFor(mount) {
    const parent = mount.parentElement ?? document.body;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    return parent;
  }

  namespace.createBadge = async function createBadge(book) {
    const host = document.createElement('span');
    host.dataset.bcw = book.id;
    host.style.cssText = 'position:absolute;top:2px;right:2px;z-index:900;';
    anchorFor(book.mount).append(host);

    const root = host.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [await stylesheet()];
    root.innerHTML = `<span tabindex="0" role="button" class="${DOT_CLASS}"></span>`;

    const dot = root.querySelector('.js-dot');
    const owner = { dot, verdict: null };

    dot.addEventListener('mouseenter', () => showCard(owner));
    dot.addEventListener('focus', () => showCard(owner));
    dot.addEventListener('mouseleave', closeSoon);
    dot.addEventListener('blur', closeSoon);

    return {
      set(state, verdict) {
        owner.verdict = verdict ?? null;
        dot.className = `${DOT_CLASS} ${DOT[state].class}`;
        // No `title`: the browser's own tooltip would cover the card we are about to show.
        dot.setAttribute('aria-label', verdict?.reason ?? DOT[state].label);
        if (overlay?.owner === owner) showCard(owner);
      },
      remove: () => {
        if (overlay?.owner === owner) hideCard();
        host.remove();
      },
    };
  };
})();
