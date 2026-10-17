'use strict';

/* =========================================================
   Mijn Vermogen — persoonlijk vermogensdashboard
   Data staat op de server (Cloudflare Worker + KV), zodat
   je ze op elk toestel ziet. Gekoppelde saldi komen van de server.
   ========================================================= */

const THEME_KEY = 'mijn-vermogen-theme';
const PRIVACY_KEY = 'mijn-vermogen-private';
const LEGACY_KEY = 'mijn-vermogen-v1';

// Vaste volgorde = vaste kleur per categorie (kleur volgt de categorie, nooit de rangorde).
const TYPES = [
  { id: 'bank',     label: 'Bankrekening',     color: 'var(--cat-1)', holdings: false },
  { id: 'broker',   label: 'Beleggingen / broker', color: 'var(--cat-2)', holdings: true },
  { id: 'savings',  label: 'Spaarrekening',    color: 'var(--cat-3)', holdings: false },
  { id: 'crypto',   label: 'Crypto',           color: 'var(--cat-4)', holdings: true },
  { id: 'pension',  label: 'Pensioensparen',   color: 'var(--cat-5)', holdings: true },
  { id: 'property', label: 'Vastgoed',         color: 'var(--cat-6)', holdings: false },
  { id: 'cash',     label: 'Cash / overig',    color: 'var(--cat-7)', holdings: false },
  { id: 'debt',     label: 'Lening / schuld',  color: 'var(--cat-8)', holdings: false, negative: true },
];
const TYPE = Object.fromEntries(TYPES.map(t => [t.id, t]));

const DEFAULT_RATES = { EUR: 1, USD: 0.86, GBP: 1.15, CHF: 1.07 };

/* ---------- State ---------- */

function emptyState() {
  return { version: 2, rates: { ...DEFAULT_RATES }, accounts: [], history: [], linkedMeta: {} };
}

function normalizeState(s) {
  const base = emptyState();
  if (!s || typeof s !== 'object') return base;
  return {
    version: 2,
    rates: { ...base.rates, ...(s.rates || {}), EUR: 1 },
    accounts: Array.isArray(s.accounts) ? s.accounts.map(a => ({
      id: String(a.id || uid()),
      name: String(a.name || 'Rekening'),
      institution: String(a.institution || ''),
      type: TYPE[a.type] ? a.type : 'bank',
      currency: String(a.currency || 'EUR'),
      balance: Number(a.balance) || 0,
      holdings: Array.isArray(a.holdings) ? a.holdings.map(h => ({
        id: String(h.id || uid()),
        symbol: String(h.symbol || h.name || '').trim().toUpperCase(),
        qty: Number(h.qty) || 0,
        price: Number(h.price) || 0,
      })) : [],
      note: String(a.note || ''),
      updatedAt: a.updatedAt || new Date().toISOString(),
    })) : [],
    history: Array.isArray(s.history)
      ? s.history.filter(h => h && h.date).map(h => ({
          date: String(h.date), net: Number(h.net) || 0, byType: h.byType || {},
        })).sort((a, b) => a.date.localeCompare(b.date))
      : [],
    linkedMeta: s.linkedMeta && typeof s.linkedMeta === 'object' ? s.linkedMeta : {},
  };
}

let state = emptyState();
// Wat de server aanlevert: gekoppelde rekeningen, koersen, wisselkoersen.
let remote = { rev: 0, connections: [], prices: {}, rates: null, config: {} };

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/* ---------- Server ---------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Niet aangemeld');
  }
  if (!res.ok) {
    const e = new Error(data.error || `Fout ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

function applyRemote(data) {
  remote = {
    rev: data.rev ?? remote.rev,
    connections: data.connections ?? remote.connections,
    prices: data.prices ?? remote.prices,
    rates: data.rates ?? remote.rates,
    config: data.config ?? remote.config,
  };
}

async function loadFromServer() {
  const data = await api('/api/state');
  applyRemote(data);
  if (data.state) {
    state = normalizeState(data.state);
  } else {
    // Eerste keer: neem eventueel gegevens over uit de vroegere lokale versie.
    let legacy = null;
    try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null'); } catch { /* */ }
    state = normalizeState(legacy);
  }
  showApp();
  // Momentopname van vandaag bijwerken, enkel opslaan als er iets veranderd is.
  if (recordSnapshot() || !data.state) await persist();
  render();
}

let saveTimer = null;
let saving = Promise.resolve();
let dirty = false;

function save() {
  dirty = true;
  recordSnapshot();
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saving = saving.then(persist); }, 400);
}

async function persist() {
  try {
    const res = await api('/api/state', { method: 'PUT', body: { rev: remote.rev, state } });
    dirty = false;
    const hadNewSymbols = Object.keys(res.prices || {}).length !== Object.keys(remote.prices || {}).length;
    remote.rev = res.rev;
    remote.prices = res.prices || remote.prices;
    if (hadNewSymbols) render();
  } catch (e) {
    if (e.status === 409) {
      dirty = false;
      toast('Gewijzigd op een ander toestel — nieuwste versie geladen.');
      await loadFromServer();
    } else if (e.message !== 'Niet aangemeld') {
      toast(`Opslaan mislukt: ${e.message}`, true);
    }
  }
}

/* ---------- Calculations ---------- */

function rate(cur) {
  const auto = remote.rates?.rates?.[cur];
  if (typeof auto === 'number' && auto > 0) return auto;
  const r = state.rates[cur];
  return typeof r === 'number' && r > 0 ? r : 1;
}

/** Actuele koers van een positie: automatisch (Yahoo) indien beschikbaar, anders handmatig. */
function holdingQuote(h, acc) {
  const p = h.symbol && remote.prices[h.symbol];
  if (p && p.price > 0) return { price: p.price, currency: p.currency, auto: true };
  return { price: h.price, currency: acc.currency, auto: false };
}

function holdingsEur(acc) {
  return acc.holdings.reduce((s, h) => {
    const q = holdingQuote(h, acc);
    return s + h.qty * q.price * rate(q.currency);
  }, 0);
}

/** Waarde in EUR, met teken (schulden negatief). */
function eurValue(acc) {
  const t = TYPE[acc.type];
  const v = acc.balance * rate(acc.currency) + (t.holdings ? holdingsEur(acc) : 0);
  return t.negative ? -Math.abs(v) : v;
}

// Cent-accounts (bv. VT Markets Cent) rapporteren bedragen in centen: 10.000 = 100 dollar.
const CENT_CURRENCIES = { USC: 'USD', EUC: 'EUR', GBC: 'GBP' };

function isCentAuto(a) {
  const cur = String(a.currency || '').toUpperCase();
  return cur in CENT_CURRENCIES || a.currency === 'USc' || /\bcent\b/i.test(`${a.name || ''} ${a.server || ''}`);
}

// VT Markets geeft 20% bonus op stortingen: van wat de broker toont is maar 100/120 echt geld.
const DEFAULT_BONUS_PCT = [[/vt\s*markets/i, 20]];

function bonusPctFor(a, meta, institution) {
  if (meta.bonusPct != null) return Number(meta.bonusPct) || 0;
  const hit = DEFAULT_BONUS_PCT.find(([re]) => re.test(`${institution || ''} ${a.server || ''}`));
  return hit ? hit[1] : 0;
}

/**
 * Saldo en munt van een gekoppelde rekening: omgerekend als het een cent-account is,
 * en zonder bonus van de broker (dat is geen eigen geld).
 * Met een bonuspercentage tonen we bedrag / (1 + bonus%); anders trekken we de
 * credit af die de koppeling eventueel doorgeeft.
 */
function linkedAmount(a, meta, institution) {
  const cent = meta.cent ?? isCentAuto(a);
  const div = cent ? 100 : 1;
  const cur = String(a.currency || 'EUR');
  const gross = (Number(a.balance) || 0) / div;
  const bonusPct = bonusPctFor(a, meta, institution);
  const balance = bonusPct > 0 ? gross / (1 + bonusPct / 100) : gross - (Number(a.credit) || 0) / div;
  return {
    balance,
    bonus: gross - balance,
    bonusPct,
    currency: cent ? CENT_CURRENCIES[cur.toUpperCase()] || cur : cur,
    cent,
  };
}

/** Alle rekeningen: zelf bijgehouden + automatisch gekoppelde. */
function allAccounts() {
  const linked = [];
  for (const c of remote.connections) {
    for (const a of c.accounts || []) {
      const meta = state.linkedMeta[a.key] || {};
      if (meta.hidden ?? a.demo) continue;
      const amount = linkedAmount(a, meta, c.institution);
      linked.push({
        id: a.key,
        linked: true,
        connId: c.id,
        name: meta.name || a.name,
        institution: c.institution,
        type: TYPE[meta.type] ? meta.type : (c.kind === 'eb' ? 'bank' : 'broker'),
        currency: amount.currency,
        balance: amount.balance,
        cent: amount.cent,
        bonus: amount.bonus,
        bonusPct: amount.bonusPct,
        raw: a,
        pending: a.balance == null,
        holdings: [],
        note: '',
        updatedAt: a.updatedAt || c.checkedAt || new Date().toISOString(),
        error: c.error || null,
      });
    }
  }
  return [...state.accounts, ...linked];
}

function totals() {
  const byType = {};
  let assets = 0, debts = 0;
  for (const a of allAccounts()) {
    const v = eurValue(a);
    byType[a.type] = (byType[a.type] || 0) + v;
    if (v < 0) debts += v; else assets += v;
  }
  return { byType, assets, debts, net: assets + debts };
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Werkt de momentopname van vandaag bij. Geeft true terug als er iets veranderd is. */
function recordSnapshot() {
  if (!allAccounts().length) return false;
  const t = totals();
  const date = todayISO();
  const snap = { date, net: round2(t.net), byType: Object.fromEntries(Object.entries(t.byType).map(([k, v]) => [k, round2(v)])) };
  const last = state.history[state.history.length - 1];
  if (last && last.date === date) {
    if (JSON.stringify(last) === JSON.stringify(snap)) return false;
    state.history[state.history.length - 1] = snap;
  } else {
    state.history.push(snap);
  }
  return true;
}

const round2 = n => Math.round(n * 100) / 100;

/* ---------- Formatting ---------- */

const fmtEUR = new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmtEUR2 = new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = new Intl.NumberFormat('nl-BE', { style: 'percent', maximumFractionDigits: 1 });
const fmtDate = new Intl.DateTimeFormat('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateShort = new Intl.DateTimeFormat('nl-BE', { day: 'numeric', month: 'short' });
const fmtMonth = new Intl.DateTimeFormat('nl-BE', { month: 'short', year: '2-digit' });
const fmtTime = new Intl.DateTimeFormat('nl-BE', { hour: '2-digit', minute: '2-digit' });

function money(n, decimals = false) {
  return (decimals ? fmtEUR2 : fmtEUR).format(n);
}

function moneyIn(n, cur) {
  try {
    return new Intl.NumberFormat('nl-BE', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toLocaleString('nl-BE', { maximumFractionDigits: 2 })} ${cur}`;
  }
}

function compact(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `€${(n / 1e6).toLocaleString('nl-BE', { maximumFractionDigits: 1 })}M`;
  if (abs >= 1e3) return `€${(n / 1e3).toLocaleString('nl-BE', { maximumFractionDigits: 0 })}k`;
  return `€${Math.round(n)}`;
}

function when(iso) {
  if (!iso) return 'nooit';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `vandaag ${fmtTime.format(d)}` : `${fmtDate.format(d)} ${fmtTime.format(d)}`;
}

const parseDate = iso => new Date(iso + 'T00:00:00');

/* ---------- DOM helpers ---------- */

const $ = sel => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

/* ---------- Login ---------- */

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('#login-form').password.focus();
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: { password: e.target.password.value } });
    e.target.password.value = '';
    await loadFromServer();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

/* ---------- Render ---------- */

function render() {
  const t = totals();
  const accounts = allAccounts();
  const hasAccounts = accounts.length > 0;

  $('#empty-state').hidden = hasAccounts;
  $('#dashboard').hidden = !hasAccounts;

  $('#net-worth').textContent = money(t.net);
  $('#assets-total').textContent = money(t.assets);
  $('#debts-total').textContent = money(t.debts);
  $('#account-count').textContent = accounts.length;
  renderDelta(t.net, accounts.length);
  renderSyncStatus();
  renderAlerts();

  if (!hasAccounts) return;
  renderTiles(t, accounts);
  renderAllocation(t);
  renderInstitutions(accounts);
  renderHistory();
  renderAccounts(accounts);
}

function renderDelta(net, count) {
  const box = $('#net-delta');
  box.replaceChildren();
  const today = todayISO();
  const prev = [...state.history].reverse().find(h => h.date < today);
  if (!prev) {
    box.textContent = count ? 'Eerste momentopname van vandaag.' : '';
    return;
  }
  const diff = net - prev.net;
  const pct = prev.net !== 0 ? diff / Math.abs(prev.net) : 0;
  const sign = diff >= 0 ? '+' : '−';
  box.append(
    el('span', { class: (diff >= 0 ? 'up' : 'down') + ' money' },
      `${diff >= 0 ? '▲' : '▼'} ${sign}${money(Math.abs(diff))} (${sign}${fmtPct.format(Math.abs(pct))})`),
    ` sinds ${fmtDate.format(parseDate(prev.date))}`
  );
}

function renderSyncStatus() {
  const times = remote.connections.map(c => c.checkedAt).filter(Boolean).sort();
  $('#sync-status').textContent = times.length ? `Saldi opgehaald: ${when(times[times.length - 1])}` : '';
}

function renderAlerts() {
  const box = $('#alerts');
  box.replaceChildren();
  const problems = [];
  for (const c of remote.connections) {
    if (c.error) problems.push({ c, msg: c.error });
    else if (c.validUntil) {
      const days = Math.ceil((new Date(c.validUntil) - Date.now()) / 864e5);
      if (days <= 14) problems.push({ c, msg: `Toestemming verloopt over ${Math.max(days, 0)} dag(en).` });
    }
  }
  box.hidden = !problems.length;
  for (const p of problems) {
    box.append(el('div', { class: 'alert-row' },
      el('span', {}, '⚠️ ', el('strong', {}, p.c.institution), ` — ${p.msg}`),
      p.c.kind === 'eb'
        ? el('button', { class: 'btn small', onclick: () => startBankLink(p.c.aspsp) }, 'Opnieuw koppelen')
        : null
    ));
  }
}

function renderTiles(t, accounts) {
  const box = $('#tiles');
  box.replaceChildren();
  for (const type of TYPES) {
    const accs = accounts.filter(a => a.type === type.id);
    if (!accs.length) continue;
    const v = t.byType[type.id] || 0;
    box.append(el('div', { class: 'tile', style: `--c:${type.color}` },
      el('div', { class: 'tile-head' }, el('span', { class: 'swatch' }), type.label),
      el('div', { class: 'tile-value money' + (v < 0 ? ' neg-val' : '') }, money(v)),
      el('div', { class: 'tile-sub' }, `${accs.length} ${accs.length === 1 ? 'rekening' : 'rekeningen'}`
        + (v > 0 && t.assets > 0 ? ` · ${fmtPct.format(v / t.assets)}` : ''))
    ));
  }
}

function renderAllocation(t) {
  const bar = $('#alloc-bar');
  const list = $('#alloc-list');
  bar.replaceChildren();
  list.replaceChildren();
  const rows = TYPES.map(type => ({ type, v: t.byType[type.id] || 0 })).filter(r => r.v > 0);
  if (!rows.length || t.assets <= 0) {
    list.append(el('li', {}, el('span'), el('span', { class: 'label' }, 'Nog geen bezittingen.')));
    return;
  }
  for (const r of rows) {
    const share = r.v / t.assets;
    const seg = el('div', {
      tabindex: '0',
      style: `flex:${share} 0 0; background:${r.type.color}`,
      'aria-label': `${r.type.label}: ${money(r.v)} (${fmtPct.format(share)})`,
    });
    attachTooltip(seg, () => [{ value: money(r.v), label: `${r.type.label} · ${fmtPct.format(share)}`, color: r.type.color }]);
    bar.append(seg);
    list.append(el('li', {},
      el('span', { class: 'swatch', style: `background:${r.type.color}` }),
      el('span', {}, r.type.label),
      el('span', { class: 'money' }, money(r.v)),
      el('span', { class: 'pct' }, fmtPct.format(share))
    ));
  }
}

function renderInstitutions(accounts) {
  const box = $('#inst-bars');
  box.replaceChildren();
  const map = new Map();
  for (const a of accounts) {
    const k = a.institution || '—';
    map.set(k, (map.get(k) || 0) + eurValue(a));
  }
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(...rows.map(r => Math.abs(r[1])), 1);
  for (const [name, v] of rows) {
    const fill = el('div', { class: 'fill' + (v < 0 ? ' neg' : ''), style: `width:${(Math.abs(v) / max) * 100}%` });
    box.append(el('li', {},
      el('span', { class: 'name', title: name }, name),
      el('div', { class: 'track' }, fill),
      el('span', { class: 'money' + (v < 0 ? ' neg-val' : '') }, money(v))
    ));
  }
}

/* ---------- History chart ---------- */

let historyRange = 'all';

function renderHistory() {
  const chart = $('#history-chart');
  const wrap = $('#history-wrap');
  chart.replaceChildren();
  const W = wrap.clientWidth || 600;
  const H = wrap.clientHeight || 260;
  chart.setAttribute('viewBox', `0 0 ${W} ${H}`);

  let data = state.history;
  if (historyRange !== 'all') {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Number(historyRange));
    data = data.filter(d => parseDate(d.date) >= cutoff);
  }

  if (data.length < 2) {
    const msg = svg('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty-msg' });
    msg.textContent = data.length
      ? `Eén momentopname: ${money(data[0].net)}. Kom later terug om het verloop te zien.`
      : 'Nog geen gegevens in deze periode.';
    chart.append(msg);
    return;
  }

  const m = { top: 12, right: 12, bottom: 26, left: 56 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const xs = data.map(d => parseDate(d.date).getTime());
  const ys = data.map(d => d.net);
  const x0 = xs[0], x1 = xs[xs.length - 1];
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.1;
  y0 = y0 >= 0 && y0 - pad < 0 ? 0 : y0 - pad;
  y1 += pad;
  const ticks = niceTicks(y0, y1, 4);
  y0 = Math.min(y0, ticks[0]);
  y1 = Math.max(y1, ticks[ticks.length - 1]);

  const sx = v => m.left + ((v - x0) / (x1 - x0)) * iw;
  const sy = v => m.top + ih - ((v - y0) / (y1 - y0)) * ih;

  const grid = svg('g', { class: 'grid' });
  const axis = svg('g', { class: 'axis' });
  for (const tv of ticks) {
    grid.append(svg('line', { x1: m.left, x2: W - m.right, y1: sy(tv), y2: sy(tv) }));
    const lbl = svg('text', { x: m.left - 8, y: sy(tv) + 4, 'text-anchor': 'end', class: 'money' });
    lbl.textContent = compact(tv);
    axis.append(lbl);
  }
  const spanDays = (x1 - x0) / 864e5;
  const nX = Math.max(2, Math.min(6, Math.floor(iw / 110)));
  for (let i = 0; i < nX; i++) {
    const tv = x0 + ((x1 - x0) * i) / (nX - 1);
    const lbl = svg('text', {
      x: sx(tv), y: H - 6,
      'text-anchor': i === 0 ? 'start' : i === nX - 1 ? 'end' : 'middle',
    });
    lbl.textContent = (spanDays > 120 ? fmtMonth : fmtDateShort).format(new Date(tv));
    axis.append(lbl);
  }
  chart.append(grid, axis);

  const pts = data.map((d, i) => [sx(xs[i]), sy(d.net)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const base = sy(Math.max(y0, 0));
  const grad = svg('linearGradient', { id: 'area-grad', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(svg('stop', { offset: 0, class: 'grad-top' }), svg('stop', { offset: 1, class: 'grad-bottom' }));
  const defs = svg('defs');
  defs.append(grad);
  chart.append(defs);
  chart.append(svg('path', { class: 'area', fill: 'url(#area-grad)', d: `${line}L${pts[pts.length - 1][0]},${base}L${pts[0][0]},${base}Z` }));
  chart.append(svg('path', { class: 'line', d: line }));

  const cross = svg('line', { class: 'cross', y1: m.top, y2: m.top + ih, visibility: 'hidden' });
  const dot = svg('circle', { class: 'dot', r: 5, visibility: 'hidden' });
  const hit = svg('rect', { x: m.left, y: 0, width: iw, height: H, fill: 'transparent', tabindex: '0' });
  chart.append(cross, dot, hit);

  const tip = $('#tooltip');
  let focusIdx = data.length - 1;

  const show = i => {
    focusIdx = i;
    const [px, py] = pts[i];
    cross.setAttribute('x1', px); cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px); dot.setAttribute('cy', py);
    dot.setAttribute('visibility', 'visible');
    const d = data[i];
    const prev = data[i - 1];
    const rows = [{ value: money(d.net), label: fmtDate.format(parseDate(d.date)), color: 'var(--cat-1)' }];
    if (prev) {
      const diff = d.net - prev.net;
      rows.push({ value: `${diff >= 0 ? '+' : '−'}${money(Math.abs(diff))}`, label: 't.o.v. vorige' });
    }
    fillTooltip(tip, rows);
    const scale = wrap.clientWidth / W;
    positionTooltip(tip, wrap, px * scale, py * (wrap.clientHeight / H));
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  const nearest = clientX => {
    const r = chart.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const dd = Math.abs(p[0] - x); if (dd < bd) { bd = dd; best = i; } });
    return best;
  };
  hit.addEventListener('pointermove', e => show(nearest(e.clientX)));
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('focus', () => show(focusIdx));
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { show(Math.max(0, focusIdx - 1)); e.preventDefault(); }
    if (e.key === 'ArrowRight') { show(Math.min(data.length - 1, focusIdx + 1)); e.preventDefault(); }
  });
}

function niceTicks(min, max, count) {
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.5; v += step) out.push(round2(v));
  return out;
}

/* ---------- Tooltip ---------- */

function fillTooltip(tip, rows) {
  tip.replaceChildren(...rows.map(r => el('div', { class: 'tt-row' },
    r.color ? el('span', { class: 'key', style: `background:${r.color}` }) : null,
    el('span', { class: 'tt-value money' }, r.value),
    el('span', { class: 'tt-label' }, r.label)
  )));
  tip.hidden = false;
}

function positionTooltip(tip, container, x, y) {
  const cw = container.clientWidth;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = x + 12;
  if (left + tw > cw) left = x - tw - 12;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, y - th - 10)}px`;
}

const floatTip = el('div', { class: 'tooltip', hidden: '' });
floatTip.style.position = 'fixed';
document.body.append(floatTip);

function attachTooltip(node, rowsFn) {
  const showAt = (x, y) => {
    fillTooltip(floatTip, rowsFn());
    const tw = floatTip.offsetWidth;
    floatTip.style.left = `${Math.min(window.innerWidth - tw - 8, x + 12)}px`;
    floatTip.style.top = `${y - floatTip.offsetHeight - 12}px`;
  };
  node.addEventListener('pointermove', e => showAt(e.clientX, e.clientY));
  node.addEventListener('pointerleave', () => { floatTip.hidden = true; });
  node.addEventListener('focus', () => { const r = node.getBoundingClientRect(); showAt(r.left, r.top); });
  node.addEventListener('blur', () => { floatTip.hidden = true; });
}

/* ---------- Accounts list ---------- */

function renderAccounts(accounts) {
  const box = $('#accounts');
  box.replaceChildren();
  const mode = $('#group-by').value;
  const groups = new Map();
  if (mode === 'type') {
    for (const t of TYPES) groups.set(t.id, []);
    for (const a of accounts) groups.get(a.type).push(a);
  } else {
    for (const a of [...accounts].sort((x, y) => x.institution.localeCompare(y.institution))) {
      const k = a.institution || '—';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    }
  }

  for (const [key, accs] of groups) {
    if (!accs.length) continue;
    accs.sort((x, y) => eurValue(y) - eurValue(x));
    const sum = accs.reduce((s, a) => s + eurValue(a), 0);
    const title = mode === 'type' ? TYPE[key].label : key;
    box.append(el('div', { class: 'group' },
      el('div', { class: 'group-head' },
        el('span', { class: 'left' },
          mode === 'type' ? el('span', { class: 'swatch', style: `background:${TYPE[key].color}` }) : null,
          title),
        el('span', { class: 'money' + (sum < 0 ? ' neg-val' : '') }, money(sum))
      ),
      accs.map(accountRow)
    ));
  }
}

function accountRow(a) {
  const v = eurValue(a);
  const sub = [
    $('#group-by').value === 'type' ? a.institution : TYPE[a.type].label,
    a.holdings.length ? `${a.holdings.length} ${a.holdings.length === 1 ? 'positie' : 'posities'}` : null,
    a.bonus ? `excl. ${moneyIn(a.bonus, a.currency)} bonus${a.bonusPct ? ` (${a.bonusPct}%)` : ''}` : null,
    a.linked ? `🔗 ${when(a.updatedAt)}` : `bijgewerkt ${fmtDate.format(new Date(a.updatedAt))}`,
    a.note || null,
  ].filter(Boolean).join(' · ');
  const row = el('div', { class: 'acc', tabindex: '0', role: 'button', 'aria-label': `${a.name} bewerken` },
    el('span', { class: 'acc-ico', style: `--c:${TYPE[a.type].color}`, 'aria-hidden': 'true' },
      (a.institution || a.name || '?').trim().charAt(0).toUpperCase()),
    el('div', { class: 'acc-main' },
      el('div', { class: 'acc-name' }, a.name, a.error ? el('span', { class: 'badge warn', title: a.error }, '⚠️') : null),
      el('div', { class: 'acc-sub' }, sub)
    ),
    el('div', {},
      el('div', { class: 'acc-value money' + (v < 0 ? ' neg-val' : '') }, a.pending ? '…' : money(v, true)),
      a.currency !== 'EUR' && !a.holdings.length ? el('div', { class: 'acc-orig money' }, moneyIn(a.balance, a.currency)) : null
    ),
    el('span', { class: 'acc-edit' }, 'Bewerk ›')
  );
  row.addEventListener('click', () => openAccountDialog(a));
  row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAccountDialog(a); } });
  return row;
}

/* ---------- Account dialog ---------- */

const dlg = $('#account-dialog');
const form = $('#account-form');
let editing = null; // het account-object dat bewerkt wordt, of null bij nieuw
let draftHoldings = [];

function fillSelects(extraCurrency) {
  $('#type-select').replaceChildren(...TYPES.map(t => el('option', { value: t.id }, t.label)));
  const curs = new Set([...Object.keys(state.rates), ...Object.keys(remote.rates?.rates || {})]);
  if (extraCurrency) curs.add(extraCurrency);
  const sorted = ['EUR', 'USD', ...[...curs].filter(c => c !== 'EUR' && c !== 'USD').sort()];
  $('#currency-select').replaceChildren(...sorted.map(c => el('option', { value: c }, c)));
  const insts = [...new Set(allAccounts().map(a => a.institution).filter(Boolean))].sort();
  $('#institutions').replaceChildren(...insts.map(i => el('option', { value: i })));
}

function openAccountDialog(a = null) {
  fillSelects(a?.currency);
  editing = a;
  const linked = !!a?.linked;
  $('#account-dialog-title').textContent = linked ? 'Gekoppelde rekening' : a ? 'Rekening bewerken' : 'Rekening toevoegen';
  $('#linked-note').hidden = !linked;
  $('#btn-delete').hidden = !a;
  $('#btn-delete').textContent = linked ? 'Verbergen' : 'Verwijderen';
  form.name.value = a ? a.name : '';
  form.institution.value = a ? a.institution : '';
  form.type.value = a ? a.type : 'bank';
  form.currency.value = a ? a.currency : 'EUR';
  form.balance.value = a ? a.balance : 0;
  form.note.value = a ? a.note : '';
  for (const f of [form.institution, form.currency, form.balance]) f.disabled = linked;
  $('#note-label').hidden = linked;
  const broker = linked && isBrokerConn(a);
  $('#cent-label').hidden = !broker;
  $('#credit-label').hidden = !broker;
  form.cent.checked = !!a?.cent;
  form.bonusPct.value = a?.bonusPct ?? 0;
  syncCreditHint();
  draftHoldings = a ? a.holdings.map(h => ({ ...h })) : [];
  syncTypeUI();
  renderHoldings();
  dlg.showModal();
  if (!linked && !a) form.name.focus();
}

/** Houdt het saldo-voorbeeld in het venster actueel bij cent-account en bonuspercentage. */
function syncCreditHint() {
  if (!editing?.linked || $('#credit-label').hidden) return;
  const draft = { cent: form.cent.checked, bonusPct: Math.max(0, Number(String(form.bonusPct.value).replace(',', '.')) || 0) };
  const amt = linkedAmount(editing.raw, draft, editing.institution);
  form.balance.value = round2(amt.balance);
  $('#bonus-preview').textContent = amt.bonus
    ? `Broker toont ${moneyIn(amt.balance + amt.bonus, amt.currency)} → echt geld ${moneyIn(amt.balance, amt.currency)}`
    : '';
}

form.cent.addEventListener('change', syncCreditHint);
form.bonusPct.addEventListener('input', syncCreditHint);

function isBrokerConn(a) {
  return remote.connections.find(c => c.id === a.connId)?.kind !== 'eb';
}

function syncTypeUI() {
  const t = TYPE[form.type.value];
  $('#holdings-section').hidden = !t.holdings || !!editing?.linked;
  $('#balance-label').firstChild.textContent = t.negative ? 'Openstaand bedrag'
    : editing?.linked ? 'Saldo (automatisch)'
    : t.holdings ? 'Cash op rekening' : 'Saldo';
}

function renderHoldings() {
  const box = $('#holdings');
  box.replaceChildren();
  if (!draftHoldings.length) {
    box.append(el('p', { class: 'hint' }, 'Nog geen posities. Je kan ook gewoon het totaal als cash invullen.'));
    return;
  }
  const accLike = { currency: form.currency.value };
  for (const h of draftHoldings) {
    const valueEl = el('span', { class: 'h-value money' });
    const priceInput = el('input', { type: 'number', step: 'any', value: h.price || '', 'aria-label': 'Koers', placeholder: 'koers',
      oninput: e => { h.price = Number(e.target.value) || 0; update(); } });
    function update() {
      const q = holdingQuote(h, accLike);
      priceInput.disabled = q.auto;
      if (q.auto) priceInput.value = round2(q.price);
      priceInput.title = q.auto ? `Automatische koers (${q.currency})` : 'Koers zelf invullen';
      valueEl.textContent = moneyIn(h.qty * q.price, q.currency);
    }
    update();
    box.append(el('div', { class: 'holding' },
      el('input', { class: 'h-name', value: h.symbol, placeholder: 'bv. VWCE.DE', 'aria-label': 'Ticker', autocapitalize: 'characters',
        oninput: e => { h.symbol = e.target.value.trim().toUpperCase(); update(); } }),
      el('input', { type: 'number', step: 'any', value: h.qty, 'aria-label': 'Aantal',
        oninput: e => { h.qty = Number(e.target.value) || 0; update(); } }),
      priceInput,
      valueEl,
      el('button', { type: 'button', class: 'remove', title: 'Verwijder positie', 'aria-label': 'Verwijder positie',
        onclick: () => { draftHoldings = draftHoldings.filter(x => x !== h); renderHoldings(); } }, '×')
    ));
  }
}

form.type.addEventListener('change', syncTypeUI);
form.currency.addEventListener('change', renderHoldings);
$('#btn-add-holding').addEventListener('click', () => {
  draftHoldings.push({ id: uid(), symbol: '', qty: 0, price: 0 });
  renderHoldings();
  const inputs = $('#holdings').querySelectorAll('.h-name');
  inputs[inputs.length - 1]?.focus();
});
$('#btn-cancel').addEventListener('click', () => dlg.close());
$('#btn-delete').addEventListener('click', () => {
  if (!editing) return;
  if (editing.linked) {
    if (!confirm(`"${editing.name}" verbergen? Je kan het terug tonen via Instellingen → Koppelingen.`)) return;
    state.linkedMeta[editing.id] = { ...(state.linkedMeta[editing.id] || {}), hidden: true };
  } else {
    if (!confirm(`"${editing.name}" verwijderen?`)) return;
    state.accounts = state.accounts.filter(x => x.id !== editing.id);
  }
  dlg.close();
  save();
});

form.addEventListener('submit', e => {
  e.preventDefault();
  const type = form.type.value;
  if (editing?.linked) {
    const meta = { ...(state.linkedMeta[editing.id] || {}), name: form.name.value.trim(), type };
    if (!$('#cent-label').hidden) {
      meta.cent = form.cent.checked;
      meta.bonusPct = Math.max(0, Number(String(form.bonusPct.value).replace(',', '.')) || 0);
      delete meta.credit;
    }
    state.linkedMeta[editing.id] = meta;
    dlg.close();
    save();
    return;
  }
  const data = {
    name: form.name.value.trim() || 'Rekening',
    institution: form.institution.value.trim(),
    type,
    currency: form.currency.value,
    balance: TYPE[type].negative ? Math.abs(Number(form.balance.value) || 0) : Number(form.balance.value) || 0,
    holdings: TYPE[type].holdings ? draftHoldings.filter(h => h.symbol || h.qty || h.price) : [],
    note: form.note.value.trim(),
    updatedAt: new Date().toISOString(),
  };
  if (editing) Object.assign(state.accounts.find(x => x.id === editing.id), data);
  else state.accounts.push({ id: uid(), ...data });
  dlg.close();
  save();
});

/* ---------- Koppelen ---------- */

const linkDlg = $('#link-dialog');
const bankDlg = $('#bank-dialog');
const metaDlg = $('#meta-dialog');
const mfxDlg = $('#mfx-dialog');
let aspspCache = {};

function openLinkChooser() {
  $('#settings-dialog').close();
  linkDlg.showModal();
}

$('#btn-link').addEventListener('click', openLinkChooser);
$('#btn-link-empty').addEventListener('click', openLinkChooser);
$('#choose-manual').addEventListener('click', () => { linkDlg.close(); openAccountDialog(); });
$('#choose-meta').addEventListener('click', () => {
  linkDlg.close();
  if (!remote.config.metaApi) return toast('MetaApi is nog niet ingesteld op de server (METAAPI_TOKEN). Zie README.', true);
  $('#meta-error').hidden = true;
  metaDlg.showModal();
});
$('#choose-mfx').addEventListener('click', () => {
  linkDlg.close();
  $('#mfx-error').hidden = !!remote.config.myfxbook;
  $('#mfx-error').textContent = remote.config.myfxbook ? '' : 'Let op: MYFXBOOK_EMAIL en MYFXBOOK_PASSWORD zijn nog niet ingesteld in Cloudflare (stap 3).';
  mfxDlg.showModal();
});
$('#mfx-cancel').addEventListener('click', () => mfxDlg.close());
$('#mfx-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    applyRemote(await api('/api/myfxbook/add', { method: 'POST' }));
    mfxDlg.close();
    toast('Myfxbook gekoppeld.');
    save();
  } catch (ex) {
    $('#mfx-error').textContent = ex.message;
    $('#mfx-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
});
$('#choose-bank').addEventListener('click', async () => {
  linkDlg.close();
  if (!remote.config.enableBanking) return toast('Enable Banking is nog niet ingesteld op de server (EB_APP_ID / EB_PRIVATE_KEY). Zie README.', true);
  bankDlg.showModal();
  await loadBanks();
});

async function loadBanks() {
  const country = $('#bank-country').value;
  const list = $('#bank-list');
  if (!aspspCache[country]) {
    list.replaceChildren(el('li', { class: 'hint' }, 'Banken laden…'));
    try {
      aspspCache[country] = (await api(`/api/eb/aspsps?country=${country}`)).aspsps;
    } catch (e) {
      list.replaceChildren(el('li', { class: 'form-error' }, e.message));
      return;
    }
  }
  renderBanks();
}

function renderBanks() {
  const q = $('#bank-search').value.trim().toLowerCase();
  const banks = (aspspCache[$('#bank-country').value] || []).filter(b => b.name.toLowerCase().includes(q));
  $('#bank-list').replaceChildren(...(banks.length ? banks.map(b => el('li', {},
    el('button', { type: 'button', class: 'bank', onclick: () => startBankLink(b) },
      b.logo ? el('img', { src: b.logo, alt: '', loading: 'lazy' }) : el('span', { class: 'bank-ph' }, '🏦'),
      b.name)
  )) : [el('li', { class: 'hint' }, 'Geen bank gevonden. Probeer een ander land (Revolut staat soms onder Litouwen).')]));
}

$('#bank-country').addEventListener('change', loadBanks);
$('#bank-search').addEventListener('input', renderBanks);

async function startBankLink(aspsp) {
  try {
    toast(`Doorsturen naar ${aspsp.name}…`);
    const { url } = await api('/api/eb/start', { method: 'POST', body: { name: aspsp.name, country: aspsp.country } });
    location.href = url;
  } catch (e) {
    toast(e.message, true);
  }
}

$('#meta-cancel').addEventListener('click', () => metaDlg.close());
$('#meta-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    applyRemote(await api('/api/metaapi/add', { method: 'POST', body: { accountId: e.target.accountId.value } }));
    e.target.accountId.value = '';
    metaDlg.close();
    toast('MetaTrader-account gekoppeld.');
    save();
  } catch (ex) {
    $('#meta-error').textContent = ex.message;
    $('#meta-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
});

async function refreshNow() {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    applyRemote(await api('/api/refresh', { method: 'POST' }));
    save();
    toast(remote.connections.some(c => c.error) ? 'Vernieuwd, maar niet alles lukte.' : 'Saldi vernieuwd.');
  } catch (e) {
    if (e.message !== 'Niet aangemeld') toast(`Vernieuwen mislukt: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}
$('#btn-refresh').addEventListener('click', refreshNow);

/* ---------- Settings ---------- */

const sdlg = $('#settings-dialog');

function renderConnections() {
  const box = $('#connections');
  box.replaceChildren();
  if (!remote.connections.length) {
    box.append(el('p', { class: 'hint' }, 'Nog niets gekoppeld.'));
  }
  for (const c of remote.connections) {
    const days = c.validUntil ? Math.ceil((new Date(c.validUntil) - Date.now()) / 864e5) : null;
    box.append(el('div', { class: 'conn' },
      el('div', { class: 'conn-head' },
        el('strong', {}, c.institution),
        el('span', { class: 'hint' }, `opgehaald ${when(c.checkedAt)}` + (days != null ? ` · toestemming nog ${Math.max(days, 0)} d` : '')),
      ),
      c.error ? el('p', { class: 'form-error' }, c.error) : null,
      (c.accounts || []).map(a => {
        const meta = state.linkedMeta[a.key] || {};
        return el('label', { class: 'conn-acc' },
          el('input', { type: 'checkbox', checked: (meta.hidden ?? a.demo) ? false : '', onchange: e => {
            state.linkedMeta[a.key] = { ...meta, hidden: !e.target.checked };
            save();
          } }),
          el('span', {}, meta.name || a.name, a.demo ? el('span', { class: 'hint' }, ' (demo)') : null, a.iban ? el('span', { class: 'hint' }, ` ${maskIban(a.iban)}`) : null),
          el('span', { class: 'money' }, a.balance == null ? '…' : (amt => moneyIn(amt.balance, amt.currency) + (amt.cent ? ' (cent)' : ''))(linkedAmount(a, meta, c.institution)))
        );
      }),
      el('div', { class: 'row wrap' },
        c.kind === 'eb' ? el('button', { type: 'button', class: 'btn small', onclick: () => startBankLink(c.aspsp) }, 'Opnieuw koppelen') : null,
        el('button', { type: 'button', class: 'btn small danger', onclick: () => removeConnection(c) }, 'Ontkoppelen')
      )
    ));
  }
  const cfg = remote.config || {};
  $('#config-status').replaceChildren(
    `Enable Banking: ${cfg.enableBanking ? '✅ ingesteld' : '❌ niet ingesteld'} · Myfxbook: ${cfg.myfxbook ? '✅ ingesteld' : '❌ niet ingesteld'} · MetaApi: ${cfg.metaApi ? '✅ ingesteld' : '❌ niet ingesteld'}`,
    cfg.redirectUrl ? el('span', { class: 'block' }, 'Redirect-URL voor Enable Banking: ', el('code', {}, cfg.redirectUrl)) : null
  );
}

function maskIban(iban) {
  return iban.length > 8 ? `${iban.slice(0, 4)} •••• ${iban.slice(-4)}` : iban;
}

async function removeConnection(c) {
  if (!confirm(`${c.institution} ontkoppelen?`)) return;
  try {
    applyRemote(await api(`/api/connections/${encodeURIComponent(c.id)}`, { method: 'DELETE' }));
    renderConnections();
    save();
  } catch (e) {
    toast(e.message, true);
  }
}

function renderRates() {
  const auto = remote.rates;
  $('#rates-auto').textContent = auto
    ? `Automatisch van de ECB (${auto.date}). Onderstaande koersen gelden enkel voor munten die de ECB niet kent.`
    : 'Waarde van 1 eenheid vreemde munt in euro.';
  const box = $('#rates');
  box.replaceChildren();
  for (const [code, r] of Object.entries(state.rates)) {
    if (code === 'EUR') continue;
    const autoRate = auto?.rates?.[code];
    const inUse = allAccounts().some(a => a.currency === code);
    box.append(el('div', { class: 'rate-row' },
      el('strong', {}, code),
      el('input', { type: 'number', step: 'any', min: '0', value: autoRate ? round4(autoRate) : r, disabled: autoRate ? '' : false,
        'aria-label': `Koers ${code}`,
        onchange: e => { const v = Number(e.target.value); if (v > 0) { state.rates[code] = v; save(); } } }),
      el('button', { type: 'button', class: 'remove', title: inUse ? 'In gebruik' : 'Verwijder', disabled: inUse ? '' : false,
        onclick: () => { delete state.rates[code]; save(); renderRates(); } }, '×')
    ));
  }
}

const round4 = n => Math.round(n * 10000) / 10000;

$('#btn-settings').addEventListener('click', () => { renderConnections(); renderRates(); sdlg.showModal(); });
$('#btn-add-rate').addEventListener('click', () => {
  const code = $('#new-rate-code').value.trim().toUpperCase();
  if (!/^[A-Z]{3,5}$/.test(code) || state.rates[code]) return;
  state.rates[code] = 1;
  $('#new-rate-code').value = '';
  save();
  renderRates();
});

$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `vermogen-${todayISO()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!confirm('Huidige gegevens vervangen door de geïmporteerde back-up?')) return;
    state = normalizeState(parsed);
    save();
    renderRates();
  } catch {
    alert('Ongeldig bestand.');
  } finally {
    e.target.value = '';
  }
});

$('#btn-reset').addEventListener('click', () => {
  if (!confirm('Alle zelf toegevoegde rekeningen en de geschiedenis wissen? Koppelingen blijven bestaan.')) return;
  state = emptyState();
  save();
  sdlg.close();
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

/* ---------- Demo data ---------- */

function loadDemo() {
  if (allAccounts().length && !confirm('Huidige gegevens vervangen door demo-data?')) return;
  const now = new Date().toISOString();
  const acc = (name, institution, type, balance, extra = {}) =>
    ({ id: uid(), name, institution, type, currency: 'EUR', balance, holdings: [], note: '', updatedAt: now, ...extra });
  const h = (symbol, qty, price) => ({ id: uid(), symbol, qty, price });
  state = emptyState();
  state.accounts = [
    acc('Zichtrekening', 'Argenta', 'bank', 1615.2),
    acc('Spaarrekening', 'Argenta', 'savings', 8200),
    acc('Hoofdrekening', 'Revolut', 'bank', 940.35),
    acc('Portefeuille', 'Lightyear', 'broker', 120, { holdings: [h('VWCE.DE', 42, 138.5), h('IWDA.AS', 30, 104.2)] }),
    acc('MT5-account', 'VT Markets', 'broker', 2150, { currency: 'USD' }),
  ];
  const t0 = totals().net;
  for (let i = 12; i >= 1; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const factor = 1 - i * 0.022 + Math.sin(i * 1.7) * 0.015;
    state.history.push({ date: iso, net: round2(t0 * factor), byType: {} });
  }
  save();
}

$('#btn-demo').addEventListener('click', loadDemo);

/* ---------- Top bar ---------- */

$('#btn-add').addEventListener('click', openLinkChooser);
$('#btn-add-empty').addEventListener('click', () => openAccountDialog());
$('#group-by').addEventListener('change', () => renderAccounts(allAccounts()));

$('#range-seg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  historyRange = b.dataset.range;
  for (const x of $('#range-seg').querySelectorAll('button')) x.classList.toggle('active', x === b);
  renderHistory();
});

function applyTheme(theme) {
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}
function currentTheme() {
  return document.documentElement.getAttribute('data-theme')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
$('#btn-theme').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* */ }
});

function applyPrivacy(on) {
  document.body.classList.toggle('private', on);
  const b = $('#btn-privacy');
  b.setAttribute('aria-pressed', String(on));
  b.querySelector('.lbl').textContent = on ? 'Toon' : 'Verberg';
}
$('#btn-privacy').addEventListener('click', () => {
  const on = !document.body.classList.contains('private');
  applyPrivacy(on);
  try { localStorage.setItem(PRIVACY_KEY, on ? '1' : '0'); } catch { /* */ }
});

/* ---------- Init ---------- */

try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* */ }
try { applyPrivacy(localStorage.getItem(PRIVACY_KEY) === '1'); } catch { /* */ }

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (allAccounts().length) renderHistory(); }, 120);
});

// Terug van de bank?
const params = new URLSearchParams(location.search);
if (params.has('linked')) toast(`${params.get('linked')} gekoppeld ✔`);
if (params.has('link_error')) toast(`Koppelen mislukt: ${params.get('link_error')}`, true);
if (params.has('linked') || params.has('link_error')) history.replaceState(null, '', location.pathname);

// Bij terugkeren naar de app (bv. op gsm) de nieuwste data tonen.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#app').hidden && !dirty) loadFromServer().catch(() => {});
});

loadFromServer().catch(e => {
  if (e.message !== 'Niet aangemeld') {
    showLogin();
    const err = $('#login-error');
    err.textContent = `Server niet bereikbaar: ${e.message}`;
    err.hidden = false;
  }
});
