const DEFAULTS = { modelPanel: true, profilePanel: true, pointsPanel: true, quickReplies: true, cardStats: true, collapsed: false };
const IT = (navigator.language || '').toLowerCase().startsWith('it');
const TEXT = {
  tagline: ['Stats & tools for MakerWorld creators', 'Statistiche e strumenti per i creator di MakerWorld'],
  thanks: ['Thanks for using MakerPulse! A side project made by a MakerWorld creator, for creators.', 'Grazie per usare MakerPulse! Un progetto nato da un creator di MakerWorld, per i creator.'],
  local: [
    'Not affiliated with Bambu Lab. It runs locally in your browser and sends no data anywhere. Found a bug? Let me know on GitHub.',
    'Non è affiliato a Bambu Lab. Funziona in locale nel tuo browser e non invia dati a nessuno. Hai trovato un bug? Scrivimi su GitHub.',
  ],
  ask: ['Like it? Support me with a free Boost on one of my models!', 'Ti piace? Supportami con un Boost gratuito su uno dei miei modelli!'],
  boostNote: ['*The button opens my models on MakerWorld', '*Il pulsante apre i miei modelli su MakerWorld'],
  settings: ['Settings', 'Impostazioni'],
  start: ['Open any model or profile page on MakerWorld and the MakerPulse panel appears at the bottom right.', 'Apri una pagina modello o profilo su MakerWorld: il pannello MakerPulse compare in basso a destra.'],
  startLink: ['Try it now →', 'Provalo ora →'],
  modelPanel: ['Panel on model pages', 'Pannello sulle pagine modello'],
  profilePanel: ['Panel on profile pages', 'Pannello sulle pagine profilo'],
  pointsPanel: ['Points, gift cards and redemption (logged-in account)', 'Punti, gift card e riscatto (account loggato)'],
  collapsed: ['Panel collapsed when opened', "Pannello compresso all'apertura"],
  cardStats: ['Prints and boosts on model cards', 'Stampe e boost sulle schede modello'],
  quickReplies: ['Quick replies in comment boxes', 'Risposte rapide nei commenti'],
  repliesTitle: ['Quick replies (one per line)', 'Risposte rapide (una per riga)'],
  repliesLang: [
    "Replies start in English. MakerPulse switches to Italian only when the comment you're replying to is in Italian. You can switch it from the bar too.",
    "Le risposte partono in inglese. MakerPulse passa all'italiano solo se il commento a cui rispondi è in italiano. Puoi cambiarla anche dalla barra.",
  ],
  repliesHint: ['Empty the box to restore the defaults. The + button next to a comment box saves the text you typed.', 'Svuota il riquadro per ripristinare quelle predefinite. Il tasto + accanto al commento salva il testo che hai scritto.'],
  note: ['Changes apply immediately to open tabs.', 'Le modifiche si applicano subito alle schede aperte.'],
};
document.documentElement.lang = IT ? 'it' : 'en';
// Aperta in una scheda alla prima installazione come pagina di benvenuto.
document.body.classList.toggle('welcome', new URLSearchParams(location.search).has('welcome'));
document.querySelector('.version').textContent = `MakerPulse ${IT ? 'versione' : 'version'} ${chrome.runtime.getManifest().version}`;
for (const el of document.querySelectorAll('[data-t]')) el.textContent = TEXT[el.dataset.t][IT ? 1 : 0];
chrome.storage.sync.get(DEFAULTS).then((s) => {
  for (const k in DEFAULTS) {
    const el = document.getElementById(k);
    el.checked = s[k];
    el.onchange = () => chrome.storage.sync.set({ [k]: el.checked });
  }
});

// Risposte rapide in due lingue: null = testi predefiniti. "replies" è l'elenco unico della versione precedente.
chrome.storage.sync.get({ replies: null, repliesIt: null, repliesEn: null }).then((st) => {
  const old = IT ? 'repliesIt' : 'repliesEn';
  if (Array.isArray(st.replies) && !st[old]) st[old] = st.replies;
  for (const box of document.querySelectorAll('textarea[data-lang]')) {
    const lang = box.dataset.lang;
    box.value = (st[box.id] || MAKERPULSE_DEFAULT_REPLIES[lang]).join('\n');
    let timer;
    box.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const list = box.value.split('\n').map((l) => l.trim()).filter(Boolean);
        chrome.storage.sync.set({ [box.id]: list.length ? list : null });
        chrome.storage.sync.remove('replies');
      }, 400);
    };
  }
});
