// Alla prima installazione apre la pagina di benvenuto (il popup in una scheda); dopo un aggiornamento segna le novità da mostrare.
// Salva anche da quando è installata, per chiedere una valutazione solo dopo qualche giorno d'uso.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: 'popup.html?welcome=1' });
  // Dopo un aggiornamento il pannello mostra una volta le novità della versione.
  if (reason === 'update') await chrome.storage.local.set({ whatsNew: chrome.runtime.getManifest().version });
  const { installedAt } = await chrome.storage.local.get('installedAt');
  if (!installedAt) await chrome.storage.local.set({ installedAt: Date.now() });
});
