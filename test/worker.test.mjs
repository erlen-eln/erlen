// ルーティングの結線検査。HTTPの入口から出口まで、実際にRequest/Responseで通す。
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { createTestEnv, createTestDb, addMember } from './d1-adapter.mjs';
import { signSession, SESSION_COOKIE, SESSION_TTL_MS } from '../src/auth.mjs';
// 版番号は直書きしない（版を上げるたびに無関係なテストが赤くなるため）。
// package.jsonとの一致は test/health.test.mjs が別途検査している
import { VERSION } from '../src/api/health.mjs';

const BASE = 'https://erlen.example.workers.dev';

async function makeEnv(opts = {}) {
  const { env, ctx } = createTestEnv(opts);
  // 静的アセットの代役
  env.ASSETS = { fetch: async () => new Response('<html>app</html>', { headers: { 'content-type': 'text/html' } }) };
  const cookie = `${SESSION_COOKIE}=${await signSession(
    { email: 'owner@example.com', expMs: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET
  )}`;
  return { env, ctx, cookie };
}

function req(path, { method = 'GET', cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('GET /api/health はログイン不要', async () => {
  const { env } = await makeEnv();
  const res = await worker.fetch(req('/api/health'), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, version: VERSION, demo: false });
});

test('/api/* はログイン必須（Cookieなしは401）', async () => {
  const { env } = await makeEnv();
  for (const path of ['/api/me', '/api/notebooks', '/api/pages/X']) {
    const res = await worker.fetch(req(path), env);
    assert.equal(res.status, 401, path);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
});

test('GET /api/me はログイン中の本人を返す', async () => {
  const { env, cookie } = await makeEnv();
  const res = await worker.fetch(req('/api/me', { cookie }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    email: 'owner@example.com', name: '所有者', role: 'owner', demo: false,
  });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('ノートブック→ページ→分子までHTTP経由で通る', async () => {
  const { env, cookie } = await makeEnv();
  const nbRes = await worker.fetch(req('/api/notebooks', {
    method: 'POST', cookie, body: { title: '有機合成2026' },
  }), env);
  assert.equal(nbRes.status, 201);
  const nb = (await nbRes.json()).notebook;

  const pageRes = await worker.fetch(req(`/api/notebooks/${nb.id}/pages`, {
    method: 'POST', cookie, body: { title: 'アルドール縮合' },
  }), env);
  assert.equal(pageRes.status, 201);
  const page = (await pageRes.json()).page;

  const molRes = await worker.fetch(req(`/api/pages/${page.id}/molecules`, {
    method: 'PUT', cookie, body: { molecules: [{ name: 'ベンズアルデヒド', molecular_weight: 106.12 }] },
  }), env);
  assert.equal(molRes.status, 200);
  assert.equal((await molRes.json()).rev_no, 1);

  const got = await worker.fetch(req(`/api/pages/${page.id}`, { cookie }), env);
  const body = await got.json();
  assert.equal(body.page.title, 'アルドール縮合');
  assert.equal(body.molecules.length, 1);

  const list = await worker.fetch(req(`/api/notebooks/${nb.id}/pages`, { cookie }), env);
  assert.equal((await list.json()).pages.length, 1);

  const del = await worker.fetch(req(`/api/notebooks/${nb.id}`, { method: 'DELETE', cookie }), env);
  assert.equal(del.status, 200);
});

test('壊れたJSON・許していないメソッド・知らないパス', async () => {
  const { env, cookie } = await makeEnv();
  const bad = new Request(`${BASE}/api/notebooks`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{',
  });
  assert.equal((await worker.fetch(bad, env)).status, 400);
  assert.equal((await worker.fetch(req('/api/notebooks', { method: 'PUT', cookie }), env)).status, 405);
  assert.equal((await worker.fetch(req('/api/unknown', { cookie }), env)).status, 404);
});

test('GET /auth/login はsecret未設定なら503、揃っていればGoogleへ302', async () => {
  const { env } = await makeEnv();
  const notReady = await worker.fetch(req('/auth/login'), env);
  assert.equal(notReady.status, 503);
  assert.deepEqual(await notReady.json(), { error: 'setup_incomplete' });

  env.GOOGLE_CLIENT_ID = 'client-1';
  env.GOOGLE_CLIENT_SECRET = 'client-secret';
  const res = await worker.fetch(req('/auth/login?next=https://evil.example'), env);
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get('location'));
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(to.searchParams.get('redirect_uri'), `${BASE}/auth/callback`);
  const setCookies = res.headers.getSetCookie();
  assert.equal(setCookies.length, 2);
  assert.ok(setCookies.every((c) => c.includes('HttpOnly') && c.includes('Secure') && c.includes('SameSite=Lax')));
  // 外部URLへの戻り先は/appへ丸められている
  assert.ok(setCookies.some((c) => c.startsWith('erlen_login_next=/app;')));
  // stateとnonceは同じ値
  assert.equal(to.searchParams.get('state'), to.searchParams.get('nonce'));
  assert.ok(setCookies.some((c) => c.startsWith(`erlen_oauth_state=${to.searchParams.get('state')};`)));
});

test('/auth/callback はstate不一致を弾いて ?login=error へ戻す', async () => {
  const { env } = await makeEnv();
  env.GOOGLE_CLIENT_ID = 'client-1';
  env.GOOGLE_CLIENT_SECRET = 'client-secret';
  const res = await worker.fetch(req('/auth/callback?code=abc&state=attacker', {
    cookie: 'erlen_oauth_state=legit',
  }), env);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `${BASE}/app?login=error`);
});

test('POST /auth/logout はCookieを破棄する', async () => {
  const { env, cookie } = await makeEnv();
  const res = await worker.fetch(req('/auth/logout', { method: 'POST', cookie }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.match(res.headers.get('set-cookie'), /^erlen_session=; Max-Age=0/);
});

test('/auth/の知らないパスは404・その他は静的アセットへ委譲', async () => {
  const { env } = await makeEnv();
  assert.equal((await worker.fetch(req('/auth/whatever'), env)).status, 404);
  const app = await worker.fetch(req('/app'), env);
  assert.equal(app.status, 200);
  assert.equal(await app.text(), '<html>app</html>');
});

test('/ は画面の入口 /app/ へ飛ばす', async () => {
  const { env } = await makeEnv();
  const res = await worker.fetch(req('/'), env);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `${BASE}/app/`);
});

test('GET /api/pubchem はクエリを受けて照会APIへ渡る（外部はモック）', async () => {
  const { env, cookie } = await makeEnv();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = String(url).includes('/cids/JSON')
      ? { IdentifierList: { CID: [243] } }
      : String(url).includes('/property/')
        ? { PropertyTable: { Properties: [{ CID: 243, MolecularWeight: '122.12' }] } }
        : { InformationList: { Information: [{ CID: 243, Synonym: ['65-85-0'] }] } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const res = await worker.fetch(req('/api/pubchem?type=cas&q=65-85-0', { cookie }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.found, true);
    assert.equal(body.compound.molecular_weight, 122.12);
    assert.ok(calls.length > 0);

    // クエリが無ければ400、GET以外は405
    assert.equal((await worker.fetch(req('/api/pubchem', { cookie }), env)).status, 400);
    assert.equal(
      (await worker.fetch(req('/api/pubchem?type=cas&q=1', { method: 'POST', cookie }), env)).status,
      405
    );
    // ログインしていなければ他の/api/*と同じく401
    assert.equal((await worker.fetch(req('/api/pubchem?type=cas&q=1'), env)).status, 401);
  } finally {
    globalThis.fetch = original;
  }
});

// 添付・検索・レポートの結線。ページを1枚作ってから叩く
async function makePage(env, cookie) {
  const nb = (await (await worker.fetch(req('/api/notebooks', {
    method: 'POST', cookie, body: { title: '有機合成2026' },
  }), env)).json()).notebook;
  const page = (await (await worker.fetch(req(`/api/notebooks/${nb.id}/pages`, {
    method: 'POST', cookie, body: { title: 'アルドール縮合' },
  }), env)).json()).page;
  return { notebook: nb, page };
}

test('添付: 生ボディでアップロード→ダウンロード→削除がHTTP経由で通る', async () => {
  const { env, cookie } = await makeEnv();
  const { page } = await makePage(env, cookie);
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);

  const up = await worker.fetch(new Request(
    `${BASE}/api/pages/${page.id}/attachments?filename=${encodeURIComponent('1H-NMR スペクトル.pdf')}`,
    { method: 'POST', headers: { cookie, 'content-type': 'application/pdf' }, body: bytes }
  ), env);
  assert.equal(up.status, 201);
  const att = (await up.json()).attachment;
  assert.equal(att.file_name, '1H-NMR スペクトル.pdf');
  assert.equal(att.file_size, 6);

  const list = await worker.fetch(req(`/api/pages/${page.id}/attachments`, { cookie }), env);
  assert.equal((await list.json()).attachments.length, 1);

  const down = await worker.fetch(req(`/api/attachments/${att.id}`, { cookie }), env);
  assert.equal(down.status, 200);
  assert.equal(down.headers.get('content-type'), 'application/pdf');
  assert.equal(down.headers.get('content-length'), '6');
  assert.equal(down.headers.get('cache-control'), 'private, no-store');
  // 日本語のファイル名はRFC 5987形式で渡す（ASCII版も併記）
  const disposition = down.headers.get('content-disposition');
  assert.match(disposition, /^attachment; filename="1H-NMR _+\.pdf"; filename\*=UTF-8''/);
  assert.ok(disposition.includes(encodeURIComponent('1H-NMR スペクトル.pdf')));
  assert.deepEqual(new Uint8Array(await down.arrayBuffer()), bytes, 'バイト列が一致');

  const del = await worker.fetch(req(`/api/attachments/${att.id}`, { method: 'DELETE', cookie }), env);
  assert.equal(del.status, 200);
  assert.equal((await worker.fetch(req(`/api/attachments/${att.id}`, { cookie }), env)).status, 404);
});

test('添付: Content-Lengthの時点で上限超えは413（本体を読まずに断る）', async () => {
  const { env, cookie } = await makeEnv();
  const { page } = await makePage(env, cookie);
  env.MAX_ATTACHMENT_MB = '1';
  const res = await worker.fetch(new Request(`${BASE}/api/pages/${page.id}/attachments?filename=x.bin`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/octet-stream', 'content-length': '2000000' },
    body: new Uint8Array(8),
  }), env);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'file_too_large');
});

test('検索: 未ログインは401・ログイン中はヒットを返す', async () => {
  const { env, cookie } = await makeEnv();
  assert.equal((await worker.fetch(req('/api/search?q=メチル化'), env)).status, 401);

  const { page } = await makePage(env, cookie);
  await worker.fetch(req(`/api/pages/${page.id}`, {
    method: 'PATCH', cookie, body: { content: '水素化ナトリウムでメチル化した。' },
  }), env);

  const res = await worker.fetch(req(`/api/search?q=${encodeURIComponent('メチル化')}`, { cookie }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'fts');
  assert.deepEqual(body.results.map((r) => r.pageId), [page.id]);
  // qが無ければ400、GET以外は405
  assert.equal((await worker.fetch(req('/api/search', { cookie }), env)).status, 400);
  assert.equal((await worker.fetch(req('/api/search?q=x', { method: 'POST', cookie }), env)).status, 405);
});

test('レポート: text/htmlで印刷用の完結HTMLが返る', async () => {
  const { env, cookie } = await makeEnv();
  const { page } = await makePage(env, cookie);
  const res = await worker.fetch(req(`/api/pages/${page.id}/report`, { cookie }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  const html = await res.text();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('アルドール縮合'));

  assert.equal((await worker.fetch(req('/api/pages/NOPE/report', { cookie }), env)).status, 404);
  assert.equal((await worker.fetch(req(`/api/pages/${page.id}/report`), env)).status, 401);
});

// ---- ログイン・ログアウトの監査記録 -------------------------------------
// /auth/callback までHTTPで通す。Googleのトークン交換とJWKSは fetch をモックする。
// auth.mjs はJWKSをモジュール内にキャッシュするので、このファイル内では同じ鍵を使い回す。
let googleKeyCache = null;
async function googleKey() {
  if (googleKeyCache) return googleKeyCache;
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  googleKeyCache = { pair, jwks: { keys: [{ ...jwk, kid: 'test-kid', alg: 'RS256', use: 'sig' }] } };
  return googleKeyCache;
}

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

async function googleIdToken({ email, sub, nonce, extra = {} }) {
  const { pair } = await googleKey();
  const nowSec = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })}.${b64({
    iss: 'https://accounts.google.com', aud: 'client-1',
    exp: nowSec + 600, iat: nowSec, nonce, sub, email, email_verified: true, ...extra,
  })}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(sig).toString('base64url')}`;
}

// Google側の2往復（トークン交換＋JWKS）をモックして /auth/callback へ通す。
// tokenFail:true で交換自体を失敗させる（auth.login_error の検査用）
async function loginViaGoogle(env, { email, sub, cfRay = '', extraClaims = {}, tokenFail = false } = {}) {
  const state = 'state-1';
  const idToken = await googleIdToken({ email, sub, nonce: state, extra: extraClaims });
  const { jwks } = await googleKey();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      return tokenFail
        ? new Response('bad gateway', { status: 502 })
        : new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
    }
    if (u.includes('googleapis.com/oauth2/v3/certs')) {
      return new Response(JSON.stringify(jwks), { status: 200 });
    }
    return new Response('unexpected call', { status: 500 });
  };
  try {
    const headers = { cookie: `erlen_oauth_state=${state}` };
    if (cfRay) headers['cf-ray'] = cfRay;
    return await worker.fetch(
      new Request(`${BASE}/auth/callback?code=abc&state=${state}`, { headers }), env);
  } finally {
    globalThis.fetch = original;
  }
}

const auditRows = (env, action) => env.DB.__raw.prepare(
  'SELECT * FROM audit_events WHERE action = ? ORDER BY seq'
).all(action);

function withGoogle(env) {
  env.GOOGLE_CLIENT_ID = 'client-1';
  env.GOOGLE_CLIENT_SECRET = 'secret';
  return env;
}

test('監査: ログイン成立で auth.login が記録され、cf-ray が request_id に入る', async () => {
  const { env } = await makeEnv();
  withGoogle(env);
  const res = await loginViaGoogle(env, {
    email: 'owner@example.com', sub: 'google-sub-1', cfRay: 'ray-login-1',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `${BASE}/app`);

  const rows = auditRows(env, 'auth.login');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_id, 'ray-login-1');
  const after = JSON.parse(rows[0].after_json);
  assert.equal(after.sub, 'google-sub-1');
  assert.equal(after.demo, false);
});

test('監査: テナント初期化では tenant.bootstrap → auth.login の順で記録される', async () => {
  // まだ誰もいないDB（オーナーの初回ログインがテナントを作る経路）
  const env = withGoogle({
    DB: createTestDb(),
    OWNER_EMAIL: 'owner@example.com',
    SESSION_SECRET: 'x'.repeat(48),
    BASE_URL: BASE,
    ASSETS: { fetch: async () => new Response('<html></html>') },
  });
  const res = await loginViaGoogle(env, { email: 'owner@example.com', sub: 'sub-owner-1' });
  assert.equal(res.status, 302);
  const actions = env.DB.__raw.prepare(
    'SELECT action FROM audit_events ORDER BY seq'
  ).all().map((r) => r.action);
  assert.deepEqual(actions, ['tenant.bootstrap', 'auth.login']);
});

test('監査: 招待の無いログインは auth.login_denied が記録される', async () => {
  const { env } = await makeEnv();
  withGoogle(env);
  const res = await loginViaGoogle(env, { email: 'stranger@example.com', sub: 'sub-x' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `${BASE}/app?login=denied`);

  const rows = auditRows(env, 'auth.login_denied');
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].after_json).email, 'stranger@example.com');
});

test('監査: アカウント不一致（sub違い）は auth.login_forbidden が記録される', async () => {
  const { env } = await makeEnv();
  withGoogle(env);
  addMember(env, { id: 'sub-real', email: 'member@example.com' });
  const res = await loginViaGoogle(env, { email: 'member@example.com', sub: 'sub-impostor' });
  assert.equal(res.status, 403);

  const rows = auditRows(env, 'auth.login_forbidden');
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].after_json).email, 'member@example.com');
});

test('監査: トークン交換の失敗は auth.login_error（stage=token）が記録される', async () => {
  const { env } = await makeEnv();
  withGoogle(env);
  const res = await loginViaGoogle(env, {
    email: 'owner@example.com', sub: 'google-sub-1', tokenFail: true,
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `${BASE}/app?login=error`);

  const rows = auditRows(env, 'auth.login_error');
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].after_json).stage, 'token');
});

test('監査: ログアウトで auth.logout が記録され cf-ray が request_id に入る', async () => {
  const { env, cookie } = await makeEnv();
  const res = await worker.fetch(new Request(`${BASE}/auth/logout`, {
    method: 'POST', headers: { cookie, 'cf-ray': 'ray-out-1' },
  }), env);
  assert.equal(res.status, 200);

  const rows = auditRows(env, 'auth.logout');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_user_id, 'google-sub-1');
  assert.equal(rows[0].request_id, 'ray-out-1');
});

test('監査: APIの書き込みにも cf-ray が request_id に入る', async () => {
  const { env, cookie } = await makeEnv();
  const res = await worker.fetch(new Request(`${BASE}/api/notebooks`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'cf-ray': 'ray-api-1' },
    body: JSON.stringify({ title: '検査帳' }),
  }), env);
  assert.equal(res.status, 201);

  const rows = auditRows(env, 'notebook.create');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_id, 'ray-api-1');
});

