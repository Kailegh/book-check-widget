// Turning a Goodreads book into a catalogue verdict.
//
// The catalogue cannot be searched by ISBN, so lookups go by title and author and the
// candidates are then *verified* against ISBNs we already know. When no ISBN confirms a
// match the verdict carries a lower confidence, which the hover card shows honestly.

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'el', 'la', 'los', 'las', 'un', 'una', 'de', 'y']);

/** Strip accents, punctuation and case so Spanish and English spellings compare cleanly. */
export function normalize(text) {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The part of a Goodreads title worth searching: no series suffix, no subtitle.
 * "Sapiens: A Brief History of Humankind" -> "Sapiens"
 * "The Name of the Wind (The Kingkiller Chronicle, #1)" -> "The Name of the Wind"
 */
export function coreTitle(title) {
  return (title ?? '')
    .replace(/\s*[([][^)\]]*[#№]\s*[\d.]+[^)\]]*[)\]]\s*$/, '')
    .replace(/\s*[([][^)\]]*(?:series|saga|trilogy|chronicle)[^)\]]*[)\]]\s*$/i, '')
    .split(/\s*[:;]\s*/)[0]
    .replace(/\s*\/\s*$/, '')
    .trim();
}

/**
 * The catalogue's title index cannot cope with a repeated word: searching
 * "Tomorrow, and Tomorrow, and Tomorrow" returns nothing, while "tomorrow and" finds the
 * record. Distinct significant words give the same results everywhere else, so always
 * search with those.
 */
export function searchQuery(title) {
  const words = normalize(title).split(' ').filter(Boolean);
  const significant = [...new Set(words.filter((word) => !STOP_WORDS.has(word)))];
  const chosen = significant.length ? significant : [...new Set(words)];
  return chosen.slice(0, 8).join(' ');
}

/** Goodreads gives "Patrick Rothfuss"; the catalogue indexes "Rothfuss, Patrick". */
export function authorSurname(author) {
  const text = (author ?? '').replace(/\([^)]*\)/g, '').trim();
  if (!text) return '';
  if (text.includes(',')) return text.split(',')[0].trim();
  const parts = text.split(/\s+/);
  // Spanish names often carry two surnames; keep the last two for "Ruiz Zafón".
  return parts.length > 2 ? parts.slice(-2).join(' ') : parts.at(-1);
}

function tokens(text) {
  return new Set(normalize(text).split(' ').filter((word) => word && !STOP_WORDS.has(word)));
}

/** Dice coefficient over significant words: 1 = identical, 0 = nothing in common. */
export function titleSimilarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

const isbn13 = (value) => (value ?? '').replace(/[^0-9Xx]/g, '');

/**
 * Score one catalogue result against the book we are looking for.
 * Returns { score, confidence } — confidence is what the UI shows.
 */
/** Catalogue authors read "Harari, Yuval Noah (1976-)", so compare word sets. */
function authorAgrees(resultAuthor, wantedAuthor) {
  const wanted = tokens(authorSurname(wantedAuthor));
  if (!wanted.size) return false;
  const found = tokens(resultAuthor);
  for (const word of wanted) if (!found.has(word)) return false;
  return true;
}

export function scoreResult(result, wanted) {
  // Compare every title the record carries (its own plus the original it translates)
  // against every title we would accept (the Goodreads one plus any translations we
  // looked up). Searching by a Spanish title must not then be judged against English.
  const resultTitles = [result.title, ...result.originalTitles];
  const wantedTitles = wanted.titles ?? [wanted.title];
  const titleScore = Math.max(0, ...resultTitles.flatMap(
    (title) => wantedTitles.map((candidate) => titleSimilarity(title, candidate)),
  ));
  const authorMatches = authorAgrees(result.author, wanted.author);

  // An ISBN we already know outranks any title similarity: titles of different editions
  // are identical, so without this the right edition would not sort to the front.
  const knownIsbns = new Set([...(wanted.isbns ?? [])].map(isbn13).filter(Boolean));
  if (knownIsbns.size && result.isbns.some((isbn) => knownIsbns.has(isbn13(isbn)))) {
    return { score: 2 + titleScore, confidence: 'high' };
  }

  const score = titleScore * (authorMatches ? 1 : 0.6);
  const confidence = score >= 0.85 && authorMatches ? 'medium' : 'low';
  return { score, confidence };
}

/** Best matches first; anything implausible is dropped. */
export function rankResults(results, wanted, minimumScore = 0.4) {
  return results
    .map((result) => ({ result, ...scoreResult(result, wanted) }))
    .filter(({ score }) => score >= minimumScore)
    .sort((a, b) => b.score - a.score);
}

const count = (n, singular, plural) => `${n === 1 ? 'una' : n} ${n === 1 ? singular : plural}`;

/**
 * The verdict: colour plus a human reason, from the copies found and the user's branches.
 * On-shelf drives the colour; loans are visible in the branch list for later reservation.
 */
export function decideStatus(copies, preferredCodes) {
  const preferred = new Set(preferredCodes ?? []);
  const isPreferred = (copy) => preferred.has(copy.code) || preferred.has(copy.networkCode);

  if (!copies.length) {
    return { colour: 'red', reason: 'No está en el catálogo de las bibliotecas de Madrid.' };
  }

  const available = copies.filter((copy) => copy.status === 'available');
  const availableHere = available.filter(isPreferred);

  if (availableHere.length) {
    const where = availableHere.length === 1
      ? `en ${availableHere[0].branchName}`
      : `en ${availableHere.length} de tus bibliotecas`;
    return { colour: 'green', reason: `En la estantería ahora mismo ${where}.` };
  }
  if (available.length) {
    const where = preferred.size
      ? ', pero ninguna de las tuyas'
      : '. Elige tus bibliotecas para ver cuáles te interesan';
    return {
      colour: 'yellow',
      reason: `En la estantería en ${count(available.length, 'biblioteca', 'bibliotecas')}${where}.`,
    };
  }

  const loaned = copies.filter((copy) => copy.status === 'on_loan');
  if (loaned.length) {
    const next = loaned
      .map((copy) => copy.dueDate)
      .filter(Boolean)
      .sort((a, b) => toDate(a) - toDate(b))[0];
    const mine = loaned.some(isPreferred) ? ', una en tu biblioteca' : '';
    return {
      colour: 'red',
      reason: `Todo prestado: ${count(loaned.length, 'copia', 'copias')}${mine}` +
        `${next ? `. La primera vuelve el ${next}` : ''}. Puedes reservarla.`,
    };
  }

  return { colour: 'red', reason: 'Hay ejemplares, pero ninguno es prestable ahora mismo.' };
}

function toDate(spanishDate) {
  const [day, month, year] = spanishDate.split('/').map(Number);
  return new Date(year, month - 1, day).getTime();
}

/** Preferred branches first, then available ones, then the rest. */
export function sortCopies(copies, preferredCodes) {
  const preferred = new Set(preferredCodes ?? []);
  const rank = (copy) => (
    (preferred.has(copy.code) || preferred.has(copy.networkCode) ? 0 : 2) +
    (copy.status === 'available' ? 0 : 1)
  );
  return [...copies].sort((a, b) => rank(a) - rank(b) || a.branchName.localeCompare(b.branchName, 'es'));
}
