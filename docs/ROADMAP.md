# Roadmap

Nothing here is built yet. It is written down so the shape of the current code can be judged
against where it is going.

## 1. Beyond Madrid: other provinces

Today the extension is hard-wired to one catalogue. The goal is to pick your **province or
region first, then your libraries within it**.

### What makes this tractable

absysNET (Baratz) is not a Madrid thing — it is the common ILS across much of Spain. The
Comunitat Valenciana runs one at `xlpv.gva.es/abnet/`, and the same vendor's OPAC is in use in
other regions. Where the ILS is shared, the whole of `src/bg/opac.js` is reusable against a
different base URL: the session dance, `ACC=131`, `data-disp`, the MARC block and the
ISO-8859-1 encoding are all properties of absysNET, not of Madrid.

So the first province to add should be another absysNET one — it should cost a config entry,
not a new parser — and that is what proves the abstraction before anything harder is attempted.

### The shape of the change

**A provider interface.** Extract what `opac.js` already does behind:

```js
// providers/absysnet.js — one implementation, parameterised by base URL
createAbsysNetProvider({ id, name, baseUrl })
  → { search({title, author}), fetchHoldings(titn), recordUrl(titn), listBranches() }
```

`lookup.js` then talks to a provider rather than importing `opac.js` directly. Regions on a
different ILS (Koha, Symphony, Sierra) get their own module implementing the same three
methods; nothing else in the pipeline changes.

**Data.** Replace the single flat file with an index plus one file per region:

```
data/regions.json              [{ id, name, provider, baseUrl }]
data/regions/madrid.json       the 346 entries currently in data/libraries.json
data/regions/valencia.json     …
```

`tools/refresh-libraries.mjs` becomes `refresh-libraries.mjs <region>`, reading the base URL
from the index. Its `subcat` parsing already works for any absysNET OPAC.

**Settings.** `preferred` currently holds bare branch codes, which collide across regions
(`BPM` means something different elsewhere). It becomes region-qualified:

```js
{ regions: ['madrid'], preferred: ['madrid:BPM/BP05', 'madrid:MUNI/BMETRO'] }
```

A migration should map existing bare codes to `madrid:` on first run, so nobody loses their
selection.

**Options UI.** Two steps: choose regions, then the branch picker shows only those regions'
libraries, grouped as today. The existing search box stays — with several regions loaded,
typing a town name matters more than browsing.

**Lookup.** For each selected region, search its provider; union the holdings. Cost grows
linearly with regions selected, so the request budget and the 400 ms spacing need revisiting:
probably per-provider spacing rather than one global queue, since different catalogues are
different servers.

### Open question

Whether to show a book as green when it is available in a region you selected but 300 km away.
Probably the colour should reflect your *primary* region and the card should list the rest —
but that is a decision to make with real multi-region use, not in advance.

## 2. Smaller things worth doing

- **Reserve directly from the card.** The catalogue has a reservation flow behind a reader
  login. The card already knows the record and which branches hold it.
- **A shelf-wide summary.** On Want to Read, "12 of these 40 are on a shelf near you" is
  probably more useful than scanning 40 dots.
- **Verify the login-gated layouts.** My Books and author pages are matched by selector but
  have never been confirmed against a logged-in session — see README's limitations.
- **Icons.** The extension currently uses Chrome's default puzzle piece.

## 3. Publishing

Before this goes public:

- Pick a licence (none chosen yet) and add `LICENSE`.
- Decide whether `dist/ui.css` is committed. It is currently gitignored as a build artifact,
  which means anyone cloning must run `npm run build` before loading the extension — fine for
  a repo, wrong for a Chrome Web Store zip.
- The extension scrapes a public institutional catalogue. The throttling, viewport gating and
  caching exist to keep that defensible; they should not be weakened to make it feel faster,
  and that reasoning belongs in the README where contributors will see it.
