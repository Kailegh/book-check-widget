// The per-book pipeline: Goodreads book in, catalogue verdict out.


import { spanishEditions } from './openlibrary.js';
import * as cache from './cache.js';
import {
  authorSurname, coreTitle, decideStatus, normalize, rankResults, searchQuery, sortCopies,
} from './match.js';

const MAX_COPIES_SHOWN = 30;

/** Short stable hash, so a long list of preferred branches makes a short key. */
function fingerprint(values) {
  let hash = 5381;
  for (const char of [...values].sort().join(',')) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

/**
 * A verdict depends on which branches you call yours, so the chosen branches are part of
 * the key: change them and the dots re-decide immediately instead of going stale.
 * The underlying holdings are cached separately, per record, so this costs no requests.
 */
function cacheKey({ title, author }, preferred = []) {
  return `${normalize(coreTitle(title))}|${normalize(authorSurname(author))}|${fingerprint(preferred)}`;
}

/** Keep the payload small: every preferred copy, then a sample of the rest. */
function trimCopies(copies, preferred) {
  const chosen = new Set(preferred);
  const isMine = (copy) => chosen.has(copy.code) || chosen.has(copy.networkCode);
  const mine = copies.filter(isMine);
  const others = copies.filter((copy) => !isMine(copy));
  const shown = [...mine, ...others.slice(0, Math.max(0, MAX_COPIES_SHOWN - mine.length))];
  return { shown, hidden: copies.length - shown.length };
}

const dedupeByTitn = (results) => {
  const seen = new Set();
  return results.filter(({ titn }) => titn && !seen.has(titn) && seen.add(titn));
};

async function holdingsFor(opac, titn) {
  const { value } = await cache.through('holdings', String(titn), () => opac.fetchHoldings(titn));
  return value;
}

/**
 * Search the catalogue for the first candidate title that returns anything.
 * The English title is tried first because the catalogue indexes uniform titles, so a
 * translation is usually found without needing Open Library at all.
 */
async function searchCandidates(opac, titles, surname) {
  const tried = new Set();
  for (const title of titles) {
    const query = searchQuery(title);
    if (!query || tried.has(query)) continue;
    tried.add(query);
    const results = await opac.search({ title: query, author: surname });
    if (results.length) return { results, usedTitle: title };
  }
  return { results: [], usedTitle: null };
}

// Two tabs, or the same book twice on one page, must not both do the work.
const inFlight = new Map();

export async function lookup(book, settings, opac) {
  const key = cacheKey(book, settings.preferred);
  const cached = await cache.read('verdict', key);
  if (cached) return { ...cached, fromCache: true };

  if (inFlight.has(key)) return { ...await inFlight.get(key), fromCache: true };

  const work = resolve(book, settings, cacheKey(book, []), opac)
    .then(async (verdict) => {
      await cache.write('verdict', key, verdict);
      return verdict;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, work);
  return { ...await work, fromCache: false };
}

async function resolve(book, settings, key, opac) {
  const title = coreTitle(book.title);
  const surname = authorSurname(book.author);
  const baseIsbns = book.isbn ? [book.isbn] : [];

  // The catalogue indexes uniform titles, so the English title Goodreads shows often
  // finds the Spanish edition on its own.
  let { results, usedTitle } = await searchCandidates(opac, [title], surname);
  let wanted = { titles: [title], author: book.author, isbns: baseIsbns };
  let ranked = rankResults(results, wanted);

  // Ask Open Library for the Spanish title when the catalogue gave us nothing plausible,
  // or gave us only foreign-language editions — the translation usually has many more
  // copies in Madrid, and may well be on a shelf near you when the English one is not.
  const noSpanishMatch = !ranked.some(({ result }) => result.language === 'spa');
  if (noSpanishMatch) {
    const { value: bridged } = await cache.through('bridge', key, () => spanishEditions({
      title, author: surname, isbn: book.isbn,
    }).catch(() => ({ titles: [], isbns: [] })));

    if (bridged.titles.length) {
      const retry = await searchCandidates(opac, bridged.titles, surname);
      wanted = {
        titles: [title, ...bridged.titles.map(coreTitle)],
        author: book.author,
        isbns: [...baseIsbns, ...bridged.isbns],
      };
      // Rank old and new results together: the bridged ISBNs may vindicate a record the
      // first search already found, and both sets are legitimate editions of the work.
      results = dedupeByTitn([...retry.results, ...results]);
      usedTitle = retry.usedTitle ?? usedTitle;
      ranked = rankResults(results, wanted);
    }
  }

  if (!ranked.length) {
    return {
      colour: 'red',
      confidence: 'high',
      reason: 'No está en el catálogo de las bibliotecas de Madrid.',
      copies: [],
      hidden: 0,
      titn: null,
      matchedTitle: null,
      searchedTitle: usedTitle ?? title,
    };
  }

  // Equal scores mean different editions of the same work. Prefer the Spanish ones: in
  // Madrid they hold far more copies, so they answer "can I borrow this?" sooner.
  const ordered = [...ranked].sort((a, b) => b.score - a.score
    || (b.result.language === 'spa') - (a.result.language === 'spa'));

  const best = ordered[0];
  const editions = ordered.slice(0, settings.maxEditions).map(({ result }) => result.titn);

  // The best edition first on its own: it is usually the Spanish one with the most copies,
  // and if it is already on a preferred shelf nothing else can improve on green. Only when
  // it does not settle the question are the rest fetched, and then all at once rather than
  // one after another.
  const copies = [...await holdingsFor(opac, editions[0])];
  if (editions.length > 1 && decideStatus(copies, settings.preferred).colour !== 'green') {
    const rest = await Promise.all(editions.slice(1).map((titn) => holdingsFor(opac, titn)));
    for (const found of rest) copies.push(...found);
  }

  const status = decideStatus(copies, settings.preferred);
  const { shown, hidden } = trimCopies(sortCopies(copies, settings.preferred), settings.preferred);

  return {
    ...status,
    confidence: ordered.some(({ confidence }) => confidence === 'high') ? 'high' : best.confidence,
    copies: shown,
    hidden,
    titn: best.result.titn,
    matchedTitle: best.result.title,
    matchedAuthor: best.result.author,
    searchedTitle: usedTitle ?? title,
  };
}
