// 「どの方針が効くか」の解決範囲（スコープ）の検査。
// プロジェクトに割り当てた方針だけが、そのプロジェクトのノートブック・ページに効く。
// 別のプロジェクト・プロジェクトに属さないノートブック・論理削除済みの方針には効かない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv } from './d1-adapter.mjs';
import {
  NO_POLICY, policyForNotebook, policyForPage, requiresReason, tenantDefaultPolicy,
} from '../src/compliance.mjs';
import { createPolicy, putProjectPolicy } from '../src/api/policies.mjs';
import { createProject } from '../src/api/projects.mjs';
import { createNotebook } from '../src/api/notebooks.mjs';
import { createPage } from '../src/api/pages.mjs';

const NOW = '2026-07-22T00:00:00.000Z';

function envOn() {
  const t = createTestEnv();
  t.env.COMPLIANCE_MODE = '1';
  return t;
}

test('プロジェクトに割り当てた方針が、そのプロジェクトのページ・ノートブックにだけ効く', async () => {
  const { env, ctx } = envOn();
  const pol = (await createPolicy(env, ctx, {
    name: 'GMP標準', require_reason: true, require_esign: true,
  }, NOW)).data.policy;
  const pjA = (await createProject(env, ctx, { name: '案件A' }, NOW)).data.project;
  const pjB = (await createProject(env, ctx, { name: '案件B' }, NOW)).data.project;
  const nbA = (await createNotebook(env, ctx, { title: 'NA', project_id: pjA.id }, NOW))
    .data.notebook;
  const nbB = (await createNotebook(env, ctx, { title: 'NB', project_id: pjB.id }, NOW))
    .data.notebook;
  const nbFree = (await createNotebook(env, ctx, { title: 'NF' }, NOW)).data.notebook;
  const pgA = (await createPage(env, ctx, nbA.id, { title: 'PA' }, NOW)).data.page;
  const pgB = (await createPage(env, ctx, nbB.id, { title: 'PB' }, NOW)).data.page;
  const pgFree = (await createPage(env, ctx, nbFree.id, { title: 'PF' }, NOW)).data.page;

  // 割り当て前は全て NO_POLICY
  assert.equal(await policyForPage(env, ctx, pgA.id), NO_POLICY);
  assert.equal(await policyForNotebook(env, ctx, nbA.id), NO_POLICY);

  // 案件Aに方針を割り当てる → Aのページとノートブックにだけ効く
  assert.equal(
    (await putProjectPolicy(env, ctx, pjA.id, { policy_id: pol.id }, NOW)).status, 200
  );
  const eff = await policyForPage(env, ctx, pgA.id);
  assert.equal(eff.id, pol.id);
  assert.equal(eff.require_reason, 1);
  assert.equal(eff.require_esign, 1);
  assert.equal((await policyForNotebook(env, ctx, nbA.id)).id, pol.id);
  // 別のプロジェクト・プロジェクトに属さないノートブックには効かない
  assert.equal(await policyForPage(env, ctx, pgB.id), NO_POLICY);
  assert.equal(await policyForNotebook(env, ctx, nbB.id), NO_POLICY);
  assert.equal(await policyForPage(env, ctx, pgFree.id), NO_POLICY);
  assert.equal(await policyForNotebook(env, ctx, nbFree.id), NO_POLICY);

  // requiresReason は「効いている方針 × 対象の操作」のときだけ true
  assert.equal(requiresReason(eff, 'page.delete'), true);
  assert.equal(requiresReason(eff, 'page.reopen'), true);
  assert.equal(requiresReason(eff, 'notebook.delete'), true);
  assert.equal(requiresReason(eff, 'page.create'), false, '作成系は理由を要求しない');
  assert.equal(requiresReason(eff, 'page.update'), false);
  assert.equal(requiresReason(NO_POLICY, 'page.delete'), false, '方針無しなら要求しない');

  // 方針を外すと NO_POLICY に戻る
  assert.equal(
    (await putProjectPolicy(env, ctx, pjA.id, { policy_id: null }, NOW)).status, 200
  );
  assert.equal(await policyForPage(env, ctx, pgA.id), NO_POLICY);
  assert.equal(await policyForNotebook(env, ctx, nbA.id), NO_POLICY);
});

test('論理削除した方針は効かない（割り当てを残したまま deleted_at が立った場合）', async () => {
  const { env, ctx, DB } = envOn();
  const pol = (await createPolicy(env, ctx, { name: '方針P' }, NOW)).data.policy;
  const pj = (await createProject(env, ctx, { name: '案件' }, NOW)).data.project;
  const nb = (await createNotebook(env, ctx, { title: 'N', project_id: pj.id }, NOW))
    .data.notebook;
  const pg = (await createPage(env, ctx, nb.id, { title: 'P1' }, NOW)).data.page;
  await putProjectPolicy(env, ctx, pj.id, { policy_id: pol.id }, NOW);
  assert.equal((await policyForPage(env, ctx, pg.id)).id, pol.id);

  // deletePolicy は割り当て中を 409 で断るので、ここでは直接 deleted_at を立てて再現する
  DB.__raw.prepare(
    `UPDATE compliance_policies SET deleted_at = ? WHERE id = ? AND tenant_id = ?`
  ).run(NOW, pol.id, ctx.tenantId);
  assert.equal(await policyForPage(env, ctx, pg.id), NO_POLICY);
  assert.equal(await policyForNotebook(env, ctx, nb.id), NO_POLICY);
});

test('テナント既定の方針は tenantDefaultPolicy でだけ効く（ページには自動では乗らない）', async () => {
  const { env, ctx } = envOn();
  assert.equal(await tenantDefaultPolicy(env, ctx), NO_POLICY);

  const pol = (await createPolicy(env, ctx, {
    name: '既定方針', is_tenant_default: true, require_reason: true,
  }, NOW)).data.policy;
  const got = await tenantDefaultPolicy(env, ctx);
  assert.equal(got.id, pol.id);
  assert.equal(got.require_reason, 1);

  // 既定はテナント操作（メンバー管理等）向けの解決。
  // プロジェクトに割り当てていないページ・ノートブックに既定は乗らない
  const nb = (await createNotebook(env, ctx, { title: 'N' }, NOW)).data.notebook;
  const pg = (await createPage(env, ctx, nb.id, { title: 'P' }, NOW)).data.page;
  assert.equal(await policyForPage(env, ctx, pg.id), NO_POLICY);
  assert.equal(await policyForNotebook(env, ctx, nb.id), NO_POLICY);
});
