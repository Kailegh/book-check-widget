// Book details from the Goodreads book page, for listings that show only a cover.
//
// Cover grids give a title from the image's alt text and often no author or ISBN. The book
// page's JSON-LD carries all three, and an ISBN finds the exact catalogue record even when
// the catalogue's title index does not.

const BOOK_URL = 'https://www.goodreads.com/book/show/';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text) => text?.replace(/&(\w+);/g, (match, name) => ENTITIES[name] ?? match);

export function parseBookDetails(html) {
  const book = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, json]) => { try { return JSON.parse(json); } catch { return null; } })
    .find((data) => data?.['@type'] === 'Book');
  return {
    title: decode(book?.name) ?? null,
    author: decode(book?.author?.[0]?.name) ?? null,
    isbn: book?.isbn ?? null,
  };
}

/**
 * Goodreads answers suspected bots with an empty 202. That must throw rather than return
 * empty details, which would be cached as "this book has no ISBN". Sending the person's
 * own cookies makes the request look like what it is, a visit from their browser.
 */
export async function bookDetails(id) {
  const response = await fetch(`${BOOK_URL}${id}`, { credentials: 'include' });
  if (response.status !== 200) throw new Error(`Goodreads responded ${response.status}`);
  const details = parseBookDetails(await response.text());
  if (!details.title) throw new Error('Goodreads page had no book data');
  return details;
}
