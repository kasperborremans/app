/* =========================================================
   Mijn Vermogen — Cloudflare Worker
   - Bewaart het dashboard (rekeningen, geschiedenis) in KV
   - Haalt automatisch saldi op:
       * banken via Enable Banking (PSD2): Argenta, Revolut, …
       * MetaTrader-accounts via Myfxbook (gratis) of MetaApi (VT Markets)
       * koersen via Yahoo Finance, wisselkoersen via ECB (Frankfurter)
   - Alles achter één wachtwoord
   ========================================================= */

import { signSession, verifySession, safeEqual, signJwtRS256 } from './crypto.js';

const EB_API = 'https://api.enablebanking.com';
const META_PROV = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai';
const metaClient = region => `https://mt-client-api-v1.${region}.agiliumtrade.ai`;
const MFX_API = 'https://www.myfxbook.com/api';

const COOKIE = 'mv_session';
// Zoveel recente transacties per rekening bewaren we (en tonen we in de app).
const MAX_TX = 60;
const TX_DAYS = 90;
const SESSION_DAYS = 30;
const MAX_LOGIN_FAILS = 10;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, ctx, url);
    } catch (e) {
      if (!e.status || e.status >= 500) console.error(e);
      return json({ error: e.message || 'Serverfout' }, e.status || 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshAll(env, null));
  },
};

/* ---------- Routing ---------- */

async function route(request, env, ctx, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/login' && method === 'POST') return login(request, env);
  if (pathname === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }
  // De bank stuurt de gebruiker hierheen terug; beveiligd via de eenmalige `state`.
  if (pathname === '/api/eb/callback' && method === 'GET') return ebCallback(url, env);

  if (!(await isAuthed(request, env))) return json({ error: 'Niet aangemeld' }, 401);

  if (pathname === '/api/state' && method === 'GET') return json(await snapshot(env, url.origin));
  if (pathname === '/api/state' && method === 'PUT') return putState(request, env);
  if (pathname === '/api/refresh' && method === 'POST') {
    await refreshAll(env, psuHeaders(request));
    return json(await snapshot(env, url.origin));
  }
  if (pathname === '/api/eb/aspsps' && method === 'GET') return ebAspsps(url, env);
  if (pathname === '/api/eb/start' && method === 'POST') return ebStart(request, env, url.origin);
  if (pathname === '/api/metaapi/add' && method === 'POST') return metaAdd(request, env, url.origin);
  if (pathname === '/api/myfxbook/add' && method === 'POST') return mfxAdd(env, url.origin);

  const m = pathname.match(/^\/api\/connections\/(.+)$/);
  if (m && method === 'DELETE') {
    const id = decodeURIComponent(m[1]);
    const conns = (await getJSON(env, 'connections', [])).filter(c => c.id !== id);
    await putJSON(env, 'connections', conns);
    return json(await snapshot(env, url.origin));
  }

  return json({ error: 'Niet gevonden' }, 404);
}

/* ---------- Auth ---------- */

async function login(request, env) {
  if (!env.DASHBOARD_PASSWORD || !env.SESSION_SECRET) {
    throw httpError(500, 'DASHBOARD_PASSWORD en SESSION_SECRET zijn nog niet ingesteld.');
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const failKey = `login-fail:${ip}`;
  const fails = Number(await env.KV.get(failKey)) || 0;
  if (fails >= MAX_LOGIN_FAILS) throw httpError(429, 'Te veel pogingen. Probeer het over een uur opnieuw.');

  const { password } = await readJSON(request);
  if (!(await safeEqual(String(password || ''), env.DASHBOARD_PASSWORD, env.SESSION_SECRET))) {
    await env.KV.put(failKey, String(fails + 1), { expirationTtl: 3600 });
    throw httpError(401, 'Fout wachtwoord.');
  }
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const token = await signSession({ exp }, env.SESSION_SECRET);
  return json({ ok: true }, 200, {
    'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
  });
}

async function isAuthed(request, env) {
  if (!env.SESSION_SECRET) return false;
  const cookie = request.headers.get('Cookie') || '';
  const token = cookie.split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token) return false;
  const payload = await verifySession(token, env.SESSION_SECRET);
  return !!payload && payload.exp > Date.now();
}

/* ---------- Dashboard state ---------- */

async function snapshot(env, origin) {
  const [stored, connections, prices, rates] = await Promise.all([
    getJSON(env, 'state', { rev: 0, state: null }),
    getJSON(env, 'connections', []),
    getJSON(env, 'prices', {}),
    getJSON(env, 'rates', null),
  ]);
  return {
    rev: stored.rev,
    state: stored.state,
    connections,
    prices,
    rates,
    config: {
      enableBanking: !!(env.EB_APP_ID && env.EB_PRIVATE_KEY),
      metaApi: !!env.METAAPI_TOKEN,
      myfxbook: !!(env.MYFXBOOK_EMAIL && env.MYFXBOOK_PASSWORD),
      redirectUrl: `${origin}/api/eb/callback`,
    },
  };
}

async function putState(request, env) {
  const body = await readJSON(request);
  if (!body.state || typeof body.state !== 'object') throw httpError(400, 'Ongeldige data.');
  const raw = JSON.stringify(body.state);
  if (raw.length > 5_000_000) throw httpError(413, 'Te veel data.');
  const stored = await getJSON(env, 'state', { rev: 0, state: null });
  if (typeof body.rev === 'number' && body.rev !== stored.rev) {
    throw httpError(409, 'Gegevens zijn intussen op een ander toestel gewijzigd.');
  }
  const rev = stored.rev + 1;
  await env.KV.put('state', JSON.stringify({ rev, state: body.state }));
  // Nieuwe tickers meteen van een koers voorzien.
  const prices = await getJSON(env, 'prices', {});
  if (symbolsIn(body.state).some(s => !prices[s])) await refreshPrices(env, body.state);
  return json({ rev, prices: await getJSON(env, 'prices', {}) });
}

/* ---------- Refresh ---------- */

async function refreshAll(env, psu) {
  const conns = await getJSON(env, 'connections', []);
  for (const c of conns) {
    try {
      if (c.kind === 'eb') await refreshEB(env, c, psu);
      else if (c.kind === 'metaapi') await refreshMeta(env, c);
      else if (c.kind === 'myfxbook') await refreshMfx(env, c);
      delete c.error;
    } catch (e) {
      c.error = String(e.message || e).slice(0, 300);
    }
    c.checkedAt = new Date().toISOString();
  }
  await putJSON(env, 'connections', conns);
  await Promise.allSettled([refreshRates(env), refreshPrices(env)]);
}

/* ---------- Enable Banking ---------- */

async function ebFetch(env, path, init = {}, psu = null) {
  if (!env.EB_APP_ID || !env.EB_PRIVATE_KEY) throw httpError(400, 'Enable Banking is nog niet ingesteld (EB_APP_ID / EB_PRIVATE_KEY).');
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJwtRS256(
    { typ: 'JWT', alg: 'RS256', kid: env.EB_APP_ID },
    { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 },
    env.EB_PRIVATE_KEY
  );
  const res = await fetch(EB_API + path, {
    ...init,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', ...(psu || {}), ...(init.headers || {}) },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data.message || data.error || data.detail || text.slice(0, 200);
    throw httpError(res.status === 401 ? 502 : res.status, `Enable Banking: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return data;
}

async function ebAspsps(url, env) {
  const country = (url.searchParams.get('country') || 'BE').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
  const data = await ebFetch(env, `/aspsps?country=${country}&psu_type=personal`);
  const list = (data.aspsps || []).map(a => ({ name: a.name, country: a.country, logo: a.logo || null }));
  return json({ aspsps: list });
}

async function ebStart(request, env, origin) {
  const { name, country } = await readJSON(request);
  if (!name || !country) throw httpError(400, 'Kies een bank.');
  const state = crypto.randomUUID();
  const validUntil = new Date(Date.now() + 179 * 864e5).toISOString();
  const data = await ebFetch(env, '/auth', {
    method: 'POST',
    body: JSON.stringify({
      access: { valid_until: validUntil },
      aspsp: { name, country },
      state,
      redirect_url: `${origin}/api/eb/callback`,
      psu_type: 'personal',
    }),
  }, psuHeaders(request));
  await env.KV.put(`ebpending:${state}`, JSON.stringify({ name, country }), { expirationTtl: 1800 });
  return json({ url: data.url });
}

async function ebCallback(url, env) {
  const back = (params) => Response.redirect(`${url.origin}/?${new URLSearchParams(params)}`, 302);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (!state) return back({ link_error: 'Ongeldige terugkeer van de bank.' });
  const pending = await getJSON(env, `ebpending:${state}`, null);
  if (!pending) return back({ link_error: 'Koppeling verlopen. Probeer opnieuw.' });
  await env.KV.delete(`ebpending:${state}`);
  if (err || !code) return back({ link_error: err || 'Koppeling geannuleerd.' });

  try {
    const session = await ebFetch(env, '/sessions', { method: 'POST', body: JSON.stringify({ code }) });
    const conns = await getJSON(env, 'connections', []);
    const id = `eb:${pending.country}:${pending.name}`;
    const old = conns.find(c => c.id === id);
    const conn = {
      id,
      kind: 'eb',
      institution: session.aspsp?.name || pending.name,
      aspsp: pending,
      sessionId: session.session_id,
      validUntil: session.access?.valid_until || null,
      accounts: (session.accounts || []).map(a => {
        const acc = typeof a === 'string' ? { uid: a } : a;
        const iban = acc.account_id?.iban || null;
        const prev = old?.accounts.find(x => (iban && x.iban === iban) || x.uid === acc.uid);
        return {
          uid: acc.uid,
          key: `eb:${iban || acc.uid}`,
          iban,
          name: acc.name || acc.product || acc.details || prev?.name || 'Rekening',
          currency: acc.currency || prev?.currency || 'EUR',
          balance: prev?.balance ?? null,
          updatedAt: prev?.updatedAt ?? null,
        };
      }),
    };
    await refreshEB(env, conn, null).catch(e => { conn.error = String(e.message).slice(0, 300); });
    conn.checkedAt = new Date().toISOString();
    await putJSON(env, 'connections', [...conns.filter(c => c.id !== id), conn]);
    return back({ linked: conn.institution });
  } catch (e) {
    return back({ link_error: String(e.message).slice(0, 200) });
  }
}

const BALANCE_PREFERENCE = ['CLBD', 'ITBD', 'XPCD', 'ITAV', 'CLAV', 'OPBD', 'PRCD'];

async function refreshEB(env, conn, psu) {
  if (conn.validUntil && new Date(conn.validUntil) < new Date()) {
    throw new Error('Toestemming bij de bank is verlopen. Koppel opnieuw.');
  }
  for (const acc of conn.accounts) {
    const data = await ebFetch(env, `/accounts/${encodeURIComponent(acc.uid)}/balances`, {}, psu);
    const balances = data.balances || [];
    const pick = BALANCE_PREFERENCE.map(t => balances.find(b => b.balance_type === t)).find(Boolean) || balances[0];
    if (!pick) continue;
    acc.balance = Number(pick.balance_amount.amount);
    acc.currency = pick.balance_amount.currency || acc.currency;
    acc.updatedAt = new Date().toISOString();
    await keepTx(acc, () => ebTransactions(env, acc, psu));
  }
}

/** Haalt de transacties op; een fout hierbij mag het saldo niet tegenhouden. */
async function keepTx(acc, load) {
  try {
    acc.transactions = (await load())
      .filter(t => t.date && Number.isFinite(t.amount) && t.amount !== 0)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, MAX_TX);
    delete acc.txError;
  } catch (e) {
    acc.txError = String(e.message || e).slice(0, 200);
  }
}

const isoDaysAgo = days => new Date(Date.now() - days * 864e5).toISOString();

async function ebTransactions(env, acc, psu) {
  const from = isoDaysAgo(TX_DAYS).slice(0, 10);
  const data = await ebFetch(env, `/accounts/${encodeURIComponent(acc.uid)}/transactions?date_from=${from}`, {}, psu);
  return (data.transactions || []).map(t => {
    const amount = Number(t.transaction_amount?.amount) || 0;
    const credit = t.credit_debit_indicator === 'CRDT';
    const party = credit ? t.debtor?.name : t.creditor?.name;
    const info = Array.isArray(t.remittance_information) ? t.remittance_information.join(' ') : t.remittance_information;
    const day = t.booking_date || t.value_date || t.transaction_date;
    return {
      id: String(t.entry_reference || t.transaction_id || `${day}:${amount}:${info || ''}`),
      date: day ? new Date(`${day}T12:00:00Z`).toISOString() : null,
      amount: credit ? Math.abs(amount) : -Math.abs(amount),
      currency: t.transaction_amount?.currency || acc.currency,
      label: String(party || info || (credit ? 'Ontvangen' : 'Betaling')).replace(/\s+/g, ' ').trim().slice(0, 120),
      detail: party && info ? String(info).replace(/\s+/g, ' ').trim().slice(0, 160) : undefined,
      kind: credit ? 'in' : 'out',
      pending: t.status === 'PDNG' || undefined,
    };
  });
}

/* ---------- MetaApi (MetaTrader / VT Markets) ---------- */

async function metaFetch(env, url) {
  if (!env.METAAPI_TOKEN) throw httpError(400, 'MetaApi is nog niet ingesteld (METAAPI_TOKEN).');
  const res = await fetch(url, { headers: { 'auth-token': env.METAAPI_TOKEN, Accept: 'application/json' } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw httpError(res.status === 401 ? 502 : res.status, `MetaApi: ${data.message || text.slice(0, 200)}`);
  return data;
}

async function metaAdd(request, env, origin) {
  const { accountId } = await readJSON(request);
  const id = String(accountId || '').trim();
  if (!/^[\w-]{8,64}$/.test(id)) throw httpError(400, 'Ongeldig MetaApi account-ID.');
  const info = await metaFetch(env, `${META_PROV}/users/current/accounts/${id}`);
  const conn = {
    id: `meta:${id}`,
    kind: 'metaapi',
    institution: info.server ? `MetaTrader · ${info.server}` : 'MetaTrader',
    accountId: id,
    region: info.region || 'new-york',
    accounts: [{
      key: `meta:${id}`,
      name: info.name || `Account ${info.login || ''}`.trim(),
      currency: 'USD',
      balance: null,
      updatedAt: null,
    }],
  };
  try { await refreshMeta(env, conn); } catch (e) { conn.error = String(e.message).slice(0, 300); }
  conn.checkedAt = new Date().toISOString();
  const conns = await getJSON(env, 'connections', []);
  await putJSON(env, 'connections', [...conns.filter(c => c.id !== conn.id), conn]);
  return json(await snapshot(env, origin));
}

async function refreshMeta(env, conn) {
  const info = await metaFetch(env, `${metaClient(conn.region)}/users/current/accounts/${conn.accountId}/account-information`);
  const acc = conn.accounts[0];
  // Equity = saldo + open winst/verlies: wat het account nu echt waard is.
  acc.balance = Number(info.equity ?? info.balance);
  acc.cashBalance = Number(info.balance);
  // Bonus/credit van de broker: zit in de equity, maar is geen eigen geld.
  acc.credit = Number(info.credit) || 0;
  acc.currency = info.currency || acc.currency;
  acc.server = info.server || acc.server || null;
  if (info.broker) conn.institution = info.broker;
  acc.updatedAt = new Date().toISOString();
  await keepTx(acc, async () => {
    const url = `${metaClient(conn.region)}/users/current/accounts/${conn.accountId}/history-deals/time/${isoDaysAgo(TX_DAYS)}/${new Date().toISOString()}`;
    const deals = await metaFetch(env, url);
    return (Array.isArray(deals) ? deals : []).map(metaDealTx).filter(Boolean);
  });
}

/** Stortingen/opnames en het resultaat van gesloten trades; bonus (credit) en openingen tellen niet. */
function metaDealTx(d) {
  const amount = (Number(d.profit) || 0) + (Number(d.commission) || 0) + (Number(d.swap) || 0);
  const date = d.time ? new Date(d.time).toISOString() : null;
  if (d.type === 'DEAL_TYPE_BALANCE') {
    return { id: String(d.id), date, amount, label: amount >= 0 ? 'Storting' : 'Opname', detail: d.comment || undefined, kind: amount >= 0 ? 'deposit' : 'withdrawal' };
  }
  if ((d.type === 'DEAL_TYPE_BUY' || d.type === 'DEAL_TYPE_SELL') && /OUT/.test(d.entryType || '')) {
    return { id: String(d.id), date, amount, label: `${amount >= 0 ? 'Winst' : 'Verlies'} trade ${d.symbol || ''}`.trim(), detail: d.volume ? `${d.volume} lot` : undefined, kind: 'trade' };
  }
  return null;
}

/* ---------- Myfxbook (gratis alternatief voor MetaApi) ---------- */

async function mfxCall(env, method, params) {
  const res = await fetch(`${MFX_API}/${method}.json?${new URLSearchParams(params)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MijnVermogen/1.0)', Accept: 'application/json' },
  });
  if (!res.ok) throw httpError(502, `Myfxbook: ${res.status}`);
  return res.json();
}

/** Roept een Myfxbook-methode aan met een (hergebruikte) sessie; meldt opnieuw aan als die verlopen is. */
async function mfxGet(env, method, params = {}) {
  if (!env.MYFXBOOK_EMAIL || !env.MYFXBOOK_PASSWORD) {
    throw httpError(400, 'Myfxbook is nog niet ingesteld (MYFXBOOK_EMAIL / MYFXBOOK_PASSWORD).');
  }
  // Sessie hergebruiken: de gratis API laat 100 verzoeken per dag toe.
  let session = await env.KV.get('mfx-session');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session) {
      const login = await mfxCall(env, 'login', { email: env.MYFXBOOK_EMAIL, password: env.MYFXBOOK_PASSWORD });
      if (login.error || !login.session) throw httpError(502, `Myfxbook-login mislukt: ${login.message || 'onbekende fout'}`);
      try { session = decodeURIComponent(login.session); } catch { session = login.session; }
      await env.KV.put('mfx-session', session, { expirationTtl: 30 * 86400 });
    }
    const data = await mfxCall(env, method, { session, ...params });
    if (!data.error) return data;
    if (!/session/i.test(data.message || '')) throw httpError(502, `Myfxbook: ${data.message}`);
    await env.KV.delete('mfx-session');
    session = null;
  }
  throw httpError(502, 'Myfxbook: sessie ongeldig.');
}

async function mfxAccounts(env) {
  return (await mfxGet(env, 'get-my-accounts')).accounts || [];
}

/** Som van de winst/verlies van alle open trades; null als dat niet op te halen is. */
async function mfxOpenProfit(env, id) {
  try {
    const data = await mfxGet(env, 'get-open-trades', { id });
    return (data.openTrades || []).reduce((s, t) => s + (Number(t.profit) || 0), 0);
  } catch {
    return null;
  }
}

function mfxInstitution(accounts) {
  const server = accounts.map(a => a.server?.name || '').find(Boolean) || '';
  if (/vt\s*markets/i.test(server)) return 'VT Markets';
  return server ? server.replace(/[-_ ]*(live|real|demo)\b.*$/i, '') || 'Myfxbook' : 'Myfxbook';
}

async function mfxAdd(env, origin) {
  const conn = { id: 'mfx', kind: 'myfxbook', institution: 'Myfxbook', accounts: [] };
  await refreshMfx(env, conn);
  if (!conn.accounts.length) throw httpError(400, 'Geen accounts gevonden op Myfxbook. Voeg eerst je VT Markets-account toe op myfxbook.com.');
  conn.checkedAt = new Date().toISOString();
  const conns = await getJSON(env, 'connections', []);
  await putJSON(env, 'connections', [...conns.filter(c => c.id !== conn.id), conn]);
  return json(await snapshot(env, origin));
}

async function refreshMfx(env, conn) {
  const accounts = await mfxAccounts(env);
  conn.institution = mfxInstitution(accounts);
  const previous = new Map((conn.accounts || []).map(a => [a.key, a]));
  // Open winst/verlies apart ophalen: equity = saldo + credit + open winst/verlies,
  // dus zonder dit getal is de credit (bonus) niet van de open winst te onderscheiden.
  const openProfit = await Promise.all(accounts.map(a => (a.demo ? null : mfxOpenProfit(env, a.id))));
  conn.accounts = accounts.map((a, i) => ({
    key: `mfx:${a.id}`,
    name: a.name || `Account ${a.accountId || a.id}`,
    // Equity zoals de broker die toont (inclusief credit/bonus).
    balance: Number(a.equity ?? a.balance),
    // Saldo in MetaTrader: hier zit de credit nooit in.
    cashBalance: Number(a.balance),
    openProfit: openProfit[i],
    credit: a.credit != null ? Number(a.credit) || 0 : null,
    // Stortingen/opnames: nodig om de bonus (een % van de stortingen) te berekenen.
    deposits: a.deposits != null ? Number(a.deposits) || 0 : null,
    withdrawals: Number(a.withdrawals) || 0,
    currency: a.currency || 'USD',
    server: a.server?.name || null,
    demo: !!a.demo,
    updatedAt: a.lastUpdateDate ? parseMfxDate(a.lastUpdateDate) : new Date().toISOString(),
    mfxId: a.id,
  }));
  // De gratis API laat 100 verzoeken per dag toe: enkel echte accounts, demo's overslaan.
  for (const acc of conn.accounts) {
    const prev = previous.get(acc.key);
    if (prev?.transactions) acc.transactions = prev.transactions;
    if (acc.demo) continue;
    await keepTx(acc, async () => {
      const data = await mfxGet(env, 'get-history', { id: acc.mfxId });
      return (data.history || []).map(h => mfxHistoryTx(h, acc.currency)).filter(Boolean);
    });
  }
}

function mfxHistoryTx(h, currency) {
  const action = String(h.action || '');
  const amount = (Number(h.profit) || 0) + (Number(h.interest) || 0) + (Number(h.commission) || 0);
  const date = parseMfxDate(h.closeTime || h.openTime);
  const id = `${h.openTime}|${h.closeTime}|${action}|${h.symbol || ''}|${h.profit}`;
  if (/deposit|withdraw/i.test(action)) {
    const isIn = amount >= 0;
    return { id, date, amount, currency, label: isIn ? 'Storting' : 'Opname', detail: h.comment || undefined, kind: isIn ? 'deposit' : 'withdrawal' };
  }
  if (/^(buy|sell)$/i.test(action) && h.symbol) {
    return { id, date, amount, currency, label: `${amount >= 0 ? 'Winst' : 'Verlies'} trade ${h.symbol}`, detail: h.sizing?.value ? `${action} ${h.sizing.value} lot` : action, kind: 'trade' };
  }
  return null; // bonus (credit) e.d. is geen eigen geld
}

/** Myfxbook geeft datums als "MM/dd/yyyy HH:mm". */
function parseMfxDate(s) {
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?/);
  if (!m) return new Date().toISOString();
  return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0))).toISOString();
}

/* ---------- Koersen & wisselkoersen ---------- */

function symbolsIn(state) {
  const out = new Set();
  for (const a of state?.accounts || []) for (const h of a.holdings || []) {
    const s = String(h.symbol || '').trim().toUpperCase();
    if (/^[A-Z0-9^=.\-]{1,20}$/.test(s)) out.add(s);
  }
  return [...out];
}

async function refreshPrices(env, stateOverride = null) {
  const state = stateOverride || (await getJSON(env, 'state', { state: null })).state;
  const symbols = symbolsIn(state);
  const prices = await getJSON(env, 'prices', {});
  await Promise.allSettled(symbols.map(async s => {
    try { prices[s] = await fetchYahoo(s); } catch (e) {
      // Onthoud de fout, zodat niet bij elke opslag opnieuw wordt geprobeerd.
      if (!prices[s]?.price) prices[s] = { error: String(e.message).slice(0, 100), at: new Date().toISOString() };
    }
  }));
  for (const s of Object.keys(prices)) if (!symbols.includes(s)) delete prices[s];
  await putJSON(env, 'prices', prices);
}

async function fetchYahoo(s) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1d&interval=1d`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MijnVermogen/1.0)', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${s}: ${res.status}`);
  const meta = (await res.json())?.chart?.result?.[0]?.meta;
  let price = Number(meta?.regularMarketPrice);
  let currency = meta?.currency || 'EUR';
  if (!(price > 0)) throw new Error(`${s}: geen koers`);
  // Londense noteringen staan in pence.
  if (currency === 'GBp' || currency === 'GBX') { price /= 100; currency = 'GBP'; }
  return { price, currency, at: new Date().toISOString() };
}

async function refreshRates(env) {
  const res = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR');
  if (!res.ok) throw new Error(`Wisselkoersen: ${res.status}`);
  const data = await res.json();
  // Opslaan als "1 eenheid vreemde munt = x euro".
  const rates = { EUR: 1 };
  for (const [cur, perEur] of Object.entries(data.rates || {})) if (perEur > 0) rates[cur] = 1 / perEur;
  await putJSON(env, 'rates', { rates, date: data.date, at: new Date().toISOString() });
}

/* ---------- Helpers ---------- */

function psuHeaders(request) {
  // Gebruiker is zelf aanwezig: banken tellen dit niet mee in de limiet van 4 automatische opvragingen per dag.
  const h = {};
  const ip = request.headers.get('CF-Connecting-IP');
  const ua = request.headers.get('User-Agent');
  if (ip) h['Psu-Ip-Address'] = ip;
  if (ua) h['Psu-User-Agent'] = ua.slice(0, 200);
  return h;
}

async function getJSON(env, key, fallback) {
  const v = await env.KV.get(key, 'json');
  return v ?? fallback;
}

function putJSON(env, key, value) {
  return env.KV.put(key, JSON.stringify(value));
}

async function readJSON(request) {
  try { return await request.json(); } catch { throw httpError(400, 'Ongeldige JSON.'); }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
