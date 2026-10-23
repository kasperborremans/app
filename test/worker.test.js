import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/index.js';

const ORIGIN = 'https://vermogen.example.workers.dev';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function makeEnv(extra = {}) {
  const store = new Map();
  return {
    DASHBOARD_PASSWORD: 'geheim-wachtwoord',
    SESSION_SECRET: 'sessie-secret',
    EB_APP_ID: 'app-123',
    EB_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    METAAPI_TOKEN: 'meta-token',
    KV: {
      async get(k, type) { const v = store.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
      async put(k, v) { store.set(k, v); },
      async delete(k) { store.delete(k); },
    },
    ASSETS: { fetch: () => new Response('static') },
    ...extra,
  };
}

// Nagebootste externe API's
const calls = [];
beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, init });
    const ok = body => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('finance.yahoo.com')) {
      if (url.includes('VWCE.DE')) return ok({ chart: { result: [{ meta: { regularMarketPrice: 140.5, currency: 'EUR' } }] } });
      if (url.includes('VUSA.L')) return ok({ chart: { result: [{ meta: { regularMarketPrice: 9050, currency: 'GBp' } }] } });
      return new Response('{"chart":{"result":null}}', { status: 404 });
    }
    if (url.includes('frankfurter')) return ok({ base: 'EUR', date: '2026-10-16', rates: { USD: 1.25 } });
    if (url.startsWith('https://api.enablebanking.com/auth')) return ok({ url: 'https://bank.example/login' });
    if (url.startsWith('https://api.enablebanking.com/sessions')) return ok({
      session_id: 'sess-1', aspsp: { name: 'Argenta', country: 'BE' }, access: { valid_until: '2027-04-15T00:00:00Z' },
      accounts: [{ uid: 'uid-1', account_id: { iban: 'BE68539007547034' }, name: 'Zichtrekening', currency: 'EUR' }],
    });
    if (url.includes('/accounts/uid-1/balances')) return ok({ balances: [
      { balance_type: 'ITAV', balance_amount: { amount: '999.00', currency: 'EUR' } },
      { balance_type: 'CLBD', balance_amount: { amount: '1234.56', currency: 'EUR' } },
    ] });
    if (url.includes('/accounts/uid-1/transactions')) return ok({ transactions: [
      { entry_reference: 't1', transaction_amount: { amount: '250.00', currency: 'EUR' }, credit_debit_indicator: 'CRDT', booking_date: '2026-10-15', debtor: { name: 'Werkgever NV' }, remittance_information: ['Loon oktober'], status: 'BOOK' },
      { entry_reference: 't2', transaction_amount: { amount: '42.10', currency: 'EUR' }, credit_debit_indicator: 'DBIT', booking_date: '2026-10-16', creditor: { name: 'Colruyt' }, status: 'BOOK' },
    ] });
    if (url.includes('history-deals')) return ok([
      { id: 'd1', type: 'DEAL_TYPE_BALANCE', profit: 500, time: '2026-10-01T10:00:00Z' },
      { id: 'd2', type: 'DEAL_TYPE_BUY', entryType: 'DEAL_ENTRY_IN', symbol: 'XAUUSD', profit: 0, time: '2026-10-02T10:00:00Z' },
      { id: 'd3', type: 'DEAL_TYPE_SELL', entryType: 'DEAL_ENTRY_OUT', symbol: 'XAUUSD', profit: 80, commission: -3, swap: -1, time: '2026-10-03T10:00:00Z' },
      { id: 'd4', type: 'DEAL_TYPE_CREDIT', profit: 100, time: '2026-10-01T10:00:00Z' },
    ]);
    if (url.startsWith('https://api.enablebanking.com/aspsps')) return ok({ aspsps: [{ name: 'Argenta', country: 'BE', logo: 'x.png' }] });
    if (url.includes('mt-provisioning-api')) return ok({ name: 'VT live', login: 123, server: 'VTMarkets-Live', region: 'london' });
    if (url.includes('mt-client-api-v1.london')) return ok({ broker: 'VT Markets', currency: 'USD', balance: 2000, equity: 2100.5, credit: 400 });
    throw new Error(`onverwachte fetch: ${url}`);
  };
});

async function call(env, path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const req = new Request(ORIGIN + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { res, data };
}

async function login(env) {
  const { res } = await call(env, '/api/login', { method: 'POST', body: { password: 'geheim-wachtwoord' } });
  assert.equal(res.status, 200);
  return res.headers.get('Set-Cookie').split(';')[0];
}

const runCron = env => new Promise(resolve => worker.scheduled({}, env, { waitUntil: p => p.then(resolve) }));

test('API vereist login; fout wachtwoord wordt geweigerd en beperkt', async () => {
  const env = makeEnv();
  assert.equal((await call(env, '/api/state')).res.status, 401);
  for (let i = 0; i < 10; i++) {
    assert.equal((await call(env, '/api/login', { method: 'POST', body: { password: 'fout' } })).res.status, 401);
  }
  assert.equal((await call(env, '/api/login', { method: 'POST', body: { password: 'geheim-wachtwoord' } })).res.status, 429);
});

test('state opslaan met revisies en automatische koersen', async () => {
  const env = makeEnv();
  const cookie = await login(env);
  const state = { accounts: [{ id: 'a', type: 'broker', holdings: [{ symbol: 'VWCE.DE', qty: 2 }, { symbol: 'VUSA.L', qty: 1 }, { symbol: 'ONBEKEND', qty: 1 }] }] };
  const put = await call(env, '/api/state', { method: 'PUT', cookie, body: { rev: 0, state } });
  assert.equal(put.data.rev, 1);
  assert.equal(put.data.prices['VWCE.DE'].price, 140.5);
  assert.deepEqual([put.data.prices['VUSA.L'].price, put.data.prices['VUSA.L'].currency], [90.5, 'GBP']);
  assert.ok(put.data.prices.ONBEKEND.error);

  // Tweede opslag met bekende tickers vraagt geen koersen opnieuw op.
  calls.length = 0;
  await call(env, '/api/state', { method: 'PUT', cookie, body: { rev: 1, state } });
  assert.equal(calls.length, 0);

  assert.equal((await call(env, '/api/state', { method: 'PUT', cookie, body: { rev: 0, state } })).res.status, 409);
});

test('Enable Banking: koppelen, callback, saldo en cron', async () => {
  const env = makeEnv();
  const cookie = await login(env);

  const banks = await call(env, '/api/eb/aspsps?country=be', { cookie });
  assert.equal(banks.data.aspsps[0].name, 'Argenta');
  assert.match(calls.find(c => c.url.includes('/aspsps')).init.headers.Authorization, /^Bearer ey/);

  const start = await call(env, '/api/eb/start', { method: 'POST', cookie, body: { name: 'Argenta', country: 'BE' } });
  assert.equal(start.data.url, 'https://bank.example/login');
  const authBody = JSON.parse(calls.find(c => c.url.endsWith('/auth')).init.body);
  assert.equal(authBody.redirect_url, `${ORIGIN}/api/eb/callback`);
  assert.equal(authBody.psu_type, 'personal');

  // Callback zonder geldige state wordt geweigerd
  const bad = await call(env, '/api/eb/callback?state=fout&code=x');
  assert.match(bad.res.headers.get('Location'), /link_error/);

  const cb = await call(env, `/api/eb/callback?state=${authBody.state}&code=abc`);
  assert.equal(cb.res.status, 302);
  assert.match(cb.res.headers.get('Location'), /\?linked=Argenta$/);

  // state is eenmalig
  const again = await call(env, `/api/eb/callback?state=${authBody.state}&code=abc`);
  assert.match(again.res.headers.get('Location'), /link_error/);

  let snap = (await call(env, '/api/state', { cookie })).data;
  assert.equal(snap.connections.length, 1);
  const acc = snap.connections[0].accounts[0];
  assert.equal(acc.balance, 1234.56, 'CLBD heeft voorrang op ITAV');
  assert.equal(acc.key, 'eb:BE68539007547034');
  assert.deepEqual(acc.transactions.map(t => [t.amount, t.label, t.kind]), [[-42.1, 'Colruyt', 'out'], [250, 'Werkgever NV', 'in']], 'nieuwste eerst, uitgaven negatief');
  assert.equal(acc.transactions[1].detail, 'Loon oktober');

  // Cron: zonder PSU-headers (onbeheerde opvraging)
  calls.length = 0;
  await runCron(env);
  assert.equal(calls.find(c => c.url.includes('/balances')).init.headers['Psu-Ip-Address'], undefined);
  snap = (await call(env, '/api/state', { cookie })).data;
  assert.equal(snap.rates.rates.USD, 0.8);

  // Handmatig vernieuwen: met PSU-headers
  calls.length = 0;
  await call(env, '/api/refresh', { method: 'POST', cookie, headers: { 'CF-Connecting-IP': '9.9.9.9' } });
  assert.equal(calls.find(c => c.url.includes('/balances')).init.headers['Psu-Ip-Address'], '9.9.9.9');

  // Ontkoppelen
  const del = await call(env, `/api/connections/${encodeURIComponent('eb:BE:Argenta')}`, { method: 'DELETE', cookie });
  assert.equal(del.data.connections.length, 0);
});

test('verlopen toestemming geeft duidelijke fout', async () => {
  const env = makeEnv();
  await env.KV.put('connections', JSON.stringify([{ id: 'eb:BE:Argenta', kind: 'eb', institution: 'Argenta', validUntil: '2020-01-01T00:00:00Z', accounts: [] }]));
  await runCron(env);
  const conns = await env.KV.get('connections', 'json');
  assert.match(conns[0].error, /verlopen/);
});

test('MetaApi: account toevoegen gebruikt equity', async () => {
  const env = makeEnv();
  const cookie = await login(env);
  const res = await call(env, '/api/metaapi/add', { method: 'POST', cookie, body: { accountId: 'abcdef12-3456' } });
  const c = res.data.connections[0];
  assert.equal(c.institution, 'VT Markets');
  assert.equal(c.accounts[0].balance, 2100.5);
  assert.equal(c.accounts[0].currency, 'USD');
  assert.equal(c.accounts[0].credit, 400);
  assert.deepEqual(c.accounts[0].transactions.map(t => [t.label, t.amount]), [['Winst trade XAUUSD', 76], ['Storting', 500]], 'enkel stortingen en gesloten trades, geen bonus');
  assert.equal(calls.find(x => x.url.includes('provisioning')).init.headers['auth-token'], 'meta-token');
  assert.equal((await call(env, '/api/metaapi/add', { method: 'POST', cookie, body: { accountId: '../x' } })).res.status, 400);
});

test('zonder configuratie: duidelijke melding', async () => {
  const env = makeEnv({ EB_APP_ID: '', METAAPI_TOKEN: '' });
  const cookie = await login(env);
  const r = await call(env, '/api/eb/aspsps', { cookie });
  assert.equal(r.res.status, 400);
  assert.match(r.data.error, /niet ingesteld/);
  const s = (await call(env, '/api/state', { cookie })).data;
  assert.deepEqual([s.config.enableBanking, s.config.metaApi], [false, false]);
});

test('Myfxbook: sessie hergebruiken, verlopen sessie opnieuw aanmelden, equity gebruiken', async () => {
  const env = makeEnv({ MYFXBOOK_EMAIL: 'ik@example.com', MYFXBOOK_PASSWORD: 'mfx-ww' });
  const cookie = await login(env);
  let validSession = 'S1';
  const mfxCalls = [];
  globalThis.fetch = async url => {
    url = String(url);
    if (!url.includes('myfxbook.com')) throw new Error(`onverwachte fetch: ${url}`);
    mfxCalls.push(url);
    const ok = body => new Response(JSON.stringify(body), { status: 200 });
    const u = new URL(url);
    if (u.pathname.endsWith('/login.json')) {
      assert.equal(u.searchParams.get('email'), 'ik@example.com');
      return ok({ error: false, message: '', session: validSession });
    }
    if (u.searchParams.get('session') !== validSession) return ok({ error: true, message: 'Invalid session.' });
    if (u.pathname.endsWith('/get-history.json')) {
      assert.equal(u.searchParams.get('id'), '111', 'geen geschiedenis voor demo-accounts');
      return ok({ error: false, history: [
        { openTime: '10/01/2026 08:00', closeTime: '10/01/2026 08:00', action: 'Deposit', profit: 1000 },
        { openTime: '10/14/2026 09:00', closeTime: '10/14/2026 15:20', action: 'Sell', symbol: 'EURUSD', sizing: { value: '0.10' }, profit: 35.5, commission: -0.5, interest: 0 },
        { openTime: '10/02/2026 08:00', closeTime: '10/02/2026 08:00', action: 'Credit', profit: 200 },
      ] });
    }
    if (u.pathname.endsWith('/get-open-trades.json')) {
      assert.equal(u.searchParams.get('id'), '111', 'geen open trades opvragen voor demo-accounts');
      return ok({ error: false, openTrades: [{ profit: 12.5 }, { profit: -2.5 }] });
    }
    return ok({ error: false, accounts: [
      { id: 111, name: 'VT live', accountId: 81234567, balance: 2000, equity: 2150.25, credit: 300, deposits: 1800, withdrawals: 100, currency: 'USD', demo: false, lastUpdateDate: '10/17/2026 09:30', server: { name: 'VTMarkets-Live 3' } },
      { id: 222, name: 'VT demo', balance: 100000, equity: 100000, currency: 'USD', demo: true, server: { name: 'VTMarkets-Demo' } },
    ] });
  };

  const res = await call(env, '/api/myfxbook/add', { method: 'POST', cookie });
  const c = res.data.connections[0];
  assert.equal(c.institution, 'VT Markets');
  assert.equal(c.accounts[0].balance, 2150.25);
  assert.equal(c.accounts[0].updatedAt, '2026-10-17T09:30:00.000Z');
  assert.equal(c.accounts[0].credit, 300);
  assert.deepEqual([c.accounts[0].deposits, c.accounts[0].withdrawals], [1800, 100]);
  assert.equal(c.accounts[0].cashBalance, 2000);
  assert.equal(c.accounts[0].openProfit, 10);
  assert.equal(c.accounts[1].openProfit, null);
  assert.equal(c.accounts[1].deposits, null);
  assert.equal(c.accounts[1].credit, null);
  assert.equal(c.accounts[1].demo, true);
  assert.deepEqual(c.accounts[0].transactions.map(t => [t.label, t.amount, t.date]), [
    ['Winst trade EURUSD', 35, '2026-10-14T15:20:00.000Z'],
    ['Storting', 1000, '2026-10-01T08:00:00.000Z'],
  ]);
  assert.equal(c.accounts[1].transactions, undefined);
  assert.equal(res.data.config.myfxbook, true);

  // Tweede vernieuwing: geen nieuwe login nodig.
  mfxCalls.length = 0;
  await call(env, '/api/refresh', { method: 'POST', cookie });
  assert.equal(mfxCalls.filter(u => u.includes('login.json')).length, 0);

  // Sessie verlopen: één keer opnieuw aanmelden.
  validSession = 'S2';
  mfxCalls.length = 0;
  await call(env, '/api/refresh', { method: 'POST', cookie });
  assert.equal(mfxCalls.filter(u => u.includes('login.json')).length, 1);
  const conns = await env.KV.get('connections', 'json');
  assert.equal(conns[0].error, undefined);
});

test('Myfxbook zonder instellingen of accounts: duidelijke fout', async () => {
  const env = makeEnv();
  const cookie = await login(env);
  const r = await call(env, '/api/myfxbook/add', { method: 'POST', cookie });
  assert.equal(r.res.status, 400);
  assert.match(r.data.error, /MYFXBOOK_EMAIL/);
});
