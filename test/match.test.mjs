import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorSurname, coreTitle, decideStatus, scoreResult, searchQuery, titleSimilarity,
} from '../src/bg/match.js';

const copy = (code, status, dueDate = null, branchName = code) => ({
  code, networkCode: code.split('/')[0], branchName, status, dueDate,
  statusText: status === 'available' ? 'Disponible' : `Disponible después de ${dueDate}`,
});

test('Goodreads titles reduce to something the catalogue can find', () => {
  assert.equal(coreTitle('The Name of the Wind (The Kingkiller Chronicle, #1)'), 'The Name of the Wind');
  assert.equal(coreTitle('Sapiens: A Brief History of Humankind'), 'Sapiens');
  assert.equal(coreTitle('Patria'), 'Patria');
});

test('repeated words are collapsed, because the catalogue cannot match them', () => {
  // Searching the title verbatim returns nothing from absysNET; "tomorrow" finds it.
  assert.equal(searchQuery('Tomorrow, and Tomorrow, and Tomorrow'), 'tomorrow');
  assert.equal(searchQuery('The Name of the Wind'), 'name wind');
  assert.equal(searchQuery('It'), 'it', 'a title made only of stop words still yields a query');
});

test('author surnames survive both orderings and accents', () => {
  assert.equal(authorSurname('Patrick Rothfuss'), 'Rothfuss');
  assert.equal(authorSurname('Rothfuss, Patrick (1973-)'), 'Rothfuss');
  assert.equal(authorSurname('Carlos Ruiz Zafón'), 'Ruiz Zafón');
});

test('a known ISBN outranks any title similarity', () => {
  const wanted = { titles: ['The Name of the Wind'], author: 'Patrick Rothfuss', isbns: ['9780756404079'] };
  const spanish = { title: 'El nombre del viento', originalTitles: ['The name of the wind'], author: 'Rothfuss, Patrick (1973-)', isbns: ['9788401022524'] };
  const exact = { title: 'The name of the wind', originalTitles: [], author: 'Rothfuss, Patrick (1973-)', isbns: ['9780756404079'] };

  const byIsbn = scoreResult(exact, wanted);
  assert.equal(byIsbn.confidence, 'high');
  assert.ok(byIsbn.score > scoreResult(spanish, wanted).score,
    'the ISBN-verified edition must sort ahead of an equally-titled one');
});

test('a translated title still matches through the uniform title', () => {
  const wanted = { titles: ['The Name of the Wind'], author: 'Patrick Rothfuss', isbns: [] };
  const spanish = { title: 'El nombre del viento', originalTitles: ['The name of the wind'], author: 'Rothfuss, Patrick (1973-)', isbns: [] };
  assert.ok(scoreResult(spanish, wanted).score > 0.8);
  assert.equal(titleSimilarity('El nombre del viento', 'The Name of the Wind'), 0,
    'the Spanish and English titles share no words, so the match comes from the uniform title');
});

test('author order does not matter when comparing names', () => {
  const wanted = { titles: ['Sapiens'], author: 'Yuval Noah Harari', isbns: [] };
  const result = { title: 'Sapiens', originalTitles: [], author: 'Harari, Yuval Noah (1976-)', isbns: [] };
  assert.equal(scoreResult(result, wanted).confidence, 'medium');
});

const mine = ['BPM/BP05'];

test('green only when a preferred branch has it on the shelf', () => {
  const verdict = decideStatus([copy('BPM/BP05', 'available'), copy('RBMALC/BMALC1', 'available')], mine);
  assert.equal(verdict.colour, 'green');
});

test('yellow when it is on a shelf, but not one of yours', () => {
  const verdict = decideStatus([copy('RBMALC/BMALC1', 'available')], mine);
  assert.equal(verdict.colour, 'yellow');
});

test('all copies on loan is red, and says when the first comes back', () => {
  const verdict = decideStatus([
    copy('BPM/BP05', 'on_loan', '30/10/2026'),
    copy('RBMALC/BMALC1', 'on_loan', '13/10/2026'),
  ], mine);
  assert.equal(verdict.colour, 'red');
  assert.match(verdict.reason, /13\/10\/2026/, 'reports the earliest return date');
  assert.match(verdict.reason, /tu biblioteca/, 'mentions that one is in a preferred branch');
  assert.match(verdict.reason, /reservarla/);
});

test('nothing in the catalogue is red for a different reason', () => {
  assert.match(decideStatus([], mine).reason, /No está en el catálogo/);
});

test('a preferred whole network counts, not just a named branch', () => {
  const verdict = decideStatus([copy('BPM/BCDIX', 'available')], ['BPM']);
  assert.equal(verdict.colour, 'green', 'selecting a network covers all of its branches');
});

test('a Spanish record without a uniform title still matches via the bridged title', () => {
  // The Hunger Games: the catalogue's Spanish record carries no original-title field, so the
  // English title scores zero against it. Only the bridged title rescues the match.
  const spanish = { title: 'Los juegos del hambre', originalTitles: [], author: 'Collins, Suzanne (1962-)', isbns: [] };

  const englishOnly = { titles: ['The Hunger Games'], author: 'Suzanne Collins', isbns: [] };
  assert.equal(scoreResult(spanish, englishOnly).score, 0, 'nothing in common without the bridge');

  const bridged = { titles: ['The Hunger Games', 'Los juegos del hambre'], author: 'Suzanne Collins', isbns: [] };
  assert.ok(scoreResult(spanish, bridged).score > 0.9, 'the bridged title makes it a clear match');
});

test('with no libraries chosen, yellow does not claim they are "not yours"', () => {
  const copies = [copy('RBMALC/BMALC1', 'available')];
  assert.match(decideStatus(copies, []).reason, /Elige tus bibliotecas/);
  assert.doesNotMatch(decideStatus(copies, []).reason, /ninguna de las tuyas/);
  assert.match(decideStatus(copies, ['BPM/BP05']).reason, /ninguna de las tuyas/);
});
