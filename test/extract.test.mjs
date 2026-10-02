// Runs the real content-script extractor against markup captured from live Goodreads.
// Run with: npm test
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import test from 'node:test';

const script = readFileSync('src/content/extract.js', 'utf8');

function booksFrom(fixture, url) {
  const dom = new JSDOM(readFileSync(`test/fixtures/${fixture}`, 'utf8'), { url, runScripts: 'outside-only' });
  dom.window.eval(script);
  return dom.window.__bcw.collectBooks();
}

test('listopia rows yield title, author and a cover to mount on', () => {
  const books = booksFrom('listopia.html', 'https://www.goodreads.com/list/show/1.Best_Books_Ever');
  assert.equal(books.length, 3);
  const { mount, ...first } = books[0];
  assert.deepEqual(first, {
    id: '2767052',
    title: 'The Hunger Games (The Hunger Games, #1)',
    author: 'Suzanne Collins',
    isbn: null,
  });
  assert.equal(mount.tagName, 'IMG', 'the dot mounts on the cover image');
  for (const book of books) {
    assert.ok(book.title && book.author && book.id, `incomplete: ${JSON.stringify(book)}`);
  }
});

test('search results use the same microdata shape', () => {
  const books = booksFrom('search.html', 'https://www.goodreads.com/search?q=sapiens');
  assert.equal(books.length, 3);
  assert.ok(books.every((book) => book.title && book.author));
});

test('a book page reads title, author and a real ISBN from JSON-LD', () => {
  const books = booksFrom('book.html', 'https://www.goodreads.com/book/show/186074.The_Name_of_the_Wind');
  assert.equal(books.length, 1);
  const [book] = books;
  assert.equal(book.title, 'The Name of the Wind (The Kingkiller Chronicle, #1)');
  assert.equal(book.author, 'Patrick Rothfuss');
  assert.equal(book.isbn, '9780756404079');
  assert.equal(book.detailed, true);
  assert.equal(book.id, '186074');
});

test('cover grids get the author from a nearby link when the alt text lacks it', () => {
  const books = booksFrom('covergrid.html', 'https://www.goodreads.com/recommendations');
  assert.equal(books.length, 2);

  assert.equal(books[0].title, 'The Name of the Wind');
  assert.equal(books[0].author, 'Patrick Rothfuss', 'taken from the sibling author link');

  assert.equal(books[1].title, 'Klara and the Sun');
  assert.equal(books[1].author, 'Kazuo Ishiguro', 'taken from "Title by Author" in the attribute');
});
