// Pagina dello store da cui arriva l'estensione, per l'invito a lasciare una valutazione (popup e pannello).
globalThis.MAKERPULSE_STORE_URL = (() => {
  let base = '';
  try {
    base = chrome.runtime.getURL('');
  } catch {}
  if (base.startsWith('moz-extension:')) return 'https://addons.mozilla.org/firefox/addon/makerpulse-makerworld/';
  if (/\bEdg\//.test(navigator.userAgent)) return 'https://microsoftedge.microsoft.com/addons/detail/aihonfmgicmamchimkdceleomgbbndec';
  return 'https://chromewebstore.google.com/detail/moiomhlofgpbiifcjblcaefcebnccblp/reviews';
})();
