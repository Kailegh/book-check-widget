// The hover card must live in a page-level overlay, not inside the badge pinned over the
// cover: anything inside that host is croppable by Goodreads' own overflow and loses
// stacking fights with other badges.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import test from 'node:test';

const badgeScript = readFileSync('src/content/badge.js', 'utf8');

function setup({ cssFetch = 'ok', workerStyles = true } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="cover" style="overflow:hidden"><img id="img" /></div></body></html>',
    { url: 'https://www.goodreads.com/list/show/1', runScripts: 'outside-only' },
  );
  const { window } = dom;

  // jsdom has no constructable stylesheets, and the sheet's content is irrelevant here.
  window.CSSStyleSheet = class { replaceSync() {} };
  window.fetch = async () => {
    if (cssFetch === 'throws') throw new TypeError('Failed to fetch');  // blocked by page CSP
    if (cssFetch === 'notok') return { ok: false, text: async () => '' };
    return { ok: true, text: async () => '' };
  };
  window.chrome = {
    runtime: {
      id: 'test-extension',
      getURL: (path) => path,
      lastError: null,
      sendMessage: (message, respond) => {
        if (message?.type === 'styles') return respond?.(workerStyles ? { ok: true, value: '' } : null);
        return respond?.({ ok: true, value: '' });
      },
    },
  };

  window.eval(badgeScript);
  return window;
}

const verdict = {
  colour: 'green',
  confidence: 'high',
  reason: 'En la estantería ahora mismo en CHAMBERÍ. BP José Luis Sampedro.',
  copies: [{ code: 'BPM/BP05', networkCode: 'BPM', branchName: 'CHAMBERÍ. BP José Luis Sampedro', status: 'available', statusText: 'Disponible', signature: 'Sala adultos N ROT nom' }],
  hidden: 3,
  titn: '2142242',
  matchedTitle: 'El nombre del viento',
};

test('the dot mounts over the cover, the card does not', async () => {
  const window = setup();
  const badge = await window.__bcw.createBadge({ id: '1', mount: window.document.getElementById('img') });
  badge.set('green', verdict);

  // The overlay is built on first hover, so provoke one.
  window.document.querySelector('[data-bcw="1"]').shadowRoot.querySelector('.js-dot')
    .dispatchEvent(new window.MouseEvent('mouseenter'));
  await new Promise((resolve) => setTimeout(resolve, 5));

  const cover = window.document.getElementById('cover');
  assert.ok(cover.querySelector('[data-bcw="1"]'), 'the dot is pinned inside the cover container');
  assert.equal(cover.querySelector('[data-bcw-layer]'), null, 'the card layer is NOT inside it');

  const layer = window.document.body.querySelector('[data-bcw-layer]');
  assert.ok(layer, 'the card layer hangs off the body');
  assert.equal(layer.parentElement, window.document.body);
  assert.equal(layer.style.position, 'fixed');
  assert.equal(layer.style.pointerEvents, 'none', 'the sheet must not swallow page clicks');
});

test('one overlay is shared by every badge', async () => {
  const window = setup();
  const { document } = window;
  for (const id of ['1', '2', '3']) {
    const img = document.createElement('img');
    document.body.append(img);
    await window.__bcw.createBadge({ id, mount: img });
  }
  // The layer is built on first hover, so provoke one.
  const first = document.querySelector('[data-bcw="1"]').shadowRoot.querySelector('.js-dot');
  first.dispatchEvent(new window.MouseEvent('mouseenter'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(document.body.querySelectorAll('[data-bcw-layer]').length, 1);
});

test('hovering renders the verdict into the card', async () => {
  const window = setup();
  const badge = await window.__bcw.createBadge({ id: '1', mount: window.document.getElementById('img') });
  badge.set('green', verdict);

  const dot = window.document.querySelector('[data-bcw="1"]').shadowRoot.querySelector('.js-dot');
  dot.dispatchEvent(new window.MouseEvent('mouseenter'));
  await new Promise((resolve) => setTimeout(resolve, 5));

  const card = window.document.body.querySelector('[data-bcw-layer]').shadowRoot.firstElementChild;
  assert.ok(!card.classList.contains('hidden'), 'the card is shown');
  assert.match(card.textContent, /José Luis Sampedro/);
  assert.match(card.textContent, /y 3 ejemplares más/);
  assert.match(card.textContent, /Ver en el catálogo/);
  assert.ok(!card.textContent.includes('coincidencia probable'), 'an ISBN-confirmed match is not hedged');
});

test('the card survives the pointer leaving the dot, then closes', async () => {
  const window = setup();
  const badge = await window.__bcw.createBadge({ id: '1', mount: window.document.getElementById('img') });
  badge.set('green', verdict);
  const dot = window.document.querySelector('[data-bcw="1"]').shadowRoot.querySelector('.js-dot');
  dot.dispatchEvent(new window.MouseEvent('mouseenter'));
  await new Promise((resolve) => setTimeout(resolve, 5));

  const card = window.document.body.querySelector('[data-bcw-layer]').shadowRoot.firstElementChild;
  dot.dispatchEvent(new window.MouseEvent('mouseleave'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(!card.classList.contains('hidden'), 'still open while the pointer travels to it');

  card.dispatchEvent(new window.MouseEvent('mouseenter'));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(!card.classList.contains('hidden'), 'reaching the card cancels the close');

  card.dispatchEvent(new window.MouseEvent('mouseleave'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(card.classList.contains('hidden'), 'leaving the card closes it');
});

test('a CSS fetch blocked by the page CSP still produces a dot', async () => {
  const window = setup({ cssFetch: 'throws' });
  const badge = await window.__bcw.createBadge({ id: '1', mount: window.document.getElementById('img') });
  badge.set('green', verdict);

  const dot = window.document.querySelector('[data-bcw="1"]')?.shadowRoot.querySelector('.js-dot');
  assert.ok(dot, 'the dot is created from the worker-supplied stylesheet');
  assert.match(dot.className, /bg-emerald-500/);
});

test('losing the stylesheet entirely still produces a dot', async () => {
  const window = setup({ cssFetch: 'throws', workerStyles: false });
  const badge = await window.__bcw.createBadge({ id: '1', mount: window.document.getElementById('img') });
  badge.set('red', { ...verdict, colour: 'red' });

  const dot = window.document.querySelector('[data-bcw="1"]')?.shadowRoot.querySelector('.js-dot');
  assert.ok(dot, 'styling is best-effort; the dot is not');
  assert.match(dot.className, /bg-rose-500/);
});

test('a failed stylesheet is not memoised into every later badge', async () => {
  // The original bug: `sheetPromise ??= fetch(...)` cached the REJECTED promise, so one
  // transient failure left the whole page permanently dotless.
  const window = setup({ cssFetch: 'throws' });
  for (const id of ['1', '2', '3']) {
    const img = window.document.createElement('img');
    window.document.body.append(img);
    const badge = await window.__bcw.createBadge({ id, mount: img });
    badge.set('yellow', { ...verdict, colour: 'yellow' });
    assert.ok(window.document.querySelector(`[data-bcw="${id}"]`), `badge ${id} was created`);
  }
});
