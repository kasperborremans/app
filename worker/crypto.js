/* Kleine crypto-helpers op basis van WebCrypto (werkt in Workers én Node 20+). */

const enc = new TextEncoder();

export function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/* ---------- Sessiecookie: base64url(payload).base64url(hmac) ---------- */

export async function signSession(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifySession(token, secret) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sig), enc.encode(body));
    return ok ? JSON.parse(new TextDecoder().decode(b64urlDecode(body))) : null;
  } catch {
    return null;
  }
}

/** Vergelijkt twee strings in constante tijd (via HMAC van beide). */
export async function safeEqual(a, b, secret) {
  const key = await hmacKey(secret);
  const [ha, hb] = await Promise.all([a, b].map(x => crypto.subtle.sign('HMAC', key, enc.encode(x))));
  const va = new Uint8Array(ha), vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/* ---------- RS256-JWT voor Enable Banking ---------- */

function pemToDer(pem) {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return isPkcs1 ? pkcs1ToPkcs8(der) : der;
}

function derLength(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}

/** Verpakt een PKCS#1 RSA-sleutel als PKCS#8, want WebCrypto kent enkel PKCS#8. */
function pkcs1ToPkcs8(pkcs1) {
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const inner = version.length + algId.length + octet.length + pkcs1.length;
  const out = new Uint8Array([0x30, ...derLength(inner), ...version, ...algId, ...octet, ...pkcs1]);
  return out;
}

const keyCache = new Map();

export async function signJwtRS256(header, payload, pem) {
  let key = keyCache.get(pem);
  if (!key) {
    key = await crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(pem, key);
  }
  const data = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}
