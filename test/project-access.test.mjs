// プロジェクトの閲覧範囲。
//
// 「隠したはずのノートが、別の入口からは見えていた」が起きやすい場所なので、
// 一覧・単体・ページ・分子・添付・検索・印刷レポートの全経路を1本ずつ潰す。
// 存在ごと隠す約束なので、期待するのは 403 ではなく 404。
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMember, createTestEnv } from './d1-adapter.mjs';
import { createProject, putProjectMembers } from '../src/api/projects.mjs';
import {
  createNotebook, deleteNotebook, getNotebook, listNotebooks, patchNotebook,
} from '../src/api/notebooks.mjs';
import { createPage, deletePage, getPage, listPages, patchPage } from '../src/api/pages.mjs';
import { saveMolecules } from '../src/api/molecules.mjs';
import { createAttachment, getAttachment, listAttachments } from '../src/api/attachments.mjs';
import { searchPages } from '../src/api/search.mjs';
import { buildPageReport } from '../src/api/report.mjs';

const NOW = '2026-07-05T00:00:00.000Z';

// オーナー・部内の editor・部外の editor と、
// 「部内プロジェクトのノート」「プロジェクトなしのノート」を1組ずつ用意する
async function makeLab() {
  const { env, ctx } = createTestEnv();
  const inside = addMember(env, { id: 'sub-in', email: 'in@example.com', role: 'editor' });
  const outside = addMember(env, { id: 'sub-out', email: 'out@example.com', role: 'editor' });
  const viewer = addMember(env, { id: 'sub-v', email: 'v@example.com', role: 'viewer' });

  const project = (await createProject(env, ctx, { name: '極秘プロジェクト' }, NOW)).data.project;
  await putProjectMembers(env, ctx, project.id, { user_ids: [inside.userId, viewer.userId] }, NOW);

  const secret = (await createNotebook(
    env, ctx, { title: '極秘ノート', project_id: project.id }, NOW
  )).data.notebook;
  const open = (await createNotebook(env, ctx, { title: '共用ノート' }, NOW)).data.notebook;

  const secretPage = (await createPage(
    env, ctx, secret.id, { title: '極秘の実験', experiment_date: '2026-07-01' }, NOW
  )).data.page;
  const openPage = (await createPage(env, ctx, open.id, { title: '共用の実験' }, NOW)).data.page;
  await patchPage(env, ctx, secretPage.id, { content: 'トシル化の検討' }, NOW);
  await patchPage(env, ctx, openPage.id, { content: 'トシル化の予備検討' }, NOW);

  return { env, ctx, inside, outside, viewer, project, secret, open, secretPage, openPage };
}

test('一覧: 部外の人にはプロジェクトのノートブックが出ない', async () => {
  const { env, ctx, inside, outside } = await makeLab();

  assert.deepEqual(
    (await listNotebooks(env, ctx)).data.notebooks.map((n) => n.title),
    ['極秘ノート', '共用ノート'], 'オーナーは全部見える'
  );
  assert.deepEqual(
    (await listNotebooks(env, inside)).data.notebooks.map((n) => n.title),
    ['極秘ノート', '共用ノート'], '閲覧可能メンバーは見える'
  );
  assert.deepEqual(
    (await listNotebooks(env, outside)).data.notebooks.map((n) => n.title),
    ['共用ノート'], 'プロジェクト未設定のノートだけが見える'
  );
});

test('単体: 部外の人が直接IDを叩いても404（403にしない）', async () => {
  const { env, inside, outside, secret, open } = await makeLab();

  assert.equal((await getNotebook(env, inside, secret.id)).status, 200);
  const denied = await getNotebook(env, outside, secret.id);
  assert.equal(denied.status, 404);
  assert.equal(denied.data.error, 'not_found');
  assert.equal((await getNotebook(env, outside, open.id)).status, 200);
});

test('書き込み: 部外の人はノートブックを書き換えも削除もできない', async () => {
  const { env, ctx, outside, secret } = await makeLab();

  assert.equal((await patchNotebook(env, outside, secret.id, { title: 'のっとり' }, NOW)).status, 404);
  assert.equal((await deleteNotebook(env, outside, secret.id, NOW)).status, 404);
  // 弾いたふりでないことを、中身とDBの行で裏取りする
  const after = await getNotebook(env, ctx, secret.id);
  assert.equal(after.data.notebook.title, '極秘ノート');
  assert.equal(
    env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM notebooks WHERE deleted_at IS NULL').get().n, 2
  );
});

test('ページ: 一覧も単体も、部外の人には見えない', async () => {
  const { env, inside, outside, secret, secretPage } = await makeLab();

  assert.equal((await listPages(env, inside, secret.id)).data.pages.length, 1);
  const listed = await listPages(env, outside, secret.id);
  assert.equal(listed.status, 404);
  assert.equal(listed.data.error, 'notebook_not_found');

  assert.equal((await getPage(env, inside, secretPage.id)).status, 200);
  assert.equal((await getPage(env, outside, secretPage.id)).status, 404);
});

test('ページ: 部外の人は作成・更新・削除もできない', async () => {
  const { env, ctx, outside, secret, secretPage } = await makeLab();

  assert.equal((await createPage(env, outside, secret.id, { title: '割り込み' }, NOW)).status, 404);
  assert.equal((await patchPage(env, outside, secretPage.id, { content: '改ざん' }, NOW)).status, 404);
  assert.equal((await deletePage(env, outside, secretPage.id, NOW)).status, 404);

  const after = await getPage(env, ctx, secretPage.id);
  assert.equal(after.data.page.content, 'トシル化の検討', '本文は無傷');
  assert.equal(
    env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL').get().n, 2
  );
});

test('分子: 部外の人は反応テーブルを保存できない', async () => {
  const { env, ctx, inside, outside, secretPage } = await makeLab();

  const ok = await saveMolecules(env, inside, secretPage.id, {
    molecules: [{ name: 'ベンズアルデヒド', smiles: 'O=Cc1ccccc1', molecular_weight: 106.12 }],
  }, NOW);
  assert.equal(ok.status, 200);

  const denied = await saveMolecules(env, outside, secretPage.id, {
    molecules: [{ name: 'のっとり' }],
  }, NOW);
  assert.equal(denied.status, 404);
  assert.deepEqual(
    (await getPage(env, ctx, secretPage.id)).data.molecules.map((m) => m.name),
    ['ベンズアルデヒド']
  );
});

test('添付: 部外の人は一覧も追加もダウンロードもできない', async () => {
  const { env, ctx, inside, outside, secretPage } = await makeLab();

  const made = await createAttachment(env, ctx, secretPage.id, {
    bytes: new TextEncoder().encode('spectrum').buffer,
    contentType: 'text/plain',
    fileName: 'nmr.txt',
  }, NOW);
  assert.equal(made.status, 201);
  const attachmentId = made.data.attachment.id;

  assert.equal((await listAttachments(env, inside, secretPage.id)).status, 200);
  assert.equal((await getAttachment(env, inside, attachmentId)).status, 200);

  assert.equal((await listAttachments(env, outside, secretPage.id)).status, 404);
  assert.equal((await getAttachment(env, outside, attachmentId)).status, 404);
  assert.equal((await createAttachment(env, outside, secretPage.id, {
    bytes: new TextEncoder().encode('x').buffer, contentType: 'text/plain', fileName: 'x.txt',
  }, NOW)).status, 404);
});

test('検索: 部外の人のヒットからは、隠したページが落ちる', async () => {
  const { env, ctx, inside, outside } = await makeLab();

  // 3文字以上＝FTS経路
  assert.deepEqual(
    (await searchPages(env, ctx, { q: 'トシル化' })).data.results.map((r) => r.pageTitle).sort(),
    ['共用の実験', '極秘の実験'].sort(), 'オーナーは両方ヒット'
  );
  assert.deepEqual(
    (await searchPages(env, inside, { q: 'トシル化' })).data.results.map((r) => r.pageTitle).sort(),
    ['共用の実験', '極秘の実験'].sort()
  );
  const denied = await searchPages(env, outside, { q: 'トシル化' });
  assert.equal(denied.data.mode, 'fts');
  assert.deepEqual(denied.data.results.map((r) => r.pageTitle), ['共用の実験']);
});

test('検索: 2文字以下のLIKE経路でも、隠したページは出ない', async () => {
  const { env, outside } = await makeLab();
  const r = await searchPages(env, outside, { q: '実験' });
  assert.equal(r.data.mode, 'like', 'trigramに載らない語はLIKEへ落ちる');
  assert.deepEqual(r.data.results.map((x) => x.pageTitle), ['共用の実験']);
});

test('印刷レポート: 部外の人には出せない（画面を経由しない直リンクでも）', async () => {
  const { env, inside, outside, secretPage, openPage } = await makeLab();

  assert.equal((await buildPageReport(env, inside, secretPage.id, NOW)).status, 200);
  assert.equal((await buildPageReport(env, outside, secretPage.id, NOW)).status, 404);
  assert.equal((await buildPageReport(env, outside, openPage.id, NOW)).status, 200);
});

test('閲覧可能メンバーから外すと、その場で見えなくなる', async () => {
  const { env, ctx, inside, project, secret, secretPage } = await makeLab();
  assert.equal((await getNotebook(env, inside, secret.id)).status, 200);

  await putProjectMembers(env, ctx, project.id, { user_ids: [] }, NOW);

  assert.equal((await getNotebook(env, inside, secret.id)).status, 404);
  assert.equal((await getPage(env, inside, secretPage.id)).status, 404);
  assert.deepEqual((await listNotebooks(env, inside)).data.notebooks.map((n) => n.title), ['共用ノート']);
});

test('ノートブックをプロジェクトへ移すと、部外の人から消える', async () => {
  const { env, ctx, outside, project, open } = await makeLab();
  assert.equal((await getNotebook(env, outside, open.id)).status, 200);

  const moved = await patchNotebook(env, ctx, open.id, { project_id: project.id }, NOW);
  assert.equal(moved.status, 200);
  assert.equal(moved.data.notebook.project_id, project.id);

  assert.equal((await getNotebook(env, outside, open.id)).status, 404);
  assert.deepEqual((await listNotebooks(env, outside)).data.notebooks, []);
});

test('実在しないプロジェクトを指したノートブックは作れない', async () => {
  const { env, ctx, outside } = await makeLab();
  assert.equal((await createNotebook(env, ctx, { title: 'x', project_id: 'NOPE' }, NOW)).status, 400);
  assert.equal((await patchNotebook(env, ctx, 'NOPE', { project_id: 'NOPE' }, NOW)).status, 404);
  // 空文字は「プロジェクトなし」。ここを弾くと、外す操作ができなくなる
  const free = await createNotebook(env, ctx, { title: '自由帳', project_id: '' }, NOW);
  assert.equal(free.status, 201);
  assert.equal(free.data.notebook.project_id, null);
  assert.equal((await getNotebook(env, outside, free.data.notebook.id)).status, 200);
});

test('プロジェクト一覧は、閲覧可能メンバーに入っているものだけを返す', async () => {
  const { env, ctx, inside, outside } = await makeLab();
  const { listProjects } = await import('../src/api/projects.mjs');

  assert.deepEqual((await listProjects(env, ctx)).data.projects.map((p) => p.name), ['極秘プロジェクト']);
  assert.deepEqual((await listProjects(env, inside)).data.projects.map((p) => p.name), ['極秘プロジェクト']);
  assert.deepEqual((await listProjects(env, outside)).data.projects, []);
});

// ---- 公開デモ（DEMO_MODE="1"）------------------------------------------
// デモは「中身を見せる」のが目的なので、プロジェクトで隠さない（src/access.mjs の seesEverything）。
// 書き込みは worker.mjs の一括ガードが viewer として断る（test/permissions.test.mjs）
function demoCtx(ctx) {
  return {
    userId: 'demo', tenantId: ctx.tenantId, email: 'guest@example.com',
    name: '', role: 'viewer', demo: true,
  };
}

test('デモの閲覧者にはプロジェクト配下のノートブックも見える', async () => {
  const { env, ctx, secret, secretPage } = await makeLab();
  const demo = demoCtx(ctx);

  assert.deepEqual(
    (await listNotebooks(env, demo)).data.notebooks.map((n) => n.title),
    ['極秘ノート', '共用ノート']
  );
  assert.equal((await getNotebook(env, demo, secret.id)).status, 200);
  assert.deepEqual(
    (await listPages(env, demo, secret.id)).data.pages.map((p) => p.title), ['極秘の実験']
  );
  assert.equal((await getPage(env, demo, secretPage.id)).status, 200);
  assert.equal((await buildPageReport(env, demo, secretPage.id)).status, 200);
});

test('デモの閲覧者にはプロジェクトそのものも見える', async () => {
  const { env, ctx } = await makeLab();
  const { listProjects } = await import('../src/api/projects.mjs');
  assert.deepEqual(
    (await listProjects(env, demoCtx(ctx))).data.projects.map((p) => p.name), ['極秘プロジェクト']
  );
});

test('デモの閲覧者の検索は、隠しノートも含めて拾う', async () => {
  const { env, ctx } = await makeLab();
  const hits = (await searchPages(env, demoCtx(ctx), { q: 'トシル化' })).data.results;
  assert.deepEqual(hits.map((h) => h.pageTitle).sort(), ['共用の実験', '極秘の実験']);
});
