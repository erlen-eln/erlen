import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv } from './d1-adapter.mjs';
import { createNotebook } from '../src/api/notebooks.mjs';
import { createPage, patchPage } from '../src/api/pages.mjs';
import { saveMolecules } from '../src/api/molecules.mjs';
import { revisionStatement } from '../src/revisions.mjs';

async function setup() {
  const t = createTestEnv();
  const nb = (await createNotebook(t.env, t.ctx, { title: 'ノート' })).data.notebook;
  const page = (await createPage(t.env, t.ctx, nb.id, { title: '実験' })).data.page;
  return { ...t, notebookId: nb.id, pageId: page.id };
}

const revRows = (DB, pageId) => DB.__raw.prepare(
  'SELECT rev_no, author_user_id, snapshot, created_at FROM page_revisions WHERE page_id = ? ORDER BY rev_no'
).all(pageId);

test('本文を変えると page_revisions に {page, molecules} 形で追記される', async () => {
  const { env, ctx, pageId, DB } = await setup();
  await saveMolecules(env, ctx, pageId, { molecules: [{ name: 'トルエン' }] }, '2026-09-22T00:00:00.000Z');
  const r = await patchPage(env, ctx, pageId, { content: '# 手順\n冷却する' }, '2026-09-22T01:00:00.000Z');
  assert.equal(r.status, 200);

  const revs = revRows(DB, pageId);
  assert.equal(revs.length, 2, '分子の保存と本文の編集で2版');
  assert.deepEqual(revs.map((x) => x.rev_no), [1, 2]);
  const snap = JSON.parse(revs[1].snapshot);
  assert.equal(snap.page.id, pageId);
  assert.equal(snap.page.content, '# 手順\n冷却する');
  assert.equal(snap.page.title, '実験');
  assert.equal(snap.molecules.length, 1, 'スナップショットにはその時点の分子も入る');
  assert.equal(snap.molecules[0].name, 'トルエン');
});

test('本文・タイトル・実験日が変わっていない再保存では版が増えない（自動保存対策）', async () => {
  const { env, ctx, pageId, DB } = await setup();
  await patchPage(env, ctx, pageId, { content: '同じ本文' }, '2026-09-22T00:00:00.000Z');
  // 1.5秒間隔の自動保存を真似て、同じ内容をもう一度 PATCH する
  await patchPage(env, ctx, pageId, { content: '同じ本文' }, '2026-09-22T00:00:01.500Z');
  assert.equal(revRows(DB, pageId).length, 1, '変わっていないので版は増えない');

  // status の遷移だけでも版は増えない（中身が変わっていない）
  await patchPage(env, ctx, pageId, { status: 'closed' }, '2026-09-22T00:00:02.000Z');
  assert.equal(revRows(DB, pageId).length, 1);
});

test('revisionStatement は直前の版と同一なら文を作らず、その時点の版番号を返す', async () => {
  const { env, ctx, pageId } = await setup();
  const snapshot = { page: { id: pageId, title: '実験' }, molecules: [] };

  const first = await revisionStatement(env, ctx, pageId, snapshot, '2026-09-22T00:00:00.000Z');
  assert.ok(first.stmt, '最初の版は書く');
  assert.equal(first.revNo, 1);
  await first.stmt.run();

  const again = await revisionStatement(env, ctx, pageId, snapshot, '2026-09-22T00:00:01.000Z');
  assert.equal(again.stmt, null, '同一内容は書かない');
  assert.equal(again.revNo, 1, '版番号はその時点の最新のまま');

  const changed = await revisionStatement(env, ctx, pageId,
    { ...snapshot, page: { id: pageId, title: '改名' } }, '2026-09-22T00:00:02.000Z');
  assert.ok(changed.stmt, '内容が変われば書く');
  assert.equal(changed.revNo, 2);
});
