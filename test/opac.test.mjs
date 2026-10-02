// Parser tests against a holdings page captured from the live catalogue.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyStatus, parseHoldings } from '../src/bg/opac.js';

const html = readFileSync('test/fixtures/holdings.html', 'utf8');

test('holdings parse into branch-coded copies', () => {
  const copies = parseHoldings(html);
  assert.ok(copies.length >= 4, `expected several copies, got ${copies.length}`);

  for (const copy of copies) {
    assert.match(copy.code, /^[A-Z0-9]+\/[A-Z0-9]+$/, `branch code looks wrong: ${copy.code}`);
    assert.ok(copy.branchName.length > 0, 'every copy names its branch');
    assert.ok(['available', 'on_loan', 'unavailable', 'pending'].includes(copy.status), copy.statusText);
  }
});

test('a loaned copy keeps its due date', () => {
  const loaned = parseHoldings(html).filter((copy) => copy.status === 'on_loan');
  assert.ok(loaned.length > 0, 'the fixture contains loaned copies');
  for (const copy of loaned) {
    assert.match(copy.dueDate, /^\d{2}\/\d{2}\/\d{4}$/, `no due date on: ${copy.statusText}`);
  }
});

test('status text maps onto the four states the catalogue uses', () => {
  assert.deepEqual(classifyStatus('Disponible'), { status: 'available', statusText: 'Disponible', dueDate: null });
  assert.deepEqual(classifyStatus('Disponible después de 21/10/2026'),
    { status: 'on_loan', statusText: 'Disponible después de 21/10/2026', dueDate: '21/10/2026' });
  assert.equal(classifyStatus('No disponible').status, 'unavailable');
  assert.equal(classifyStatus('En proceso de petición').status, 'pending');
  assert.equal(classifyStatus('').status, 'unknown');
});

test('shelf marks come through as text, not markup', () => {
  for (const copy of parseHoldings(html)) {
    assert.ok(!copy.signature.includes('class='), `markup leaked into signature: ${copy.signature}`);
    assert.ok(!copy.signature.includes('<'), `markup leaked into signature: ${copy.signature}`);
  }
});

test('result listings yield the record number, ISBNs and the original title', async () => {
  const { parseResults } = await import('../src/bg/opac.js');
  const results = parseResults(readFileSync('test/fixtures/results.html', 'latin1'));

  assert.ok(results.length >= 1, `expected results, got ${results.length}`);
  const [first] = results;

  assert.equal(first.titn, '2142242', 'TITN is the stable record number used for holdings');
  assert.equal(first.title, 'El nombre del viento');
  assert.match(first.author, /Rothfuss/);
  assert.equal(first.language, 'spa');
  assert.ok(first.isbns.includes('9788401022524'), `ISBNs were ${first.isbns}`);
  // The uniform title is what lets an English Goodreads title match a Spanish edition.
  assert.deepEqual(first.originalTitles, ['The name of the wind']);
  assert.ok(results.every((r) => Number.isInteger(r.doc)));
});
