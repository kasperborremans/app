'use strict';

/* =========================================================
   Mijn Vermogen — persoonlijk vermogensdashboard
   Alle data blijft lokaal in localStorage.
   ========================================================= */

const STORAGE_KEY = 'mijn-vermogen-v1';
const THEME_KEY = 'mijn-vermogen-theme';
const PRIVACY_KEY = 'mijn-vermogen-private';

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
  return { version: 1, rates: { ...DEFAULT_RATES }, accounts: [], history: [] };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    return normalizeState(JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

function normalizeState(s) {
  const base = emptyState();
  if (!s || typeof s !== 'object') return base;
  return {
    version: 1,
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
        name: String(h.name || ''),
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
  };
}

let state = loadState();

function save() {
  recordSnapshot();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* opslag niet beschikbaar */ }
  render();
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/* ---------- Calculations ---------- */

function rate(cur) {
  const r = state.rates[cur];
  return typeof r === 'number' && r > 0 ? r : 1;
}

function holdingsValue(acc) {
  return acc.holdings.reduce((s, h) => s + h.qty * h.price, 0);
}

/** Waarde in de eigen munt van de rekening (positief). */
function nativeValue(acc) {
  return acc.balance + (TYPE[acc.type].holdings ? holdingsValue(acc) : 0);
}

/** Waarde in EUR, met teken (schulden negatief). */
function eurValue(acc) {
  const v = nativeValue(acc) * rate(acc.currency);
  return TYPE[acc.type].negative ? -Math.abs(v) : v;
}

function totals() {
  const byType = {};
  let assets = 0, debts = 0;
  for (const a of state.accounts) {
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

function recordSnapshot() {
  const t = totals();
  const date = todayISO();
  const snap = { date, net: round2(t.net), byType: Object.fromEntries(Object.entries(t.byType).map(([k, v]) => [k, round2(v)])) };
  const last = state.history[state.history.length - 1];
  if (last && last.date === date) state.history[state.history.length - 1] = snap;
  else state.history.push(snap);
}

const round2 = n => Math.round(n * 100) / 100;

/* ---------- Formatting ---------- */

const fmtEUR = new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmtEUR2 = new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = new Intl.NumberFormat('nl-BE', { style: 'percent', maximumFractionDigits: 1 });
const fmtDate = new Intl.DateTimeFormat('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateShort = new Intl.DateTimeFormat('nl-BE', { day: 'numeric', month: 'short' });
const fmtMonth = new Intl.DateTimeFormat('nl-BE', { month: 'short', year: '2-digit' });

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

/* ---------- Render ---------- */

function render() {
  const t = totals();
  const hasAccounts = state.accounts.length > 0;

  $('#empty-state').hidden = hasAccounts;
  $('#dashboard').hidden = !hasAccounts;

  $('#net-worth').textContent = money(t.net);
  $('#assets-total').textContent = money(t.assets);
  $('#debts-total').textContent = money(t.debts);
  $('#account-count').textContent = state.accounts.length;
  renderDelta(t.net);

  if (!hasAccounts) return;
  renderTiles(t);
  renderAllocation(t);
  renderInstitutions();
  renderHistory();
  renderAccounts();
}

function renderDelta(net) {
  const box = $('#net-delta');
  box.replaceChildren();
  const today = todayISO();
  const prev = [...state.history].reverse().find(h => h.date < today);
  if (!prev) {
    box.textContent = state.accounts.length ? 'Eerste momentopname van vandaag.' : '';
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

function renderTiles(t) {
  const box = $('#tiles');
  box.replaceChildren();
  for (const type of TYPES) {
    const accs = state.accounts.filter(a => a.type === type.id);
    if (!accs.length) continue;
    const v = t.byType[type.id] || 0;
    box.append(el('div', { class: 'tile' },
      el('div', { class: 'tile-head' }, el('span', { class: 'swatch', style: `background:${type.color}` }), type.label),
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

function renderInstitutions() {
  const box = $('#inst-bars');
  box.replaceChildren();
  const map = new Map();
  for (const a of state.accounts) {
    const k = a.institution || '—';
    map.set(k, (map.get(k) || 0) + eurValue(a));
  }
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(...rows.map(r => Math.abs(r[1])), 1);
  for (const [name, v] of rows) {
    const fill = el('div', { class: 'fill' + (v < 0 ? ' neg' : ''), style: `width:${(Math.abs(v) / max) * 100}%` });
    const li = el('li', {},
      el('span', { class: 'name', title: name }, name),
      el('div', { class: 'track' }, fill),
      el('span', { class: 'money' + (v < 0 ? ' neg-val' : '') }, money(v))
    );
    box.append(li);
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
  chart.append(svg('path', { class: 'area', d: `${line}L${pts[pts.length - 1][0]},${base}L${pts[0][0]},${base}Z` }));
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

function renderAccounts() {
  const box = $('#accounts');
  box.replaceChildren();
  const mode = $('#group-by').value;
  const groups = new Map();
  if (mode === 'type') {
    for (const t of TYPES) groups.set(t.id, []);
    for (const a of state.accounts) groups.get(a.type).push(a);
  } else {
    for (const a of [...state.accounts].sort((x, y) => x.institution.localeCompare(y.institution))) {
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
    TYPE[a.type].holdings && a.holdings.length ? `${a.holdings.length} ${a.holdings.length === 1 ? 'positie' : 'posities'}` : null,
    `bijgewerkt ${fmtDate.format(new Date(a.updatedAt))}`,
    a.note || null,
  ].filter(Boolean).join(' · ');
  const row = el('div', { class: 'acc', tabindex: '0', role: 'button', 'aria-label': `${a.name} bewerken` },
    el('div', {},
      el('div', { class: 'acc-name' }, a.name),
      el('div', { class: 'acc-sub' }, sub)
    ),
    el('div', {},
      el('div', { class: 'acc-value money' + (v < 0 ? ' neg-val' : '') }, money(v, true)),
      a.currency !== 'EUR' ? el('div', { class: 'acc-orig money' }, moneyIn(nativeValue(a), a.currency)) : null
    ),
    el('span', { class: 'acc-edit' }, 'Bewerk ›')
  );
  row.addEventListener('click', () => openAccountDialog(a.id));
  row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAccountDialog(a.id); } });
  return row;
}

/* ---------- Account dialog ---------- */

const dlg = $('#account-dialog');
const form = $('#account-form');
let editingId = null;
let draftHoldings = [];

function fillSelects() {
  $('#type-select').replaceChildren(...TYPES.map(t => el('option', { value: t.id }, t.label)));
  $('#currency-select').replaceChildren(...Object.keys(state.rates).map(c => el('option', { value: c }, c)));
  const insts = [...new Set(state.accounts.map(a => a.institution).filter(Boolean))].sort();
  $('#institutions').replaceChildren(...insts.map(i => el('option', { value: i })));
}

function openAccountDialog(id = null) {
  fillSelects();
  editingId = id;
  const a = id ? state.accounts.find(x => x.id === id) : null;
  $('#account-dialog-title').textContent = a ? 'Rekening bewerken' : 'Rekening toevoegen';
  $('#btn-delete').hidden = !a;
  form.name.value = a ? a.name : '';
  form.institution.value = a ? a.institution : '';
  form.type.value = a ? a.type : 'bank';
  form.currency.value = a ? a.currency : 'EUR';
  form.balance.value = a ? a.balance : 0;
  form.note.value = a ? a.note : '';
  draftHoldings = a ? a.holdings.map(h => ({ ...h })) : [];
  syncTypeUI();
  renderHoldings();
  dlg.showModal();
  form.name.focus();
}

function syncTypeUI() {
  const t = TYPE[form.type.value];
  $('#holdings-section').hidden = !t.holdings;
  $('#balance-label').firstChild.textContent = t.negative ? 'Openstaand bedrag'
    : t.holdings ? 'Cash op rekening' : 'Saldo';
}

function renderHoldings() {
  const box = $('#holdings');
  box.replaceChildren();
  if (!draftHoldings.length) {
    box.append(el('p', { class: 'hint' }, 'Nog geen posities. Je kan ook gewoon het totaal als cash invullen.'));
    return;
  }
  for (const h of draftHoldings) {
    const valueEl = el('span', { class: 'h-value money' }, moneyIn(h.qty * h.price, form.currency.value));
    const update = () => { valueEl.textContent = moneyIn(h.qty * h.price, form.currency.value); };
    box.append(el('div', { class: 'holding' },
      el('input', { class: 'h-name', value: h.name, placeholder: 'bv. VWCE', 'aria-label': 'Naam',
        oninput: e => { h.name = e.target.value; } }),
      el('input', { type: 'number', step: 'any', value: h.qty, 'aria-label': 'Aantal',
        oninput: e => { h.qty = Number(e.target.value) || 0; update(); } }),
      el('input', { type: 'number', step: 'any', value: h.price, 'aria-label': 'Koers',
        oninput: e => { h.price = Number(e.target.value) || 0; update(); } }),
      valueEl,
      el('button', { type: 'button', class: 'remove', title: 'Verwijder positie', 'aria-label': 'Verwijder positie',
        onclick: () => { draftHoldings = draftHoldings.filter(x => x !== h); renderHoldings(); } }, '×')
    ));
  }
}

form.type.addEventListener('change', syncTypeUI);
form.currency.addEventListener('change', renderHoldings);
$('#btn-add-holding').addEventListener('click', () => {
  draftHoldings.push({ id: uid(), name: '', qty: 0, price: 0 });
  renderHoldings();
  const inputs = $('#holdings').querySelectorAll('.h-name');
  inputs[inputs.length - 1]?.focus();
});
$('#btn-cancel').addEventListener('click', () => dlg.close());
$('#btn-delete').addEventListener('click', () => {
  const a = state.accounts.find(x => x.id === editingId);
  if (a && confirm(`"${a.name}" verwijderen?`)) {
    state.accounts = state.accounts.filter(x => x.id !== editingId);
    dlg.close();
    save();
  }
});

form.addEventListener('submit', e => {
  e.preventDefault();
  const type = form.type.value;
  const data = {
    name: form.name.value.trim() || 'Rekening',
    institution: form.institution.value.trim(),
    type,
    currency: form.currency.value,
    balance: TYPE[type].negative ? Math.abs(Number(form.balance.value) || 0) : Number(form.balance.value) || 0,
    holdings: TYPE[type].holdings ? draftHoldings.filter(h => h.name || h.qty || h.price) : [],
    note: form.note.value.trim(),
    updatedAt: new Date().toISOString(),
  };
  if (editingId) {
    Object.assign(state.accounts.find(x => x.id === editingId), data);
  } else {
    state.accounts.push({ id: uid(), ...data });
  }
  dlg.close();
  save();
});

/* ---------- Settings ---------- */

const sdlg = $('#settings-dialog');

function renderRates() {
  const box = $('#rates');
  box.replaceChildren();
  for (const [code, r] of Object.entries(state.rates)) {
    if (code === 'EUR') continue;
    const inUse = state.accounts.some(a => a.currency === code);
    box.append(el('div', { class: 'rate-row' },
      el('strong', {}, code),
      el('input', { type: 'number', step: 'any', min: '0', value: r, 'aria-label': `Koers ${code}`,
        onchange: e => { const v = Number(e.target.value); if (v > 0) { state.rates[code] = v; save(); } } }),
      el('button', { type: 'button', class: 'remove', title: inUse ? 'In gebruik' : 'Verwijder', disabled: inUse ? '' : false,
        onclick: () => { delete state.rates[code]; save(); renderRates(); } }, '×')
    ));
  }
}

$('#btn-settings').addEventListener('click', () => { renderRates(); sdlg.showModal(); });
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
  if (!confirm('Alle rekeningen en geschiedenis wissen? Dit kan niet ongedaan worden.')) return;
  state = emptyState();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* */ }
  render();
  sdlg.close();
});

/* ---------- Demo data ---------- */

function loadDemo() {
  if (state.accounts.length && !confirm('Huidige gegevens vervangen door demo-data?')) return;
  const now = new Date().toISOString();
  const acc = (name, institution, type, balance, extra = {}) =>
    ({ id: uid(), name, institution, type, currency: 'EUR', balance, holdings: [], note: '', updatedAt: now, ...extra });
  const h = (name, qty, price) => ({ id: uid(), name, qty, price });
  state = emptyState();
  state.accounts = [
    acc('Zichtrekening', 'KBC', 'bank', 2840.55),
    acc('Spaarrekening', 'KBC', 'savings', 12500),
    acc('Zichtrekening', 'Argenta', 'bank', 615.2),
    acc('Spaarrekening', 'Argenta', 'savings', 8200),
    acc('Beleggingsrekening', 'Bolero', 'broker', 340, { holdings: [h('IWDA', 85, 104.2), h('EMIM', 60, 33.9)] }),
    acc('Effectenrekening', 'DEGIRO', 'broker', 125.4, { holdings: [h('VWCE', 42, 138.5), h('ASML', 3, 712)] }),
    acc('Brokerage', 'Interactive Brokers', 'broker', 210, { currency: 'USD', holdings: [h('AAPL', 10, 247), h('MSFT', 5, 512)] }),
    acc('Wallet', 'Bitvavo', 'crypto', 0, { holdings: [h('BTC', 0.045, 92000), h('ETH', 0.6, 3300)] }),
    acc('Pensioenspaarfonds', 'Argenta', 'pension', 9450),
    acc('Autolening', 'KBC', 'debt', 6800),
  ];
  // Fictieve geschiedenis van 12 maanden
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
$('#btn-demo-2').addEventListener('click', () => { loadDemo(); sdlg.close(); });

/* ---------- Top bar ---------- */

$('#btn-add').addEventListener('click', () => openAccountDialog());
$('#btn-add-empty').addEventListener('click', () => openAccountDialog());
$('#group-by').addEventListener('change', renderAccounts);

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
  b.textContent = on ? '👁 Toon' : '👁 Verberg';
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
  resizeTimer = setTimeout(() => { if (state.accounts.length) renderHistory(); }, 120);
});

if (state.accounts.length) {
  // Werk de momentopname van vandaag bij (bv. bij nieuwe wisselkoersen).
  recordSnapshot();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* */ }
}
render();
