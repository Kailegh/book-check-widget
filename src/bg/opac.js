// Client for the Comunidad de Madrid collective catalogue (absysNET OPAC).
//
// Protocol notes, established by probing the live service:
//   * The base URL answers with a meta-refresh carrying a session token. Every later
//     request goes through /<token>/NT1. One token serves many searches, but it is
//     sometimes rotated, so we always adopt the token the latest response hands back.
//   * Searching is a POST with ACC=131. ISBN is not an indexed field, so lookups go by
//     title + author and are disambiguated afterwards against ISBNs in the result list.
//   * Responses are ISO-8859-1. Decoding and encoding both matter: accented titles and
//     author names will not match otherwise.
//   * MV3 service workers have no DOMParser, so parsing is string based. The markup
//     cooperates: copy rows carry data-disp, and branches carry sucosu/sudesc spans.

const HOST = 'https://gestiona.comunidad.madrid';
const BASE = `${HOST}/biblio_publicas/cgi-bin/abnetopac`;

const DECODER = new TextDecoder('iso-8859-1');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&(\w+);/g, (match, name) => ENTITIES[name] ?? match);
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Encode a form body as latin-1 percent-escapes, which is what the OPAC expects. */
function encodeForm(fields) {
  return Object.entries(fields)
    .map(([key, value]) => {
      const bytes = [...String(value)].map((char) => {
        const code = char.codePointAt(0);
        return code < 256 ? code : 63; // '?' for anything outside latin-1
      });
      const escaped = bytes
        .map((byte) => (/[A-Za-z0-9*\-._]/.test(String.fromCharCode(byte))
          ? String.fromCharCode(byte)
          : byte === 32 ? '+' : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`))
        .join('');
      return `${key}=${escaped}`;
    })
    .join('&');
}

const TIMEOUT_MS = 20000;

/**
 * One conversation with the catalogue.
 *
 * The session token is per-instance on purpose: it rotates, and two concurrent requests
 * sharing one token would overwrite each other's. Each lane of the request pool therefore
 * gets its own session.
 */
export function createSession() {
  let token = null;

  async function request(url, body, attempt = 0) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
        body,
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(`OPAC responded ${response.status}`);
      const html = DECODER.decode(await response.arrayBuffer());
      token = html.match(/abnetopac\/([A-Za-z0-9]+)/)?.[1] ?? token;
      return html;
    } catch (error) {
      // The OPAC occasionally stalls under load; one retry of the same request covers it.
      if (attempt === 0) return request(url, body, 1);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function ensure() {
    if (!token) await request(BASE);
    if (!token) throw new Error('could not obtain an OPAC session token');
    return token;
  }

  return {
    reset() { token = null; },

    /** Warm the session up front so the first real query does not pay for it. */
    open: ensure,

    /** Search by title and author. ISBN is not an indexed field; see docs/ARCHITECTURE.md. */
    async search({ title, author }) {
      const session = await ensure();
      return parseResults(await request(`${BASE}/${session}/NT1`, encodeForm({
        ACC: '131',
        START: '1',
        FORM: '2',
        xsnf12: '0',
        xsqf12: title,
        xsqf03: author ?? '',
      })));
    },

    /** Every branch holding this record, keyed by the catalogue's stable record number. */
    async fetchHoldings(titn) {
      const session = await ensure();
      return parseHoldings(await request(`${BASE}/${session}/NT1?TITN=${titn}`));
    },

    /**
     * A URL a human can open. A bare ?TITN= link loses the parameter to the session
     * redirect, so the link has to be built against a live session when it is opened.
     */
    async recordUrl(titn) {
      return `${BASE}/${await ensure()}/NT1?TITN=${titn}`;
    },
  };
}

export function parseResults(html) {
  const list = html.match(/<ol[^>]*class="c-docs[\s\S]*?<\/ol>/)?.[0];
  if (!list) return [];

  const results = [];
  for (const item of list.split(/<li\b/).slice(1)) {
    const doc = Number(item.match(/ACC=165&(?:amp;)?DOC=(\d+)/)?.[1]);
    if (!doc || results.some((entry) => entry.doc === doc)) continue;

    const span = (className) => {
      const match = item.match(new RegExp(`class="[^"]*${className}[^"]*"[^>]*>([\\s\\S]*?)<\\/span>`));
      return match ? stripTags(match[1]) : '';
    };
    const marc = (field) => [...item.matchAll(new RegExp(`class="js-${field}"[^>]*>([^<]*)<`, 'g'))]
      .map(([, value]) => decodeEntities(value).trim())
      .filter(Boolean);

    // js-T240 is the uniform title, which for a translation records the original
    // title ("The name of the wind. Español"). That is what lets an English
    // Goodreads title match a Spanish edition directly.
    const originalTitles = marc('T240').map((value) => value.replace(/\.\s*[^.]*$/, '').trim());
    const isbns = [...new Set([...marc('T020a'), ...marc('T020aq')]
      .map((value) => value.replace(/[^0-9Xx]/g, ''))
      .filter((value) => value.length === 13 || value.length === 10))];

    results.push({
      doc,
      titn: marc('TITN')[0] ?? null,
      title: span('c-docs_title').replace(/\s*\/\s*$/, ''),
      author: span('c-docs_author'),
      originalTitles,
      language: marc('LENG')[0] ?? null,
      isbns,
    });
  }
  return results;
}

const STATUS_PATTERNS = [
  [/^disponible$/i, 'available'],
  [/disponible\s+despu/i, 'on_loan'],
  [/en\s+proceso/i, 'pending'],
  [/no\s+disponible/i, 'unavailable'],
];

export function classifyStatus(raw) {
  const text = decodeEntities(raw ?? '').trim();
  const match = STATUS_PATTERNS.find(([pattern]) => pattern.test(text));
  return {
    status: match ? match[1] : 'unknown',
    statusText: text,
    dueDate: text.match(/(\d{2}\/\d{2}\/\d{4})/)?.[1] ?? null,
  };
}

/** Shelf location and call number, e.g. "Sala adultos 930 HAR sap". */
function parseSignature(row) {
  const cell = row.match(/class="icm_locSign"[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? '';
  const parts = [...cell.matchAll(/<span(?![^>]*class)[^>]*>([^<]+)<\/span>/g)]
    .map(([, text]) => decodeEntities(text).trim())
    .filter(Boolean);
  return [...new Set(parts)].join(' ').slice(0, 120);
}

/**
 * Parse the holdings accordion into a flat list of copies.
 * Returns [{ networkCode, networkName, branchCode, branchName, code, signature, status, statusText, dueDate }]
 * where `code` is the "NETWORK/BRANCH" form used by data/libraries.json.
 */
export function parseHoldings(html) {
  const copies = [];
  // Each branch block opens with a hidden varJSONcopiasSuc paragraph carrying its codes.
  const blocks = html.split(/<p class="varJSONcopiasSuc\b/).slice(1);

  for (const block of blocks) {
    const networkCode = block.match(/class="sucobi">([^<]*)</)?.[1]?.trim();
    const branchCode = block.match(/class="sucosu">([^<]*)</)?.[1]?.trim();
    const branchName = decodeEntities(block.match(/class="sudesc">([^<]*)</)?.[1]?.trim() ?? '');
    if (!networkCode || !branchCode) continue;

    // Rows belonging to this branch end where the next branch block begins.
    const rows = [...block.matchAll(/<tr[^>]*data-disp="([^"]*)"[\s\S]*?<\/tr>/g)];
    for (const [row, rawStatus] of rows) {
      copies.push({
        networkCode,
        networkName: '',
        branchCode,
        branchName,
        code: `${networkCode}/${branchCode}`,
        signature: parseSignature(row),
        ...classifyStatus(rawStatus),
      });
    }
  }

  // Attach network display names, which live in the enclosing copias_data block.
  const networkNames = new Map(
    [...html.matchAll(/class="bicobi">([^<]*)<\/span>\s*<span class="bidesc">([^<]*)</g)]
      .map(([, code, name]) => [code.trim(), decodeEntities(name.trim())]),
  );
  for (const copy of copies) copy.networkName = networkNames.get(copy.networkCode) ?? '';

  return copies;
}
