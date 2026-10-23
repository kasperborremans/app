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
  return { version: 2, rates: { ...DEFAULT_RATES }, accounts: [], history: [], linkedMeta: {}, manualTx: [] };
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
          ...(h.byAccount && typeof h.byAccount === 'object' ? { byAccount: h.byAccount } : {}),
        })).sort((a, b) => a.date.localeCompare(b.date))
      : [],
    linkedMeta: s.linkedMeta && typeof s.linkedMeta === 'object' ? s.linkedMeta : {},
    // Logboek van saldowijzigingen bij zelf bijgehouden rekeningen.
    manualTx: Array.isArray(s.manualTx) ? s.manualTx.filter(t => t && t.accountId && t.date).map(t => ({
      id: String(t.id || uid()),
      accountId: String(t.accountId),
      date: String(t.date),
      amount: Number(t.amount) || 0,
      currency: String(t.currency || 'EUR'),
      label: String(t.label || 'Saldo aangepast'),
      kind: 'manual',
    })) : [],
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
 * en zonder bonus/credit van de broker (dat is geen eigen geld).
 *
 * In MetaTrader is equity = saldo + credit + open winst/verlies, en zit de credit nooit
 * in het saldo. Volgorde, van exact naar geschat:
 *  1. credit bekend (MetaApi)            → echt geld = equity − credit
 *  2. saldo bekend (Myfxbook)            → echt geld = saldo + open winst/verlies
 *  3. bonus% en stortingen bekend        → echt geld = equity − bonus% × netto stortingen
 *  4. enkel bonus%                       → echt geld = equity ÷ (1 + bonus%)
 */
function linkedAmount(a, meta, institution) {
  const cent = meta.cent ?? isCentAuto(a);
  const div = cent ? 100 : 1;
  const cur = String(a.currency || 'EUR');
  const gross = (Number(a.balance) || 0) / div;
  const bonusPct = bonusPctFor(a, meta, institution);
  const deposits = a.deposits != null ? (Number(a.deposits) || 0) / div : null;
  const withdrawals = (Number(a.withdrawals) || 0) / div;
  const cashBalance = a.cashBalance != null && !Number.isNaN(Number(a.cashBalance)) ? Number(a.cashBalance) / div : null;
  const openProfit = a.openProfit != null ? Number(a.openProfit) / div : null;
  let bonus, method;
  if (a.credit != null) {
    bonus = (Number(a.credit) || 0) / div;
    method = 'credit';
  } else if (cashBalance != null && a.balance != null) {
    bonus = Math.max(0, gross - (cashBalance + (openProfit ?? 0)));
    method = 'balance';
  } else if (bonusPct > 0 && deposits > 0) {
    bonus = (bonusPct / 100) * Math.max(0, deposits - withdrawals);
    method = 'deposits';
  } else if (bonusPct > 0) {
    bonus = gross - gross / (1 + bonusPct / 100);
    method = 'ratio';
  } else {
    bonus = 0;
    method = null;
  }
  return {
    balance: gross - bonus,
    gross,
    bonus,
    bonusPct: method === 'deposits' || method === 'ratio' ? bonusPct : 0,
    exact: method === 'credit' || method === 'balance',
    cashBalance,
    openProfit,
    deposits,
    withdrawals,
    method,
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

function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Werkt de momentopname van vandaag bij. Geeft true terug als er iets veranderd is. */
function recordSnapshot() {
  if (!allAccounts().length) return false;
  const t = totals();
  const date = todayISO();
  const snap = {
    date,
    net: round2(t.net),
    byType: Object.fromEntries(Object.entries(t.byType).map(([k, v]) => [k, round2(v)])),
    // Per rekening, voor de grafiek van elke rekening apart.
    byAccount: Object.fromEntries(allAccounts().filter(a => !a.pending).map(a => [a.id, round2(eurValue(a))])),
  };
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
  $('#alloc-card').hidden = !hasAccounts;

  $('#net-worth').textContent = money(t.net);
  $('#assets-total').textContent = money(t.assets);
  $('#debts-total').textContent = money(t.debts);
  $('#account-count').textContent = accounts.length;
  renderDelta(t.net, accounts.length);
  renderSyncStatus();
  renderAlerts();
  renderConnections();
  renderProviders();
  renderRates();
  renderAccountInfo(accounts);
  renderAccounts(accounts);
  renderAllocation(t);
  renderAllTransactions(accounts);
  if (route === 'overzicht' && hasAccounts) renderNetChart();
  if (route === 'rekening') renderAccountPage(routeArg);
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
  box.append(deltaChip(net - prev.net, prev.net), ` sinds ${fmtDate.format(parseDate(prev.date))}`);
}

/** Procentuele wijziging, of null als dat niets zegt (vertrek vanaf ±0, bv. vóór de eerste storting). */
function changePct(diff, base) {
  if (!base || Math.abs(base) < 1) return null;
  const pct = diff / Math.abs(base);
  return Math.abs(pct) > 10 ? null : pct;
}

/** ▲ +€ 120 (+1,2%) — groen of rood. */
function deltaChip(diff, base) {
  const pct = changePct(diff, base);
  const sign = diff >= 0 ? '+' : '−';
  return el('span', { class: (diff >= 0 ? 'up' : 'down') + ' money' },
    `${diff >= 0 ? '▲' : '▼'} ${sign}${money(Math.abs(diff))}` + (pct != null ? ` (${sign}${fmtPct.format(Math.abs(pct))})` : ''));
}

function renderSyncStatus() {
  const times = remote.connections.map(c => c.checkedAt).filter(Boolean).sort();
  const text = times.length ? `Saldi opgehaald: ${when(times[times.length - 1])}` : '';
  $('#sync-status').textContent = text;
  $('#sidebar-sync').textContent = text;
}

/** Koppelingen met een probleem of een toestemming die binnenkort verloopt. */
function connectionProblems() {
  const problems = [];
  for (const c of remote.connections) {
    if (c.error) problems.push({ c, msg: c.error });
    else if (c.validUntil) {
      const days = Math.ceil((new Date(c.validUntil) - Date.now()) / 864e5);
      if (days <= 14) problems.push({ c, msg: `Toestemming verloopt over ${Math.max(days, 0)} dag(en).` });
    }
  }
  return problems;
}

function renderAlerts() {
  const box = $('#alerts');
  box.replaceChildren();
  const problems = connectionProblems();
  box.hidden = !problems.length;
  const badge = $('#nav-conn-badge');
  badge.hidden = !problems.length;
  badge.textContent = problems.length;
  for (const p of problems) {
    box.append(el('div', { class: 'alert-row' },
      el('span', {}, '⚠️ ', el('strong', {}, p.c.institution), ` — ${p.msg}`),
      p.c.kind === 'eb'
        ? el('button', { class: 'btn small', onclick: () => startBankLink(p.c.aspsp) }, 'Opnieuw koppelen')
        : null
    ));
  }
}

function renderAccountInfo(accounts) {
  const linked = accounts.filter(a => a.linked).length;
  $('#account-info').textContent = [
    `${accounts.length} ${accounts.length === 1 ? 'rekening' : 'rekeningen'}`,
    `${linked} automatisch gekoppeld`,
    $('#sync-status').textContent || null,
  ].filter(Boolean).join(' · ');
  const n = remote.connections.length;
  const problems = connectionProblems().length;
  $('#conn-summary').textContent = (n ? `${n} ${n === 1 ? 'koppeling' : 'koppelingen'}` : 'Nog niets gekoppeld')
    + (problems ? ` · ⚠️ ${problems} vraagt aandacht` : '') + ' — bank, broker, diensten';
}

function renderAllocation(t) {
  const bar = $('#alloc-bar');
  const list = $('#alloc-list');
  bar.replaceChildren();
  list.replaceChildren();
  $('#alloc-total').textContent = money(t.assets);
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

/* ---------- Grafieken ---------- */

let chartRange = 'all';

function inRange(points) {
  if (chartRange === 'all') return points;
  const cutoff = Date.now() - Number(chartRange) * 864e5;
  const inside = points.filter(p => p.t >= cutoff);
  // Vertrek vanaf de laatste waarde vóór de periode, zodat de lijn niet halverwege begint.
  const before = points.filter(p => p.t < cutoff).pop();
  return before && inside.length ? [{ t: cutoff, v: before.v }, ...inside] : inside;
}

function netSeries() {
  return state.history.map(h => ({ t: parseDate(h.date).getTime(), v: h.net }));
}

function renderNetChart() {
  drawChart($('#history-chart'), inRange(netSeries()), n => n
    ? 'Eén momentopname. Kom later terug om het verloop te zien.'
    : 'Nog geen gegevens in deze periode.');
}

function rerenderCharts() {
  if (route === 'overzicht' && allAccounts().length) renderNetChart();
  if (route === 'rekening') renderAccountPage(routeArg);
}

/**
 * Lijngrafiek met verloop en tooltip.
 * points: [{ t: tijdstip in ms, v: waarde in euro }], chronologisch.
 */
function drawChart(chart, data, emptyMsg) {
  const wrap = chart.parentElement;
  const tip = wrap.querySelector('.tooltip');
  chart.replaceChildren();
  tip.hidden = true;
  const W = wrap.clientWidth || 600;
  const H = wrap.clientHeight || 260;
  chart.setAttribute('viewBox', `0 0 ${W} ${H}`);

  if (data.length < 2) {
    const msg = svg('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty-msg' });
    msg.textContent = emptyMsg(data.length);
    chart.append(msg);
    return;
  }

  const m = { top: 12, right: 12, bottom: 26, left: 56 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const xs = data.map(d => d.t);
  const ys = data.map(d => d.v);
  const x0 = xs[0];
  const x1 = Math.max(xs[xs.length - 1], x0 + 1);
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

  const pts = data.map((d, i) => [sx(xs[i]), sy(d.v)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const base = sy(Math.max(y0, 0));
  const gradId = `grad-${chart.id}`;
  const grad = svg('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(svg('stop', { offset: 0, class: 'grad-top' }), svg('stop', { offset: 1, class: 'grad-bottom' }));
  const defs = svg('defs');
  defs.append(grad);
  chart.append(defs);
  chart.append(svg('path', { class: 'area', fill: `url(#${gradId})`, d: `${line}L${pts[pts.length - 1][0]},${base}L${pts[0][0]},${base}Z` }));
  chart.append(svg('path', { class: 'line', d: line }));

  const cross = svg('line', { class: 'cross', y1: m.top, y2: m.top + ih, visibility: 'hidden' });
  const dot = svg('circle', { class: 'dot', r: 5, visibility: 'hidden' });
  const hit = svg('rect', { x: m.left, y: 0, width: iw, height: H, fill: 'transparent', tabindex: '0' });
  chart.append(cross, dot, hit);

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
    const rows = [{ value: money(d.v), label: fmtDate.format(new Date(d.t)), color: 'var(--accent)' }];
    if (prev) {
      const diff = d.v - prev.v;
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

/* ---------- Transacties ---------- */

/**
 * Transacties van één rekening, nieuwste eerst. Gekoppelde rekeningen krijgen ze van
 * de bank/broker; bij zelf bijgehouden rekeningen is het het logboek van saldowijzigingen.
 */
function accountTransactions(a) {
  const list = a.linked
    ? (a.raw.transactions || []).map(t => ({
        ...t,
        // Cent-accounts: bedragen in centen, net als het saldo.
        amount: a.cent ? t.amount / 100 : t.amount,
        currency: a.cent ? a.currency : t.currency || a.currency,
      }))
    : state.manualTx.filter(t => t.accountId === a.id).map(t => ({ ...t, currency: t.currency || a.currency }));
  return list
    .map(t => ({ ...t, account: a, eur: t.amount * rate(t.currency) }))
    .sort((x, y) => String(y.date).localeCompare(String(x.date)));
}

function allTransactions(accounts) {
  return accounts.flatMap(accountTransactions).sort((x, y) => String(y.date).localeCompare(String(x.date)));
}

let txShown = 15;

function renderAllTransactions(accounts) {
  const txs = allTransactions(accounts);
  renderTxList($('#tx-all'), txs.slice(0, txShown), { showAccount: true,
    empty: 'Nog geen transacties. Gekoppelde rekeningen tonen hier stortingen, betalingen en trades; bij zelf bijgehouden rekeningen zie je hier elke saldowijziging.' });
  $('#tx-more').hidden = txs.length <= txShown;
}

const TX_ICON = { in: '↓', deposit: '↓', out: '↑', withdrawal: '↑', trade: '⇅', manual: '✎' };

function txWhen(t) {
  const d = new Date(t.date);
  const days = Math.round((parseDate(todayISO()) - parseDate(todayISO(d))) / 864e5);
  const day = days === 0 ? 'vandaag' : days === 1 ? 'gisteren' : fmtDate.format(d);
  // Bankboekingen hebben enkel een datum; trades en eigen wijzigingen ook een uur.
  return t.kind === 'in' || t.kind === 'out' ? day : `${day} ${fmtTime.format(d)}`;
}

function signedIn(n, cur) {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${moneyIn(Math.abs(n), cur)}`;
}

function renderTxList(ul, txs, { showAccount = false, empty = 'Geen transacties.' } = {}) {
  ul.replaceChildren();
  if (!txs.length) {
    ul.append(el('li', { class: 'tx-empty hint' }, empty));
    return;
  }
  for (const t of txs) {
    const up = t.amount >= 0;
    const sub = [
      showAccount ? `${t.account.name} · ${t.account.institution}` : null,
      txWhen(t),
      t.detail || null,
    ].filter(Boolean).join(' · ');
    const li = el('li', { class: 'tx' + (showAccount ? ' clickable' : '') },
      el('span', { class: `tx-ico ${t.kind === 'trade' || t.kind === 'manual' ? t.kind : up ? 'in' : 'out'}`, 'aria-hidden': 'true' }, TX_ICON[t.kind] || (up ? '↓' : '↑')),
      el('div', { class: 'tx-main' },
        el('div', { class: 'tx-label' }, t.label, t.pending ? el('span', { class: 'pill muted' }, 'in behandeling') : null),
        el('div', { class: 'tx-sub' }, sub)
      ),
      el('div', { class: 'tx-amt' },
        el('div', { class: 'money ' + (up ? 'pos-val' : 'neg-val') }, signedIn(t.amount, t.currency)),
        t.currency !== 'EUR' ? el('div', { class: 'acc-orig money' }, `≈ ${signedIn(t.eur, 'EUR')}`) : null
      )
    );
    if (showAccount) {
      li.tabIndex = 0;
      li.setAttribute('role', 'link');
      const go = () => navigate(`rekening/${encodeURIComponent(t.account.id)}`);
      li.addEventListener('click', go);
      li.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    }
    ul.append(li);
  }
}

/* ---------- Rekeningen ---------- */

/**
 * Verloop van één rekening in euro. Uit de dagelijkse momentopnames; zolang die er nog
 * niet zijn, geschat door vanaf het huidige saldo terug te rekenen met de transacties.
 */
function accountSeries(a) {
  const cur = round2(eurValue(a));
  const today = parseDate(todayISO()).getTime();
  const points = state.history
    .filter(h => h.byAccount && a.id in h.byAccount)
    .map(h => ({ t: parseDate(h.date).getTime(), v: h.byAccount[a.id] }));
  if (points.length && points[points.length - 1].t === today) points[points.length - 1].v = cur;
  else points.push({ t: today, v: cur });
  if (points.length >= 2 || a.pending) return { points, estimated: false };

  const txs = accountTransactions(a);
  if (!txs.length) return { points, estimated: false };
  const out = [{ t: Date.now(), v: cur }];
  let v = cur;
  for (const tx of txs) {
    out.push({ t: new Date(tx.date).getTime(), v: round2(v) });
    v -= tx.eur;
  }
  out.push({ t: new Date(txs[txs.length - 1].date).getTime() - 864e5, v: round2(v) });
  return { points: out.sort((x, y) => x.t - y.t), estimated: true };
}

function renderAccounts(accounts) {
  const box = $('#accounts');
  box.replaceChildren();
  if (!accounts.length) {
    box.append(el('p', { class: 'hint' }, 'Nog geen rekeningen. Voeg er een toe of koppel je bank of broker.'));
    return;
  }
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
      accs.map(a => accountRow(a, mode))
    ));
  }
}

function accIcon(a) {
  return el('span', { class: 'acc-ico', style: `--c:${TYPE[a.type].color}`, 'aria-hidden': 'true' },
    (a.institution || a.name || '?').trim().charAt(0).toUpperCase());
}

/** mode 'type': toon de instelling als ondertitel; 'institution': toon de categorie. */
function accountRow(a, mode = 'type') {
  const v = eurValue(a);
  const { points } = accountSeries(a);
  const change = points.length >= 2 ? v - points[0].v : null;
  const sub = [
    mode === 'type' ? a.institution : TYPE[a.type].label,
    a.holdings.length ? `${a.holdings.length} ${a.holdings.length === 1 ? 'positie' : 'posities'}` : null,
    a.linked ? `🔗 ${when(a.updatedAt)}` : `bijgewerkt ${fmtDate.format(new Date(a.updatedAt))}`,
  ].filter(Boolean).join(' · ');
  const open = () => navigate(`rekening/${encodeURIComponent(a.id)}`);
  const row = el('div', { class: 'acc', tabindex: '0', role: 'link', 'aria-label': `${a.name} openen` },
    accIcon(a),
    el('div', { class: 'acc-main' },
      el('div', { class: 'acc-name' }, a.name, a.error ? el('span', { class: 'badge warn', title: a.error }, '⚠️') : null),
      el('div', { class: 'acc-sub' }, sub)
    ),
    el('div', {},
      el('div', { class: 'acc-value money' + (v < 0 ? ' neg-val' : '') }, a.pending ? '…' : money(v, true)),
      change != null && Math.abs(change) >= 0.005
        ? el('div', { class: 'acc-orig money ' + (change >= 0 ? 'pos-val' : 'neg-val') },
            `${change >= 0 ? '▲' : '▼'} ${(pct => pct != null ? fmtPct.format(Math.abs(pct)) : money(Math.abs(change)))(changePct(change, points[0].v))}`)
        : a.currency !== 'EUR' && !a.holdings.length ? el('div', { class: 'acc-orig money' }, moneyIn(a.balance, a.currency)) : null
    ),
    el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')
  );
  row.addEventListener('click', open);
  row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return row;
}

function renderAccountPage(id) {
  const a = allAccounts().find(x => x.id === id);
  const hero = $('#acc-hero');
  if (!a) {
    $('#page-title').textContent = 'Rekening';
    hero.replaceChildren(el('p', { class: 'hint' }, 'Deze rekening bestaat niet (meer).'), el('a', { class: 'btn small', href: '#/rekeningen' }, '‹ Naar rekeningen'));
    for (const id2 of ['#acc-chart', '#acc-tx', '#acc-holdings']) $(id2).replaceChildren();
    $('#acc-chart-hint').textContent = '';
    $('#acc-tx-hint').textContent = '';
    $('#acc-holdings-card').hidden = true;
    return;
  }
  $('#page-title').textContent = a.name;
  document.title = `${a.name} – Mijn Vermogen`;

  const v = eurValue(a);
  const { points, estimated } = accountSeries(a);
  const first = points[0];
  const txs = accountTransactions(a);
  // Bij brokers: de winst of het verlies uit trades, los van stortingen en opnames.
  const trades = txs.filter(t => t.kind === 'trade');
  const tradeResult = trades.reduce((sum, t) => sum + t.eur, 0);
  hero.replaceChildren(...[
    el('div', { class: 'acc-hero-head' },
      accIcon(a),
      el('div', { class: 'acc-main' },
        el('div', { class: 'acc-name' }, a.name),
        el('div', { class: 'acc-sub' }, [a.institution, TYPE[a.type].label].filter(Boolean).join(' · '))
      ),
      el('button', { type: 'button', class: 'btn small', onclick: () => openAccountDialog(a) }, a.linked ? 'Instellingen' : 'Bewerken')
    ),
    el('div', { class: 'acc-hero-value money' + (v < 0 ? ' neg-val' : '') }, a.pending ? '…' : money(v, true)),
    a.currency !== 'EUR' && !a.holdings.length ? el('div', { class: 'hint money' }, moneyIn(a.balance, a.currency)) : null,
    points.length >= 2
      ? el('div', { class: 'hero-delta' }, deltaChip(v - first.v, first.v), ` sinds ${fmtDate.format(new Date(first.t))}`)
      : null,
    trades.length
      ? el('div', { class: 'hero-delta' }, deltaChip(tradeResult, 0), ` resultaat uit ${trades.length} ${trades.length === 1 ? 'trade' : 'trades'}`)
      : null,
    el('p', { class: 'hint' },
      a.linked ? `🔗 Automatisch gekoppeld · opgehaald ${when(a.updatedAt)}` : `✍️ Zelf bijgehouden · bijgewerkt ${fmtDate.format(new Date(a.updatedAt))}`,
      a.bonus ? ` · excl. ${moneyIn(a.bonus, a.currency)} bonus van de broker` : '',
      a.note ? ` · ${a.note}` : ''),
    a.error ? el('p', { class: 'form-error' }, a.error) : null,
  ].filter(Boolean));

  drawChart($('#acc-chart'), inRange(points), () => 'Nog te weinig gegevens. Het verloop wordt vanaf nu elke dag bewaard.');
  $('#acc-chart-hint').textContent = estimated
    ? 'Geschat door terug te rekenen met de transacties. Vanaf nu wordt het echte verloop elke dag bewaard.'
    : points.length >= 2 ? 'Op basis van de dagelijkse momentopnames.' : '';

  $('#acc-holdings-card').hidden = !a.holdings.length;
  $('#acc-holdings').replaceChildren(...a.holdings.map(h => {
    const q = holdingQuote(h, a);
    return el('li', { class: 'tx' },
      el('span', { class: 'tx-ico trade', 'aria-hidden': 'true' }, (h.symbol || '?').charAt(0)),
      el('div', { class: 'tx-main' },
        el('div', { class: 'tx-label' }, h.symbol || 'Positie'),
        el('div', { class: 'tx-sub money' }, `${h.qty.toLocaleString('nl-BE')} × ${moneyIn(q.price, q.currency)}${q.auto ? ' · automatische koers' : ''}`)),
      el('div', { class: 'tx-amt' }, el('div', { class: 'money' }, money(h.qty * q.price * rate(q.currency), true)))
    );
  }));

  renderTxList($('#acc-tx'), txs.slice(0, 50), {
    empty: a.linked ? 'Nog geen transacties opgehaald.' : 'Nog geen wijzigingen. Pas je het saldo aan via Bewerken, dan verschijnt dat hier.',
  });
  $('#acc-tx-hint').textContent = a.linked
    ? (a.raw.txError ? `Transacties ophalen lukte niet: ${a.raw.txError}` : 'De laatste 90 dagen, rechtstreeks van de bank of broker.')
    : 'Logboek van je eigen saldowijzigingen.';
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
  const m = v => moneyIn(v, amt.currency);
  const lines = [];
  $('#bonus-pct-wrap').hidden = amt.exact;
  if (amt.method === 'balance') {
    lines.push(
      `Saldo (zonder credit) ${m(amt.cashBalance)}`,
      amt.openProfit == null ? 'Open winst/verlies: nog niet opgehaald (tik op ↻ Vernieuwen)' : `Open winst/verlies ${m(amt.openProfit)}`,
      `Credit/bonus ${m(amt.bonus)} (telt niet mee)`,
      `Broker toont ${m(amt.gross)} → echt geld ${m(amt.balance)}`,
    );
  } else if (amt.method === 'credit') {
    lines.push(`Credit/bonus ${m(amt.bonus)} (telt niet mee)`, `Broker toont ${m(amt.gross)} → echt geld ${m(amt.balance)}`);
  } else if (amt.method === 'deposits') {
    const net = amt.deposits - amt.withdrawals;
    lines.push(
      `Gestort ${m(amt.deposits)}` + (amt.withdrawals ? ` − opgenomen ${m(amt.withdrawals)}` : ''),
      `Bonus ${amt.bonusPct}% van ${m(net)} = ${m(amt.bonus)}`,
      `Winst/verlies ${m(amt.balance - net)}`,
      `Broker toont ${m(amt.gross)} → echt geld ${m(amt.balance)}`,
    );
  } else if (amt.bonus) {
    lines.push(`Broker toont ${m(amt.gross)} → echt geld ${m(amt.balance)}`);
    if (amt.method === 'ratio') lines.push('Stortingen onbekend: geschat als bedrag ÷ ' + (1 + amt.bonusPct / 100).toLocaleString('nl-BE'));
  }
  $('#bonus-preview').replaceChildren(...lines.flatMap((l, i) => (i ? [el('br'), l] : [l])));
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
    state.manualTx = state.manualTx.filter(t => t.accountId !== editing.id);
  }
  dlg.close();
  if (route === 'rekening') navigate('rekeningen');
  save();
});

/** Elke saldowijziging van een zelf bijgehouden rekening komt in het transactielogboek. */
function logManualTx(accountId, amount, currency, label) {
  if (Math.abs(amount) < 0.005) return;
  state.manualTx.push({ id: uid(), accountId, date: new Date().toISOString(), amount: round2(amount), currency, label, kind: 'manual' });
  if (state.manualTx.length > 1000) state.manualTx = state.manualTx.slice(-1000);
}

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
  if (editing) {
    const acc = state.accounts.find(x => x.id === editing.id);
    const diff = acc.currency === data.currency ? data.balance - acc.balance : 0;
    const signed = TYPE[type].negative ? -diff : diff;
    logManualTx(acc.id, signed, data.currency, signed > 0 ? 'Saldo verhoogd' : 'Saldo verlaagd');
    Object.assign(acc, data);
  } else {
    const id = uid();
    state.accounts.push({ id, ...data });
    logManualTx(id, TYPE[type].negative ? -data.balance : data.balance, data.currency, 'Beginsaldo');
  }
  dlg.close();
  save();
});

/* ---------- Koppelen ---------- */

const linkDlg = $('#link-dialog');
const bankDlg = $('#bank-dialog');
const metaDlg = $('#meta-dialog');
const mfxDlg = $('#mfx-dialog');
let aspspCache = {};

const LINK_OPTIONS = [
  { id: 'bank', title: '🏦 Bank', text: 'Argenta, Revolut, KBC, Belfius, ING, … via open banking', start: chooseBank },
  { id: 'mfx', title: '📈 MetaTrader-broker via Myfxbook (gratis)', text: 'VT Markets en andere MT4/MT5-brokers, met je investor password', start: chooseMfx },
  { id: 'meta', title: '📈 MetaTrader-broker via MetaApi (betalend)', text: 'Alternatief als Myfxbook niet werkt', start: chooseMeta },
  { id: 'manual', title: '✍️ Zelf bijhouden', text: 'Bv. Lightyear: vul je posities in, de koersen worden automatisch opgehaald', start: () => openAccountDialog() },
];

// Dezelfde keuzes staan in het koppelvenster en op de pagina Koppelingen.
for (const box of document.querySelectorAll('[data-choices]')) {
  box.replaceChildren(...LINK_OPTIONS.map(o => el('button', { type: 'button', class: 'choice', onclick: () => {
    if (linkDlg.open) linkDlg.close();
    o.start();
  } }, el('strong', {}, o.title), el('span', {}, o.text))));
}

function openLinkChooser() {
  linkDlg.showModal();
}

function chooseMeta() {
  if (!remote.config.metaApi) return toast('MetaApi is nog niet ingesteld op de server (METAAPI_TOKEN). Zie README.', true);
  $('#meta-error').hidden = true;
  metaDlg.showModal();
}

function chooseMfx() {
  $('#mfx-error').hidden = !!remote.config.myfxbook;
  $('#mfx-error').textContent = remote.config.myfxbook ? '' : 'Let op: MYFXBOOK_EMAIL en MYFXBOOK_PASSWORD zijn nog niet ingesteld in Cloudflare (stap 3).';
  mfxDlg.showModal();
}
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
async function chooseBank() {
  if (!remote.config.enableBanking) return toast('Enable Banking is nog niet ingesteld op de server (EB_APP_ID / EB_PRIVATE_KEY). Zie README.', true);
  bankDlg.showModal();
  await loadBanks();
}

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
  const btns = document.querySelectorAll('.js-refresh');
  for (const b of btns) { b.disabled = true; b.classList.add('spinning'); }
  try {
    applyRemote(await api('/api/refresh', { method: 'POST' }));
    save();
    toast(remote.connections.some(c => c.error) ? 'Vernieuwd, maar niet alles lukte.' : 'Saldi vernieuwd.');
  } catch (e) {
    if (e.message !== 'Niet aangemeld') toast(`Vernieuwen mislukt: ${e.message}`, true);
  } finally {
    for (const b of btns) { b.disabled = false; b.classList.remove('spinning'); }
  }
}
for (const b of document.querySelectorAll('.js-refresh')) b.addEventListener('click', refreshNow);

/* ---------- Koppelingen ---------- */

const KIND_LABEL = { eb: 'Bank · Enable Banking', myfxbook: 'MetaTrader · Myfxbook', metaapi: 'MetaTrader · MetaApi' };

function renderConnections() {
  const box = $('#connections');
  box.replaceChildren();
  if (!remote.connections.length) {
    box.append(el('p', { class: 'hint' }, 'Nog niets gekoppeld. Kies hieronder een bank of broker om te koppelen.'));
  }
  for (const c of remote.connections) {
    const days = c.validUntil ? Math.ceil((new Date(c.validUntil) - Date.now()) / 864e5) : null;
    const status = c.error ? ['bad', 'Fout'] : days != null && days <= 14 ? ['warn', 'Verloopt binnenkort'] : ['good', 'Actief'];
    box.append(el('div', { class: 'conn' },
      el('div', { class: 'conn-head' },
        el('span', { class: 'conn-title' },
          el('span', { class: 'acc-ico', 'aria-hidden': 'true' }, (c.institution || '?').charAt(0).toUpperCase()),
          el('span', {},
            el('strong', {}, c.institution),
            el('span', { class: 'hint block' }, KIND_LABEL[c.kind] || c.kind))),
        el('span', { class: `pill ${status[0]}` }, status[1]),
      ),
      el('p', { class: 'hint' }, `Opgehaald ${when(c.checkedAt)}` + (days != null ? ` · toestemming nog ${Math.max(days, 0)} dagen geldig` : '')),
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
}

function renderProviders() {
  const cfg = remote.config || {};
  const rows = [
    ['Enable Banking', 'Banken via open banking', cfg.enableBanking, 'EB_APP_ID, EB_PRIVATE_KEY'],
    ['Myfxbook', 'MetaTrader-brokers (gratis)', cfg.myfxbook, 'MYFXBOOK_EMAIL, MYFXBOOK_PASSWORD'],
    ['MetaApi', 'MetaTrader-brokers (betalend)', cfg.metaApi, 'METAAPI_TOKEN'],
  ];
  $('#providers').replaceChildren(...rows.map(([name, desc, ok, secrets]) => el('li', {},
    el('span', {}, el('strong', {}, name), el('span', { class: 'hint block' }, ok ? desc : `${desc} — secrets: ${secrets}`)),
    el('span', { class: `pill ${ok ? 'good' : 'muted'}` }, ok ? 'Ingesteld' : 'Niet ingesteld')
  )));
  $('#config-status').replaceChildren(
    cfg.redirectUrl ? el('span', {}, 'Redirect-URL voor Enable Banking: ', el('code', {}, cfg.redirectUrl)) : ''
  );
}

/* ---------- Instellingen ---------- */

function maskIban(iban) {
  return iban.length > 8 ? `${iban.slice(0, 4)} •••• ${iban.slice(-4)}` : iban;
}

async function removeConnection(c) {
  if (!confirm(`${c.institution} ontkoppelen?`)) return;
  try {
    applyRemote(await api(`/api/connections/${encodeURIComponent(c.id)}`, { method: 'DELETE' }));
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
        onclick: () => { delete state.rates[code]; save(); } }, '×')
    ));
  }
}

const round4 = n => Math.round(n * 10000) / 10000;

$('#btn-add-rate').addEventListener('click', () => {
  const code = $('#new-rate-code').value.trim().toUpperCase();
  if (!/^[A-Z]{3,5}$/.test(code) || state.rates[code]) return;
  state.rates[code] = 1;
  $('#new-rate-code').value = '';
  save();
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
  navigate('overzicht');
});

async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}
$('#btn-logout').addEventListener('click', logout);

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
  // Een jaar verloop per rekening, en wat voorbeeldtransacties.
  const now0 = Object.fromEntries(state.accounts.map(a => [a.id, eurValue(a)]));
  for (let i = 52; i >= 1; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i * 7);
    const byAccount = {};
    state.accounts.forEach((a, k) => {
      const trend = 1 - i * (0.002 + k * 0.0006);
      byAccount[a.id] = round2(now0[a.id] * Math.max(0.2, trend + Math.sin(i * (0.9 + k * 0.4)) * 0.03));
    });
    const net = round2(Object.values(byAccount).reduce((x, y) => x + y, 0));
    state.history.push({ date: todayISO(d), net, byType: {}, byAccount });
  }
  const [zicht, spaar, rev, ly, vt] = state.accounts;
  const tx = (acc, daysAgo, amount, label, cur = 'EUR') => state.manualTx.push({
    id: uid(), accountId: acc.id, date: new Date(Date.now() - daysAgo * 864e5).toISOString(), amount, currency: cur, label, kind: 'manual',
  });
  tx(zicht, 0.2, -42.1, 'Colruyt');
  tx(vt, 0.5, 64.3, 'Winst trade XAUUSD', 'USD');
  tx(zicht, 1, 500, 'Storting van spaarrekening');
  tx(spaar, 1, -500, 'Naar zichtrekening');
  tx(vt, 2, -18.75, 'Verlies trade EURUSD', 'USD');
  tx(rev, 3, -12.99, 'Spotify');
  tx(ly, 4, 300, 'Storting');
  tx(zicht, 6, 2150, 'Loon oktober');
  tx(vt, 8, 250, 'Storting', 'USD');
  tx(zicht, 9, -850, 'Huur');
  save();
}

$('#btn-demo').addEventListener('click', loadDemo);

/* ---------- Top bar ---------- */

$('#btn-add').addEventListener('click', openLinkChooser);
for (const b of document.querySelectorAll('.js-link')) b.addEventListener('click', openLinkChooser);
$('#tx-more').addEventListener('click', () => { txShown += 30; renderAllTransactions(allAccounts()); });
for (const b of document.querySelectorAll('.js-add-manual')) b.addEventListener('click', () => openAccountDialog());
$('#group-by').addEventListener('change', () => renderAccounts(allAccounts()));

// Eén gedeelde periode voor alle grafieken.
for (const seg of document.querySelectorAll('.js-range')) {
  seg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    chartRange = b.dataset.range;
    for (const x of document.querySelectorAll('.js-range button')) x.classList.toggle('active', x.dataset.range === chartRange);
    rerenderCharts();
  });
}

/** theme: 'light', 'dark' of null (volg het toestel). */
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
  const opt = document.documentElement.getAttribute('data-theme') || 'system';
  for (const b of $('#theme-seg').querySelectorAll('button')) b.classList.toggle('active', b.dataset.themeOpt === opt);
}
$('#theme-seg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  const opt = b.dataset.themeOpt;
  applyTheme(opt);
  try {
    if (opt === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, opt);
  } catch { /* */ }
  rerenderCharts();
});

function applyPrivacy(on) {
  document.body.classList.toggle('private', on);
  const b = $('#btn-privacy');
  b.setAttribute('aria-pressed', String(on));
  b.querySelector('.lbl').textContent = on ? 'Toon' : 'Verberg';
  $('#privacy-toggle').checked = on;
}
$('#privacy-toggle').addEventListener('change', e => {
  applyPrivacy(e.target.checked);
  try { localStorage.setItem(PRIVACY_KEY, e.target.checked ? '1' : '0'); } catch { /* */ }
});
$('#btn-privacy').addEventListener('click', () => {
  const on = !document.body.classList.contains('private');
  applyPrivacy(on);
  try { localStorage.setItem(PRIVACY_KEY, on ? '1' : '0'); } catch { /* */ }
});

/* ---------- Pagina's ---------- */

const PAGES = {
  overzicht: 'Overzicht',
  rekeningen: 'Rekeningen',
  rekening: 'Rekening',
  instellingen: 'Instellingen',
  koppelingen: 'Gekoppelde accounts',
};
// Subpagina's: welk menu-item oplicht en waar de terugknop naartoe gaat.
const PARENT = { rekening: 'rekeningen', koppelingen: 'instellingen' };
let route = 'overzicht';
let routeArg = null;

function parseHash() {
  const [r, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  if (!(r in PAGES)) return ['overzicht', null];
  let arg = rest.join('/') || null;
  try { arg = arg && decodeURIComponent(arg); } catch { /* */ }
  return [r, arg];
}

function navigate(r) {
  location.hash = r === 'overzicht' ? '#/' : `#/${r}`;
}

function showRoute() {
  const prev = `${route}/${routeArg}`;
  [route, routeArg] = parseHash();
  for (const p of document.querySelectorAll('.page')) p.hidden = p.dataset.page !== route;
  const navRoute = PARENT[route] || route;
  for (const a of document.querySelectorAll('.nav a')) {
    if (a.dataset.route === navRoute) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const parent = PARENT[route];
  $('#btn-back').hidden = !parent;
  $('#btn-back').href = parent ? `#/${parent}` : '#/';
  $('#topbar-logo').classList.toggle('gone', !!parent);
  $('#page-title').textContent = PAGES[route];
  document.title = route === 'overzicht' ? 'Mijn Vermogen' : `${PAGES[route]} – Mijn Vermogen`;
  // Grafieken meten hun breedte: pas tekenen als de pagina zichtbaar is.
  rerenderCharts();
  if (prev !== `${route}/${routeArg}`) window.scrollTo(0, 0);
}

window.addEventListener('hashchange', showRoute);

/* ---------- Init ---------- */

applyTheme(null);
try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* */ }
try { applyPrivacy(localStorage.getItem(PRIVACY_KEY) === '1'); } catch { /* */ }

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(rerenderCharts, 120);
});

// Terug van de bank?
const params = new URLSearchParams(location.search);
if (params.has('linked')) toast(`${params.get('linked')} gekoppeld ✔`);
if (params.has('link_error')) toast(`Koppelen mislukt: ${params.get('link_error')}`, true);
// Na het koppelen naar de pagina Koppelingen gaan.
if (params.has('linked') || params.has('link_error')) history.replaceState(null, '', `${location.pathname}#/koppelingen`);
showRoute();

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
