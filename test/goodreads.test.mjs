// The ISBN, title and author a cover-only listing lacks, read from a captured book page.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBookDetails } from '../src/bg/goodreads.js';

test('a book page yields its ISBN, title and first author', () => {
  assert.deepEqual(parseBookDetails(readFileSync('test/fixtures/book.html', 'utf8')), {
    title: 'The Name of the Wind (The Kingkiller Chronicle, #1)',
    author: 'Patrick Rothfuss',
    isbn: '9780756404079',
  });
});

test('a page without book data yields nothing rather than throwing', () => {
  assert.deepEqual(parseBookDetails('<html></html>'), { title: null, author: null, isbn: null });
});
