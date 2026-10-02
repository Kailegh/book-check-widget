// User settings live in chrome.storage.sync so preferred branches follow the profile.

const DEFAULTS = {
  preferred: [],       // library/branch codes from data/libraries.json, e.g. "BPM/BP05"
  autoCheck: true,     // check on load, on the Want to Read shelf and book pages only
  maxEditions: 4,      // holdings pages fetched per book before giving up
};

export async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}
