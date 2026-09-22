// 監査証跡の閲覧APIの結線検査。worker.mjs のルーティングを含めて Request/Response で通す。
//   GET /api/audit と /api/audit/export … オーナーだけ（他は403）
//   GET /api/pages/:id/audit           … そのページが見える人（見えない相手には404）
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { createTestEnv, addMember, sqlMissingTenantScope } from './d1-adapter.mjs';
import { signSession, SESSION_COOKIE, SESSION_TTL_MS } from '../src/auth.mjs';

const BASE = 'https://erlen.example.workers.dev';

async function makeEnv() {
  const { env, ctx } = createTestEnv();
  const cookie = await cookieFor(env, 'owner@example.com');
  return { env, ctx, cookie };
}

async function cookieFor(env, email) {
  return `${SESSION_COOKIE}=${await signSession(
    { email, expMs: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET
  )}`;
}

function req(path, { method = 'GET', cookie, body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  return new Request(`${BASE}${path}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ノートブック＋ページを1枚作る（監査も2件生える）。projectId を渡すとプロジェクト配下に置く
async function makePage(env, cookie, projectId = null) {
  const nbRes = await worker.fetch(req('/api/notebooks', {
    method: 'POST', cookie, body: { title: '検査帳', project_id: projectId },
  }), env);
  const nb = (await nbRes.json()).notebook;
  const pgRes = await worker.fetch(req(`/api/notebooks/${nb.id}/pages`, {
    method: 'POST', cookie, body: { title: 'ページ1' },
  }), env);
  return { notebook: nb, page: (await pgRes.json()).page };
}

test('オーナーは /api/audit を読める（seq降順・絞り込み・ページング）', async () => {
  const { env, cookie } = await makeEnv();
  const { page } = await makePage(env, cookie);

  const res = await worker.fetch(req('/api/audit', { cookie }), env);
  assert.equal(res.status, 200);
  const { events, next_before_seq } = await res.json();
  assert.equal(events.length, 2);
  // 新しい順（seq 降順）で返る
  assert.deepEqual(events.map((e) => e.action), ['page.create', 'notebook.create']);
  assert.ok(events[0].seq > events[1].seq);
  assert.equal(next_before_seq, null);

  // target_type で絞れる
  const nbOnly = await worker.fetch(req('/api/audit?target_type=notebook', { cookie }), env);
  assert.deepEqual((await nbOnly.json()).events.map((e) => e.action), ['notebook.create']);

  // ページング: limit=1 で次のキーが返り、before_seq で続きが引ける
  const p1 = await (await worker.fetch(req('/api/audit?limit=1', { cookie }), env)).json();
  assert.equal(p1.events.length, 1);
  assert.equal(p1.events[0].target_id, page.id);
  assert.equal(p1.next_before_seq, events[0].seq);
  const p2 = await (await worker.fetch(
    req(`/api/audit?limit=1&before_seq=${p1.next_before_seq}`, { cookie }), env
  )).json();
  assert.deepEqual(p2.events.map((e) => e.action), ['notebook.create']);
  assert.equal(p2.next_before_seq, null);
});

test('オーナー以外は /api/audit と /api/audit/export が 403', async () => {
  const { env, cookie } = await makeEnv();
  addMember(env, { id: 'sub-ed', email: 'editor@example.com', role: 'editor' });
  const edCookie = await cookieFor(env, 'editor@example.com');

  assert.equal((await worker.fetch(req('/api/audit', { cookie: edCookie }), env)).status, 403);
  assert.equal((await worker.fetch(req('/api/audit/export', { cookie: edCookie }), env)).status, 403);
  // オーナーならexportも通る
  assert.equal((await worker.fetch(req('/api/audit/export', { cookie }), env)).status, 200);
});

test('ページ単位の監査は可視性に従う（プロジェクト外のページは404）', async () => {
  const { env, cookie } = await makeEnv();

  // プロジェクトに縛ったノートブックの中のページ。メンバー以外には存在ごと隠す
  const pj = (await (await worker.fetch(req('/api/projects', {
    method: 'POST', cookie, body: { name: '社内案件' },
  }), env)).json()).project;
  const { page } = await makePage(env, cookie, pj.id);

  addMember(env, { id: 'sub-ed', email: 'editor@example.com', role: 'editor' });
  const edCookie = await cookieFor(env, 'editor@example.com');

  // プロジェクトに入っていない editor には 404（存在ごと隠す）
  const hidden = await worker.fetch(req(`/api/pages/${page.id}/audit`, { cookie: edCookie }), env);
  assert.equal(hidden.status, 404);

  // オーナーは読める。ページに紐づく事象だけが返る
  const mine = await worker.fetch(req(`/api/pages/${page.id}/audit`, { cookie }), env);
  assert.equal(mine.status, 200);
  const { events } = await mine.json();
  assert.deepEqual(events.map((e) => e.action), ['page.create']);
  assert.equal(events[0].page_id, page.id);

  // プロジェクトに入れてもらった editor は読める
  await worker.fetch(req(`/api/projects/${pj.id}/members`, {
    method: 'PUT', cookie, body: { user_ids: ['sub-ed'] },
  }), env);
  const visible = await worker.fetch(req(`/api/pages/${page.id}/audit`, { cookie: edCookie }), env);
  assert.equal(visible.status, 200);
  assert.deepEqual((await visible.json()).events.map((e) => e.action), ['page.create']);
});

test('/api/audit/export は1行1事象のJSONL（seq昇順・application/x-ndjson）', async () => {
  const { env, cookie } = await makeEnv();
  await makePage(env, cookie);

  const res = await worker.fetch(req('/api/audit/export', { cookie }), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/x-ndjson/);

  const lines = (await res.text()).trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const rows = lines.map((l) => JSON.parse(l));
  // seq の昇順で連続している（1からの連番）
  assert.deepEqual(rows.map((r) => r.seq), [1, 2]);
  assert.deepEqual(rows.map((r) => r.action), ['notebook.create', 'page.create']);
  assert.ok(rows.every((r) => r.hash && r.tenant_id));
});

test('監査まわりのSQLに tenant_id 抜けが無い（実行時検査）', async () => {
  const { env, cookie } = await makeEnv();
  const { page } = await makePage(env, cookie);
  await worker.fetch(req('/api/audit', { cookie }), env);
  await worker.fetch(req('/api/audit/export', { cookie }), env);
  await worker.fetch(req(`/api/pages/${page.id}/audit`, { cookie }), env);
  assert.deepEqual(sqlMissingTenantScope(env.DB.__sql), [],
    `tenant_id の無いSQL:\n${env.DB.__sql.filter((s) => s.includes('audit')).join('\n')}`);
});
