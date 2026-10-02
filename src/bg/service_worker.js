// Message router for the extension.
//
// Content scripts own the per-page queue (they decide which books are visible and in what
// order). This worker owns throughput and politeness: a small pool of lanes, each with its
// own catalogue session, so several books are resolved at once without any two requests
// racing over the session token the OPAC keeps rotating.

import { lookup } from './lookup.js';
import { createSession } from './opac.js';
import { getSettings } from './settings.js';
import * as cache from './cache.js';

// Three lanes is a deliberate ceiling. The catalogue answers in roughly 0.3–2s, so three
// in flight is well under a request per second each — comparable to a person clicking
// through the OPAC, and far short of hammering a public service.
const LANES = 3;
const SPACING_MS = 250;

const lanes = Array.from({ length: LANES }, () => ({
  opac: createSession(),
  busy: false,
}));

const waiting = [];

// Entries written by an older build can outlive the fix that made them wrong, so the store
// is checked against the current cache version before anything is served from it.
const ready = cache.ensureVersion()
  .then(({ cleared }) => { if (cleared) console.info(`[bcw] cleared ${cleared} entries from an older build`); })
  .catch(() => {});

function acquire() {
  const free = lanes.find((lane) => !lane.busy);
  if (free) {
    free.busy = true;
    return Promise.resolve(free);
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release(lane) {
  // A short gap before the lane is reused, so a burst stays a trickle.
  setTimeout(() => {
    const next = waiting.shift();
    if (next) next(lane);
    else lane.busy = false;
  }, SPACING_MS);
}

async function onLane(task) {
  const lane = await acquire();
  try {
    return await task(lane.opac);
  } finally {
    release(lane);
  }
}

const handlers = {
  async settings() {
    return getSettings();
  },

  async check({ book }) {
    await ready;
    const settings = await getSettings();
    return onLane((opac) => lookup(book, settings, opac));
  },

  /** The page's CSP can block a content script from fetching our own CSS; the worker cannot
   *  be blocked, so it serves the file on request. */
  async styles() {
    const response = await fetch(chrome.runtime.getURL('dist/ui.css'));
    return response.text();
  },

  async openRecord({ titn }) {
    await chrome.tabs.create({ url: await onLane((opac) => opac.recordUrl(titn)) });
    return { opened: true };
  },

  async clearCache({ tier }) {
    for (const lane of lanes) lane.opac.reset();
    return { removed: await cache.clear(tier) };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message)
    .then((value) => respond({ ok: true, value }))
    .catch((error) => respond({ ok: false, error: String(error?.message ?? error) }));
  return true; // keep the channel open for the async reply
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await chrome.runtime.openOptionsPage();
});
