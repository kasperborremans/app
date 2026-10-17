import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { signJwtRS256, signSession, verifySession, safeEqual } from '../worker/crypto.js';

function verifyJwt(jwt, publicKey) {
  const [h, p, s] = jwt.split('.');
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${p}`);
  return v.verify(publicKey, Buffer.from(s, 'base64url'));
}

for (const type of ['pkcs8', 'pkcs1']) {
  test(`RS256-JWT met ${type}-sleutel is geldig`, async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type, format: 'pem' });
    const jwt = await signJwtRS256({ typ: 'JWT', alg: 'RS256', kid: 'app' }, { iss: 'enablebanking.com' }, pem);
    assert.ok(verifyJwt(jwt, publicKey));
    const header = JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url'));
    assert.equal(header.kid, 'app');
  });
}

test('PEM met letterlijke \\n (zoals soms in secrets geplakt) werkt', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');
  const jwt = await signJwtRS256({ alg: 'RS256' }, { a: 1 }, pem);
  assert.ok(verifyJwt(jwt, publicKey));
});

test('sessiecookie: geldig, en vervalsing wordt geweigerd', async () => {
  const token = await signSession({ exp: 123 }, 'geheim');
  assert.deepEqual(await verifySession(token, 'geheim'), { exp: 123 });
  assert.equal(await verifySession(token, 'ander'), null);
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ exp: 999 })).toString('base64url');
  assert.equal(await verifySession(`${forged}.${sig}`, 'geheim'), null);
  assert.equal(await verifySession('rommel', 'geheim'), null);
  assert.ok(body);
});

test('safeEqual', async () => {
  assert.equal(await safeEqual('abc', 'abc', 'k'), true);
  assert.equal(await safeEqual('abc', 'abd', 'k'), false);
  assert.equal(await safeEqual('', 'abc', 'k'), false);
});
