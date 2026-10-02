// Where the extension is allowed to check books without being asked.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import test from 'node:test';

const extract = readFileSync('src/content/extract.js', 'utf8');
const controller = readFileSync('src/content/goodreads.js', 'utf8');

/** Load the content scripts against a URL and report whether they scanned on their own. */
async function autoScanned(url, { autoCheck = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url, runScripts: 'outside-only' });
  const { window } = dom;

  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.chrome = {
    runtime: {
      id: 'test-extension',   // present while the extension context is alive
      lastError: null,
      sendMessage: (message, respond) => respond({ ok: true, value: { preferred: [], autoCheck } }),
      onMessage: { addListener() {} },
      getURL: (path) => `chrome-extension://test/${path}`,
    },
  };

  window.eval(extract);
  let scanned = false;
  const real = window.__bcw.collectBooks;
  window.__bcw.collectBooks = (...args) => { scanned = true; return real(...args); };
  window.__bcw.createBadge = async () => ({ set() {}, remove() {} });

  window.eval(controller);
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the settings promise settle
  return scanned;
}

test('the Want to Read shelf checks itself', async () => {
  assert.equal(await autoScanned('https://www.goodreads.com/review/list/1234-me?shelf=to-read'), true);
  assert.equal(await autoScanned('https://www.goodreads.com/review/list/1234-me?ref=nav_mybooks&shelf=to-read'), true);
});

test('a single book page checks itself', async () => {
  assert.equal(await autoScanned('https://www.goodreads.com/book/show/186074.The_Name_of_the_Wind'), true);
});

test('other shelves and browsing pages wait for the button', async () => {
  assert.equal(await autoScanned('https://www.goodreads.com/review/list/1234-me?shelf=read'), false);
  assert.equal(await autoScanned('https://www.goodreads.com/review/list/1234-me'), false,
    'the default "all" view is not the Want to Read shelf');
  assert.equal(await autoScanned('https://www.goodreads.com/list/show/1.Best_Books_Ever'), false);
  assert.equal(await autoScanned('https://www.goodreads.com/search?q=sapiens'), false);
});

test('turning the setting off stops even the allowed pages', async () => {
  assert.equal(await autoScanned('https://www.goodreads.com/book/show/186074.X', { autoCheck: false }), false);
});

test('an extension reload leaves the page quiet, not throwing', async () => {
  // Reloading the extension orphans the injected script: it keeps running, but every
  // chrome.* call throws "Extension context invalidated".
  const dom = new JSDOM('<!doctype html><html><body></body></html>',
    { url: 'https://www.goodreads.com/book/show/1.X', runScripts: 'outside-only' });
  const { window } = dom;

  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.chrome = {
    runtime: {
      get id() { throw new Error('Extension context invalidated.'); },
      sendMessage() { throw new Error('Extension context invalidated.'); },
      onMessage: { addListener() {} },
      getURL: (path) => path,
    },
  };

  window.eval(extract);
  assert.equal(window.__bcw.extensionAlive(), false, 'the dead context is detected, not thrown on');

  window.__bcw.createBadge = async () => ({ set() {}, remove() {} });
  let threw = null;
  window.addEventListener('unhandledrejection', (event) => { threw = event.reason; });
  window.eval(controller);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(threw, null, 'no uncaught rejection escapes');
});
