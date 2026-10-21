// Gira nel contesto della pagina: legge (senza modificarle) le risposte che MakerWorld scarica per le liste di modelli
// e passa al content script le statistiche di ogni modello, così le schede possono mostrarle.
(() => {
  if (window.__makerPulseHook) return;
  window.__makerPulseHook = true;

  const all = new Map(); // tutto ciò che è stato visto, per chi arriva dopo (il content script parte a pagina caricata)
  const post = (designs) => designs.length && window.postMessage({ makerpulse: 'designs', designs }, location.origin);
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.makerpulse === 'replay') post([...all.values()]);
  });
  const collect = (root) => {
    const out = [];
    const seen = new Set();
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 14) return;
      if (Array.isArray(o)) {
        for (const x of o) walk(x, depth + 1);
        return;
      }
      if (typeof o.id === 'number' && 'downloadCount' in o && 'printCount' in o && !seen.has(o.id)) {
        seen.add(o.id);
        const d = { id: o.id, dl: o.downloadCount, pr: o.printCount, bo: o.boostCnt ?? o.boostInfo?.total ?? null, hot: o.hotScore || 0 };
        all.set(o.id, d);
        out.push(d);
      }
      for (const k in o) walk(o[k], depth + 1);
    })(root, 0);
    post(out);
  };
  const watched = (url) => /\/api\/v1\/|\/_next\/data\//.test(url);

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = String(args[0]?.url || args[0]);
      if (watched(url)) res.clone().json().then(collect, () => {});
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__makerPulseUrl = String(url);
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (watched(this.__makerPulseUrl || ''))
      this.addEventListener('load', () => {
        try {
          if (this.responseType === 'json') collect(this.response);
          else if (!this.responseType || this.responseType === 'text') collect(JSON.parse(this.responseText));
        } catch {}
      });
    return origSend.apply(this, args);
  };

  const fromNextData = () => {
    try {
      collect(JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null'));
    } catch {}
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fromNextData);
  else fromNextData();
})();
