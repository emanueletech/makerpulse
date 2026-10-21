(() => {
  'use strict';
  if (window.__makerPulse) return;
  window.__makerPulse = true;

  // ---------- impostazioni ----------
  const DEFAULTS = { modelPanel: true, profilePanel: true, pointsPanel: true, quickReplies: true, replies: null, collapsed: false, giftRegion: '' };
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
  const lget = async (k) => (local ? (await local.get(k))[k] : mem[k]);
  const lset = (k, v) => (local ? local.set({ [k]: v }) : (mem[k] = v));

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
    const key = `bills:${uid}`;
    let agg = await lget(key);
    const head = await api('/api/v1/point-service/point-bill/my?offset=0&limit=1&filter=all');
    if (!agg || head.total < agg.count) agg = { count: 0, byDesign: {}, byDay: {} };
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
          <div class="muted">${t(`${fmt(Math.ceil(c.price - rest))} points to the next one`, `mancano ${fmt(Math.ceil(c.price - rest))} punti alla prossima`)}</div>`;
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
        )} ${t('per request', 'per richiesta')}${ok ? '' : ` · ${t(`${fmt(Math.ceil(min - cash.exclusivePoint))} exclusive points to the minimum`, `mancano ${fmt(Math.ceil(min - cash.exclusivePoint))} punti esclusivi al minimo`)}`}</div>`;
    }

    if (agg) {
      const top = Object.entries(agg.byDesign)
        .map(([id, e]) => ({ id, ...e, d30: sumSince(e.d, 30) }))
        .sort((a, b) => b.d30 - a.d30 || b.all - a.all)
        .slice(0, 8);
      html += `<h4>${t('Top-earning models (30 days)', 'Modelli che rendono di più (30 gg)')}</h4><table><thead><tr><th>${t('Model', 'Modello')}</th><th class="n">${t('30 days', '30 gg')}</th><th class="n">${t('Total', 'Totale')}</th></tr></thead><tbody>
        ${top.map((e) => `<tr><td><a href="${localePrefix()}/models/${e.id}">${esc(e.t)}</a></td><td class="n">${fmt(Math.round(e.d30))}</td><td class="n">${fmt(Math.round(e.all))}</td></tr>`).join('')}
        </tbody></table><p class="muted">${t(`Calculated from your ${fmt(agg.count)} point transactions.`, `Calcolato dalle tue ${fmt(agg.count)} transazioni punti.`)}</p>`;
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
      store?.set({ giftRegion: e.target.value });
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
    /* risposte rapide */
    .qr { position: fixed; z-index: 2147483002; display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; background: var(--surface);
      border-radius: 14px; box-shadow: var(--shadow-lg); font-size: 12px; border-top: 3px solid var(--green); }
    .qr button { border: 1px solid var(--line); background: var(--plate); color: var(--ink); border-radius: 999px; padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; transition: transform .08s; }
    .qr button:hover { border-color: var(--green); background: var(--green-soft); transform: translateY(-1px); }
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
    store?.set({ collapsed: c });
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
  const DEFAULT_REPLIES = globalThis.MAKERPULSE_DEFAULT_REPLIES?.[IT ? 'it' : 'en'] || [];
  const replies = () => (Array.isArray(settings.replies) && settings.replies.length ? settings.replies : DEFAULT_REPLIES);
  const qr = root.querySelector('.qr');
  let qrTarget = null;

  function drawQr() {
    qr.innerHTML =
      replies().map((r, i) => `<button data-i="${i}" title="${esc(r)}">${esc(r.length > 40 ? `${r.slice(0, 38)}…` : r)}</button>`).join('') +
      `<button class="save" title="${t('Save the current text as a quick reply', 'Salva il testo attuale come risposta rapida')}">+</button>`;
  }
  function placeQr() {
    if (qr.hidden) return;
    if (!qrTarget?.isConnected) return hideQr();
    const r = qrTarget.getBoundingClientRect();
    qr.style.left = `${Math.max(8, r.left)}px`;
    qr.style.maxWidth = `${Math.max(280, r.width)}px`;
    const h = qr.offsetHeight;
    qr.style.top = `${r.top - h - 6 > 8 ? r.top - h - 6 : r.bottom + 6}px`; // sopra l'editor, o sotto se non c'è spazio
  }
  function hideQr() {
    qr.hidden = true;
    qrTarget = null;
  }
  // Gli editor dei commenti di MakerWorld sono div contenteditable dentro un <form>.
  document.addEventListener('focusin', (e) => {
    const ed = e.target.closest?.('.js-editable-content, textarea');
    if (!settings.quickReplies || !ed?.closest('form')) return;
    if (!host.isConnected) document.documentElement.appendChild(host);
    qrTarget = ed;
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
    if (b.classList.contains('save')) {
      const txt = (qrTarget.value ?? qrTarget.innerText).trim();
      if (txt && !replies().includes(txt)) {
        settings.replies = [...replies(), txt];
        store?.set({ replies: settings.replies });
        drawQr();
        placeQr();
      }
      return;
    }
    // insertText passa dagli eventi input, così l'editor del sito registra il testo
    document.execCommand('insertText', false, replies()[+b.dataset.i]);
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
    if (settings.pointsPanel && (await isMe(d.designCreator?.handle))) modelPoints(id, body.querySelector('.mine'), token).catch(() => {});
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
        kind: 'rating', id: r.id, score: r.score || 0, text: r.contentTranslated || r.content || '', images: r.images || [],
        user: r.creator || {}, time: r.createTime, likes: r.likeCount || 0, replies: r.replyCount || 0,
        authorReplied: !!r.replyByInstanceUser, boosted: !!r.boosted, printed: !!r.successPrinted,
        profile: r.instInfo?.title || '',
      };
    }
    const c = h.comment || {};
    return {
      kind: 'comment', id: c.id, score: 0, text: c.contentTranslated || c.content || '', images: c.images || [],
      user: c.user || {}, time: c.createTime, likes: c.likeCount || 0, replies: c.replyCount || 0,
      authorReplied: !!c.replyByDesignUser, boosted: !!c.boosted, printed: false, profile: '',
    };
  }
  const imgUrl = (x) => (typeof x === 'string' ? x : x?.url || x?.imageUrl || x?.picUrl || '');
  // Miniatura dal CDN di MakerWorld (gli originali pesano diversi MB).
  const thumb = (u, w) => (u && u.includes('bblmw.com') && !u.includes('?') ? `${u}?x-oss-process=image/resize,w_${w}/format,webp` : u);

  async function openComments(id, title) {
    openModal(`${t('Comments and reviews', 'Commenti e recensioni')} – ${title}`, `<div class="sum">${t('Loading…', 'Caricamento…')}</div><div class="mbody"></div>`);
    const sum = modal.querySelector('.sum');
    const items = [];
    try {
      for (let offset = 0; ; offset += 50) {
        const j = await api(`/api/v1/comment-service/commentandrating?designId=${id}&limit=50&offset=${offset}&msgId=0&msgType=0`);
        if (ovl.hidden) return;
        (j.hits || []).forEach((h) => items.push(normalize(h)));
        sum.textContent = `${t('Loading…', 'Caricamento…')} ${items.length} / ${j.total ?? '?'}`;
        if (!j.hits?.length || j.hits.length < 50 || items.length >= j.total) break;
      }
    } catch (e) {
      sum.innerHTML = `<span class="err">${t('Loading error', 'Errore nel caricamento')}: ${esc(e.message)}</span>`;
      return;
    }
    const seen = new Set();
    const all = items.filter((i) => !seen.has(i.kind + i.id) && seen.add(i.kind + i.id));
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
      const lp = localePrefix();
      list.innerHTML =
        out
          .slice(0, 500)
          .map(
            (i) => `<div class="item" data-id="${i.id}" data-kind="${i.kind}" data-handle="${esc(i.user.handle)}" title="${t('Show on the page', 'Mostra sulla pagina')}">
          ${i.user.avatar ? `<img class="av" src="${esc(thumb(i.user.avatar, 64))}" alt="">` : ''}
          <div>
            <div class="meta"><a href="${lp}/@${esc(i.user.handle)}" target="_blank" rel="noopener"><b>${esc(i.user.name || i.user.handle || t('User', 'Utente'))}</b></a>
              · ${date(i.time)}
              ${i.kind === 'rating' && i.score ? ` · <span class="stars">${'★'.repeat(i.score)}${'☆'.repeat(5 - i.score)}</span>` : ` · ${t('comment', 'commento')}`}
              ${i.profile ? ` · ${esc(i.profile)}` : ''}
              ${i.printed ? ` · ✅ ${t('printed', 'stampato')}` : ''}${i.boosted ? ' · 🚀 boost' : ''}${i.authorReplied ? ` · 💬 ${t('author reply', 'risposta autore')}` : ''}
              ${i.likes ? ` · ♥ ${i.likes}` : ''}</div>
            <div class="txt">${esc(i.text) || `<span class="muted">${t('(no text)', '(nessun testo)')}</span>`}</div>
            ${i.images.length ? `<div class="pics">${i.images.map((x) => `<a href="${esc(imgUrl(x))}" target="_blank" rel="noopener"><img src="${esc(thumb(imgUrl(x), 200))}" loading="lazy" alt=""></a>`).join('')}</div>` : ''}
          </div></div>`
          )
          .join('') || `<p class="muted">${t('No results with these filters.', 'Nessun risultato con questi filtri.')}</p>`;
    };
    tb.addEventListener('input', draw);
    list.addEventListener('click', (e) => {
      const it = e.target.closest('.item[data-id]');
      if (!it || e.target.closest('a')) return; // link a profilo e foto restano normali
      goToComment(id, it.dataset);
    });
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
    const mine = settings.pointsPanel && (await isMe(u.handle));
    body.querySelector('[data-act=models]').onclick = () => openModels(u, mine);
    if (mine && token === renderToken) await mountPoints(body.querySelector('.mine'), token);
  }

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
    const rows = [];
    try {
      for (let offset = 0; ; offset += 100) {
        const j = await api(`/api/v1/design-service/published/${u.uid}/design?handle=${encodeURIComponent(u.handle)}&limit=100&offset=${offset}`);
        if (ovl.hidden) return;
        rows.push(...(j.hits || []));
        sum.textContent = `${t('Loading…', 'Caricamento…')} ${rows.length} / ${j.total ?? '?'}`;
        if (!j.hits?.length || rows.length >= j.total) break;
      }
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
    globalThis.chrome?.storage?.onChanged?.addListener((ch, area) => {
      if (area !== 'sync') return;
      for (const k in ch) settings[k] = ch[k].newValue;
      if ('quickReplies' in ch && !settings.quickReplies) hideQr();
      if ('modelPanel' in ch || 'profilePanel' in ch || 'pointsPanel' in ch) {
        lastKey = '';
        render();
      }
    });
    render();
    scrollToPendingComment();
    setInterval(render, 500);
    window.addEventListener('popstate', render);
  }
  init();
})();
