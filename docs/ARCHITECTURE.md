# Architecture

Everything runs in the browser. There is no server, no account, and nothing leaves your
machine except the catalogue searches themselves.

## Data flow

```
Goodreads page
  │
  ├─ content/extract.js ....... finds books on the page → {id, title, author, isbn?, mount}
  ├─ content/goodreads.js ..... decides what to look up and when; owns the queue
  └─ content/badge.js ......... a dot per cover; ONE shared overlay for the hover card
        │ chrome.runtime.sendMessage({type:'check', book})
        ▼
  bg/service_worker.js ........ routes messages; serializes upstream requests
        │
  bg/lookup.js ................ the per-book pipeline
       ├─ bg/opac.js ........... the Madrid collective catalogue (absysNET)
       ├─ bg/openlibrary.js .... fallback: what is this book called in Spanish?
       ├─ bg/match.js .......... scoring and the colour decision (pure functions)
       └─ bg/cache.js .......... chrome.storage.local, three expiry tiers
```

The queue lives in the **content script**, not the worker, because an MV3 service worker is
evicted whenever it goes idle while a page context lives as long as its tab. The worker owns
throughput and politeness instead — see below.

## Throughput

Measured against the live catalogue: a warm search costs 260–900 ms and a holdings page
270 ms–2.2 s, with a cold session adding ~3 s once. Latency, not volume, is the cost.

Three things exploit that:

- **A pool of three lanes** (`service_worker.js`), each with **its own catalogue session**.
  Per-lane sessions are not optional: the OPAC rotates its token on responses, so two
  concurrent requests sharing one session would overwrite each other's.
- **Parallel editions.** `lookup.js` fetches the best-matching edition alone — it is usually
  the one with the most copies, and if it is already on a preferred shelf nothing else can
  beat green. Only when that does not settle it are the remaining editions fetched, all at
  once rather than one after another.
- **In-flight de-duplication.** The same book in two tabs, or twice on one page, waits on one
  lookup instead of repeating it.

Nine uncached books: **82 s serially, 33 s pooled** — and the old path additionally paid
400 ms between every one of its 44 requests.

Three lanes is a deliberate ceiling, not a tuning knob to raise. At observed latencies it
works out to ~1.4 requests/second, comparable to a person clicking through the OPAC. The
viewport gating keeps it bursty rather than sustained, and the caches mean a revisit costs
nothing. Raising `LANES` or dropping `SPACING_MS` to make it feel snappier would trade that
restraint for very little: the remaining time is the catalogue's own latency.

## The catalogue protocol

The Comunidad de Madrid collective catalogue runs **absysNET** (Baratz). The Madrid *city*
municipal network was folded into it in 2017, so one catalogue covers both — 346 libraries
and branches. None of this is documented publicly; it was established by probing the live
service, and each point below is load-bearing:

| Finding | Consequence |
|---|---|
| The base URL returns a meta-refresh carrying a session token; later requests go through `/<token>/NT1` | `getSession()` scrapes the token and reuses it |
| One session serves many searches, but the token sometimes rotates | Always adopt the token the latest response hands back |
| Search is `POST` with `ACC=131`; fields are `xsqf12`+`xsnf12=0` (title), `xsqf03` (author), `subcat` (branch) | `search()` in `opac.js` |
| **ISBN is not an indexed field** — every query form returns zero | Matching must be fuzzy; see below |
| Results *do* carry their ISBNs in a hidden MARC block | ISBNs verify a candidate even though they cannot find one |
| `js-T240` holds the **uniform title**: for a translation, the original title | An English Goodreads title finds the Spanish edition directly |
| `?TITN=<n>` fetches a record by its stable number | Holdings cache per record and are reused across books |
| Holdings are inlined, no AJAX; copy rows carry `data-disp`, branches carry `sucosu`/`sudesc` | Parsing is structural, not text-scraping |
| Pages are **ISO-8859-1** | Request bodies *and* responses are latin-1, or accents stop matching |
| A repeated word breaks the title index | Queries use distinct significant words only |

Status vocabulary: `Disponible`, `Disponible después de DD/MM/YYYY`, `No disponible`,
`En proceso de petición` → `available` / `on_loan` / `unavailable` / `pending`.

MV3 service workers have **no `DOMParser`**, so all parsing in `opac.js` is string-based.

## Matching, and why it is the weak point

Because the catalogue cannot be searched by ISBN, a book is found by title and author and
then *verified*. `lookup.js:resolve()` runs:

1. Search the catalogue with the Goodreads title, reduced by `coreTitle()` (series suffix and
   subtitle removed) and `searchQuery()` (distinct significant words).
2. Score every result (`match.js:scoreResult`). An ISBN we already know outranks any title
   similarity — different editions share a title, so without this the right one would not
   sort first. Confidence is `high` only when an ISBN confirmed it.
3. If nothing plausible came back, **or only foreign-language editions did**, ask Open Library
   for the Spanish title and search again, ranking old and new results together.
4. Fetch holdings for up to `maxEditions` (4) best matches, preferring Spanish editions since
   they hold far more copies in Madrid. Stop early once a preferred branch has it on the shelf.
5. `decideStatus()` turns the copies into a colour.

The hover card shows *coincidencia probable* whenever no ISBN confirmed the match, rather
than presenting a guess as fact.

## Caching

| Tier | Key | Lifetime | Why |
|---|---|---|---|
| `bridge` | normalized title+author | 90 days | Translated titles do not change |
| `holdings` | record TITN | 6 hours | Loan state does |
| `verdict` | title+author+**chosen branches** | 6 hours | The colour depends on which branches are yours |

Concurrent lookups of the same book share one in-flight promise, so parallel lanes never
duplicate work that the cache has not yet recorded.

**Cached entries outlive the code that wrote them.** A verdict stored by a build with a
matching bug keeps being served from storage for six hours after the bug is fixed, which
looks exactly like the bug not being fixed. `cache.js` therefore carries a `CACHE_VERSION`;
the worker compares it before serving anything and wipes the store on a mismatch. **Bump it
in the same commit as any change to matching, the colour rules, or the verdict shape.**

The verdict key includes a fingerprint of the preferred branches, so changing your libraries
re-decides immediately instead of showing stale dots — and costs no requests, because the
underlying holdings are cached separately per record.

## Why the hover card is not inside the badge

Two bugs, one cause. The card originally lived in the badge's shadow root, pinned over the
cover. That meant any Goodreads ancestor with `overflow: hidden` cropped it, and since every
badge is its own stacking context at the same `z-index`, a dot further down the page painted
over an open card.

The card now lives in **one** page-level overlay hanging off `<body>`: `position: fixed`,
`pointer-events: none` so it never swallows page clicks, with only the card itself
interactive. It is positioned from the dot's `getBoundingClientRect()`, flips above when
there is no room below, and follows on scroll. `test/badge.test.mjs` pins this.

## Surviving an extension reload

Reloading or updating the extension **orphans the content script already injected into open
tabs**: the code keeps running, but every `chrome.*` call throws
`Extension context invalidated`. In development this happens on every reload; in normal use it
happens whenever Chrome updates the extension.

`extract.js` exposes `extensionAlive()` (`Boolean(chrome.runtime?.id)`, itself wrapped in a
`try`, because reading the property can throw). Every call into `chrome.*` checks it first.
When the context dies mid-run the page shuts down cleanly — queue cleared, observers
disconnected, remaining dots switched to *"La extensión se actualizó. Recarga la página."* —
rather than emitting uncaught rejections.

The page must still be refreshed to get the new code; nothing can inject it into a tab that is
already open.

## Styling: why the scale is in pixels

Goodreads ships `html { font-size: 62.5% }` — the 10px-root trick. `rem` always resolves
against the document root, and a shadow root gives no protection, so every Tailwind size
rendered at 62.5% on their pages: a 420px card became 262px and 14px text became 8.75px.

`src/styles/ui.css` therefore pins `--spacing` and the `--text-*` scale to pixels. The values
equal Tailwind's defaults at a 16px root, so the options and popup pages are unaffected.

Tailwind is loaded *into* the shadow roots via `adoptedStyleSheets`, so its reset never
touches Goodreads' own layout and Goodreads' CSS never reaches our markup.

Getting that stylesheet is treated as best-effort. A content script's `fetch` is subject to
the **page's** CSP, and Goodreads' `connect-src` blocks `chrome-extension:` on some pages, so
`badge.js` falls back to asking the service worker (which no page CSP can reach) and then to a
tiny inline stylesheet. Two rules matter here: a failure is never memoised — caching a
rejected promise once left a whole page permanently dotless — and a styling failure never
stops a dot being drawn. `test/badge.test.mjs` covers all three paths.
