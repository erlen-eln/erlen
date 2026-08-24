import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, sqlMissingTenantScope } from './d1-adapter.mjs';
import {
  listNotebooks, getNotebook, createNotebook, patchNotebook, deleteNotebook,
} from '../src/api/notebooks.mjs';
import { createPage, listPages } from '../src/api/pages.mjs';

test('作成→一覧→取得の往復', async () => {
  const { env, ctx } = createTestEnv();
  const created = await createNotebook(env, ctx, { title: '有機合成2026', description: '第1期' });
  assert.equal(created.status, 201);
  assert.equal(created.data.notebook.title, '有機合成2026');
  assert.equal(created.data.notebook.description, '第1期');

  const list = await listNotebooks(env, ctx);
  assert.equal(list.status, 200);
  assert.equal(list.data.notebooks.length, 1);

  const one = await getNotebook(env, ctx, created.data.notebook.id);
  assert.equal(one.status, 200);
  assert.equal(one.data.notebook.id, created.data.notebook.id);
});

test('titleは必須', async () => {
  const { env, ctx } = createTestEnv();
  for (const body of [{}, { title: '' }, { title: '   ' }, { title: null }]) {
    const r = await createNotebook(env, ctx, body);
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'title_required');
  }
});

test('並び順は sort_order → updated_at の順', async () => {
  const { env, ctx } = createTestEnv();
  const a = await createNotebook(env, ctx, { title: 'A' }, '2026-07-01T00:00:00.000Z');
  const b = await createNotebook(env, ctx, { title: 'B' }, '2026-07-02T00:00:00.000Z');
  const c = await createNotebook(env, ctx, { title: 'C' }, '2026-07-03T00:00:00.000Z');
  // 既定は全部sort_order=0なので、更新の新しい順に並ぶ
  let list = await listNotebooks(env, ctx);
  assert.deepEqual(list.data.notebooks.map((x) => x.title), ['C', 'B', 'A']);

  await patchNotebook(env, ctx, a.data.notebook.id, { sort_order: -1 }, '2026-07-04T00:00:00.000Z');
  list = await listNotebooks(env, ctx);
  assert.deepEqual(list.data.notebooks.map((x) => x.title), ['A', 'C', 'B']);
  assert.ok(b.data.notebook.id !== c.data.notebook.id);
});

test('PATCHは指定した項目だけ変える・空指定は400', async () => {
  const { env, ctx } = createTestEnv();
  const created = await createNotebook(env, ctx, { title: '旧題', description: '説明' });
  const id = created.data.notebook.id;

  const patched = await patchNotebook(env, ctx, id, { title: '新題' }, '2026-07-05T00:00:00.000Z');
  assert.equal(patched.status, 200);
  assert.equal(patched.data.notebook.title, '新題');
  assert.equal(patched.data.notebook.description, '説明', '触っていない項目は残る');
  assert.equal(patched.data.notebook.updated_at, '2026-07-05T00:00:00.000Z');

  assert.equal((await patchNotebook(env, ctx, id, {})).status, 400);
  assert.equal((await patchNotebook(env, ctx, id, { title: '' })).data.error, 'title_required');
  assert.equal((await patchNotebook(env, ctx, 'NOPE', { title: 'x' })).status, 404);
});

test('DELETEは論理削除（行は残り、一覧から消え、配下ページも伏せる）', async () => {
  const { env, ctx, DB } = createTestEnv();
  const nb = (await createNotebook(env, ctx, { title: '削除対象' })).data.notebook;
  await createPage(env, ctx, nb.id, { title: '実験1' });

  const del = await deleteNotebook(env, ctx, nb.id, '2026-07-09T00:00:00.000Z');
  assert.equal(del.status, 200);
  assert.equal((await listNotebooks(env, ctx)).data.notebooks.length, 0);
  assert.equal((await getNotebook(env, ctx, nb.id)).status, 404);
  assert.equal((await listPages(env, ctx, nb.id)).status, 404, '親が消えたらページ一覧も404');

  // 物理削除されていないこと（実験ノートは消さない）
  const row = DB.__raw.prepare('SELECT deleted_at FROM notebooks WHERE id = ?').get(nb.id);
  assert.equal(row.deleted_at, '2026-07-09T00:00:00.000Z');
  const page = DB.__raw.prepare('SELECT deleted_at FROM pages WHERE notebook_id = ?').get(nb.id);
  assert.equal(page.deleted_at, '2026-07-09T00:00:00.000Z');

  // 二重削除は404
  assert.equal((await deleteNotebook(env, ctx, nb.id)).status, 404);
});

test('他テナントのノートブックは見えない・触れない', async () => {
  const { env, ctx, otherCtx } = createTestEnv();
  const mine = (await createNotebook(env, ctx, { title: '自分の' })).data.notebook;
  await createNotebook(env, otherCtx, { title: 'よその' });

  assert.deepEqual((await listNotebooks(env, ctx)).data.notebooks.map((x) => x.title), ['自分の']);
  assert.equal((await getNotebook(env, otherCtx, mine.id)).status, 404);
  assert.equal((await patchNotebook(env, otherCtx, mine.id, { title: '乗っ取り' })).status, 404);
  assert.equal((await deleteNotebook(env, otherCtx, mine.id)).status, 404);
  assert.equal((await getNotebook(env, ctx, mine.id)).data.notebook.title, '自分の');
});

test('発行された全SQLに tenant_id 条件が入っている', async () => {
  const { env, ctx, DB } = createTestEnv();
  const nb = (await createNotebook(env, ctx, { title: '検査用' })).data.notebook;
  await listNotebooks(env, ctx);
  await getNotebook(env, ctx, nb.id);
  await patchNotebook(env, ctx, nb.id, { title: 'x', description: 'y', sort_order: 2 });
  await deleteNotebook(env, ctx, nb.id);
  assert.deepEqual(sqlMissingTenantScope(DB.__sql), []);
});
