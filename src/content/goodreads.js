// Page controller: find the books, badge the ones you can actually see, ask the background
// worker about them one at a time.
//
// The queue lives here rather than in the service worker because a page context survives as
// long as the tab does, while an MV3 worker is evicted whenever it goes idle.

(() => {
  const namespace = window.__bcw;
  const badges = new Map();
  const pending = new Map();
  const queue = [];
  const state = { queued: 0, done: 0, running: false, scanned: false };

  const ask = (message) => new Promise((resolve) => {
    if (!namespace.extensionAlive()) { resolve({ ok: false, error: 'reloaded', gone: true }); return; }
    try {
      chrome.runtime.sendMessage(message, (reply) => resolve(
        chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : reply,
      ));
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error), gone: true });
    }
  });

  /** The extension was reloaded or updated while this page stayed open. Stop cleanly. */
  function shutdown() {
    queue.length = 0;
    watcher.disconnect();
    grower.disconnect();
    for (const badge of badges.values()) {
      badge?.set('error', { failed: true, error: 'La extensión se actualizó. Recarga la página.' });
    }
  }

  // Answer the popup straight away: it decides whether this page is supported by whether
  // this listener replies, so it must exist before anything is awaited.
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'scan') { scan(); respond({ ok: true }); return false; }
    if (message?.type === 'progress') {
      respond({ ok: true, value: { ...state, visible: badges.size, waiting: queue.length } });
      return false;
    }
    return false;
  });

  // Colours depend on the chosen branches, so no book is looked up before settings arrive.
  const ready = ask({ type: 'settings' }).then((reply) => {
    // If the worker could not be reached, lookups would fail anyway: stay idle.
    const settings = reply?.value ?? { preferred: [], autoCheck: false };
    namespace.preferred = settings.preferred;
    return settings;
  });

  const payload = ({ title, author, isbn }) => ({ title, author, isbn });

  async function drain() {
    if (state.running) return;
    state.running = true;
    while (queue.length) {
      const book = queue.shift();
      const badge = badges.get(book.id);
      const reply = await ask({ type: 'check', book: payload(book) });
      if (reply?.gone) { shutdown(); break; }
      state.done += 1;
      if (!badge) continue;
      if (reply?.ok) badge.set(reply.value.colour, reply.value);
      else badge.set('error', { failed: true, error: reply?.error });
    }
    state.running = false;
  }

  async function enqueue(book) {
    if (badges.has(book.id)) return;
    badges.set(book.id, null); // claim the slot before awaiting, so nothing enqueues twice
    try {
      await ready;
      const badge = await namespace.createBadge(book);
      badge.set('pending');
      badges.set(book.id, badge);
      queue.push(book);
      state.queued += 1;
      drain();
    } catch (error) {
      // One book that cannot be badged must not stop the rest of the page.
      badges.delete(book.id);
      console.warn('[bcw] could not badge', book.title, error);
    }
  }

  // Only books actually scrolled into view are looked up, so a 100-entry Listopia page
  // costs a handful of requests instead of hundreds.
  const watcher = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const book = pending.get(entry.target);
      if (book) enqueue(book);
    }
  }, { rootMargin: '600px' });  // start a little before they are on screen

  function scan() {
    state.scanned = true;
    for (const book of namespace.collectBooks()) {
      if (badges.has(book.id) || !book.mount) continue;
      // A single book page has nothing to scroll to; check it immediately.
      if (book.detailed) { enqueue(book); continue; }
      pending.set(book.mount, book);
      watcher.observe(book.mount);
    }
  }

  /**
   * Automatic checking is deliberately narrow: the Want to Read shelf, where the question
   * "can I borrow this?" actually applies, and a single book page, which is one lookup.
   * Browsing and search pages still wait for the button.
   */
  function autoCheckApplies() {
    if (/^\/book\/show\//.test(location.pathname)) return true;
    if (/^\/review\/list/.test(location.pathname)) {
      return new URLSearchParams(location.search).get('shelf') === 'to-read';
    }
    return false;
  }

  ready.then((settings) => { if (settings.autoCheck && autoCheckApplies()) scan(); });

  // Goodreads adds rows as you page through shelves, so re-scan when the list grows.
  // Debounced, because inserting our own badges also mutates the page.
  let rescan = null;
  const grower = new MutationObserver(() => {
    if (!state.scanned || rescan) return;
    rescan = setTimeout(() => { rescan = null; scan(); }, 600);
  });
  grower.observe(document.body, { childList: true, subtree: true });
})();
