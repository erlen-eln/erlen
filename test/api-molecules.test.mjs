import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, sqlMissingTenantScope } from './d1-adapter.mjs';
import { createNotebook } from '../src/api/notebooks.mjs';
import { createPage, getPage } from '../src/api/pages.mjs';
import { saveMolecules, listMolecules, normalizeMolecule } from '../src/api/molecules.mjs';

async function setup() {
  const t = createTestEnv();
  const nb = (await createNotebook(t.env, t.ctx, { title: 'ノート' })).data.notebook;
  const page = (await createPage(t.env, t.ctx, nb.id, { title: '実験' })).data.page;
  return { ...t, notebookId: nb.id, pageId: page.id };
}

test('normalizeMoleculeは入力を安全な形に整える', () => {
  const row = normalizeMolecule({
    role: 'catalyst',            // 未知のroleはreactantへ倒す
    name: 'ベンズアルデヒド',
    molecular_weight: '106.12',  // 文字列の数値も受ける
    purity: '',                  // 空欄は既定値
    mass: 'abc',                 // 数値にならない入力はnull
    is_reference: true,
  }, 3);
  assert.equal(row.role, 'reactant');
  assert.equal(row.molecular_weight, 106.12);
  assert.equal(row.purity, 100);
  assert.equal(row.equivalents, 1.0);
  assert.equal(row.mass, null);
  assert.equal(row.is_reference, 1);
  assert.equal(row.sort_order, 3, 'sort_order未指定なら並び位置を使う');
  assert.equal(normalizeMolecule({ role: 'product' }, 0).role, 'product');
});

test('一括保存: 新規INSERT・既存UPDATE・消えた行は論理削除', async () => {
  const { env, ctx, pageId, DB } = await setup();
  const first = await saveMolecules(env, ctx, pageId, {
    molecules: [
      { role: 'reactant', name: 'ベンズアルデヒド', molecular_weight: 106.12, mass: 1.06, is_reference: true },
      { role: 'reactant', name: 'アセトン', molecular_weight: 58.08, equivalents: 3 },
      { role: 'product', name: 'カルコン', molecular_weight: 208.26, yield_percent: 72 },
    ],
  }, '2026-07-10T00:00:00.000Z');
  assert.equal(first.status, 200);
  assert.equal(first.data.molecules.length, 3);
  assert.equal(first.data.rev_no, 1);

  const rows = first.data.molecules;
  assert.equal(rows[0].is_reference, 1);
  assert.equal(rows[1].equivalents, 3);
  assert.equal(rows[2].role, 'product');

  // 1行目を更新・2行目を消す・4行目を追加
  const second = await saveMolecules(env, ctx, pageId, {
    molecules: [
      { ...rows[0], mass: 2.12 },
      { ...rows[2] },
      { role: 'reactant', name: '水酸化ナトリウム' },
    ],
  }, '2026-07-11T00:00:00.000Z');
  assert.equal(second.status, 200);
  assert.equal(second.data.rev_no, 2);

  const after = await listMolecules(env, ctx, pageId);
  assert.deepEqual(after.map((x) => x.name), ['ベンズアルデヒド', 'カルコン', '水酸化ナトリウム']);
  assert.equal(after[0].id, rows[0].id, '既存行はidを保ったままUPDATEされる');
  assert.equal(after[0].mass, 2.12);
  assert.equal(after[0].updated_at, '2026-07-11T00:00:00.000Z');

  // 消した行は物理削除されず deleted_at が入るだけ
  const gone = DB.__raw.prepare('SELECT name, deleted_at FROM molecules WHERE id = ?').get(rows[1].id);
  assert.equal(gone.name, 'アセトン');
  assert.equal(gone.deleted_at, '2026-07-11T00:00:00.000Z');
});

test('保存のたびに page_revisions へスナップショットが連番で追記される', async () => {
  const { env, ctx, pageId, DB } = await setup();
  await saveMolecules(env, ctx, pageId, { molecules: [{ name: 'A' }] }, '2026-07-10T00:00:00.000Z');
  await saveMolecules(env, ctx, pageId, { molecules: [{ name: 'A' }, { name: 'B' }] }, '2026-07-11T00:00:00.000Z');
  await saveMolecules(env, ctx, pageId, { molecules: [] }, '2026-07-12T00:00:00.000Z');

  const revs = DB.__raw.prepare(
    'SELECT rev_no, author_user_id, snapshot, created_at FROM page_revisions WHERE page_id = ? ORDER BY rev_no'
  ).all(pageId);
  assert.deepEqual(revs.map((r) => r.rev_no), [1, 2, 3]);
  assert.equal(revs[0].author_user_id, 'google-sub-1');

  const snap2 = JSON.parse(revs[1].snapshot);
  assert.equal(snap2.page.id, pageId);
  assert.equal(snap2.page.updated_at, '2026-07-11T00:00:00.000Z');
  assert.deepEqual(snap2.molecules.map((m) => m.name), ['A', 'B']);
  assert.deepEqual(JSON.parse(revs[2].snapshot).molecules, []);
});

test('page_revisionsは追記専用（UPDATE/DELETEはトリガでabort）', async () => {
  const { env, ctx, pageId, DB } = await setup();
  await saveMolecules(env, ctx, pageId, { molecules: [{ name: 'A' }] });
  assert.throws(
    () => DB.__raw.prepare("UPDATE page_revisions SET snapshot = '{}' WHERE page_id = ?").run(pageId),
    /append-only/
  );
  assert.throws(
    () => DB.__raw.prepare('DELETE FROM page_revisions WHERE page_id = ?').run(pageId),
    /append-only/
  );
  assert.equal(DB.__raw.prepare('SELECT COUNT(*) AS n FROM page_revisions').get().n, 1);
});

test('保存はページのupdated_atも進める', async () => {
  const { env, ctx, pageId } = await setup();
  await saveMolecules(env, ctx, pageId, { molecules: [{ name: 'A' }] }, '2026-07-13T10:00:00.000Z');
  const page = await getPage(env, ctx, pageId);
  assert.equal(page.data.page.updated_at, '2026-07-13T10:00:00.000Z');
  assert.equal(page.data.molecules.length, 1, 'GET /api/pages/:id は分子も同梱する');
});

test('入力が配列でなければ400・存在しないページは404', async () => {
  const { env, ctx, pageId, otherCtx } = await setup();
  assert.equal((await saveMolecules(env, ctx, pageId, {})).data.error, 'molecules_required');
  assert.equal((await saveMolecules(env, ctx, pageId, { molecules: 'x' })).status, 400);
  assert.equal((await saveMolecules(env, ctx, 'NOPE', { molecules: [] })).status, 404);
  assert.equal((await saveMolecules(env, otherCtx, pageId, { molecules: [] })).status, 404,
    '他テナントのページには保存できない');
});

test('他テナントのidを混ぜても、そのテナントの行は書き換わらない', async () => {
  const { env, ctx, otherCtx, DB } = await setup();
  // よそのテナントにもノート・ページ・分子を作る
  const otherNb = (await createNotebook(env, otherCtx, { title: 'よそのノート' })).data.notebook;
  const otherPage = (await createPage(env, otherCtx, otherNb.id, { title: 'よその実験' })).data.page;
  const otherMol = (await saveMolecules(env, otherCtx, otherPage.id, { molecules: [{ name: 'よその試薬' }] }))
    .data.molecules[0];

  const myPage = (await createPage(env, ctx, (await createNotebook(env, ctx, { title: '自分の' })).data.notebook.id,
    { title: '自分の実験' })).data.page;
  // よそのidを指定して上書きを試みる
  await saveMolecules(env, ctx, myPage.id, { molecules: [{ id: otherMol.id, name: '乗っ取り' }] });

  const victim = DB.__raw.prepare('SELECT name, page_id FROM molecules WHERE id = ?').get(otherMol.id);
  assert.equal(victim.name, 'よその試薬', 'よそのテナントの行は無傷');
  assert.equal(victim.page_id, otherPage.id);
  const mine = await listMolecules(env, ctx, myPage.id);
  assert.equal(mine.length, 1);
  assert.notEqual(mine[0].id, otherMol.id, '未知のidは新規行として採番し直す');
});

test('発行された全SQLに tenant_id 条件が入っている', async () => {
  const { env, ctx, pageId, DB } = await setup();
  const saved = await saveMolecules(env, ctx, pageId, { molecules: [{ name: 'A' }, { name: 'B' }] });
  await saveMolecules(env, ctx, pageId, { molecules: [{ ...saved.data.molecules[0], mass: 1 }] });
  await listMolecules(env, ctx, pageId);
  assert.deepEqual(sqlMissingTenantScope(DB.__sql), []);
});
