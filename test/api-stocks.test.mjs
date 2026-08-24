// 試薬在庫（reagent_stocks）のCRUD・検索・マスタJOINでの表示名解決・テナント分離。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, sqlMissingTenantScope } from './d1-adapter.mjs';
import { createReagent, deleteReagent, patchReagent } from '../src/api/reagents.mjs';
import {
  createStock, deleteStock, getStock, listStocks, patchStock,
} from '../src/api/stocks.mjs';

async function setup() {
  const t = createTestEnv();
  const master = (await createReagent(t.env, t.ctx, {
    name: 'トルエン', cas_number: '108-88-3', molecular_weight: 92.14, density: 0.867,
  }, '2026-07-01T00:00:00.000Z')).data.reagent;
  return { ...t, master };
}

test('マスタ紐づけの在庫: 表示名と分子量がJOINで同梱される', async () => {
  const { env, ctx, master } = await setup();
  const created = await createStock(env, ctx, {
    reagent_master_id: master.id,
    manufacturer: '富士フイルム和光純薬',
    lot_number: 'ABC-001',
    received_date: '2026-07-05',
    is_opened: true,
    storage_location: '溶媒棚A-2',
    remaining_amount: 480,
    remaining_unit: 'mL',
  }, '2026-07-05T00:00:00.000Z');
  assert.equal(created.status, 201);

  const stock = created.data.stock;
  assert.equal(stock.display_name, 'トルエン');
  assert.equal(stock.master_name, 'トルエン');
  assert.equal(stock.cas_number, '108-88-3');
  assert.equal(stock.molecular_weight, 92.14);
  assert.equal(stock.density, 0.867);
  assert.equal(stock.is_opened, 1, '真偽値は0/1で入る');
  assert.equal(stock.remaining_amount, 480);

  const listed = (await listStocks(env, ctx)).data.stocks;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].display_name, 'トルエン');
});

test('カスタム名の在庫: マスタが無くても表示名が出る', async () => {
  const { env, ctx } = await setup();
  const created = await createStock(env, ctx, {
    custom_reagent_name: '自家調製 グリニャール試薬',
    storage_location: '冷蔵庫B',
  }, '2026-07-06T00:00:00.000Z');
  assert.equal(created.status, 201);
  assert.equal(created.data.stock.reagent_master_id, null);
  assert.equal(created.data.stock.display_name, '自家調製 グリニャール試薬');
  assert.equal(created.data.stock.master_name, null);
  assert.equal(created.data.stock.molecular_weight, null);
});

test('マスタにも名前にも紐づかない在庫は作れない', async () => {
  const { env, ctx } = await setup();
  const res = await createStock(env, ctx, { manufacturer: 'どこか' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.data, { error: 'reagent_required' });

  // 存在しないマスタID・よそのテナントのマスタIDも断る
  assert.deepEqual(
    (await createStock(env, ctx, { reagent_master_id: 'NOPE' })).data,
    { error: 'reagent_master_not_found' }
  );
});

test('マスタ名を変えると在庫の表示名も追随する（名前を二重管理しない）', async () => {
  const { env, ctx, master } = await setup();
  const id = (await createStock(env, ctx, { reagent_master_id: master.id })).data.stock.id;
  await patchReagent(env, ctx, master.id, { name: 'トルエン（脱水）' });
  assert.equal((await getStock(env, ctx, id)).data.stock.display_name, 'トルエン（脱水）');
});

test('マスタを論理削除しても、在庫の行と表示名は残る（棚の現物は消えない）', async () => {
  const { env, ctx, master } = await setup();
  const id = (await createStock(env, ctx, { reagent_master_id: master.id })).data.stock.id;
  await deleteReagent(env, ctx, master.id);
  const stock = (await getStock(env, ctx, id)).data.stock;
  assert.equal(stock.display_name, 'トルエン');
  assert.equal((await listStocks(env, ctx)).data.stocks.length, 1);
});

test('更新と論理削除', async () => {
  const { env, ctx, master, DB } = await setup();
  const id = (await createStock(env, ctx, {
    reagent_master_id: master.id, remaining_amount: 500, remaining_unit: 'mL',
  }, '2026-07-05T00:00:00.000Z')).data.stock.id;

  const patched = await patchStock(env, ctx, id, {
    is_opened: true, remaining_amount: 120, storage_location: '溶媒棚A-2',
  }, '2026-07-12T00:00:00.000Z');
  assert.equal(patched.status, 200);
  assert.equal(patched.data.stock.is_opened, 1);
  assert.equal(patched.data.stock.remaining_amount, 120);
  assert.equal(patched.data.stock.updated_at, '2026-07-12T00:00:00.000Z');

  // マスタ紐づけを外すときは、代わりの名前が要る
  assert.deepEqual(
    (await patchStock(env, ctx, id, { reagent_master_id: '' })).data,
    { error: 'reagent_required' }
  );
  assert.equal(
    (await patchStock(env, ctx, id, { reagent_master_id: '', custom_reagent_name: '瓶詰め品' })).status,
    200
  );
  assert.equal((await getStock(env, ctx, id)).data.stock.display_name, '瓶詰め品');

  assert.deepEqual((await patchStock(env, ctx, id, {})).data, { error: 'no_fields' });
  assert.equal((await patchStock(env, ctx, 'NOPE', { lot_number: 'x' })).status, 404);

  assert.equal((await deleteStock(env, ctx, id)).status, 200);
  assert.equal((await getStock(env, ctx, id)).status, 404);
  assert.equal((await deleteStock(env, ctx, id)).status, 404);
  assert.equal(DB.__raw.prepare('SELECT COUNT(*) AS n FROM reagent_stocks').get().n, 1, '行は残る');
});

test('?q=はマスタ名・カスタム名・メーカー・Lot・保管場所を横断して探す', async () => {
  const { env, ctx, master } = await setup();
  await createStock(env, ctx, {
    reagent_master_id: master.id, manufacturer: '関東化学', lot_number: 'K-777',
    storage_location: '溶媒棚A-2',
  }, '2026-07-05T00:00:00.000Z');
  await createStock(env, ctx, {
    custom_reagent_name: '自家調製 触媒', manufacturer: '自作', storage_location: '冷蔵庫B',
  }, '2026-07-06T00:00:00.000Z');

  const names = async (q) => (await listStocks(env, ctx, { q })).data.stocks.map((s) => s.display_name);
  assert.deepEqual(await names('トルエン'), ['トルエン']);
  assert.deepEqual(await names('触媒'), ['自家調製 触媒']);
  assert.deepEqual(await names('K-777'), ['トルエン']);
  assert.deepEqual(await names('冷蔵庫'), ['自家調製 触媒']);
  assert.deepEqual(await names('関東'), ['トルエン']);
  assert.deepEqual(await names('無い'), []);
  // 検索なしは更新の新しい順
  assert.deepEqual(
    (await listStocks(env, ctx)).data.stocks.map((s) => s.display_name),
    ['自家調製 触媒', 'トルエン']
  );
});

test('別テナントの在庫は見えない・触れない（JOIN先のマスタも跨がない）', async () => {
  const { env, ctx, otherCtx, master, DB } = await setup();
  const mine = (await createStock(env, ctx, { reagent_master_id: master.id })).data.stock.id;
  await createStock(env, otherCtx, { custom_reagent_name: 'よその在庫' });

  assert.deepEqual((await listStocks(env, ctx)).data.stocks.map((s) => s.display_name), ['トルエン']);
  assert.equal((await getStock(env, otherCtx, mine)).status, 404);
  assert.equal((await patchStock(env, otherCtx, mine, { lot_number: 'x' })).status, 404);
  assert.equal((await deleteStock(env, otherCtx, mine)).status, 404);
  // よそのテナントから、うちのマスタへは紐づけられない
  assert.deepEqual(
    (await createStock(env, otherCtx, { reagent_master_id: master.id })).data,
    { error: 'reagent_master_not_found' }
  );
  assert.deepEqual(sqlMissingTenantScope(DB.__sql), []);
});
