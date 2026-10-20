// Alla prima installazione apre la pagina di benvenuto (il popup in una scheda).
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: 'popup.html?welcome=1' });
});
