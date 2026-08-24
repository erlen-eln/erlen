// 認証の純関数の検証。ここが緑なら「他人のCookieでログインされる」事故は起きない。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signSession, verifySession, parseCookies, googleAuthUrl, safeNextPath,
  validSessionSecret, verifyGoogleIdToken, newToken,
  SESSION_COOKIE, STATE_COOKIE, NEXT_COOKIE, SESSION_TTL_MS,
} from '../src/auth.mjs';

const SECRET = 's'.repeat(48);
const NOW = Date.parse('2026-07-31T12:00:00+09:00');

test('Cookie名はerlen_接頭辞・セッションは30日', () => {
  assert.equal(SESSION_COOKIE, 'erlen_session');
  assert.equal(STATE_COOKIE, 'erlen_oauth_state');
  assert.equal(NEXT_COOKIE, 'erlen_login_next');
  assert.equal(SESSION_TTL_MS, 30 * 86400000);
});

test('署名→検証の往復でemailが返る', async () => {
  const v = await signSession({ email: 'a@example.com', expMs: NOW + 1000 }, SECRET);
  assert.deepEqual(await verifySession(v, NOW, SECRET), { email: 'a@example.com' });
});

test('期限切れはnull', async () => {
  const v = await signSession({ email: 'a@example.com', expMs: NOW - 1 }, SECRET);
  assert.equal(await verifySession(v, NOW, SECRET), null);
});

test('署名改ざんはnull', async () => {
  const v = await signSession({ email: 'a@example.com', expMs: NOW + 1000 }, SECRET);
  const bad = v.slice(0, -2) + (v.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(await verifySession(bad, NOW, SECRET), null);
});

test('ペイロード改ざん（別emailへの差し替え）はnull', async () => {
  const v = await signSession({ email: 'a@example.com', expMs: NOW + 1000 }, SECRET);
  const sig = v.split('.')[1];
  const forged = Buffer.from(JSON.stringify({ email: 'evil@example.com', exp: NOW + 1000 }))
    .toString('base64url');
  assert.equal(await verifySession(`${forged}.${sig}`, NOW, SECRET), null);
});

test('別secretで作った署名はnull', async () => {
  const v = await signSession({ email: 'a@example.com', expMs: NOW + 1000 }, 'o'.repeat(48));
  assert.equal(await verifySession(v, NOW, SECRET), null);
});

test('形式不正・短すぎるsecretはnull', async () => {
  assert.equal(await verifySession('garbage', NOW, SECRET), null);
  assert.equal(await verifySession('', NOW, SECRET), null);
  assert.equal(await verifySession(null, NOW, SECRET), null);
  const v = await signSession({ email: 'a@example.com', expMs: NOW + 1000 }, 'short');
  assert.equal(await verifySession(v, NOW, 'short'), null, '32文字未満のSESSION_SECRETは未設定扱い');
});

test('validSessionSecretは32文字以上だけ通す', () => {
  assert.equal(validSessionSecret(undefined), false);
  assert.equal(validSessionSecret('short'), false);
  assert.equal(validSessionSecret('a'.repeat(31)), false);
  assert.equal(validSessionSecret('a'.repeat(32)), true);
});

test('parseCookiesは複数クッキーを分解する', () => {
  assert.deepEqual(
    parseCookies('a=1; erlen_session=abc.def; b=2'),
    { a: '1', erlen_session: 'abc.def', b: '2' }
  );
  assert.deepEqual(parseCookies(null), {});
});

test('safeNextPathは/appだけを許し、外部URLは/appへ丸める', () => {
  assert.equal(safeNextPath('/app'), '/app');
  assert.equal(safeNextPath('/admin'), '/app');
  assert.equal(safeNextPath('//evil.example'), '/app');
  assert.equal(safeNextPath('https://evil.example'), '/app');
  assert.equal(safeNextPath('/app/../../etc'), '/app');
  assert.equal(safeNextPath(undefined), '/app');
});

test('googleAuthUrlに必須パラメータが入る', () => {
  const u = new URL(googleAuthUrl({ clientId: 'cid', redirectUri: 'https://x/cb', state: 'st1' }));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://x/cb');
  assert.equal(u.searchParams.get('state'), 'st1');
  assert.equal(u.searchParams.get('nonce'), 'st1');
  assert.equal(u.searchParams.get('scope'), 'openid email');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('prompt'), 'select_account');
});

test('newTokenは毎回違う24桁の16進', () => {
  const a = newToken();
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.notEqual(a, newToken());
});

function b64url(value) {
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
  return bytes.toString('base64url');
}

async function signedGoogleToken(overrides = {}) {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const nowSec = Math.floor(NOW / 1000);
  const header = { alg: 'RS256', kid: 'test-kid', typ: 'JWT' };
  const claims = {
    iss: 'https://accounts.google.com',
    aud: 'client-1',
    exp: nowSec + 600,
    iat: nowSec,
    nonce: 'nonce-1',
    sub: '1234567890',
    email: 'owner@example.com',
    email_verified: true,
    ...overrides,
  };
  const input = `${b64url(header)}.${b64url(claims)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(input)
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    token: `${input}.${Buffer.from(signature).toString('base64url')}`,
    jwks: { keys: [{ ...jwk, kid: 'test-kid', alg: 'RS256', use: 'sig' }] },
  };
}

test('Google ID tokenは署名・aud・iss・exp・nonceがすべて正しいときだけ通る', async () => {
  const good = await signedGoogleToken();
  const claims = await verifyGoogleIdToken(good.token, {
    clientId: 'client-1', expectedNonce: 'nonce-1', nowMs: NOW, jwks: good.jwks,
  });
  assert.equal(claims.email, 'owner@example.com');
  assert.equal(claims.sub, '1234567890');

  for (const badClaims of [
    { aud: 'other-client' },
    { iss: 'https://evil.example' },
    { exp: Math.floor(NOW / 1000) - 1 },
    { nonce: 'other-nonce' },
    { aud: ['client-1', 'other-client'], azp: 'other-client' },
  ]) {
    const bad = await signedGoogleToken(badClaims);
    assert.equal(await verifyGoogleIdToken(bad.token, {
      clientId: 'client-1', expectedNonce: 'nonce-1', nowMs: NOW, jwks: bad.jwks,
    }), null);
  }
});

test('Google ID tokenの署名改ざんは拒否する', async () => {
  const good = await signedGoogleToken();
  const parts = good.token.split('.');
  parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  assert.equal(await verifyGoogleIdToken(parts.join('.'), {
    clientId: 'client-1', expectedNonce: 'nonce-1', nowMs: NOW, jwks: good.jwks,
  }), null);
});

// ---- デモセッションの印（公開デモ用） ---------------------------------
test('demo:true を渡したセッションは、検証で {email, demo:true} に戻る', async () => {
  const v = await signSession({ email: 'guest@example.com', expMs: NOW + 1000, demo: true }, SECRET);
  assert.deepEqual(await verifySession(v, NOW, SECRET), { email: 'guest@example.com', demo: true });
});

test('demoを渡さないセッションのペイロードには demo キーが入らない（既存Cookieと同じ形）', async () => {
  const v = await signSession({ email: 'a@example.com', expMs: NOW + 1000 }, SECRET);
  const payload = JSON.parse(atob(v.slice(0, v.indexOf('.')).replace(/-/g, '+').replace(/_/g, '/')));
  assert.deepEqual(payload, { email: 'a@example.com', exp: NOW + 1000 });
  assert.deepEqual(await verifySession(v, NOW, SECRET), { email: 'a@example.com' });
});

test('demoの印は署名の中にある（後から書き足したCookieは通らない）', async () => {
  const forged = btoa(JSON.stringify({ email: 'a@example.com', exp: NOW + 1000, demo: true }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const honest = await signSession({ email: 'a@example.com', expMs: NOW + 1000 }, SECRET);
  const sig = honest.slice(honest.indexOf('.') + 1);
  assert.equal(await verifySession(`${forged}.${sig}`, NOW, SECRET), null);
});
