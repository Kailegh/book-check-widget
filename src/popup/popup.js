const scanButton = document.getElementById('scan');
const statusNode = document.getElementById('status');

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

// tab.url is only readable with a host permission for the site, which this extension does
// not ask for. Whether we are on a supported page is decided by whether the content
// script answers, which needs no permission at all.
const toTab = (message) => new Promise((resolve) => {
  if (!tab?.id) { resolve(null); return; }
  chrome.tabs.sendMessage(tab.id, message, (reply) => resolve(
    chrome.runtime.lastError ? null : reply,
  ));
});

let polling = null;

function stop() {
  if (polling) { clearInterval(polling); polling = null; }
}

async function refresh() {
  const progress = (await toTab({ type: 'progress' }))?.value;
  if (!progress) {
    stop();
    scanButton.disabled = true;
    statusNode.textContent = 'Abre una página de Goodreads con libros y recárgala.';
    return;
  }

  scanButton.disabled = false;
  const { done, queued, waiting } = progress;
  statusNode.textContent = waiting
    ? `Consultando el catálogo… ${done}/${queued}`
    : queued
      ? `${done} de ${queued} libros comprobados.`
      : 'Pulsa el botón para comprobar los libros visibles.';

  if (!waiting) stop();
}

scanButton.addEventListener('click', async () => {
  statusNode.textContent = 'Buscando libros en la página…';
  await toTab({ type: 'scan' });
  polling ??= setInterval(refresh, 600);
  refresh();
});

document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.getElementById('clear').addEventListener('click', async () => {
  const reply = await chrome.runtime.sendMessage({ type: 'clearCache' });
  statusNode.textContent = `Caché vaciada (${reply?.value?.removed ?? 0} entradas). Recarga la página.`;
});

refresh();
