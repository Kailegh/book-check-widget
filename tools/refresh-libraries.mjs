// Regenerates data/libraries.json from the live absysNET advanced-search form.
// Run with: npm run libraries
import { writeFile } from 'node:fs/promises';

const BASE = 'https://gestiona.comunidad.madrid/biblio_publicas/cgi-bin/abnetopac';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const decode = (buffer) => new TextDecoder('iso-8859-1').decode(buffer);

async function fetchLatin1(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return decode(await response.arrayBuffer());
}

function unescapeHtml(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&(\w+);/g, (match, name) => named[name] ?? match);
}

function parseBranches(html) {
  const select = html.match(/<select[^>]*name="subcat"[\s\S]*?<\/select>/)?.[0];
  if (!select) throw new Error('subcat select not found — the OPAC form has changed');

  const options = [...select.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)/g)];
  return options
    .map(([, code, label]) => ({ code, name: unescapeHtml(label).replace(/^[\s>]+/, '').trim() }))
    .filter(({ code }) => code && code !== '/')
    .map(({ code, name }) => {
      const parent = code.includes('/') ? code.split('/')[0] : null;
      return { code, name, parent };
    });
}

const session = (await fetchLatin1(BASE)).match(/abnetopac\/([A-Za-z0-9]+)/)?.[1];
if (!session) throw new Error('could not obtain an OPAC session token');

const branches = parseBranches(await fetchLatin1(`${BASE}/${session}/NT1?ACC=120&FORM=2`));
const networks = branches.filter((entry) => !entry.parent).length;

await writeFile('data/libraries.json', `${JSON.stringify(branches, null, 2)}\n`);
console.log(`data/libraries.json: ${branches.length} entries (${networks} networks, ${branches.length - networks} branches)`);
