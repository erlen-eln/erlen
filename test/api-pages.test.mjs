import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, sqlMissingTenantScope } from './d1-adapter.mjs';
import { createNotebook } from '../src/api/notebooks.mjs';
import { listPages, getPage, createPage, patchPage, deletePage } from '../src/api/pages.mjs';
import { saveMolecules } from '../src/api/molecules.mjs';

async function setup() {
  const t = createTestEnv();
  const nb = (await createNotebook(t.env, t.ctx, { title: '有機合成2026' })).data.notebook;
  return { ...t, notebookId: nb.id };
}

test('ページ作成→一覧→取得', async () => {
  const { env, ctx, notebookId } = await setup();
  const created = await createPage(env, ctx, notebookId, { title: 'アルドール縮合' });
  assert.equal(created.status, 201);
  assert.equal(created.data.page.status, 'draft');
  assert.equal(created.data.page.notebook_id, notebookId);
  assert.deepEqual(created.data.molecules, []);

  const list = await listPages(env, ctx, notebookId);
  assert.equal(list.status, 200);
  assert.equal(list.data.pages.length, 1);
  assert.equal(list.data.pages[0].content, undefined, '一覧は本文を返さない（転送量対策）');

  const one = await getPage(env, ctx, created.data.page.id);
  assert.equal(one.status, 200);
  assert.equal(one.data.page.title, 'アルドール縮合');
});

test('titleは必須・存在しないノートブックには作れない', async () => {
  const { env, ctx, notebookId } = await setup();
  assert.equal((await createPage(env, ctx, notebookId, { title: '  ' })).data.error, 'title_required');
  const r = await createPage(env, ctx, 'NOPE', { title: '実験' });
  assert.equal(r.status, 404);
  assert.equal(r.data.error, 'notebook_not_found');
});

test('PATCHで本文・実験日・状態を更新できる', async () => {
  const { env, ctx, notebookId } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '実験1' })).data.page;
  const r = await patchPage(env, ctx, page.id, {
    content: '# 手順\n1. 冷却する',
    experiment_date: '2026-07-15',
  }, '2026-07-15T09:00:00.000Z');
  assert.equal(r.status, 200);
  assert.equal(r.data.page.content, '# 手順\n1. 冷却する');
  assert.equal(r.data.page.experiment_date, '2026-07-15');
  assert.equal(r.data.page.updated_at, '2026-07-15T09:00:00.000Z');

  assert.equal((await patchPage(env, ctx, page.id, {})).data.error, 'no_fields');
  assert.equal((await patchPage(env, ctx, page.id, { status: 'archived' })).data.error, 'invalid_status');
  assert.equal((await patchPage(env, ctx, 'NOPE', { title: 'x' })).status, 404);
});

test('closedにしたページは編集も分子保存も409で拒否（記録の確定）', async () => {
  const { env, ctx, notebookId } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '確定する実験' })).data.page;
  await saveMolecules(env, ctx, page.id, { molecules: [{ name: '安息香酸' }] });

  const closed = await patchPage(env, ctx, page.id, { status: 'closed' });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.page.status, 'closed');

  const again = await patchPage(env, ctx, page.id, { content: 'こっそり書き換え' });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, 'page_closed');

  const mol = await saveMolecules(env, ctx, page.id, { molecules: [] });
  assert.equal(mol.status, 409);
  assert.equal(mol.data.error, 'page_closed');

  // 中身は守られている
  const after = await getPage(env, ctx, page.id);
  assert.equal(after.data.molecules.length, 1);
  assert.notEqual(after.data.page.content, 'こっそり書き換え');
});

test('確定の取り消しは通る（画面の「確定を取り消す」が効くこと）', async () => {
  const { env, ctx, notebookId } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '締めて開く実験' })).data.page;
  await patchPage(env, ctx, page.id, { content: '初回の記録' });
  await patchPage(env, ctx, page.id, { status: 'closed' });

  // 取り消しと同時に中身を書き換える指示は通さない（取り消しを経ない抜け道を作らない）
  const sneaky = await patchPage(env, ctx, page.id, { status: 'draft', content: 'こっそり' });
  assert.equal(sneaky.status, 409);
  assert.equal(sneaky.data.error, 'page_closed');
  assert.equal((await getPage(env, ctx, page.id)).data.page.status, 'closed', 'まだ確定のまま');

  // status を draft へ戻すだけなら通る
  const reopened = await patchPage(env, ctx, page.id, { status: 'draft' });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.page.status, 'draft');
  assert.equal(reopened.data.page.content, '初回の記録', '取り消しで中身が消えない');

  // 開いたあとは普通に編集でき、もう一度締められる
  assert.equal((await patchPage(env, ctx, page.id, { content: '追記' })).status, 200);
  assert.equal((await saveMolecules(env, ctx, page.id, { molecules: [{ name: 'トルエン' }] })).status, 200);
  assert.equal((await patchPage(env, ctx, page.id, { status: 'closed' })).data.page.status, 'closed');
});

test('DELETEは論理削除・確定済みでも一覧から下げられる', async () => {
  const { env, ctx, notebookId, DB } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '消す実験' })).data.page;
  await patchPage(env, ctx, page.id, { status: 'closed' });

  const del = await deletePage(env, ctx, page.id, '2026-07-20T00:00:00.000Z');
  assert.equal(del.status, 200);
  assert.equal((await getPage(env, ctx, page.id)).status, 404);
  assert.equal((await listPages(env, ctx, notebookId)).data.pages.length, 0);
  const row = DB.__raw.prepare('SELECT deleted_at, title FROM pages WHERE id = ?').get(page.id);
  assert.equal(row.deleted_at, '2026-07-20T00:00:00.000Z');
  assert.equal(row.title, '消す実験', '物理削除しない');
  assert.equal((await deletePage(env, ctx, page.id)).status, 404);
});

test('他テナントのページは見えない・触れない', async () => {
  const { env, ctx, otherCtx, notebookId } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '自分の実験' })).data.page;
  assert.equal((await getPage(env, otherCtx, page.id)).status, 404);
  assert.equal((await patchPage(env, otherCtx, page.id, { title: '乗っ取り' })).status, 404);
  assert.equal((await deletePage(env, otherCtx, page.id)).status, 404);
  assert.equal((await listPages(env, otherCtx, notebookId)).status, 404);
  assert.equal((await getPage(env, ctx, page.id)).data.page.title, '自分の実験');
});

test('全文検索の索引がページの追加・更新・削除に追随する（FTS同期トリガ）', async () => {
  const { env, ctx, notebookId, DB } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: 'ジアゾ化反応' })).data.page;
  await patchPage(env, ctx, page.id, { content: '氷冷下で亜硝酸ナトリウムを加えた' });

  const hit = DB.__raw.prepare(
    "SELECT rowid FROM pages_fts WHERE pages_fts MATCH '亜硝酸'"
  ).all();
  assert.equal(hit.length, 1);

  await patchPage(env, ctx, page.id, { content: '別の内容に差し替えた' });
  assert.equal(DB.__raw.prepare("SELECT rowid FROM pages_fts WHERE pages_fts MATCH '亜硝酸'").all().length, 0);
  assert.equal(DB.__raw.prepare("SELECT rowid FROM pages_fts WHERE pages_fts MATCH '差し替え'").all().length, 1);
});

test('発行された全SQLに tenant_id 条件が入っている', async () => {
  const { env, ctx, notebookId, DB } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '検査用' })).data.page;
  await listPages(env, ctx, notebookId);
  await getPage(env, ctx, page.id);
  await patchPage(env, ctx, page.id, { title: 'x', content: 'y', experiment_date: '2026-07-01', status: 'draft' });
  await deletePage(env, ctx, page.id);
  assert.deepEqual(sqlMissingTenantScope(DB.__sql), []);
});
