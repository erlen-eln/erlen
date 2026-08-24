// ルーティングの結線検査。HTTPの入口から出口まで、実際にRequest/Responseで通す。
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { createTestEnv } from './d1-adapter.mjs';
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

