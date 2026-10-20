const DEFAULTS = { modelPanel: true, profilePanel: true, pointsPanel: true, quickReplies: true, collapsed: false };
const IT = (navigator.language || '').toLowerCase().startsWith('it');
const TEXT = {
  modelPanel: ['Panel on model pages', 'Pannello sulle pagine modello'],
  profilePanel: ['Panel on profile pages', 'Pannello sulle pagine profilo'],
  pointsPanel: ['Points, gift cards and redemption (logged-in account)', 'Punti, gift card e riscatto (account loggato)'],
  collapsed: ['Panel collapsed when opened', "Pannello compresso all'apertura"],
  quickReplies: ['Quick replies in comment boxes', 'Risposte rapide nei commenti'],
  repliesTitle: ['Quick replies (one per line)', 'Risposte rapide (una per riga)'],
  repliesHint: ['Empty the box to restore the defaults. The + button next to a comment box saves the text you typed.', 'Svuota il riquadro per ripristinare quelle predefinite. Il tasto + accanto al commento salva il testo che hai scritto.'],
  note: ['Changes apply immediately to open tabs.', 'Le modifiche si applicano subito alle schede aperte.'],
};
document.documentElement.lang = IT ? 'it' : 'en';
for (const el of document.querySelectorAll('[data-t]')) el.textContent = TEXT[el.dataset.t][IT ? 1 : 0];
chrome.storage.sync.get(DEFAULTS).then((s) => {
  for (const k in DEFAULTS) {
    const el = document.getElementById(k);
    el.checked = s[k];
    el.onchange = () => chrome.storage.sync.set({ [k]: el.checked });
  }
});

// Risposte rapide: null = testi predefiniti (decisi dal content script in base alla lingua).
const box = document.getElementById('replies');
chrome.storage.sync.get({ replies: null }).then(({ replies }) => {
  box.value = (replies || MAKERPULSE_DEFAULT_REPLIES[IT ? 'it' : 'en']).join('\n');
});
let timer;
box.oninput = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const list = box.value.split('\n').map((l) => l.trim()).filter(Boolean);
    chrome.storage.sync.set({ replies: list.length ? list : null });
  }, 400);
};
