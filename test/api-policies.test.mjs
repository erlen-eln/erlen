// 方針（/api/policies）・理由コード（/api/reason-codes）・プロジェクト方針割り当ての検査。
// COMPLIANCE_MODE="1" の環境で動く前提（モード無しの 404 固定は compliance-off.test.mjs）。
// 書き込みはすべて commitWithAudit 経由で、1操作につき監査がちょうど1件残ることも見る。
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { signSession, SESSION_COOKIE, SESSION_TTL_MS } from '../src/auth.mjs';
import { addMember, createTestEnv, sqlMissingTenantScope } from './d1-adapter.mjs';
import {
  createPolicy, createReasonCode, deletePolicy, deleteReasonCode,
  listPolicies, listReasonCodes, patchPolicy, patchReasonCode, putProjectPolicy,
} from '../src/api/policies.mjs';
import { createProject } from '../src/api/projects.mjs';

const NOW = '2026-07-21T00:00:00.000Z';
const BASE = 'https://erlen.example.workers.dev';

// 規制モード有効のテスト環境
function envOn() {
  const t = createTestEnv();
  t.env.COMPLIANCE_MODE = '1';
  return t;
}

const auditCount = (DB) => DB.__raw.prepare(
  'SELECT COUNT(*) AS n FROM audit_events'
).get().n;
const lastAudit = (DB) => DB.__raw.prepare(
  'SELECT action, after_json FROM audit_events ORDER BY seq DESC LIMIT 1'
).get();

// 1回の呼び出しで監査がちょうど1件増えることを確認する
async function expectAudit(DB, label, action, fn) {
  const before = auditCount(DB);
  const out = await fn();
  assert.ok(out.status < 300, `${label}: 呼び出しが失敗 (${JSON.stringify(out).slice(0, 120)})`);
  assert.equal(auditCount(DB), before + 1, `${label}: 監査がちょうど1件増える`);
  assert.equal(lastAudit(DB).action, action, `${label}: action は ${action}`);
  return out;
}

test('方針: 作成・一覧・変更・削除と入力の検査', async () => {
  const { env, ctx, DB } = envOn();

  // name は必須
  assert.equal((await createPolicy(env, ctx, {}, NOW)).status, 400);
  assert.equal((await createPolicy(env, ctx, {}, NOW)).data.error, 'name_required');
  // 数値フィールド（session_max_min / idle_logout_min）は整数か null だけ
  assert.equal(
    (await createPolicy(env, ctx, { name: 'X', session_max_min: 1.5 }, NOW)).data.error,
    'invalid_number'
  );
  assert.equal(
    (await createPolicy(env, ctx, { name: 'X', session_max_min: 'abc' }, NOW)).data.error,
    'invalid_number'
  );

  const created = await expectAudit(DB, 'policy.create', 'policy.create',
    () => createPolicy(env, ctx, {
      name: 'GMP標準', require_reason: true, require_esign: true, session_max_min: 480,
    }, NOW));
  assert.equal(created.status, 201);
  const pid = created.data.policy.id;
  assert.equal(created.data.policy.require_reason, 1);
  assert.equal(created.data.policy.session_max_min, 480);
  assert.equal(created.data.policy.is_tenant_default, 0);

  const list = await listPolicies(env, ctx);
  assert.equal(list.data.policies.length, 1);
  assert.equal(list.data.policies[0].name, 'GMP標準');

  // 同名は409（name_taken）
  const dup = await createPolicy(env, ctx, { name: 'GMP標準' }, NOW);
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error, 'name_taken');

  // 変更
  const patched = await expectAudit(DB, 'policy.update', 'policy.update',
    () => patchPolicy(env, ctx, pid, { require_review_signoff: true, idle_logout_min: 30 }, NOW));
  assert.equal(patched.status, 200);
  assert.equal(patched.data.policy.require_review_signoff, 1);
  assert.equal(patched.data.policy.idle_logout_min, 30);

  // 変更で他の方針と同名になるのも409
  const other = (await createPolicy(env, ctx, { name: 'GLP標準' }, NOW)).data.policy;
  const dupPatch = await patchPolicy(env, ctx, other.id, { name: 'GMP標準' }, NOW);
  assert.equal(dupPatch.status, 409);
  assert.equal(dupPatch.data.error, 'name_taken');
  // 変更対象が無い指定は400
  assert.equal((await patchPolicy(env, ctx, pid, {}, NOW)).data.error, 'no_fields');
  // 存在しない方針は404
  assert.equal((await patchPolicy(env, ctx, 'NOPE', { name: 'y' }, NOW)).status, 404);
  assert.equal((await deletePolicy(env, ctx, 'NOPE', NOW)).status, 404);

  // 削除（論理削除）→ 一覧から消える・再削除は404
  await expectAudit(DB, 'policy.delete', 'policy.delete',
    () => deletePolicy(env, ctx, pid, NOW));
  assert.deepEqual(
    (await listPolicies(env, ctx)).data.policies.map((p) => p.name), ['GLP標準']
  );
  assert.equal((await deletePolicy(env, ctx, pid, NOW)).status, 404);
});

test('is_tenant_default はテナントに1つだけ（新しい既定で古い既定は同じbatchで下りる）', async () => {
  const { env, ctx, DB } = envOn();
  const defaults = () => DB.__raw.prepare(
    `SELECT id FROM compliance_policies
      WHERE tenant_id = ? AND is_tenant_default = 1 AND deleted_at IS NULL`
  ).all(ctx.tenantId).map((r) => r.id);

  const a = (await createPolicy(env, ctx, { name: 'A', is_tenant_default: true }, NOW)).data.policy;
  assert.deepEqual(defaults(), [a.id]);
  // 既定として作ると、既存の既定は下りる
  const b = (await createPolicy(env, ctx, { name: 'B', is_tenant_default: true }, NOW)).data.policy;
  assert.deepEqual(defaults(), [b.id], 'Bを既定で作るとAの既定は下りる');

  // 変更で既定を立てると、他の既定が同じbatchで下りる（action は専用の set_tenant_default）
  const c = (await createPolicy(env, ctx, { name: 'C' }, NOW)).data.policy;
  await expectAudit(DB, 'policy.set_tenant_default', 'policy.set_tenant_default',
    () => patchPolicy(env, ctx, c.id, { is_tenant_default: true }, NOW));
  assert.deepEqual(defaults(), [c.id], 'Cを既定にするとBの既定は下りる');

  // 既定の取り下げ（false）もできる
  await expectAudit(DB, 'policy.update(既定を下ろす)', 'policy.update',
    () => patchPolicy(env, ctx, c.id, { is_tenant_default: false }, NOW));
  assert.deepEqual(defaults(), [], '既定を下ろすと既定無しになる');
});

test('プロジェクトへの方針割り当て: 割り当て中は削除できず、外すと消せる', async () => {
  const { env, ctx, DB } = envOn();
  const pol = (await createPolicy(env, ctx, { name: '方針P' }, NOW)).data.policy;
  const pj = (await createProject(env, ctx, { name: '案件X' }, NOW)).data.project;

  await expectAudit(DB, 'project.policy_assign', 'project.policy_assign',
    () => putProjectPolicy(env, ctx, pj.id, { policy_id: pol.id }, NOW));
  // before/after は { policy_id, policy_name } の形
  const assigned = DB.__raw.prepare(
    `SELECT before_json, after_json FROM audit_events ORDER BY seq DESC LIMIT 1`
  ).get();
  assert.deepEqual(JSON.parse(assigned.before_json), { policy_id: null, policy_name: null });
  assert.deepEqual(JSON.parse(assigned.after_json), { policy_id: pol.id, policy_name: '方針P' });
  // プロジェクトの列が更新されている
  const row = DB.__raw.prepare(
    'SELECT compliance_policy_id FROM projects WHERE id = ? AND tenant_id = ?'
  ).get(pj.id, ctx.tenantId);
  assert.equal(row.compliance_policy_id, pol.id);

  // 割り当て中は削除できない（409 policy_in_use）
  const del = await deletePolicy(env, ctx, pol.id, NOW);
  assert.equal(del.status, 409);
  assert.equal(del.data.error, 'policy_in_use');

  // 外す（policy_id: null）と NO_POLICY 相当になり、削除できる
  await expectAudit(DB, 'project.policy_assign(解除)', 'project.policy_assign',
    () => putProjectPolicy(env, ctx, pj.id, { policy_id: null }, NOW));
  const unassigned = DB.__raw.prepare(
    `SELECT after_json FROM audit_events ORDER BY seq DESC LIMIT 1`
  ).get();
  assert.deepEqual(JSON.parse(unassigned.after_json), { policy_id: null, policy_name: null });
  assert.equal((await deletePolicy(env, ctx, pol.id, NOW)).status, 200);
});

test('プロジェクトへの方針割り当て: 入力と存在の検査', async () => {
  const { env, ctx, otherCtx } = envOn();
  const pj = (await createProject(env, ctx, { name: '案件Y' }, NOW)).data.project;

  // policy_id の指定自体が無いのは400
  assert.equal(
    (await putProjectPolicy(env, ctx, pj.id, {}, NOW)).data.error, 'policy_id_required'
  );
  // 存在しない方針は400
  const notFound = await putProjectPolicy(env, ctx, pj.id, { policy_id: 'NOPE' }, NOW);
  assert.equal(notFound.status, 400);
  assert.equal(notFound.data.error, 'policy_not_found');
  // 存在しないプロジェクトは404
  assert.equal(
    (await putProjectPolicy(env, ctx, 'NOPE', { policy_id: null }, NOW)).status, 404
  );
  // 別テナントの方針は割り当てられない（見えない＝存在しない扱い）
  const foreign = (await createPolicy(env, otherCtx, { name: '別テナント' }, NOW)).data.policy;
  const cross = await putProjectPolicy(env, ctx, pj.id, { policy_id: foreign.id }, NOW);
  assert.equal(cross.status, 400);
  assert.equal(cross.data.error, 'policy_not_found');
  // 論理削除済みの方針も割り当てられない
  const dead = (await createPolicy(env, ctx, { name: '消す予定' }, NOW)).data.policy;
  await deletePolicy(env, ctx, dead.id, NOW);
  const del = await putProjectPolicy(env, ctx, pj.id, { policy_id: dead.id }, NOW);
  assert.equal(del.data.error, 'policy_not_found');
});

test('理由コード: 作成・一覧（sort_no順）・変更・削除', async () => {
  const { env, ctx, DB } = envOn();

  // code と label_ja は必須
  assert.equal((await createReasonCode(env, ctx, {}, NOW)).data.error, 'code_required');
  assert.equal(
    (await createReasonCode(env, ctx, { code: 'C1' }, NOW)).data.error, 'label_ja_required'
  );

  const fix = await expectAudit(DB, 'reason_code.create', 'reason_code.create',
    () => createReasonCode(env, ctx, {
      code: 'FIX', label_ja: '記録の修正', label_en: 'Correction', sort_no: 2,
    }, NOW));
  assert.equal(fix.status, 201);
  const err = await expectAudit(DB, 'reason_code.create(2)', 'reason_code.create',
    () => createReasonCode(env, ctx, { code: 'ERR', label_ja: '誤記', sort_no: 1 }, NOW));

  // 一覧は sort_no 順・未削除のみ
  const list = await listReasonCodes(env, ctx);
  assert.deepEqual(list.data.reason_codes.map((r) => r.code), ['ERR', 'FIX']);

  // code の重複は409
  const dup = await createReasonCode(env, ctx, { code: 'FIX', label_ja: 'x' }, NOW);
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error, 'code_taken');

  // 変更（label・sort_no・code 自体も変えられる）
  const patched = await expectAudit(DB, 'reason_code.update', 'reason_code.update',
    () => patchReasonCode(env, ctx, fix.data.reason_code.id,
      { label_ja: '記録の修正（再）', sort_no: 0 }, NOW));
  assert.equal(patched.status, 200);
  assert.equal(patched.data.reason_code.label_ja, '記録の修正（再）');
  assert.equal(patched.data.reason_code.sort_no, 0);
  // 他のコードと同じ code への変更は409
  const dupPatch = await patchReasonCode(env, ctx, fix.data.reason_code.id, { code: 'ERR' }, NOW);
  assert.equal(dupPatch.data.error, 'code_taken');
  // 存在しないのは404・変更対象無しは400
  assert.equal((await patchReasonCode(env, ctx, 'NOPE', { label_ja: 'x' }, NOW)).status, 404);
  assert.equal((await patchReasonCode(env, ctx, fix.data.reason_code.id, {}, NOW)).status, 400);

  // 削除（論理削除）→ 一覧から消える
  await expectAudit(DB, 'reason_code.delete', 'reason_code.delete',
    () => deleteReasonCode(env, ctx, fix.data.reason_code.id, NOW));
  assert.deepEqual(
    (await listReasonCodes(env, ctx)).data.reason_codes.map((r) => r.code), ['ERR']
  );
  assert.equal((await deleteReasonCode(env, ctx, 'NOPE', NOW)).status, 404);
});

test('権限: 方針と理由コードの管理はオーナーだけ（理由コードの一覧は誰でも読める）', async () => {
  const { env } = envOn();
  env.ASSETS = { fetch: async () => new Response('<html>app</html>') };
  addMember(env, { id: 'sub-ed', email: 'ed@example.com', name: '部員', role: 'editor' });
  const cookie = `${SESSION_COOKIE}=${await signSession(
    { email: 'ed@example.com', expMs: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET
  )}`;
  const req = (path, { method = 'GET', body } = {}) => new Request(`${BASE}${path}`, {
    method,
    headers: {
      cookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // editor は方針の一覧すら403
  for (const [method, path, body] of [
    ['GET', '/api/policies', undefined],
    ['POST', '/api/policies', { name: 'x' }],
    ['PATCH', '/api/policies/X', { name: 'x' }],
    ['DELETE', '/api/policies/X', undefined],
    ['PUT', '/api/projects/X/policy', { policy_id: null }],
    ['POST', '/api/reason-codes', { code: 'c', label_ja: 'l' }],
    ['PATCH', '/api/reason-codes/X', { label_ja: 'l' }],
    ['DELETE', '/api/reason-codes/X', undefined],
  ]) {
    const res = await worker.fetch(req(path, { method, body }), env);
    assert.equal(res.status, 403, `${method} ${path} はオーナー以外 403（実際 ${res.status}）`);
  }
  // 理由コードの一覧だけはログイン中なら誰でも読める
  assert.equal((await worker.fetch(req('/api/reason-codes'), env)).status, 200);
});

test('方針まわりの全SQLに tenant_id 条件がある（実行SQLの動的検査）', async () => {
  const { env, ctx, DB } = envOn();
  const pol = (await createPolicy(env, ctx, { name: 'P' }, NOW)).data.policy;
  const pj = (await createProject(env, ctx, { name: 'PJ' }, NOW)).data.project;
  const rc = (await createReasonCode(env, ctx, { code: 'C', label_ja: 'L' }, NOW))
    .data.reason_code;

  DB.__sql.length = 0; // ここから記録し直す
  await listPolicies(env, ctx);
  await patchPolicy(env, ctx, pol.id, { require_reason: true, is_tenant_default: true }, NOW);
  await putProjectPolicy(env, ctx, pj.id, { policy_id: pol.id }, NOW);
  await putProjectPolicy(env, ctx, pj.id, { policy_id: null }, NOW);
  await deletePolicy(env, ctx, pol.id, NOW); // policy_in_use 検査＋論理削除のUPDATE
  await listReasonCodes(env, ctx);
  await patchReasonCode(env, ctx, rc.id, { label_ja: 'L2' }, NOW);
  await deleteReasonCode(env, ctx, rc.id, NOW);

  assert.deepEqual(sqlMissingTenantScope(DB.__sql), []);
});
