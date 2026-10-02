// Fallback bridge for the English/Spanish title gap.
//
// The catalogue indexes uniform titles, so an English Goodreads title usually finds the
// Spanish edition on its own. This module only runs when that direct search comes back
// empty: it resolves the book on Open Library and returns the Spanish edition titles,
// which are then searched instead.

const BASE = 'https://openlibrary.org';

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Open Library responded ${response.status}`);
  return response.json();
}

async function findWorkKey({ title, author, isbn }) {
  if (isbn) {
    try {
      const edition = await getJson(`${BASE}/isbn/${isbn}.json`);
      const key = edition.works?.[0]?.key;
      if (key) return key;
    } catch {
      // Unknown ISBN on Open Library — fall through to the title search.
    }
  }
  const query = new URLSearchParams({ title, limit: '3', fields: 'key,title,author_name' });
  if (author) query.set('author', author);
  const found = await getJson(`${BASE}/search.json?${query}`);
  return found.docs?.[0]?.key ?? null;
}

function isSpanish(edition) {
  return (edition.languages ?? []).some(({ key }) => key?.endsWith('/spa'));
}

/**
 * Returns { titles, isbns } for the Spanish editions of this work.
 * Both lists are empty when nothing could be resolved; callers treat that as "no help".
 */
export async function spanishEditions({ title, author, isbn }) {
  const workKey = await findWorkKey({ title, author, isbn });
  if (!workKey) return { titles: [], isbns: [] };

  const { entries = [] } = await getJson(`${BASE}${workKey}/editions.json?limit=200`);
  const spanish = entries.filter(isSpanish);

  const titles = [...new Set(spanish.map((edition) => edition.title?.trim()).filter(Boolean))];
  const isbns = [...new Set(spanish.flatMap((edition) => [
    ...(edition.isbn_13 ?? []),
    ...(edition.isbn_10 ?? []),
  ]))];

  return { titles, isbns };
}
