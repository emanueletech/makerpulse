(() => {
  'use strict';
  if (window.__makerPulse) return;
  window.__makerPulse = true;

  // ---------- impostazioni ----------
  const DEFAULTS = { modelPanel: true, profilePanel: true, pointsPanel: true, quickReplies: true, cardStats: true, replies: null, repliesEn: null, repliesIt: null, collapsed: false, giftRegion: '' };
  let settings = { ...DEFAULTS };
  const store = globalThis.chrome?.storage?.sync;

  // ---------- utilità ----------
  // Inglese di default, italiano se il browser è in italiano.
  const IT = (navigator.language || '').toLowerCase().startsWith('it');
  const LOC = IT ? 'it-IT' : 'en-US';
  const t = (en, it) => (IT ? it : en);
  const nf = new Intl.NumberFormat(LOC);
  const fmt = (n) => (n == null ? '–' : nf.format(n));
  const dec = (n, d) => n.toLocaleString(LOC, { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (a, b) => (b ? `${dec((a / b) * 100, 1)}%` : '–');
  const ageDays = (iso) => Math.max(1, (Date.now() - new Date(iso)) / 864e5);
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString(LOC) : '–');
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const hm = (sec) => (sec ? `${Math.floor(sec / 3600)}h ${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}m` : '–');

  async function api(path) {
    const r = await fetch(path, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${t('on', 'su')} ${path}`);
    return r.json();
  }

  const localePrefix = () => (location.pathname.match(/^\/[a-z]{2}(?:-[a-z]+)?(?=\/)/i) || ['/en'])[0];

  function route() {
    const p = location.pathname.replace(/^\/[a-z]{2}(?:-[a-z]+)?(?=\/)/i, '');
    let m;
    if ((m = p.match(/^\/models\/(\d+)/))) return { type: 'model', id: m[1] };
    if ((m = p.match(/^\/@([^/]+)/))) return { type: 'profile', handle: decodeURIComponent(m[1]) };
    if (/^\/points(\/|$)/.test(p)) return { type: 'points' };
    return null;
  }

  // ---------- account loggato: punti, gift card, riscatto in denaro ----------
  const local = globalThis.chrome?.storage?.local;
  const mem = {};
  // Dopo un aggiornamento dell'estensione le schede già aperte restano con lo script vecchio, scollegato:
  // le API chrome.* lanciano errori, quindi si ripiega sulla memoria per non bloccare il pannello.
  const alive = () => !!globalThis.chrome?.runtime?.id;
  const lget = async (k) => {
    try {
      if (local && alive()) return (await local.get(k))[k];
    } catch {}
    return mem[k];
  };
  const lset = async (k, v) => {
    mem[k] = v;
    try {
      if (local && alive()) await local.set({ [k]: v });
    } catch {}
  };
  const save = (o) => {
    try {
      if (alive()) store?.set(o);
    } catch {}
  };

  let mePromise = null;
  const me = () =>
    (mePromise ||= fetch('/api/v1/design-user-service/my/profile', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j?.uid ? { uid: j.uid, handle: j.handle || '' } : null))
      .catch(() => null));
  const isMe = async (handle) => {
    const m = await me();
    return !!m && m.handle.toLowerCase() === String(handle).toLowerCase();
  };

  const isoDay = (d) => d.toISOString().slice(0, 10);
  const daysAgo = (n) => isoDay(new Date(Date.now() - n * 864e5));
  const KEEP_DAYS = 120;

  // Le transazioni punti sono append-only: si scaricano solo quelle nuove e si tengono aggregate in locale.
  let bills = null; // { at, promise }
  function pointBills(uid, onProgress) {
    if (!bills || Date.now() - bills.at > 10 * 60e3) {
      bills = { at: Date.now(), promise: loadBills(uid, onProgress) };
      bills.promise.catch(() => (bills = null));
    }
    return bills.promise;
  }
  async function loadBills(uid, onProgress) {
    const key = `bills2:${uid}`;
    let agg = await lget(key);
    try {
      if (alive()) local?.remove(`bills:${uid}`); // cache della versione precedente
    } catch {}
    const head = await api('/api/v1/point-service/point-bill/my?offset=0&limit=1&filter=all');
    if (!agg || head.total < agg.count) agg = { count: 0, byDesign: {}, byDay: {}, byDayEx: {}, boosters: {} };
    const need = head.total - agg.count;
    for (let off = 0; off < need; off += 500) {
      const j = await api(`/api/v1/point-service/point-bill/my?offset=${off}&limit=${Math.min(500, need - off)}&filter=all`);
      (j.hits || []).forEach((b) => addBill(agg, b));
      onProgress?.(Math.min(off + 500, need), need);
      if (!j.hits?.length) break;
    }
    agg.count = head.total;
    const cut = daysAgo(KEEP_DAYS);
    for (const d in agg.byDay) if (d < cut) delete agg.byDay[d];
    for (const d in agg.byDayEx) if (d < cut) delete agg.byDayEx[d];
    for (const id in agg.byDesign) for (const d in agg.byDesign[id].d) if (d < cut) delete agg.byDesign[id].d[d];
    await lset(key, agg);
    return agg;
  }
  function addBill(agg, b) {
    const pts = (b.pointChangeRegular || 0) + (b.pointChangeExclusive || 0) || b.pointChange || 0;
    if (pts <= 0) return; // le spese (riscatti) non sono guadagni
    const x = b.designRewardV2 || b.instanceRewardV2 || b.extInfoBoostExchangePoint || {};
    const id = x.id || x.designId;
    const day = x.earningTime || (b.pointTime || b.createTime || '').slice(0, 10);
    agg.byDay[day] = (agg.byDay[day] || 0) + pts;
    agg.byDayEx[day] = (agg.byDayEx[day] || 0) + (b.pointChangeExclusive || 0);
    if (b.type === 'boost_exchange_point' && x.fromUserHandle) {
      const u = (agg.boosters[x.fromUserHandle] ||= { n: x.fromUsername || x.fromUserHandle, d: {} });
      u.d[day] = (u.d[day] || 0) + 1;
    }
    if (!id) return;
    const e = (agg.byDesign[id] ||= { t: x.title || x.designTitle || '', all: 0, ex: 0, boost: 0, d: {} });
    e.all += pts;
    e.ex += b.pointChangeExclusive || 0;
    if (b.type === 'boost_exchange_point') e.boost += pts;
    e.d[day] = (e.d[day] || 0) + pts;
  }
  const sumSince = (days, n) => Object.entries(days || {}).reduce((s, [d, v]) => (d >= daysAgo(n) ? s + v : s), 0);

  const giftCache = new Map();
  async function giftCards(region) {
    if (!giftCache.has(region)) {
      const j = await api(`/api/v1/point-service/product/products?shop=${encodeURIComponent(region)}`);
      const cards = (j.hits || [])
        .filter((p) => p.productTypeId === 6 && p.selfBuiltGiftcard?.value && p.price)
        .map((p) => ({ value: p.selfBuiltGiftcard.value, cur: p.selfBuiltGiftcard.shop?.currency || '', price: p.price }))
        .sort((a, b) => b.value - a.value);
      giftCache.set(region, cards);
    }
    return giftCache.get(region);
  }
  async function giftRegion() {
    if (settings.giftRegion) return settings.giftRegion;
    const r = await api('/api/v1/design-store-service/my/region').catch(() => null);
    return r?.region?.name || 'EU';
  }
  const money = (v, cur, digits = 2) => {
    try {
      return new Intl.NumberFormat(LOC, { style: 'currency', currency: cur, maximumFractionDigits: digits }).format(v);
    } catch {
      return `${fmt(v)} ${cur}`;
    }
  };
  // Valore in gift card di n punti, usando il taglio col miglior rapporto valore/punti.
  const giftValue = (n, cards) => {
    const best = [...cards].sort((a, b) => b.value / b.price - a.value / a.price)[0];
    return best ? money((n * best.value) / best.price, best.cur) : '–';
  };

  // Data stimata in cui si accumulano `need` punti al ritmo medio degli ultimi 30 giorni.
  const eta = (need, perDay) => {
    if (need <= 0) return '';
    if (!(perDay > 0)) return '';
    const d = new Date(Date.now() + Math.ceil(need / perDay) * 864e5);
    return ` · ${t('expected around', 'previsto verso il')} <b>${d.toLocaleDateString(LOC, { day: 'numeric', month: 'short' })}</b>`;
  };

  async function pointsSummary() {
    const html = await (await fetch(`${localePrefix()}/points`, { credentials: 'include' })).text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const s = m && JSON.parse(m[1]).props?.pageProps?.boostAndPointSummary;
    if (!s) throw new Error(t('points not available (are you logged in?)', 'punti non disponibili (sei loggato?)'));
    return s;
  }

  async function pointsHtml(onProgress) {
    const m = await me();
    if (!m) return `<p class="muted">${t('Log in to MakerWorld to see points and gift cards.', 'Accedi a MakerWorld per vedere punti e gift card.')}</p>`;
    const region = await giftRegion();
    const [s, cash, cards, agg] = await Promise.all([
      pointsSummary(),
      api('/api/v1/point-service/cash-redeem/progress').catch(() => null),
      giftCards(region).catch(() => []),
      pointBills(m.uid, onProgress).catch(() => null),
    ]);
    const total = s.userTotalPoint;
    const rate = agg ? sumSince(agg.byDay, 30) / 30 : 0;
    const rateEx = agg ? sumSince(agg.byDayEx, 30) / 30 : 0;
    let html = `<h4>${t('My points', 'I miei punti')}</h4><div class="grid">
      ${stat(fmt(Math.floor(total)), t('Total points', 'Punti totali'))}
      ${stat(fmt(Math.floor(s.userTotalExclusivePoint)), t('Exclusive points', 'Punti esclusivi'))}
      ${stat(fmt(Math.floor(s.userTotalRegularPoint)), t('Regular points', 'Punti regolari'))}
      ${stat(fmt(s.userTotalBoostIncomes), t('Boosts received', 'Boost ricevuti'))}
      ${agg ? stat(fmt(Math.round(sumSince(agg.byDay, 7))), t('Earned 7 days', 'Guadagnati 7 gg')) : ''}
      ${agg ? stat(fmt(Math.round(sumSince(agg.byDay, 30))), t('Earned 30 days', 'Guadagnati 30 gg')) : ''}
    </div>`;

    const regions = ['EU', 'USA', 'UK', 'CA', 'AU', 'JP', 'ASIA', 'KR'];
    html += `<h4 class="gold">Gift card <select class="reg">${regions.map((r) => `<option ${r === region ? 'selected' : ''}>${r}</option>`).join('')}</select></h4>`;
    if (cards.length) {
      let left = total;
      const combo = cards.map((c) => {
        const n = Math.floor(left / c.price);
        left -= n * c.price;
        return { ...c, n };
      });
      const smallest = cards[cards.length - 1];
      const value = combo.reduce((s2, c) => s2 + c.n * c.value, 0);
      html += cards
        .map((c) => {
          const n = Math.floor(total / c.price);
          const rest = total - n * c.price;
          return `<div class="row"><span>${money(c.value, c.cur)} · ${fmt(c.price)} pt</span><b>${n}×</b></div>
          <div class="bar gold"><i style="width:${((rest / c.price) * 100).toFixed(1)}%"></i></div>
          <div class="muted">${t(`${fmt(Math.ceil(c.price - rest))} points to the next one`, `mancano ${fmt(Math.ceil(c.price - rest))} punti alla prossima`)}${eta(c.price - rest, rate)}</div>`;
        })
        .join('');
      html += `<p class="muted">${t('Best redemption', 'Riscattando al meglio')}: <b>${money(value, smallest.cur)}</b> (${combo
        .filter((c) => c.n)
        .map((c) => `${c.n}× ${money(c.value, c.cur)}`)
        .join(' + ') || t('none', 'nessuna')}) · ${t(`${fmt(Math.floor(left))} points left over`, `avanzano ${fmt(Math.floor(left))} punti`)}.</p>`;
    } else html += `<p class="muted">${t('No gift cards available for this region.', 'Nessuna gift card disponibile per questa regione.')}</p>`;

    if (cash?.oneExclusivePointAmount) {
      const min = cash.exclusivePointThresholdMin;
      const ok = cash.exclusivePoint >= min;
      html += `<h4>${t('Cash redemption (exclusive points)', 'Riscatto in denaro (punti esclusivi)')}</h4>
        <div class="row"><span>${t('Redeemable now', 'Riscattabile ora')}</span><b>${money(cash.canRedeemAmount, cash.currency)}</b></div>
        <div class="bar"><i style="width:${Math.min(100, (cash.exclusivePoint / min) * 100).toFixed(1)}%"></i></div>
        <div class="muted">${money(cash.oneExclusivePointAmount, cash.currency, 4)} ${t('per exclusive point', 'per punto esclusivo')} · min ${money(cash.redeemMinAmount, cash.currency)}, max ${money(
          cash.redeemMaxAmount,
          cash.currency
        )} ${t('per request', 'per richiesta')}${ok ? '' : ` · ${t(`${fmt(Math.ceil(min - cash.exclusivePoint))} exclusive points to the minimum`, `mancano ${fmt(Math.ceil(min - cash.exclusivePoint))} punti esclusivi al minimo`)}${eta(min - cash.exclusivePoint, rateEx)}`}</div>`;
    }

    if (agg) {
      const top = Object.entries(agg.byDesign)
        .map(([id, e]) => ({ id, ...e, d30: sumSince(e.d, 30) }))
        .sort((a, b) => b.d30 - a.d30 || b.all - a.all)
        .slice(0, 8);
      html += `<h4>${t('Top-earning models (30 days)', 'Modelli che rendono di più (30 gg)')}</h4><table><thead><tr><th>${t('Model', 'Modello')}</th><th class="n">${t('30 days', '30 gg')}</th><th class="n">${t('Total', 'Totale')}</th></tr></thead><tbody>
        ${top.map((e) => `<tr><td><a href="${localePrefix()}/models/${e.id}">${esc(e.t)}</a></td><td class="n">${fmt(Math.round(e.d30))}</td><td class="n">${fmt(Math.round(e.all))}</td></tr>`).join('')}
        </tbody></table>`;
      const boosters = Object.entries(agg.boosters)
        .map(([h, u]) => ({ h, n: u.n, c30: sumSince(u.d, 30), last: Object.keys(u.d).sort().pop() }))
        .filter((u) => u.c30)
        .sort((a, b) => b.c30 - a.c30 || (b.last > a.last ? 1 : -1));
      if (boosters.length)
        html += `<h4>${t(`Who boosted you (30 days): ${boosters.length}`, `Chi ti ha dato boost (30 gg): ${boosters.length}`)}</h4>
          <table><thead><tr><th>${t('User', 'Utente')}</th><th class="n">Boost</th><th class="n">${t('Last', 'Ultimo')}</th></tr></thead><tbody>
          ${boosters
            .slice(0, 15)
            .map((u) => `<tr><td><a href="${localePrefix()}/@${encodeURIComponent(u.h)}" target="_blank" rel="noopener">${esc(u.n)}</a></td><td class="n">${u.c30}</td><td class="n">${date(u.last)}</td></tr>`)
            .join('')}</tbody></table>`;
      html += `<p class="muted">${t(`Calculated from your ${fmt(agg.count)} point transactions. Forecasts use the average of the last 30 days.`, `Calcolato dalle tue ${fmt(agg.count)} transazioni punti. Le previsioni usano la media degli ultimi 30 giorni.`)}</p>`;
    }
    return html;
  }

  async function mountPoints(el, token) {
    el.innerHTML = `<p class="muted">${t('Calculating points…', 'Calcolo punti…')}</p>`;
    const html = await pointsHtml((done, need) => {
      if (token === renderToken) el.innerHTML = `<p class="muted">${t('Reading point transactions…', 'Lettura transazioni punti…')} ${fmt(done)} / ${fmt(need)}</p>`;
    });
    if (token !== renderToken) return;
    el.innerHTML = html;
    el.querySelector('.reg')?.addEventListener('change', (e) => {
      settings.giftRegion = e.target.value;
      save({ giftRegion: e.target.value });
      mountPoints(el, token);
    });
  }

  // ---------- UI (shadow DOM, isolato dal CSS del sito) ----------
  const host = document.createElement('div');
  host.id = 'makerpulse-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial;
      --graphite: #20262c; --graphite-2: #2b333b; --green: #00ae42; --green-deep: #00862f; --green-soft: #e7f7ee; --gold: #c9a24d; --gold-soft: #f7f0de;
      --surface: #fff; --plate: #f3f5f7; --ink: #1b2127; --slate: #5f6b76; --line: #e3e7eb; --link: #0a6ccf;
      --shadow-lg: 0 0 0 1px rgba(16,24,40,.06), 0 4px 8px -2px rgba(16,24,40,.08), 0 24px 48px -12px rgba(16,24,40,.32);
      --shadow-sm: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08);
      --layers: repeating-linear-gradient(180deg, rgba(255,255,255,.045) 0 1px, transparent 1px 4px); }
    @media (prefers-color-scheme: dark) {
      :host { --surface: #1b2026; --plate: #232a31; --ink: #e8edf2; --slate: #9aa6b2; --line: #333c45; --link: #5aa9ff;
        --green-soft: rgba(0,174,66,.16); --gold-soft: rgba(201,162,77,.16);
        --shadow-lg: 0 0 0 1px rgba(255,255,255,.06), 0 24px 48px -12px rgba(0,0,0,.7); --shadow-sm: 0 1px 2px rgba(0,0,0,.4); }
    }
    [hidden] { display: none !important; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    /* pannello */
    .panel { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; width: 400px; max-height: 76vh; display: flex; flex-direction: column;
      background: var(--surface); color: var(--ink); border-radius: 16px; box-shadow: var(--shadow-lg); font-size: 13px; overflow: hidden; }
    .panel.collapsed .body { display: none; }
    .head { display: flex; align-items: center; gap: 10px; padding: 11px 12px 11px 14px; color: #fff; cursor: pointer; user-select: none;
      background: var(--layers), linear-gradient(180deg, var(--graphite-2), var(--graphite)); border-bottom: 2px solid var(--green); }
    .head .logo { width: 24px; height: 24px; flex: none; }
    .head b { flex: 1; font-size: 14px; font-weight: 700; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .head button { width: 26px; height: 26px; border-radius: 8px; background: rgba(255,255,255,.08); border: 0; color: #fff; font-size: 15px; cursor: pointer; line-height: 1; }
    .head button:hover { background: rgba(255,255,255,.18); }
    .body { padding: 14px; overflow: auto; }
    /* scheda tecnica: celle separate da righe sottili, le prime due più grandi */
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; box-shadow: var(--shadow-sm); }
    .stat { background: var(--surface); padding: 9px 12px; }
    .stat .v { font-size: 16px; font-weight: 700; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
    .stat .l { font-size: 11.5px; color: var(--slate); margin-top: 1px; }
    .grid .stat:nth-child(-n+2) { background: var(--plate); padding: 12px; }
    .grid .stat:nth-child(-n+2) .v { font-size: 24px; letter-spacing: -.02em; }
    h4 { display: flex; align-items: center; gap: 8px; margin: 18px 0 8px; font-size: 13px; font-weight: 650; color: var(--ink); }
    h4::before { content: ""; width: 4px; height: 14px; border-radius: 2px; background: var(--green); }
    h4.gold::before { background: var(--gold); }
    h4 select { margin-left: auto; font-size: 12px; font-weight: 500; }
    select, input[type=search] { font-size: 12px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 6px 10px; box-shadow: var(--shadow-sm); }
    select:focus, input:focus { outline: 2px solid var(--green); outline-offset: 1px; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; box-shadow: var(--shadow-sm); }
    th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid var(--line); vertical-align: middle; }
    tbody tr:last-child td { border-bottom: 0; }
    th { background: var(--plate); color: var(--slate); font-weight: 600; white-space: nowrap; }
    td.n, th.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    tbody tr:hover td { background: var(--green-soft); }
    .btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .btn { background: var(--green); color: #fff; border: 0; border-radius: 10px; padding: 9px 14px; font-size: 13px; font-weight: 650; cursor: pointer;
      box-shadow: 0 2px 0 var(--green-deep), 0 6px 14px -4px rgba(0,174,66,.45); transition: transform .08s, box-shadow .08s; }
    .btn:hover { transform: translateY(-1px); }
    .btn:active { transform: translateY(1px); box-shadow: 0 1px 0 var(--green-deep); }
    .btn.sec { background: var(--surface); color: var(--ink); border: 1px solid var(--line); box-shadow: var(--shadow-sm); }
    .muted { color: var(--slate); font-size: 12px; }
    .err { color: #cf222e; font-size: 12px; }
    .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-top: 10px; font-variant-numeric: tabular-nums; }
    .row b { font-size: 14px; }
    /* barre come filamento estruso */
    .bar { height: 10px; border-radius: 6px; overflow: hidden; margin: 5px 0 3px; background: var(--plate);
      box-shadow: inset 0 1px 2px rgba(16,24,40,.12); }
    .bar i { display: block; height: 100%; border-radius: 6px; background: var(--layers), linear-gradient(90deg, var(--green-deep), var(--green) 70%, #3fcf78); }
    .bar.gold i { background: var(--layers), linear-gradient(90deg, #a8822f, var(--gold) 70%, #e2c27a); }
    .body a { color: var(--link); text-decoration: none; font-weight: 500; }
    .body a:hover { text-decoration: underline; }
    .tag { display: inline-block; background: var(--green-soft); color: var(--green-deep); border: 1px solid rgba(0,174,66,.25); border-radius: 999px; padding: 2px 9px; font-size: 11px; font-weight: 600; margin: 0 4px 8px 0; }
    /* modale */
    .ovl { position: fixed; inset: 0; z-index: 2147483001; background: rgba(15,20,25,.5); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; padding: 24px; }
    .modal { background: var(--surface); color: var(--ink); border-radius: 18px; width: min(1120px, 100%); max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; font-size: 13px; box-shadow: var(--shadow-lg); }
    .modal .head { cursor: default; padding: 14px 16px; }
    .modal .head b { font-size: 15px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 16px; background: var(--plate); border-bottom: 1px solid var(--line); }
    .toolbar label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; padding: 6px 12px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-sm); font-size: 12px; font-weight: 500; }
    .toolbar label:has(input:checked) { background: var(--green-soft); border-color: var(--green); color: var(--green-deep); }
    .toolbar input[type=checkbox] { accent-color: var(--green); margin: 0; }
    .toolbar input[type=search] { min-width: 200px; }
    .mbody { overflow: auto; padding: 4px 16px 16px; background: var(--plate); }
    .item { display: flex; gap: 12px; padding: 14px; margin-top: 10px; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow-sm); }
    .item img.av { width: 40px; height: 40px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px var(--surface), 0 0 0 3px var(--line); }
    .item[data-id] { cursor: pointer; transition: border-color .12s, transform .12s; }
    .item[data-id]:hover { border-color: var(--green); transform: translateY(-1px); }
    .item .on { font-size: 12px; color: var(--green-deep); margin-bottom: 3px; }
    .item .meta { color: var(--slate); font-size: 12px; margin-bottom: 5px; }
    .item .meta a { color: var(--ink); text-decoration: none; }
    .item .txt { white-space: pre-wrap; word-break: break-word; font-size: 13.5px; line-height: 1.5; }
    .item .pics { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    .item .pics img { width: 96px; height: 96px; object-fit: cover; border-radius: 10px; box-shadow: var(--shadow-sm); transition: transform .12s; }
    .item .pics a:hover img { transform: scale(1.04); }
    .stars { color: #e3a008; letter-spacing: 1px; }
    /* stelle in ordine inverso nel DOM: così "~" accende anche quelle a sinistra */
    .starpick { display: inline-flex; flex-direction: row-reverse; align-items: center; padding: 3px 8px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-sm); }
    .starpick button { background: none; border: 0; padding: 0 1px; font-size: 22px; line-height: 1; color: #d0d7de; cursor: pointer; transition: transform .1s; }
    .starpick button.on { color: #e3a008; text-shadow: 0 1px 4px rgba(227,160,8,.45); }
    .starpick:hover button { color: #d0d7de; text-shadow: none; }
    .starpick button:hover, .starpick button:hover ~ button { color: #f5b301; text-shadow: 0 1px 4px rgba(245,179,1,.45); }
    .starpick button:hover { transform: scale(1.18); }
    .starlbl { font-size: 12px; color: var(--slate); min-width: 90px; }
    .sum { padding: 10px 16px; color: var(--slate); font-size: 12px; border-bottom: 1px solid var(--line); background: var(--surface); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .models { box-shadow: var(--shadow-sm); margin-top: 12px; }
    .models th { position: sticky; top: 0; z-index: 1; cursor: pointer; padding-top: 10px; }
    .models th:hover { color: var(--ink); }
    .models td { background: var(--surface); }
    .models img { width: 46px; height: 46px; object-fit: cover; border-radius: 10px; box-shadow: var(--shadow-sm); }
    .models a { color: var(--ink); text-decoration: none; font-weight: 600; }
    .models a:hover { color: var(--green-deep); }
    .models tfoot td { font-weight: 700; background: var(--plate); border-top: 2px solid var(--line); }
    /* grafici: una serie, barre sottili, griglia a filo, valore nel tooltip */
    :host { --bar-dl: #00862f; --bar-pts: #a8822f; }
    @media (prefers-color-scheme: dark) { :host { --bar-dl: #00ae42; } }
    .trends { background: var(--plate); padding-top: 4px; }
    .chart { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px 6px; box-shadow: var(--shadow-sm); }
    .chart svg { display: block; width: 100%; height: auto; }
    .chart .grid line { stroke: var(--line); stroke-width: 1; }
    .chart text { fill: var(--slate); font-size: 11px; font-variant-numeric: tabular-nums; }
    .chart.dl path { fill: var(--bar-dl); }
    .chart.pts path { fill: var(--bar-pts); }
    .chart path.on { opacity: .75; }
    .chart .hit { fill: transparent; cursor: default; }
    .chart .tip { position: absolute; transform: translate(-50%, -100%); pointer-events: none; background: var(--graphite); color: #fff; padding: 5px 9px; border-radius: 8px; font-size: 12px; white-space: nowrap; box-shadow: var(--shadow-sm); }
    .up { color: var(--green-deep); font-weight: 600; }
    .down { color: #c2410c; font-weight: 600; }
    /* risposte rapide */
    .qr { position: fixed; z-index: 2147483002; display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; background: var(--surface);
      border-radius: 14px; box-shadow: var(--shadow-lg); font-size: 12px; border-top: 3px solid var(--green); }
    .qr button { border: 1px solid var(--line); background: var(--plate); color: var(--ink); border-radius: 999px; padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; transition: transform .08s; }
    .qr button:hover { border-color: var(--green); background: var(--green-soft); transform: translateY(-1px); }
    .qr .prev { flex-basis: 100%; order: -1; padding: 6px 10px; border-radius: 10px; background: var(--plate); color: var(--slate); font-size: 12px; line-height: 1.45; white-space: normal; }
    .qr .prev.on { color: var(--ink); background: var(--green-soft); }
    .qr button.lang { background: var(--graphite); border-color: var(--graphite); color: #fff; font-weight: 600; }
    .qr button.save { background: var(--green); border-color: var(--green); color: #fff; font-weight: 700; box-shadow: 0 2px 0 var(--green-deep); }
  </style>
  <div class="panel" hidden>
    <div class="head"><svg class="logo" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#14181c"/><rect x="20" y="62" width="56" height="7" rx="3.5" fill="#00AE42" opacity=".55"/><rect x="24" y="73" width="48" height="7" rx="3.5" fill="#00AE42" opacity=".3"/><polyline points="14,50 30,50 37,34 47,58 56,22 63,50 82,50" fill="none" stroke="#00AE42" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg><b>MakerPulse</b><button class="tog" title="${t('Collapse/expand', 'Comprimi/espandi')}">▾</button><button class="x" title="${t('Close', 'Chiudi')}">×</button></div>
    <div class="body"></div>
  </div>
  <div class="ovl" hidden><div class="modal"></div></div>
  <div class="qr" hidden></div>`;

  const panel = root.querySelector('.panel');
  const body = root.querySelector('.body');
  const ovl = root.querySelector('.ovl');
  const modal = root.querySelector('.modal');

  function setCollapsed(c) {
    settings.collapsed = c;
    panel.classList.toggle('collapsed', c);
    root.querySelector('.tog').textContent = c ? '▸' : '▾';
    save({ collapsed: c });
  }
  root.querySelector('.head').addEventListener('click', (e) => {
    if (!e.target.closest('.x')) setCollapsed(!settings.collapsed);
  });
  root.querySelector('.x').addEventListener('click', () => (panel.hidden = true));
  ovl.addEventListener('click', (e) => e.target === ovl && closeModal());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !ovl.hidden && closeModal());

  function openModal(title, html) {
    modal.innerHTML = `<div class="head">${root.querySelector('.head .logo').outerHTML}<b>${esc(title)}</b><button class="mx" title="${t('Close', 'Chiudi')}">×</button></div>${html}`;
    modal.querySelector('.mx').onclick = closeModal;
    ovl.hidden = false;
  }
  function closeModal() {
    ovl.hidden = true;
    modal.innerHTML = '';
  }

  // ---------- risposte rapide nei commenti ----------
  // Testi in inglese e italiano: si usa la lingua di chi ha scritto il commento a cui rispondi (inglese per le altre lingue).
  const replies = (lang) => {
    const own = settings[lang === 'it' ? 'repliesIt' : 'repliesEn'];
    return Array.isArray(own) && own.length ? own : globalThis.MAKERPULSE_DEFAULT_REPLIES?.[lang] || [];
  };
  const qr = root.querySelector('.qr');
  let qrTarget = null;
  let qrLang = 'en'; // inglese di default: l'italiano solo se il commento a cui rispondi è in italiano
  let qrAuto = false; // true se la lingua è stata rilevata dal commento

  function drawQr() {
    qr.innerHTML =
      `<button class="lang" title="${t('Language of the replies: click to switch', 'Lingua delle risposte: clicca per cambiarla')}">${qrLang === 'it' ? '🇮🇹 IT' : '🇬🇧 EN'}${qrAuto ? ' · auto' : ''}</button>` +
      replies(qrLang).map((r, i) => `<button data-i="${i}" title="${esc(r)}">${esc(r.length > 40 ? `${r.slice(0, 38)}…` : r)}</button>`).join('') +
      `<button class="save" title="${t('Save the current text as a quick reply', 'Salva il testo attuale come risposta rapida')}">+</button>` +
      `<div class="prev">${t('Hover a reply to read it all, click to insert it', 'Passa sopra una risposta per leggerla tutta, clicca per inserirla')}</div>`;
  }
  // Anteprima del testo completo al passaggio del mouse.
  qr.addEventListener('mouseover', (e) => {
    const b = e.target.closest('button[data-i]');
    const prev = qr.querySelector('.prev');
    if (!prev) return;
    prev.classList.toggle('on', !!b);
    prev.textContent = b ? replies(qrLang)[+b.dataset.i] : t('Hover a reply to read it all, click to insert it', 'Passa sopra una risposta per leggerla tutta, clicca per inserirla');
    placeQr();
  });
  function placeQr() {
    if (qr.hidden) return;
    if (!qrTarget?.isConnected) return hideQr();
    const r = qrTarget.getBoundingClientRect();
    qr.style.left = `${Math.max(8, r.left)}px`;
    qr.style.maxWidth = `${Math.max(280, r.width)}px`;
    const h = qr.offsetHeight;
    qr.style.top = `${r.top - h - 14 > 8 ? r.top - h - 14 : r.bottom + 8}px`; // sopra l'editor, o sotto se non c'è spazio
  }
  function hideQr() {
    qr.hidden = true;
    qrTarget = null;
  }

  // Lingua di un testo: rilevatore di Chrome, con un controllo di riserva sulle parole italiane più comuni.
  async function detectLang(text) {
    try {
      const r = await chrome.i18n.detectLanguage(text);
      const top = r?.languages?.[0];
      if (top?.language) return top.language.startsWith('it') ? 'it' : 'en';
    } catch {}
    const hits = text.toLowerCase().match(/\b(che|non|sono|grazie|molto|della|questo|questa|stampa|stampato|ciao|anche|bellissimo|bellissima|progetto|perfetto|davvero|tutto|ottimo)\b/g);
    return (hits?.length || 0) >= 2 ? 'it' : 'en';
  }
  // Commenti del modello (testo originale), caricati una volta per pagina.
  const commentsCache = new Map();
  const designComments = (id) => {
    if (!commentsCache.has(id)) commentsCache.set(id, loadComments(id).catch(() => []));
    return commentsCache.get(id);
  };
  // A chi stai rispondendo: MakerWorld scrive "Reply @utente" come segnaposto del campo di risposta.
  function replyTarget(ed) {
    let p = ed.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const m = p.innerText.replace(ed.innerText, '').match(/@([\w.\-]+)/);
      if (m) return m[1];
    }
    return null;
  }
  async function pickLanguage(ed) {
    const r = route();
    if (r?.type !== 'model') return;
    // Il campo riceve il focus un attimo prima che MakerWorld scriva "Reply @utente".
    let handle = null;
    for (let i = 0; i < 15 && !(handle = replyTarget(ed)) && qrTarget === ed; i++) await new Promise((res) => setTimeout(res, 100));
    if (!handle) return;
    const items = await designComments(r.id);
    const text = items
      .filter((i) => (i.user.handle || '').toLowerCase() === handle.toLowerCase() && i.orig.trim())
      .slice(0, 3)
      .map((i) => i.orig)
      .join('\n');
    if (!text || qrTarget !== ed) return;
    qrLang = await detectLang(text);
    qrAuto = true;
    drawQr();
    placeQr();
  }

  // Solo gli editor di commenti e risposte di un modello (div contenteditable nella sezione commenti),
  // non Bio, upload, tag o altri campi di testo.
  document.addEventListener('focusin', (e) => {
    const ed = e.target.closest?.('.js-editable-content');
    if (!settings.quickReplies || route()?.type !== 'model' || !ed?.closest('.js-comment-and-rating form')) return;
    if (!host.isConnected) document.documentElement.appendChild(host);
    const isNew = qrTarget !== ed;
    qrTarget = ed;
    if (isNew) {
      qrLang = 'en';
      qrAuto = false;
      pickLanguage(ed);
    }
    drawQr();
    qr.hidden = false;
    placeQr();
  });
  document.addEventListener('focusout', () =>
    setTimeout(() => {
      if (qrTarget && !qrTarget.contains(document.activeElement)) hideQr();
    }, 150)
  );
  qr.addEventListener('mousedown', (e) => e.preventDefault()); // il focus resta nell'editor
  qr.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !qrTarget) return;
    qrTarget.focus();
    if (b.classList.contains('lang')) {
      qrLang = qrLang === 'it' ? 'en' : 'it';
      qrAuto = false;
    } else if (b.classList.contains('save')) {
      const txt = (qrTarget.value ?? qrTarget.innerText).trim();
      const key = qrLang === 'it' ? 'repliesIt' : 'repliesEn';
      if (txt && !replies(qrLang).includes(txt)) {
        settings[key] = [...replies(qrLang), txt];
        save({ [key]: settings[key] });
      }
    } else {
      // insertText passa dagli eventi input, così l'editor del sito registra il testo
      document.execCommand('insertText', false, replies(qrLang)[+b.dataset.i]);
      return;
    }
    drawQr();
    placeQr();
  });
  window.addEventListener('scroll', placeQr, true);
  window.addEventListener('resize', placeQr);

  const stat = (v, l) => `<div class="stat"><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`;

  // ---------- pagina modello ----------
  async function renderModel(id, token) {
    const d = await api(`/api/v1/design-service/design/${id}`);
    if (token !== renderToken) return;
    const inst = d.instances || [];
    const instDl = inst.reduce((s, i) => s + (i.downloadCount || 0), 0);
    const instPr = inst.reduce((s, i) => s + (i.printCount || 0), 0);
    const days = ageDays(d.createTime);
    const tags = [
      d.isExclusive && t('Exclusive', 'Esclusivo'),
      d.isStaffPicked && 'Staff Pick',
      d.contest?.contestName && `Contest: ${d.contest.contestName}`,
      d.isPointRedeemable && t('Redeemable with points', 'Riscattabile con punti'),
    ].filter(Boolean);

    body.innerHTML = `
      ${tags.length ? `<div>${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="grid">
        ${stat(fmt(d.downloadCount), t('Model downloads', 'Download modello'))}
        ${stat(fmt(d.printCount), t('Prints', 'Stampe'))}
        ${stat(fmt(instDl), t('Profile downloads (sum)', 'Download profili (somma)'))}
        ${stat(fmt(instPr), t('Profile prints (sum)', 'Stampe profili (somma)'))}
        ${stat(fmt(d.likeCount), t('Likes', 'Mi piace'))}
        ${stat(fmt(d.collectionCount), t('Collections', 'Collezioni'))}
        ${stat(fmt(d.boostInfo?.total), t('Boosts received', 'Boost ricevuti'))}
        ${stat(fmt(d.commentCount), t('Comments', 'Commenti'))}
        ${stat(pct(d.printCount, d.downloadCount), t('Prints / downloads', 'Stampe / download'))}
        ${stat(pct(d.likeCount, d.downloadCount), t('Likes / downloads', 'Mi piace / download'))}
        ${stat(dec(d.downloadCount / days, 1), t('Downloads per day', 'Download al giorno'))}
        ${stat(date(d.createTime), t(`Published (${Math.floor(days)} days ago)`, `Pubblicato (${Math.floor(days)} gg fa)`))}
      </div>
      ${
        inst.length
          ? `<h4>${t('Print profiles', 'Profili di stampa')} (${inst.length})</h4>
        <table><thead><tr><th>${t('Profile', 'Profilo')}</th><th class="n">DL</th><th class="n">${t('Prints', 'Stampe')}</th><th class="n">${t('Rating', 'Voto')}</th><th class="n">${t('Time', 'Tempo')}</th></tr></thead><tbody>
        ${inst
          .map(
            (i) => `<tr><td>${esc(i.titleTranslated || i.title)}</td><td class="n">${fmt(i.downloadCount)}</td><td class="n">${fmt(
              i.printCount
            )}</td><td class="n">${i.ratingCount ? `${dec(i.ratingScoreTotal / i.ratingCount, 1)} (${i.ratingCount})` : '–'}</td><td class="n">${hm(
              i.prediction
            )}</td></tr>`
          )
          .join('')}</tbody></table>`
          : ''
      }
      <div class="mine"></div>
      <div class="btns"><button class="btn" data-act="comments">${t('Filter comments and reviews', 'Filtra commenti e recensioni')}</button></div>`;
    body.querySelector('[data-act=comments]').onclick = () => openComments(id, d.titleTranslated || d.title);
    const own = await isMe(d.designCreator?.handle);
    if (own && settings.quickReplies) designComments(id); // per scegliere subito la lingua delle risposte rapide
    if (own && settings.pointsPanel) modelPoints(id, body.querySelector('.mine'), token).catch(() => {});
  }

  async function modelPoints(id, el, token) {
    const m = await me();
    const [agg, cards] = await Promise.all([pointBills(m.uid), giftRegion().then(giftCards)]);
    const e = agg.byDesign[id];
    if (token !== renderToken || !e) return;
    el.innerHTML = `<h4>${t('Points earned by this model', 'Punti guadagnati da questo modello')}</h4><div class="grid">
      ${stat(fmt(Math.round(e.all)), `${t('Total', 'Totale')} (≈ ${giftValue(e.all, cards)})`)}
      ${stat(fmt(Math.round(e.ex)), t('of which exclusive', 'di cui esclusivi'))}
      ${stat(fmt(Math.round(sumSince(e.d, 30))), t('Last 30 days', 'Ultimi 30 giorni'))}
      ${stat(fmt(Math.round(sumSince(e.d, 7))), t('Last 7 days', 'Ultimi 7 giorni'))}
      ${stat(fmt(Math.round(e.boost)), t('From boosts', 'Da boost'))}
    </div>`;
  }

  // ---------- commenti / recensioni ----------
  function normalize(h) {
    if (h.ratingItem) {
      const r = h.ratingItem;
      return {
        kind: 'rating', id: r.id, score: r.score || 0, text: r.contentTranslated || r.content || '', orig: r.content || '', images: r.images || [],
        user: r.creator || {}, time: r.createTime, likes: r.likeCount || 0, replies: r.replyCount || 0,
        authorReplied: !!r.replyByInstanceUser, boosted: !!r.boosted, printed: !!r.successPrinted,
        profile: r.instInfo?.title || '',
      };
    }
    const c = h.comment || {};
    return {
      kind: 'comment', id: c.id, score: 0, text: c.contentTranslated || c.content || '', orig: c.content || '', images: c.images || [],
      user: c.user || {}, time: c.createTime, likes: c.likeCount || 0, replies: c.replyCount || 0,
      authorReplied: !!c.replyByDesignUser, boosted: !!c.boosted, printed: false, profile: '',
    };
  }
  const imgUrl = (x) => (typeof x === 'string' ? x : x?.url || x?.imageUrl || x?.picUrl || '');
  // Miniatura dal CDN di MakerWorld (gli originali pesano diversi MB).
  const thumb = (u, w) => (u && u.includes('bblmw.com') && !u.includes('?') ? `${u}?x-oss-process=image/resize,w_${w}/format,webp` : u);

  // Tutti i commenti e le recensioni di un modello, senza doppioni. onPage(caricati, totale) può restituire false per interrompere.
  async function loadComments(designId, onPage) {
    const items = [];
    for (let offset = 0; ; offset += 50) {
      const j = await api(`/api/v1/comment-service/commentandrating?designId=${designId}&limit=50&offset=${offset}&msgId=0&msgType=0`);
      (j.hits || []).forEach((h) => items.push(normalize(h)));
      if (onPage?.(items.length, j.total) === false) return null;
      if (!j.hits?.length || j.hits.length < 50 || items.length >= j.total) break;
    }
    const seen = new Set();
    return items.filter((i) => !seen.has(i.kind + i.id) && seen.add(i.kind + i.id));
  }

  const itemHtml = (i) => {
    const lp = localePrefix();
    return `<div class="item" data-id="${i.id}" data-kind="${i.kind}" data-handle="${esc(i.user.handle)}" data-design="${i.design?.id || ''}" title="${t('Show on the page', 'Mostra sulla pagina')}">
          ${i.user.avatar ? `<img class="av" src="${esc(thumb(i.user.avatar, 64))}" alt="">` : ''}
          <div>
            ${i.design ? `<div class="on">${t('on', 'su')} <b>${esc(i.design.title)}</b></div>` : ''}
            <div class="meta"><a href="${lp}/@${esc(i.user.handle)}" target="_blank" rel="noopener"><b>${esc(i.user.name || i.user.handle || t('User', 'Utente'))}</b></a>
              · ${date(i.time)}
              ${i.kind === 'rating' && i.score ? ` · <span class="stars">${'★'.repeat(i.score)}${'☆'.repeat(5 - i.score)}</span>` : ` · ${t('comment', 'commento')}`}
              ${i.profile ? ` · ${esc(i.profile)}` : ''}
              ${i.printed ? ` · ✅ ${t('printed', 'stampato')}` : ''}${i.boosted ? ' · 🚀 boost' : ''}${i.authorReplied ? ` · 💬 ${t('author reply', 'risposta autore')}` : ''}
              ${i.likes ? ` · ♥ ${i.likes}` : ''}</div>
            <div class="txt">${esc(i.text) || `<span class="muted">${t('(no text)', '(nessun testo)')}</span>`}</div>
            ${i.images.length ? `<div class="pics">${i.images.map((x) => `<a href="${esc(imgUrl(x))}" target="_blank" rel="noopener"><img src="${esc(thumb(imgUrl(x), 200))}" loading="lazy" alt=""></a>`).join('')}</div>` : ''}
          </div></div>`;
  };
  // Clic su un commento: porta al commento sulla pagina del suo modello.
  const bindGoTo = (list, designId) =>
    list.addEventListener('click', (e) => {
      const it = e.target.closest('.item[data-id]');
      if (!it || e.target.closest('a')) return; // link a profilo e foto restano normali
      goToComment(it.dataset.design || designId, it.dataset);
    });

  async function openComments(id, title) {
    openModal(`${t('Comments and reviews', 'Commenti e recensioni')} – ${title}`, `<div class="sum">${t('Loading…', 'Caricamento…')}</div><div class="mbody"></div>`);
    const sum = modal.querySelector('.sum');
    let all;
    try {
      all = await loadComments(id, (n, total) => {
        if (ovl.hidden) return false;
        sum.textContent = `${t('Loading…', 'Caricamento…')} ${n} / ${total ?? '?'}`;
      });
    } catch (e) {
      sum.innerHTML = `<span class="err">${t('Loading error', 'Errore nel caricamento')}: ${esc(e.message)}</span>`;
      return;
    }
    if (!all) return;
    const ratings = all.filter((i) => i.kind === 'rating' && i.score);
    const dist = [5, 4, 3, 2, 1].map((s) => `${s}★ ${ratings.filter((r) => r.score === s).length}`).join(' · ');
    const avg = ratings.length ? (ratings.reduce((s, r) => s + r.score, 0) / ratings.length).toLocaleString(LOC, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '–';

    sum.insertAdjacentHTML(
      'beforebegin',
      `<div class="toolbar">
        <select data-f="kind"><option value="">${t('All', 'Tutti')}</option><option value="rating">${t('Reviews only', 'Solo recensioni')}</option><option value="comment">${t('Comments only', 'Solo commenti')}</option></select>
        <span class="starpick">${[5, 4, 3, 2, 1]
          .map((s) => `<button type="button" data-star="${s}" title="${s}★ · ${ratings.filter((r) => r.score === s).length}">★</button>`)
          .join('')}</span><span class="starlbl"></span>
        <label><input type="checkbox" data-f="text">${t('With text', 'Con testo')}</label>
        <label><input type="checkbox" data-f="pics">${t('With photos', 'Con foto')}</label>
        <label><input type="checkbox" data-f="printed">${t('Printed successfully', 'Stampa riuscita')}</label>
        <label><input type="checkbox" data-f="boosted">${t('Boosted', 'Con boost')}</label>
        <select data-f="reply"><option value="">${t('Author reply: any', 'Risposta autore: tutte')}</option><option value="yes">${t('Author replied', 'Con risposta autore')}</option><option value="no">${t('No author reply', 'Senza risposta autore')}</option></select>
        <select data-f="sort"><option value="new">${t('Newest', 'Più recenti')}</option><option value="old">${t('Oldest', 'Più vecchi')}</option><option value="likes">${t('Most liked', 'Più apprezzati')}</option><option value="low">${t('Lowest rating', 'Voto più basso')}</option></select>
        <input type="search" data-f="q" placeholder="${t('Search text or user…', 'Cerca nel testo o utente…')}">
      </div>`
    );
    const tb = modal.querySelector('.toolbar');
    const list = modal.querySelector('.mbody');
    let starSel = 0; // 0 = tutte le stelle
    tb.querySelector('.starpick').addEventListener('click', (e) => {
      const b = e.target.closest('[data-star]');
      if (!b) return;
      starSel = starSel === +b.dataset.star ? 0 : +b.dataset.star;
      draw();
    });

    const draw = () => {
      const f = (k) => tb.querySelector(`[data-f=${k}]`);
      tb.querySelectorAll('[data-star]').forEach((b) => b.classList.toggle('on', +b.dataset.star <= starSel));
      tb.querySelector('.starlbl').textContent = starSel
        ? t(`Only ${starSel}★ (${ratings.filter((r) => r.score === starSel).length})`, `Solo ${starSel}★ (${ratings.filter((r) => r.score === starSel).length})`)
        : t('All ratings', 'Tutti i voti');
      const q = f('q').value.trim().toLowerCase();
      let out = all.filter(
        (i) =>
          (!f('kind').value || i.kind === f('kind').value) &&
          (!starSel || (i.kind === 'rating' && i.score === starSel)) &&
          (!f('text').checked || i.text.trim()) &&
          (!f('pics').checked || i.images.length) &&
          (!f('printed').checked || i.printed) &&
          (!f('boosted').checked || i.boosted) &&
          (!f('reply').value || i.authorReplied === (f('reply').value === 'yes')) &&
          (!q || i.text.toLowerCase().includes(q) || (i.user.name || '').toLowerCase().includes(q) || (i.user.handle || '').toLowerCase().includes(q))
      );
      const s = f('sort').value;
      out.sort((a, b) =>
        s === 'likes' ? b.likes - a.likes : s === 'low' ? (a.score || 9) - (b.score || 9) : s === 'old' ? new Date(a.time) - new Date(b.time) : new Date(b.time) - new Date(a.time)
      );
      sum.textContent = t(
        `${out.length} of ${all.length} shown · ${ratings.length} reviews, average ${avg} · ${dist}`,
        `${out.length} di ${all.length} mostrati · ${ratings.length} recensioni, media ${avg} · ${dist}`
      );
      list.innerHTML =
        out
          .slice(0, 500)
          .map(itemHtml)
          .join('') || `<p class="muted">${t('No results with these filters.', 'Nessun risultato con questi filtri.')}</p>`;
    };
    tb.addEventListener('input', draw);
    bindGoTo(list, id);
    draw();
  }

  // ---------- vai al commento sulla pagina ----------
  // MakerWorld mette in cima alla lista il messaggio indicato da ?replyId=…&replyType=… (1 commento, 2 recensione),
  // lo stesso meccanismo dei link dalle notifiche; dopo il caricamento l'estensione ci scorre e lo evidenzia.
  function goToComment(designId, d) {
    try {
      sessionStorage.setItem('makerpulse-goto', JSON.stringify({ id: d.id, handle: d.handle, at: Date.now() }));
    } catch {}
    location.href = `${localePrefix()}/models/${designId}?replyId=${d.id}&replyType=${d.kind === 'rating' ? 2 : 1}`;
  }
  async function scrollToPendingComment() {
    let g;
    try {
      g = JSON.parse(sessionStorage.getItem('makerpulse-goto') || 'null');
      sessionStorage.removeItem('makerpulse-goto');
    } catch {}
    const replyId = new URLSearchParams(location.search).get('replyId');
    if (!g || g.id !== replyId || Date.now() - g.at > 60e3 || !g.handle) return;
    // Il messaggio richiesto è il primo link al suo autore che compare sotto il campo per scrivere un commento.
    const find = () => {
      const editor = document.querySelector('.js-editable-content');
      const minTop = editor ? editor.getBoundingClientRect().bottom : 0;
      return [...document.querySelectorAll(`a[href*="/@${CSS.escape(g.handle)}"]`)].find(
        (a) => a.textContent.trim() && a.getBoundingClientRect().top > minTop
      );
    };
    let a;
    for (let i = 0; i < 60 && !(a = find()); i++) await new Promise((r) => setTimeout(r, 250));
    if (!a) return;
    let card = a;
    while (card.parentElement && card.offsetWidth < 400) card = card.parentElement;
    while (card.parentElement && card.offsetHeight < 70) card = card.parentElement;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prev = { outline: card.style.outline, offset: card.style.outlineOffset, radius: card.style.borderRadius };
    Object.assign(card.style, { outline: '3px solid #00ae42', outlineOffset: '6px', borderRadius: '12px' });
    setTimeout(() => Object.assign(card.style, { outline: prev.outline, outlineOffset: prev.offset, borderRadius: prev.radius }), 4000);
  }

  // ---------- pagina profilo ----------
  const profileCache = new Map();
  async function profileData(handle) {
    if (profileCache.has(handle)) return profileCache.get(handle);
    const html = await (await fetch(`${localePrefix()}/@${encodeURIComponent(handle)}`, { credentials: 'include' })).text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error(t('profile data not found', 'dati profilo non trovati'));
    const u = JSON.parse(m[1]).props?.pageProps?.userInfo;
    if (!u) throw new Error(t('profile not found', 'profilo non trovato'));
    profileCache.set(handle, u);
    return u;
  }

  async function renderProfile(handle, token) {
    const u = await profileData(handle);
    if (token !== renderToken) return;
    const c = u.MWCount || {};
    body.innerHTML = `
      <div class="muted" style="margin-bottom:8px"><b>${esc(u.name)}</b> · @${esc(u.handle)} · ${t('level', 'livello')} ${fmt(u.personal?.userLevel?.level)}</div>
      <div class="grid">
        ${stat(fmt(u.downloadCount), t('Total downloads', 'Download totali'))}
        ${stat(fmt(c.designCount), t('Published models', 'Modelli pubblicati'))}
        ${stat(fmt(c.myDesignDownloadCount), t('Model downloads', 'Download modelli'))}
        ${stat(fmt(c.myDesignPrintCount), t('Model prints', 'Stampe modelli'))}
        ${stat(fmt(c.myInstanceDownloadCount), t('Profile downloads', 'Download profili'))}
        ${stat(fmt(c.myInstancePrintCount), t('Profile prints', 'Stampe profili'))}
        ${stat(fmt(u.likeCount), t('Likes received', 'Mi piace ricevuti'))}
        ${stat(fmt(u.collectionCount), t('Collections', 'Collezioni'))}
        ${stat(fmt(u.boostGained), t('Boosts received', 'Boost ricevuti'))}
        ${stat(fmt(u.fanCount), t('Followers', 'Follower'))}
      </div>
      <div class="btns"><button class="btn" data-act="models">${t('Table of all models', 'Tabella di tutti i modelli')}</button></div>
      <div class="mine"></div>`;
    const own = await isMe(u.handle);
    const mine = settings.pointsPanel && own;
    body.querySelector('[data-act=models]').onclick = () => openModels(u, mine);
    if (own && token === renderToken) {
      body.querySelector('.btns').insertAdjacentHTML(
        'beforeend',
        `<button class="btn sec" data-act="inbox">💬 ${t('To reply', 'Da rispondere')}</button><button class="btn sec" data-act="trends">📈 ${t('Trends', 'Andamento')}</button>`
      );
      body.querySelector('[data-act=inbox]').onclick = () => openInbox(u);
      body.querySelector('[data-act=trends]').onclick = () => openTrends(u);
    }
    if (mine && token === renderToken) await mountPoints(body.querySelector('.mine'), token);
  }

  // Tutti i modelli pubblicati da un utente.
  async function loadDesigns(u) {
    const rows = [];
    for (let offset = 0; ; offset += 100) {
      const j = await api(`/api/v1/design-service/published/${u.uid}/design?handle=${encodeURIComponent(u.handle)}&limit=100&offset=${offset}`);
      rows.push(...(j.hits || []));
      if (!j.hits?.length || rows.length >= j.total) break;
    }
    return rows;
  }

  // ---------- da rispondere: commenti e recensioni senza la tua risposta, su tutti i tuoi modelli ----------
  async function openInbox(u) {
    openModal(t('To reply', 'Da rispondere'), `<div class="sum">${t('Loading…', 'Caricamento…')}</div><div class="mbody"></div>`);
    const sum = modal.querySelector('.sum');
    const list = modal.querySelector('.mbody');
    const myHandle = u.handle.toLowerCase();
    const all = [];
    try {
      const designs = await loadDesigns(u);
      let done = 0;
      const queue = [...designs];
      const worker = async () => {
        while (queue.length && !ovl.hidden) {
          const d = queue.shift();
          const items = (await loadComments(d.id).catch(() => null)) || [];
          for (const i of items)
            if (!i.authorReplied && (i.user.handle || '').toLowerCase() !== myHandle) all.push({ ...i, design: { id: d.id, title: d.titleTranslated || d.title } });
          sum.textContent = `${t('Checking your models…', 'Controllo i tuoi modelli…')} ${++done} / ${designs.length}`;
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]); // 4 richieste alla volta
    } catch (e) {
      sum.innerHTML = `<span class="err">${t('Loading error', 'Errore nel caricamento')}: ${esc(e.message)}</span>`;
      return;
    }
    if (ovl.hidden) return;
    sum.insertAdjacentHTML(
      'beforebegin',
      `<div class="toolbar">
        <select data-f="days"><option value="7">${t('Last 7 days', 'Ultimi 7 giorni')}</option><option value="30" selected>${t('Last 30 days', 'Ultimi 30 giorni')}</option><option value="90">${t('Last 90 days', 'Ultimi 90 giorni')}</option><option value="0">${t('Any time', 'Sempre')}</option></select>
        <select data-f="kind"><option value="">${t('Reviews and comments', 'Recensioni e commenti')}</option><option value="rating">${t('Reviews only', 'Solo recensioni')}</option><option value="comment">${t('Comments only', 'Solo commenti')}</option></select>
        <label><input type="checkbox" data-f="text" checked>${t('With text', 'Con testo')}</label>
        <label><input type="checkbox" data-f="pics">${t('With photos', 'Con foto')}</label>
      </div>`
    );
    const tb = modal.querySelector('.toolbar');
    const f = (k) => tb.querySelector(`[data-f=${k}]`);
    const draw = () => {
      const days = +f('days').value;
      const since = days ? Date.now() - days * 864e5 : 0;
      const out = all
        .filter(
          (i) =>
            new Date(i.time) >= since &&
            (!f('kind').value || i.kind === f('kind').value) &&
            (!f('text').checked || i.text.trim()) &&
            (!f('pics').checked || i.images.length)
        )
        .sort((a, b) => new Date(b.time) - new Date(a.time));
      sum.textContent = t(`${out.length} waiting for your reply · click one to open it on the page`, `${out.length} in attesa di risposta · clicca per aprirlo sulla pagina`);
      list.innerHTML = out.slice(0, 500).map(itemHtml).join('') || `<p class="muted">${t('Nothing waiting for a reply in this period.', 'Niente in attesa di risposta in questo periodo.')}</p>`;
    };
    tb.addEventListener('input', draw);
    bindGoTo(list);
    draw();
  }

  // ---------- storico: una fotografia al giorno dei tuoi modelli, salvata in locale ----------
  async function snapshotHistory() {
    const m = await me();
    if (!m?.handle) return null;
    const key = `hist:${m.uid}`;
    const h = (await lget(key)) || { days: {}, titles: {} };
    const today = isoDay(new Date());
    if (h.days[today]) return h;
    const designs = await loadDesigns(m).catch(() => null);
    if (!designs) return h;
    const day = { dl: 0, pr: 0, m: {} };
    for (const d of designs) {
      day.dl += d.downloadCount || 0;
      day.pr += d.printCount || 0;
      day.m[d.id] = [d.downloadCount || 0, d.printCount || 0];
      h.titles[d.id] = d.titleTranslated || d.title;
    }
    h.days[today] = day;
    const cut = daysAgo(400);
    for (const d in h.days) if (d < cut) delete h.days[d];
    await lset(key, h);
    return h;
  }

  const compact = (n) => new Intl.NumberFormat(LOC, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(LOC, { day: 'numeric', month: 'short' });

  // Grafico a colonne, una sola serie: [{ d: 'YYYY-MM-DD', v, tip }]. Il valore esatto è nel tooltip.
  function barChart(series, cls) {
    const W = 1000, H = 190, L = 46, R = 8, T = 12, B = 26;
    const raw = Math.max(1, ...series.map((p) => p.v));
    const step = 10 ** Math.floor(Math.log10(raw));
    const top = Math.ceil(raw / step) * step;
    const slot = (W - L - R) / series.length;
    const bw = Math.max(2, Math.min(24, slot - 2));
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const grid = [0, top / 2, top]
      .map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`)
      .join('');
    const every = Math.max(1, Math.ceil(series.length / 6));
    const bars = series
      .map((p, i) => {
        const x = L + i * slot + (slot - bw) / 2;
        const h = Math.max(0, H - B - y(p.v));
        const r = Math.min(4, h, bw / 2);
        const path = h ? `M${x},${H - B}V${H - B - h + r}Q${x},${H - B - h} ${x + r},${H - B - h}H${x + bw - r}Q${x + bw},${H - B - h} ${x + bw},${H - B - h + r}V${H - B}Z` : '';
        const label = i % every === 0 || i === series.length - 1 ? `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${shortDay(p.d)}</text>` : '';
        return `<path class="bar-${i}" d="${path}"/>${label}<rect class="hit" data-i="${i}" x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" data-tip="${esc(p.tip)}"/>`;
      })
      .join('');
    return `<div class="chart ${cls}"><svg viewBox="0 0 ${W} ${H}" role="img"><g class="grid">${grid}</g>${bars}</svg><div class="tip" hidden></div></div>`;
  }
  function bindCharts(el) {
    el.querySelectorAll('.chart').forEach((c) => {
      const tip = c.querySelector('.tip');
      c.addEventListener('mousemove', (e) => {
        const hit = e.target.closest('.hit');
        c.querySelectorAll('path.on').forEach((p) => p.classList.remove('on'));
        if (!hit) return (tip.hidden = true);
        c.querySelector(`.bar-${hit.dataset.i}`)?.classList.add('on');
        const box = c.getBoundingClientRect();
        tip.textContent = hit.dataset.tip;
        tip.style.left = `${e.clientX - box.left}px`;
        tip.style.top = `${e.clientY - box.top - 12}px`;
        tip.hidden = false;
      });
      c.addEventListener('mouseleave', () => {
        tip.hidden = true;
        c.querySelectorAll('path.on').forEach((p) => p.classList.remove('on'));
      });
    });
  }

  async function openTrends(u) {
    openModal(t('Trends', 'Andamento'), `<div class="sum">${t('Loading…', 'Caricamento…')}</div><div class="mbody trends"></div>`);
    const sum = modal.querySelector('.sum');
    const box = modal.querySelector('.mbody');
    let h, agg;
    try {
      [h, agg] = await Promise.all([snapshotHistory(), pointBills(u.uid).catch(() => null)]);
    } catch (e) {
      sum.innerHTML = `<span class="err">${t('Loading error', 'Errore nel caricamento')}: ${esc(e.message)}</span>`;
      return;
    }
    if (ovl.hidden || !h) return;
    const days = Object.keys(h.days).sort();
    const latest = h.days[days[days.length - 1]];
    // Fotografia più recente non successiva a n giorni fa (o la più vecchia disponibile).
    const at = (n) => {
      const lim = daysAgo(n);
      const d = [...days].reverse().find((x) => x <= lim) || days[0];
      return { d, s: h.days[d] };
    };
    let html = '';

    // Download al giorno: differenza tra fotografie consecutive.
    const dl = days.slice(1).map((d, i) => {
      const v = Math.max(0, h.days[d].dl - h.days[days[i]].dl);
      const gap = Math.round((new Date(d) - new Date(days[i])) / 864e5);
      return { d, v, tip: `${shortDay(d)}: ${fmt(v)} download${gap > 1 ? ` (${t(`over ${gap} days`, `in ${gap} giorni`)})` : ''}` };
    });
    html += `<h4>${t('Downloads per day', 'Download al giorno')}</h4>`;
    html +=
      dl.length >= 1
        ? barChart(dl.slice(-60), 'dl')
        : `<p class="muted">${t(
            'History starts today: MakerPulse saves a snapshot of your models once a day while you browse MakerWorld. Come back tomorrow to see the first bars.',
            'Lo storico parte da oggi: MakerPulse salva una fotografia dei tuoi modelli una volta al giorno mentre navighi su MakerWorld. Torna domani per vedere le prime colonne.'
          )}</p>`;

    // Punti al giorno: dalle transazioni, disponibili subito.
    if (agg) {
      const pts = [];
      for (let i = 59; i >= 0; i--) {
        const d = daysAgo(i);
        const v = Math.round(agg.byDay[d] || 0);
        pts.push({ d, v, tip: `${shortDay(d)}: ${fmt(v)} ${t('points', 'punti')}` });
      }
      html += `<h4 class="gold">${t('Points per day (60 days)', 'Punti al giorno (60 giorni)')}</h4>${barChart(pts, 'pts')}`;
    }

    // Tabella per modello: ultimi 7 giorni contro i 7 precedenti.
    const b7 = at(7), b14 = at(14);
    const partial = b7.d === days[0];
    const rows = Object.keys(latest.m).map((id) => {
      const now = latest.m[id][0];
      const d7 = now - (b7.s.m[id]?.[0] ?? now);
      const p7 = (b7.s.m[id]?.[0] ?? 0) - (b14.s.m[id]?.[0] ?? b7.s.m[id]?.[0] ?? 0);
      return { id, title: h.titles[id] || id, d7, p7, pts30: Math.round(sumSince(agg?.byDesign[id]?.d, 30)) };
    });
    rows.sort((a, b) => b.d7 - a.d7 || b.pts30 - a.pts30);
    const trend = (r) => {
      if (days.length < 2 || b14.d === b7.d) return '–';
      if (!r.p7) return r.d7 ? '▲' : '–';
      const pc = Math.round(((r.d7 - r.p7) / r.p7) * 100);
      return `<span class="${pc >= 0 ? 'up' : 'down'}">${pc >= 0 ? '▲' : '▼'} ${Math.abs(pc)}%</span>`;
    };
    html += `<h4>${t('Your models', 'I tuoi modelli')}</h4>
      <table><thead><tr><th>${t('Model', 'Modello')}</th><th class="n">${partial ? t(`Downloads since ${shortDay(b7.d)}`, `Download dal ${shortDay(b7.d)}`) : t('Downloads 7 days', 'Download 7 gg')}</th><th class="n">${t('vs previous 7 days', 'vs 7 gg prima')}</th><th class="n">${t('Points 30 days', 'Punti 30 gg')}</th></tr></thead><tbody>
      ${rows
        .slice(0, 100)
        .map((r) => `<tr><td><a href="${localePrefix()}/models/${r.id}" target="_blank" rel="noopener">${esc(r.title)}</a></td><td class="n">${days.length > 1 ? fmt(r.d7) : '–'}</td><td class="n">${trend(r)}</td><td class="n">${fmt(r.pts30)}</td></tr>`)
        .join('')}</tbody></table>`;
    sum.textContent = t(
      `${days.length} daily snapshots saved since ${shortDay(days[0])} · stored only in this browser`,
      `${days.length} fotografie giornaliere salvate dal ${shortDay(days[0])} · salvate solo in questo browser`
    );
    box.innerHTML = html;
    bindCharts(box);
  }

  // ---------- statistiche sulle schede modello (home, ricerca, profili) ----------
  // I dati arrivano da hook.js, che legge le risposte delle liste nel contesto della pagina.
  const cardData = new Map();
  let cardsQueued = false;
  const cardCss = document.createElement('style');
  cardCss.textContent = `.makerpulse-card { position: absolute; left: 8px; bottom: 8px; z-index: 3; display: flex; gap: 8px; align-items: center;
    padding: 3px 9px; border-radius: 999px; background: rgba(20,24,28,.78); backdrop-filter: blur(6px); color: #fff; pointer-events: none;
    font: 600 11px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-variant-numeric: tabular-nums; box-shadow: 0 2px 8px rgba(0,0,0,.25); }`;
  function scheduleCards() {
    if (cardsQueued || !settings.cardStats) return;
    cardsQueued = true;
    requestAnimationFrame(() => {
      cardsQueued = false;
      decorateCards();
    });
  }
  function decorateCards() {
    if (!cardCss.isConnected) document.head.appendChild(cardCss);
    for (const a of document.querySelectorAll('a[href*="/models/"]:not([data-makerpulse-card])')) {
      const img = a.querySelector('img');
      const d = img && cardData.get((a.getAttribute('href').match(/\/models\/(\d+)/) || [])[1]);
      if (!d) continue;
      a.dataset.makerpulseCard = '1';
      const holder = img.parentElement;
      if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative';
      const b = document.createElement('div');
      b.className = 'makerpulse-card';
      b.textContent = [
        `🖨 ${compact(d.pr)}`,
        d.bo != null ? `🚀 ${compact(d.bo)}` : '',
        d.dl ? `${Math.round((d.pr / d.dl) * 100)}% ${t('printed', 'stampati')}` : '',
        d.hot ? `🔥 ${compact(d.hot)}` : '',
      ]
        .filter(Boolean)
        .join('  ');
      holder.appendChild(b);
    }
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.makerpulse !== 'designs') return;
    for (const d of e.data.designs) cardData.set(String(d.id), d);
    scheduleCards();
  });

  // ---------- tabella modelli ----------
  const COLS = [
    { k: 'title', l: t('Model', 'Modello') },
    { k: 'publishTime', l: t('Published', 'Pubblicato'), n: 1 },
    { k: 'downloadCount', l: t('Downloads', 'Download'), n: 1, sum: 1 },
    { k: 'printCount', l: t('Prints', 'Stampe'), n: 1, sum: 1 },
    { k: 'likeCount', l: t('Likes', 'Mi piace'), n: 1, sum: 1 },
    { k: 'collectionCount', l: t('Collections', 'Collezioni'), n: 1, sum: 1 },
    { k: 'boostCnt', l: t('Boosts', 'Boost'), n: 1, sum: 1 },
    { k: 'commentCount', l: t('Comments', 'Commenti'), n: 1, sum: 1 },
    { k: 'perDay', l: t('DL/day', 'DL/giorno'), n: 1 },
    { k: 'printRate', l: t('Prints/DL', 'Stampe/DL'), n: 1 },
  ];

  async function openModels(u, mine) {
    openModal(t(`Models by ${u.name}`, `Modelli di ${u.name}`), `<div class="sum">${t('Loading…', 'Caricamento…')}</div><div class="mbody"></div>`);
    const sum = modal.querySelector('.sum');
    let rows;
    try {
      rows = await loadDesigns(u);
      if (ovl.hidden) return;
    } catch (e) {
      sum.innerHTML = `<span class="err">${t('Loading error', 'Errore nel caricamento')}: ${esc(e.message)}</span>`;
      return;
    }
    rows.forEach((r) => {
      const t = r.publishTime || r.createTime;
      r.publishTime = t;
      r.perDay = r.downloadCount / ageDays(t);
      r.printRate = r.downloadCount ? r.printCount / r.downloadCount : 0;
    });
    let cols = COLS;
    if (mine) {
      const agg = await pointBills((await me()).uid).catch(() => null);
      if (ovl.hidden) return;
      if (agg) {
        rows.forEach((r) => {
          const e = agg.byDesign[r.id];
          r.points = Math.round(e?.all || 0);
          r.points30 = Math.round(sumSince(e?.d, 30));
        });
        cols = [...COLS, { k: 'points', l: t('Points', 'Punti'), n: 1, sum: 1 }, { k: 'points30', l: t('Points 30d', 'Punti 30gg'), n: 1, sum: 1 }];
      }
    }
    let sortK = 'downloadCount';
    let dir = -1;
    const lp = localePrefix();
    const cell = (r, c) => {
      if (c.k === 'title')
        return `<td><div style="display:flex;gap:8px;align-items:center"><img src="${esc(thumb(r.coverUrl, 100))}" loading="lazy" alt=""><a href="${lp}/models/${r.id}" target="_blank" rel="noopener">${esc(
          r.titleTranslated || r.title
        )}</a>${r.isExclusive ? ` <span class="tag">${t('Exclusive', 'Esclusivo')}</span>` : ''}</div></td>`;
      if (c.k === 'publishTime') return `<td class="n">${date(r.publishTime)}</td>`;
      if (c.k === 'perDay') return `<td class="n">${dec(r.perDay, 1)}</td>`;
      if (c.k === 'printRate') return `<td class="n">${pct(r.printCount, r.downloadCount)}</td>`;
      return `<td class="n">${fmt(r[c.k])}</td>`;
    };
    const tot = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);

    const draw = () => {
      rows.sort((a, b) => {
        const x = a[sortK], y = b[sortK];
        if (sortK === 'publishTime') return dir * (new Date(x) - new Date(y));
        if (typeof x === 'string') return dir * x.localeCompare(y);
        return dir * ((x || 0) - (y || 0));
      });
      sum.innerHTML = `${t(`${rows.length} models · click a header to sort`, `${rows.length} modelli · clic sull'intestazione per ordinare`)} · <button class="btn sec" data-act="csv">${t('Export CSV', 'Esporta CSV')}</button>`;
      sum.querySelector('[data-act=csv]').onclick = () => exportCsv(u, rows);
      modal.querySelector('.mbody').innerHTML = `<table class="models">
        <thead><tr>${cols.map((c) => `<th class="${c.n ? 'n' : ''}" data-k="${c.k}">${c.l}${sortK === c.k ? (dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${cols.map((c) => cell(r, c)).join('')}</tr>`).join('')}</tbody>
        <tfoot><tr>${cols.map((c) =>
          c.k === 'title' ? `<td>${t('Total', 'Totale')}</td>` : c.sum ? `<td class="n">${fmt(tot(c.k))}</td>` : c.k === 'printRate' ? `<td class="n">${pct(tot('printCount'), tot('downloadCount'))}</td>` : '<td></td>'
        ).join('')}</tr></tfoot></table>`;
      modal.querySelectorAll('th[data-k]').forEach(
        (th) =>
          (th.onclick = () => {
            const k = th.dataset.k;
            dir = sortK === k ? -dir : k === 'title' ? 1 : -1;
            sortK = k;
            draw();
          })
      );
    };
    draw();
  }

  function exportCsv(u, rows) {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = IT
      ? ['id', 'titolo', 'url', 'pubblicato', 'download', 'stampe', 'mi_piace', 'collezioni', 'boost', 'commenti', 'dl_giorno', 'esclusivo', 'punti', 'punti_30gg']
      : ['id', 'title', 'url', 'published', 'downloads', 'prints', 'likes', 'collections', 'boosts', 'comments', 'dl_per_day', 'exclusive', 'points', 'points_30d'];
    const lines = rows.map((r) =>
      [r.id, r.title, `https://makerworld.com/en/models/${r.id}`, r.publishTime?.slice(0, 10), r.downloadCount, r.printCount, r.likeCount, r.collectionCount, r.boostCnt, r.commentCount, r.perDay.toFixed(2), r.isExclusive ? 1 : 0, r.points ?? '', r.points30 ?? '']
        .map(q)
        .join(',')
    );
    const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `makerpulse-${u.handle}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- router: il sito è una SPA, quindi si osserva il cambio di URL ----------
  let renderToken = 0;
  let lastKey = '';

  async function render() {
    const r = route();
    const key = r ? `${r.type}:${r.id || r.handle}` : '';
    if (key === lastKey) return;
    lastKey = key;
    const token = ++renderToken;
    closeModal();
    mePromise = null; // lo stato di login può cambiare tra una pagina e l'altra
    const enabled = r && { model: settings.modelPanel, profile: settings.profilePanel, points: settings.pointsPanel }[r.type];
    if (!enabled) {
      panel.hidden = true;
      return;
    }
    if (!host.isConnected) document.documentElement.appendChild(host);
    panel.hidden = false;
    setCollapsed(settings.collapsed);
    body.innerHTML = `<span class="muted">${t('Loading…', 'Caricamento…')}</span>`;
    try {
      if (r.type === 'model') await renderModel(r.id, token);
      else if (r.type === 'profile') await renderProfile(r.handle, token);
      else await mountPoints(body, token);
    } catch (e) {
      if (token === renderToken) body.innerHTML = `<span class="err">${t('Unable to read data', 'Impossibile leggere i dati')}: ${esc(e.message)}</span>`;
    }
  }

  async function init() {
    if (store) settings = { ...DEFAULTS, ...(await store.get(DEFAULTS)) };
    // Versione precedente: un solo elenco di risposte, nella lingua dell'interfaccia.
    if (Array.isArray(settings.replies)) {
      const key = IT ? 'repliesIt' : 'repliesEn';
      if (!settings[key]) settings[key] = settings.replies;
      save({ [key]: settings[key] });
      try {
        if (alive()) store?.remove('replies');
      } catch {}
      settings.replies = null;
    }
    globalThis.chrome?.storage?.onChanged?.addListener((ch, area) => {
      if (area !== 'sync') return;
      for (const k in ch) settings[k] = ch[k].newValue;
      if ('quickReplies' in ch && !settings.quickReplies) hideQr();
      if ('cardStats' in ch) {
        document.querySelectorAll('.makerpulse-card').forEach((b) => b.remove());
        document.querySelectorAll('[data-makerpulse-card]').forEach((a) => delete a.dataset.makerpulseCard);
        scheduleCards();
      }
      if ('modelPanel' in ch || 'profilePanel' in ch || 'pointsPanel' in ch) {
        lastKey = '';
        render();
      }
    });
    render();
    scrollToPendingComment();
    if (settings.pointsPanel) snapshotHistory().catch(() => {});
    new MutationObserver(scheduleCards).observe(document.documentElement, { childList: true, subtree: true });
    window.postMessage({ makerpulse: 'replay' }, location.origin);
    setInterval(render, 500);
    window.addEventListener('popstate', render);
  }
  init();
})();
