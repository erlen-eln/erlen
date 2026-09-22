// ページ改訂履歴の閲覧APIの結線検査。
//   GET /api/pages/:id/revisions        … 版の一覧（rev_no昇順・本文は載せない）
//   GET /api/pages/:id/revisions/:revNo … その版のスナップショット
// どちらも「そのページが見える人」だけ。見えない相手には404（存在ごと隠す）。
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { createTestEnv, addMember } from './d1-adapter.mjs';
import { signSession, SESSION_COOKIE, SESSION_TTL_MS } from '../src/auth.mjs';

const BASE = 'https://erlen.example.workers.dev';

async function makeEnv() {
  const { env, ctx } = createTestEnv();
  const cookie = `${SESSION_COOKIE}=${await signSession(
    { email: 'owner@example.com', expMs: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET
  )}`;
  return { env, ctx, cookie };
}

async function cookieFor(env, email) {
  return `${SESSION_COOKIE}=${await signSession(
    { email, expMs: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET
  )}`;
}

function req(path, { method = 'GET', cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function makePage(env, cookie, projectId = null) {
  const nb = (await (await worker.fetch(req('/api/notebooks', {
    method: 'POST', cookie, body: { title: '検査帳', project_id: projectId },
  }), env)).json()).notebook;
  const page = (await (await worker.fetch(req(`/api/notebooks/${nb.id}/pages`, {
    method: 'POST', cookie, body: { title: 'ページ1' },
  }), env)).json()).page;
  return { notebook: nb, page };
}

test('本文を変えると版が増え、同じ内容の保存では増えない。一覧と本文が引ける', async () => {
  const { env, cookie } = await makeEnv();
  const { page } = await makePage(env, cookie);

  const revs = async () => (await (await worker.fetch(
    req(`/api/pages/${page.id}/revisions`, { cookie }), env)).json()).revisions;

  // まだ1版も無い（作成時点では改訂を積まない）
  assert.equal((await revs()).length, 0);

  // 本文を変える → 版が1つ増える
  await worker.fetch(req(`/api/pages/${page.id}`, {
    method: 'PATCH', cookie, body: { content: '手順v1' },
  }), env);
  const r1 = await revs();
  assert.equal(r1.length, 1);
  assert.equal(r1[0].rev_no, 1);
  assert.equal(r1[0].author_user_id, 'google-sub-1');
  assert.ok(r1[0].created_at);
  assert.equal(r1[0].snapshot, undefined, '一覧は本文を載せない');

  // 同じ内容の保存 → 版は増えない（page_revisions は「直前と同一なら書かない」設計）
  await worker.fetch(req(`/api/pages/${page.id}`, {
    method: 'PATCH', cookie, body: { content: '手順v1' },
  }), env);
  assert.equal((await revs()).length, 1);

  // 別の内容 → 2版目
  await worker.fetch(req(`/api/pages/${page.id}`, {
    method: 'PATCH', cookie, body: { content: '手順v2' },
  }), env);
  assert.deepEqual((await revs()).map((r) => r.rev_no), [1, 2]);

  // 単体で本文が引ける（過去の版の中身が取れることが証拠力の本体）。
  // 版に積むのは「保存された時点の姿」なので、rev1 は v1・rev2 は v2 の本文を持つ
  const one = await worker.fetch(req(`/api/pages/${page.id}/revisions/1`, { cookie }), env);
  assert.equal(one.status, 200);
  const rev = await one.json();
  assert.equal(rev.rev_no, 1);
  assert.equal(rev.snapshot.page.title, 'ページ1');
  assert.equal(rev.snapshot.page.content, '手順v1');
  const two = await worker.fetch(req(`/api/pages/${page.id}/revisions/2`, { cookie }), env);
  assert.equal((await two.json()).snapshot.page.content, '手順v2');

  // 無い版・無いページは404。GET以外は405
  assert.equal(
    (await worker.fetch(req(`/api/pages/${page.id}/revisions/99`, { cookie }), env)).status, 404);
  assert.equal(
    (await worker.fetch(req('/api/pages/NOPE/revisions', { cookie }), env)).status, 404);
  assert.equal(
    (await worker.fetch(req(`/api/pages/${page.id}/revisions`, { method: 'POST', cookie }), env))
      .status, 405);
});

test('改訂履歴はページの可視性に従う（プロジェクト外は404・入れば読める）', async () => {
  const { env, cookie } = await makeEnv();
  const pj = (await (await worker.fetch(req('/api/projects', {
    method: 'POST', cookie, body: { name: '社内案件' },
  }), env)).json()).project;
  const { page } = await makePage(env, cookie, pj.id);
  await worker.fetch(req(`/api/pages/${page.id}`, {
    method: 'PATCH', cookie, body: { content: 'v1' },
  }), env);

  addMember(env, { id: 'sub-ed', email: 'editor@example.com', role: 'editor' });
  const edCookie = await cookieFor(env, 'editor@example.com');

  // プロジェクト外の人には一覧も本文も404
  assert.equal(
    (await worker.fetch(req(`/api/pages/${page.id}/revisions`, { cookie: edCookie }), env))
      .status, 404);
  assert.equal(
    (await worker.fetch(req(`/api/pages/${page.id}/revisions/1`, { cookie: edCookie }), env))
      .status, 404);

  // メンバーに入れば読める
  await worker.fetch(req(`/api/projects/${pj.id}/members`, {
    method: 'PUT', cookie, body: { user_ids: ['sub-ed'] },
  }), env);
  const res = await worker.fetch(req(`/api/pages/${page.id}/revisions`, { cookie: edCookie }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).revisions.length, 1);
});
