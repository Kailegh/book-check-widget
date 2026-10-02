// Finding the books on a Goodreads page.
//
// Listopia, search results and author pages use schema.org microdata, which is the same
// across all of them. "My Books" uses its own table, and the React book page keeps the
// cleanest data of all in a JSON-LD block, including a real ISBN.

(() => {
  const namespace = (window.__bcw ??= {});

  const text = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  /**
   * False once the extension has been reloaded or updated while this page stayed open: the
   * injected script lives on, but every chrome.* call throws "Extension context
   * invalidated". Callers check this and stop quietly rather than erroring.
   */
  namespace.extensionAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  const bookIdFrom = (href) => href?.match(/\/book\/show\/(\d+)/)?.[1] ?? null;

  function fromMicrodata() {
    return [...document.querySelectorAll('[itemtype*="schema.org/Book"]')].flatMap((container) => {
      const link = container.querySelector('a.bookTitle');
      const title = text(link?.querySelector('[itemprop="name"]')) || text(link);
      const author = text(container.querySelector('a.authorName'));
      const id = bookIdFrom(link?.getAttribute('href'));
      if (!title || !id) return [];
      return [{
        id,
        title,
        author,
        isbn: null,
        mount: container.querySelector('img.bookCover') ?? link ?? container,
      }];
    });
  }

  function fromMyBooks() {
    return [...document.querySelectorAll('tr.bookalike')].flatMap((row) => {
      const link = row.querySelector('td.field.title a');
      // The title cell holds the full title in its attribute and a wrapped copy as text.
      const title = link?.getAttribute('title')?.trim() || text(link);
      const author = text(row.querySelector('td.field.author a'));
      const id = bookIdFrom(link?.getAttribute('href'));
      if (!title || !id) return [];
      return [{
        id,
        title,
        author,
        isbn: text(row.querySelector('td.field.isbn13 .value')) || text(row.querySelector('td.field.isbn .value')) || null,
        mount: row.querySelector('td.field.cover img') ?? link ?? row,
      }];
    });
  }

  function fromBookPage() {
    const linked = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((node) => { try { return JSON.parse(node.textContent); } catch { return null; } })
      .find((data) => data?.['@type'] === 'Book');

    const title = linked?.name
      ?? text(document.querySelector('[data-testid="bookTitle"], h1#bookTitle'));
    const author = linked?.author?.[0]?.name
      ?? text(document.querySelector('.ContributorLink__name, a.authorName'));
    if (!title) return [];

    return [{
      id: bookIdFrom(location.pathname) ?? 'page',
      title,
      author,
      isbn: linked?.isbn ?? null,
      mount: document.querySelector('.BookCover__image img, img#coverImage, .ResponsiveImage')
        ?? document.querySelector('[data-testid="bookTitle"], h1#bookTitle'),
      detailed: true,
    }];
  }

  /**
   * The author link that belongs to this cover: whichever one shares the nearest ancestor.
   * Cover grids (recommendations, shelves) rarely put the author in the image attributes.
   */
  function nearbyAuthor(link) {
    let node = link;
    for (let depth = 0; depth < 4 && node; depth += 1) {
      const author = node.querySelector?.('a[href*="/author/show/"]');
      if (author) return text(author);
      node = node.parentElement;
    }
    return '';
  }

  /** Grid layouts that carry neither microdata nor a table (shelves, recommendations). */
  function fromCoverGrid() {
    const seen = new Set();
    return [...document.querySelectorAll('a[href*="/book/show/"]')].flatMap((link) => {
      const image = link.querySelector('img');
      const id = bookIdFrom(link.getAttribute('href'));
      if (!image || !id || seen.has(id)) return [];

      // Goodreads sometimes puts "Title by Author" in the cover's alt or title attribute;
      // when it does not, the author comes from the nearest author link instead.
      const label = (image.getAttribute('title') || image.getAttribute('alt') || '').trim();
      const matched = label.match(/^(.*?)\s+by\s+(.*)$/);
      const title = (matched?.[1] ?? label).trim();
      const author = matched?.[2]?.trim() || nearbyAuthor(link);
      if (!title) return [];

      seen.add(id);
      return [{ id, title, author, isbn: null, mount: image }];
    });
  }

  namespace.collectBooks = function collectBooks() {
    if (/^\/book\/show\//.test(location.pathname)) return fromBookPage();

    const found = [...fromMyBooks(), ...fromMicrodata()];
    if (found.length) return dedupe(found);
    return dedupe(fromCoverGrid());
  };

  function dedupe(books) {
    const seen = new Set();
    return books.filter(({ id }) => !seen.has(id) && seen.add(id));
  }
})();
