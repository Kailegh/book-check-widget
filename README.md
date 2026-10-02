# Madrid Libraries for Goodreads

A Chrome extension that marks every book you see on Goodreads with a dot saying whether you
can borrow it from a Madrid public library right now, and which branches have it.

| Dot | Meaning |
|---|---|
| 🟢 | On the shelf right now in one of **your** chosen libraries |
| 🟡 | On the shelf right now, but only in other libraries |
| 🔴 | Nothing on the shelf — either not in the catalogue, or every copy is out |

Hovering the dot lists the branches with their real status, including
`Disponible después de 21/10/2026` for copies that are out, so you can decide to reserve one.

## Install

```bash
npm install
npm run build          # compiles dist/ui.css — the extension needs this
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked** and
select this directory. The options page opens on first install: pick your libraries there.

Two pages check themselves as soon as they load: your **Want to Read** shelf and any single
**book page**. Those are where "can I borrow this?" is the actual question, and a book page is
only one lookup. Everywhere else — other shelves, Listopia, search, author pages — waits for
you: click the toolbar button and press **Comprobar esta página**. That covers Listopia,
search, author pages, other shelves, and **Recommendations**.

Untick *Comprobar sola en «Want to Read» y en fichas de libro* in the options to make every
page wait for the button.

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how it works, the undocumented catalogue
  protocol it depends on, and why several non-obvious decisions are the way they are.
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — supporting other Spanish provinces (pick a province,
  then its libraries), and what has to change for it.

## How it works

Everything runs in the browser; there is no server.

```
Goodreads page
  └─ content/extract.js ....... finds books (microdata, My Books table, or JSON-LD)
  └─ content/goodreads.js ..... queues only the books scrolled into view; decides
  │                              which pages may check themselves
  └─ content/badge.js ......... dot over each cover; one shared overlay for the card
        │  chrome.runtime.sendMessage
        ▼
  bg/service_worker.js ........ serializes every upstream request, 400 ms apart
  bg/lookup.js ................ the per-book pipeline
       ├─ bg/opac.js ........... Comunidad de Madrid collective catalogue (absysNET)
       ├─ bg/openlibrary.js .... fallback: what is this book called in Spanish?
       ├─ bg/match.js .......... scoring, and the colour decision
       └─ bg/cache.js .......... chrome.storage.local, two expiry tiers
```

### The catalogue

One catalogue covers both networks: the Madrid city municipal libraries were folded into the
Comunidad de Madrid collective catalogue in 2017. `data/libraries.json` holds all **346**
libraries and branches — including the 49 Madrid city `BP` libraries by district, Bibliometro
and the bibliobuses — scraped straight from the catalogue's own branch selector:

```bash
npm run libraries      # regenerates data/libraries.json
```

### Matching books, and why it is the weak point

The catalogue **cannot be searched by ISBN**. Lookups therefore go by title and author, which
means matching is fuzzy. Three things keep it honest:

1. The catalogue indexes *uniform titles*, so the English title Goodreads shows usually finds
   the Spanish translation on its own ("The Name of the Wind" → *El nombre del viento*).
2. Results carry their ISBNs even though you cannot search by them. When one matches an ISBN
   we already know, the match is **confirmed** and shown as such.
3. Otherwise the hover card labels it *coincidencia probable*, rather than pretending.

Open Library is consulted only when the catalogue returns nothing plausible, or returns only
foreign-language editions — it supplies the Spanish title to search instead.

Two catalogue quirks the code works around, both found by probing the live service:

- A repeated word breaks its title index. `Tomorrow, and Tomorrow, and Tomorrow` returns
  nothing; `tomorrow` finds *Mañana, y mañana, y mañana*. Queries use distinct words only.
- Pages are ISO-8859-1. Both request bodies and responses are encoded as latin-1, or accented
  titles and author names silently stop matching.

### Being a good guest

The library catalogue is a public service, not an API. So: at most three requests in flight
across all tabs, spaced out; only books actually scrolled into view are looked up; availability
is cached for 6 hours and translated titles for 90 days. A page you revisit costs nothing.

That works out to roughly 1.4 requests a second while you are actively scrolling, and nothing
at all when you are not. The lane count in `src/bg/service_worker.js` is a ceiling chosen for
that reason rather than a performance dial — most of the remaining wait is the catalogue's own
response time, so raising it buys little and costs restraint.

## Development

```bash
npm test               # 34 tests: parsers, matching, extraction
npm run watch          # rebuild CSS on change
```

If you change how books are matched, what the colours mean, or the shape of a verdict, bump
`CACHE_VERSION` in `src/bg/cache.js`. Stored verdicts live six hours and will otherwise keep
showing the old answer, which is indistinguishable from the fix not working.

Tests run against markup captured from the live Goodreads and catalogue pages, kept in
`test/fixtures/`. After editing anything under `src/`, run `npm run build`, press the reload
button on `chrome://extensions`, **and refresh the Goodreads tab**. Reloading the extension
orphans the script already injected into open tabs; the extension notices and asks you to
refresh rather than failing silently, but only a refresh actually loads the new code.

## Known limitations

- **My Books and author pages** are matched by selector but were never confirmed against a
  logged-in session; if dots do not appear there, the selectors in
  `src/content/extract.js` are the place to look.
- Books whose Spanish edition Open Library does not know, and whose catalogue record carries
  no uniform title, will miss the translation and may read yellow when a Spanish copy is in
  fact on your shelf. *The Goldfinch* is a current example.
- Both parsers depend on scraped HTML. They are isolated in `src/bg/opac.js`, and a parse
  failure degrades to a grey dot rather than a wrong colour.
