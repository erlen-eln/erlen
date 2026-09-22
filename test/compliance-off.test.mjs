// 規制モードが無い環境（COMPLIANCE_MODE 未設定・"0"）での固定。
// ① 方針まわりのAPIは全て 404（機能自体が無い扱い）
//    例外: GET /api/reason-codes だけは空配列（画面が選択肢を引いても壊れないように）
// ② 方針の解決は常に NO_POLICY、requiresReason は常に false
// ③ 既存のページ操作の挙動は1文字も変わらない（理由なしで確定取消・削除ができる）
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { signSession, SESSION_COOKIE, SESSION_TTL_MS } from '../src/auth.mjs';
import { createTestEnv } from './d1-adapter.mjs';
import {
  complianceOn, NO_POLICY, policyForNotebook, policyForPage, requiresReason,
  tenantDefaultPolicy,
} from '../src/compliance.mjs';
import { createNotebook } from '../src/api/notebooks.mjs';
import { createPage, deletePage, patchPage } from '../src/api/pages.mjs';

const BASE = 'https://erlen.example.workers.dev';
const NOW = '2026-07-20T00:00:00.000Z';

// mode: undefined（未設定）と '0' の両方を試す
async function makeEnv(mode) {
  const t = createTestEnv();
  if (mode !== undefined) t.env.COMPLIANCE_MODE = mode;
  t.env.ASSETS = { fetch: async () => new Response('<html>app</html>') };
  const cookie = `${SESSION_COOKIE}=${await signSession(
    { email: 'owner@example.com', expMs: Date.now() + SESSION_TTL_MS }, t.env.SESSION_SECRET
  )}`;
  return { ...t, cookie };
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

for (const mode of [undefined, '0']) {
  const label = mode === undefined ? '未設定' : `"${mode}"`;

  test(`COMPLIANCE_MODE ${label}: 方針まわりのAPIは全て404（GET /api/reason-codes は空配列）`, async () => {
    const { env, cookie } = await makeEnv(mode);
    const targets = [
      ['GET', '/api/policies'], ['POST', '/api/policies'],
      ['PATCH', '/api/policies/X'], ['DELETE', '/api/policies/X'],
      ['POST', '/api/reason-codes'],
      ['PATCH', '/api/reason-codes/X'], ['DELETE', '/api/reason-codes/X'],
      ['PUT', '/api/projects/X/policy'],
    ];
    for (const [method, path] of targets) {
      // GET/DELETE は body を付けられない
      const body = (method === 'GET' || method === 'DELETE') ? undefined : {};
      const res = await worker.fetch(req(path, { method, cookie, body }), env);
      assert.equal(res.status, 404, `${method} ${path} は 404 のはず（実際 ${res.status}）`);
    }
    // 例外: 理由コードの一覧だけは空配列を返す
    const rc = await worker.fetch(req('/api/reason-codes', { cookie }), env);
    assert.equal(rc.status, 200);
    assert.deepEqual((await rc.json()).reason_codes, []);
  });

  test(`COMPLIANCE_MODE ${label}: 方針の解決は常に NO_POLICY`, async () => {
    const { env, ctx } = await makeEnv(mode);
    assert.equal(complianceOn(env), false);

    const nb = (await createNotebook(env, ctx, { title: 'N' }, NOW)).data.notebook;
    const page = (await createPage(env, ctx, nb.id, { title: 'P' }, NOW)).data.page;

    assert.equal(await policyForPage(env, ctx, page.id), NO_POLICY);
    assert.equal(await policyForNotebook(env, ctx, nb.id), NO_POLICY);
    assert.equal(await tenantDefaultPolicy(env, ctx), NO_POLICY);
    // 存在しないIDでも NO_POLICY（例外ではなく「方針なし」）
    assert.equal(await policyForPage(env, ctx, 'NOPE'), NO_POLICY);
    assert.equal(await policyForNotebook(env, ctx, 'NOPE'), NO_POLICY);
  });

  test(`COMPLIANCE_MODE ${label}: requiresReason は常に false`, async () => {
    const { env, ctx } = await makeEnv(mode);
    // 解決結果（=常に NO_POLICY）を通すので、どの操作も理由は要求されない
    const policy = await tenantDefaultPolicy(env, ctx);
    for (const action of [
      'page.reopen', 'page.delete', 'notebook.delete',
      'attachment.delete', 'member.role_change', 'member.remove',
    ]) {
      assert.equal(requiresReason(policy, action), false, `${action} に理由は要らない`);
    }
  });

  test(`COMPLIANCE_MODE ${label}: 既存のページ操作の挙動が変わらない（理由なしで取消・削除できる）`, async () => {
    const { env, ctx } = await makeEnv(mode);
    const nb = (await createNotebook(env, ctx, { title: 'N' }, NOW)).data.notebook;
    const page = (await createPage(env, ctx, nb.id, { title: 'P' }, NOW)).data.page;

    assert.equal(
      (await patchPage(env, ctx, page.id, { status: 'closed' }, NOW)).status, 200, '確定できる'
    );
    // 理由を付けない確定取消も従来どおり通る（理由の必須化は別の指示書）
    const reopen = await patchPage(env, ctx, page.id, { status: 'draft' }, NOW);
    assert.equal(reopen.status, 200, '理由なしで確定取消できる');
    assert.equal(reopen.data.page.status, 'draft');
    assert.equal((await deletePage(env, ctx, page.id, NOW)).status, 200, '理由なしで削除できる');
  });
}
