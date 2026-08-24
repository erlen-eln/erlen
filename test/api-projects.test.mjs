// プロジェクトAPI（作成・変更・削除・閲覧可能メンバーの一括置換）。
// 「設定したつもりで設定できていない」を作らないことに重点を置く。
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMember, createTestEnv, sqlMissingTenantScope } from './d1-adapter.mjs';
import {
  createProject, deleteProject, getProject, listProjects, patchProject, putProjectMembers,
} from '../src/api/projects.mjs';
import { createNotebook, getNotebook, listNotebooks } from '../src/api/notebooks.mjs';

const NOW = '2026-07-05T00:00:00.000Z';

test('作成: 名前は必須。空白だけの名前も弾く', async () => {
  const { env, ctx } = createTestEnv();
  assert.equal((await createProject(env, ctx, {}, NOW)).status, 400);
  assert.equal((await createProject(env, ctx, { name: '   ' }, NOW)).status, 400);

  const r = await createProject(env, ctx, { name: '  不斉触媒開発 ', description: '配位子の探索' }, NOW);
  assert.equal(r.status, 201);
  assert.equal(r.data.project.name, '不斉触媒開発');
  assert.deepEqual(r.data.members, [], '作りたては閲覧可能メンバー0人');
});

test('一覧: ノートブック数を添えて返す', async () => {
  const { env, ctx } = createTestEnv();
  const p = (await createProject(env, ctx, { name: 'P1' }, NOW)).data.project;
  await createProject(env, ctx, { name: 'P2' }, NOW);
  await createNotebook(env, ctx, { title: 'NB1', project_id: p.id }, NOW);
  await createNotebook(env, ctx, { title: 'NB2', project_id: p.id }, NOW);

  const r = await listProjects(env, ctx);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.projects.map((x) => [x.name, x.notebook_count]), [['P1', 2], ['P2', 0]]);
});

test('変更・削除: よそのテナントからは触れない', async () => {
  const { env, ctx, otherCtx } = createTestEnv();
  const p = (await createProject(env, ctx, { name: 'P1' }, NOW)).data.project;

  assert.equal((await getProject(env, otherCtx, p.id)).status, 404);
  assert.equal((await patchProject(env, otherCtx, p.id, { name: 'のっとり' }, NOW)).status, 404);
  assert.equal((await deleteProject(env, otherCtx, p.id, NOW)).status, 404);
  assert.equal((await getProject(env, ctx, p.id)).data.project.name, 'P1', '無傷');
});

test('変更: 更新する項目が無ければ400', async () => {
  const { env, ctx } = createTestEnv();
  const p = (await createProject(env, ctx, { name: 'P1' }, NOW)).data.project;
  assert.equal((await patchProject(env, ctx, p.id, {}, NOW)).status, 400);
  assert.equal((await patchProject(env, ctx, p.id, { name: '' }, NOW)).status, 400);
  assert.equal((await patchProject(env, ctx, 'NOPE', { name: 'x' }, NOW)).status, 404);

  const r = await patchProject(env, ctx, p.id, { name: 'P1改', description: 'あとがき' }, NOW);
  assert.equal(r.data.project.name, 'P1改');
  assert.equal(r.data.project.description, 'あとがき');
});

test('削除: ノートブックは巻き添えにせず、プロジェクトなしへ戻す', async () => {
  const { env, ctx } = createTestEnv();
  const editor = addMember(env, { id: 'sub-e', email: 'e@example.com', role: 'editor' });
  const p = (await createProject(env, ctx, { name: 'P1' }, NOW)).data.project;
  const nb = (await createNotebook(env, ctx, { title: 'NB1', project_id: p.id }, NOW)).data.notebook;
  await putProjectMembers(env, ctx, p.id, { user_ids: [editor.userId] }, NOW);

  assert.equal((await listNotebooks(env, editor)).data.notebooks.length, 1, '削除前は見えている');
  assert.equal((await deleteProject(env, ctx, p.id, NOW)).status, 200);
  assert.equal((await deleteProject(env, ctx, p.id, NOW)).status, 404, '2回目は無い');

  const after = await getNotebook(env, ctx, nb.id);
  assert.equal(after.status, 200, 'ノートブックは残る');
  assert.equal(after.data.notebook.project_id, null, 'プロジェクトなしへ戻る');
  // プロジェクトが消えた＝閲覧範囲の壁も消えたので、全員に見える状態へ戻る
  assert.equal((await listNotebooks(env, editor)).data.notebooks.length, 1);
  assert.equal(
    env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM project_members').get().n, 0,
    '閲覧可能メンバーの行も片付ける'
  );
});

test('閲覧可能メンバー: 一括置換で、外した人はきちんと消える', async () => {
  const { env, ctx } = createTestEnv();
  const e1 = addMember(env, { id: 'sub-a', email: 'a@example.com', role: 'editor' });
  const e2 = addMember(env, { id: 'sub-b', email: 'b@example.com', role: 'viewer' });
  const p = (await createProject(env, ctx, { name: 'P1' }, NOW)).data.project;

  const both = await putProjectMembers(env, ctx, p.id, { user_ids: [e1.userId, e2.userId] }, NOW);
  assert.equal(both.status, 200);
  assert.deepEqual(both.data.members.map((m) => m.email), ['a@example.com', 'b@example.com']);

  // 差分ではなく置換。b を外したら本当に消えていること
  const one = await putProjectMembers(env, ctx, p.id, { user_ids: [e1.userId] }, NOW);
  assert.deepEqual(one.data.members.map((m) => m.email), ['a@example.com']);
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM project_members').get().n, 1);

  // 空配列は「全員外す」。undefined（キー無し）とは区別する
  assert.deepEqual((await putProjectMembers(env, ctx, p.id, { user_ids: [] }, NOW)).data.members, []);
  assert.equal((await putProjectMembers(env, ctx, p.id, {}, NOW)).status, 400);
});

test('閲覧可能メンバー: 知らないIDは黙って捨てず400で突き返す', async () => {
  const { env, ctx, otherCtx } = createTestEnv();
  addMember(env, { id: 'sub-yoso', email: 'yoso@example.com', role: 'editor', tenantId: otherCtx.tenantId });
  const p = (await createProject(env, ctx, { name: 'P1' }, NOW)).data.project;

  const unknown = await putProjectMembers(env, ctx, p.id, { user_ids: ['NOPE'] }, NOW);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.data.error, 'unknown_user');
  // よそのテナントの人も「知らないID」として弾く
  assert.equal((await putProjectMembers(env, ctx, p.id, { user_ids: ['sub-yoso'] }, NOW)).status, 400);
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM project_members').get().n, 0);

  assert.equal((await putProjectMembers(env, ctx, 'NOPE', { user_ids: [] }, NOW)).status, 404);
});

test('閲覧可能メンバー: 同じIDを重ねて送ってもUNIQUEで落ちない', async () => {
  const { env, ctx } = createTestEnv();
  const e1 = addMember(env, { id: 'sub-a', email: 'a@example.com', role: 'editor' });
  const p = (await createProject(env, ctx, { name: 'P1' }, NOW)).data.project;

  const r = await putProjectMembers(env, ctx, p.id, { user_ids: [e1.userId, e1.userId] }, NOW);
  assert.equal(r.status, 200);
  assert.equal(r.data.members.length, 1);
});

test('プロジェクトの全SQLがtenant_idで絞られている', async () => {
  const { env, ctx } = createTestEnv();
  const e1 = addMember(env, { id: 'sub-a', email: 'a@example.com', role: 'editor' });
  const p = (await createProject(env, ctx, { name: 'P1' }, NOW)).data.project;
  await listProjects(env, ctx);
  await getProject(env, ctx, p.id);
  await patchProject(env, ctx, p.id, { name: 'P2' }, NOW);
  await putProjectMembers(env, ctx, p.id, { user_ids: [e1.userId] }, NOW);
  await listProjects(env, e1);
  await deleteProject(env, ctx, p.id, NOW);
  assert.deepEqual(sqlMissingTenantScope(env.DB.__sql), []);
});
