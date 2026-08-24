// 機器（equipments）のCRUD・検索・一括取り込み・テナント分離。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestEnv, sqlMissingTenantScope } from './d1-adapter.mjs';
import {
  BULK_LIMIT, bulkCreateEquipments, createEquipment, deleteEquipment, getEquipment,
  listEquipments, normalizeEquipment, patchEquipment,
} from '../src/api/equipments.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SAMPLE = {
  name: 'エバポレーター',
  category: '濃縮・溶媒留去',
  capacity: 'フラスコ 50 mL〜1 L',
  temperature_range: '室温〜バス 180 °C',
  pressure_range: '約 0〜1013 mbar',
  manufacturer: 'BUCHI',
  model_number: 'R-300',
  management_number: 'EQ-EVAP-001',
  notes: '共用機。使用後は水を抜く',
};

test('normalizeEquipmentは全列を文字列へ整える', () => {
  const row = normalizeEquipment({ name: '  NMR  ', capacity: null, notes: undefined });
  assert.equal(row.name, 'NMR');
  assert.equal(row.capacity, '');
  assert.equal(row.notes, '');
  assert.equal(row.management_number, '');
});

test('作成・取得・更新・論理削除の一巡（全列）', async () => {
  const { env, ctx, DB } = createTestEnv();
  const created = await createEquipment(env, ctx, SAMPLE, '2026-07-10T00:00:00.000Z');
  assert.equal(created.status, 201);
  const eq = created.data.equipment;
  for (const [key, value] of Object.entries(SAMPLE)) {
    assert.equal(eq[key], value, `${key} が往復していない`);
  }

  const patched = await patchEquipment(env, ctx, eq.id, {
    management_number: 'EQ-EVAP-002', notes: '',
  }, '2026-07-11T00:00:00.000Z');
  assert.equal(patched.status, 200);
  assert.equal(patched.data.equipment.management_number, 'EQ-EVAP-002');
  assert.equal(patched.data.equipment.notes, '');
  assert.equal(patched.data.equipment.name, 'エバポレーター', '触っていない列は変わらない');

  assert.equal((await deleteEquipment(env, ctx, eq.id)).status, 200);
  assert.equal((await getEquipment(env, ctx, eq.id)).status, 404);
  assert.equal((await listEquipments(env, ctx)).data.equipments.length, 0);
  assert.equal(DB.__raw.prepare('SELECT COUNT(*) AS n FROM equipments').get().n, 1, '行は残る');
});

test('必須・空更新のはじき方', async () => {
  const { env, ctx } = createTestEnv();
  assert.deepEqual((await createEquipment(env, ctx, { category: '分光' })).data, { error: 'name_required' });
  const id = (await createEquipment(env, ctx, { name: 'HPLC' })).data.equipment.id;
  assert.deepEqual((await patchEquipment(env, ctx, id, {})).data, { error: 'no_fields' });
  assert.deepEqual((await patchEquipment(env, ctx, id, { name: ' ' })).data, { error: 'name_required' });
  assert.equal((await patchEquipment(env, ctx, 'NOPE', { name: 'x' })).status, 404);
});

test('?q=は名前・分類・メーカー・型番・管理番号を横断して探す', async () => {
  const { env, ctx } = createTestEnv();
  await createEquipment(env, ctx, SAMPLE, '2026-07-01T00:00:00.000Z');
  await createEquipment(env, ctx, {
    name: 'HPLC', category: '分離・定量分析', manufacturer: 'Waters',
    model_number: 'e2695', management_number: 'EQ-HPLC-001',
  }, '2026-07-02T00:00:00.000Z');

  const names = async (q) => (await listEquipments(env, ctx, { q })).data.equipments.map((e) => e.name);
  assert.deepEqual(await names('エバポ'), ['エバポレーター']);
  assert.deepEqual(await names('Waters'), ['HPLC']);
  assert.deepEqual(await names('e2695'), ['HPLC']);
  assert.deepEqual(await names('EQ-EVAP'), ['エバポレーター']);
  // 台帳の検索はFTSではなくLIKEなので、1文字でも引ける（ページ全文検索とは別の仕組み）
  assert.deepEqual(await names('分'), ['HPLC']);
  assert.deepEqual(await names('溶媒'), ['エバポレーター']);
  assert.deepEqual(await names('該当なし'), []);
  assert.deepEqual(
    (await listEquipments(env, ctx)).data.equipments.map((e) => e.name),
    ['HPLC', 'エバポレーター'], '更新の新しい順'
  );
});

test('一括取り込み: 100件まで・name必須', async () => {
  const { env, ctx } = createTestEnv();
  const many = (n) => ({ items: Array.from({ length: n }, (_, i) => ({ name: `機器${i}` })) });

  const ok = await bulkCreateEquipments(env, ctx, { items: [SAMPLE, { name: 'pHメーター' }] });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.created, 2);

  const tooMany = await bulkCreateEquipments(env, ctx, many(BULK_LIMIT + 1));
  assert.equal(tooMany.status, 400);
  assert.deepEqual(tooMany.data, { error: 'too_many_items', limit: 100 });
  const missing = await bulkCreateEquipments(env, ctx, { items: [{ name: 'A' }, { category: '分光' }] });
  assert.deepEqual(missing.data, { error: 'name_required', index: 1 });
  assert.equal((await bulkCreateEquipments(env, ctx, { items: [] })).status, 400);
  assert.equal((await listEquipments(env, ctx)).data.equipments.length, 2, '失敗時は1件も入らない');
});

test('別テナントの機器は見えない・触れない', async () => {
  const { env, ctx, otherCtx, DB } = createTestEnv();
  const mine = (await createEquipment(env, ctx, { name: 'うちのNMR' })).data.equipment.id;
  await createEquipment(env, otherCtx, { name: 'よそのNMR' });

  assert.deepEqual((await listEquipments(env, ctx)).data.equipments.map((e) => e.name), ['うちのNMR']);
  assert.equal((await getEquipment(env, otherCtx, mine)).status, 404);
  assert.equal((await patchEquipment(env, otherCtx, mine, { name: '乗っ取り' })).status, 404);
  assert.equal((await deleteEquipment(env, otherCtx, mine)).status, 404);
  assert.deepEqual(sqlMissingTenantScope(DB.__sql), []);
});

test('同梱プリセット（public/presets/equipments.json）はそのまま一括取り込みできる', async () => {
  const preset = JSON.parse(readFileSync(path.join(ROOT, 'public/presets/equipments.json'), 'utf8'));
  assert.ok(Array.isArray(preset.items) && preset.items.length > 0);
  assert.ok(preset.items.length <= BULK_LIMIT);
  assert.equal(preset.meta.count, preset.items.length);
  for (const item of preset.items) {
    assert.ok(String(item.name ?? '').trim(), 'name必須');
    assert.match(item.name, /[ぁ-んァ-ヶ一-龥]|pH|HPLC|FT-IR|UV/, `日本語名になっていない: ${item.name}`);
  }

  const { env, ctx } = createTestEnv();
  const res = await bulkCreateEquipments(env, ctx, preset);
  assert.equal(res.status, 201);
  assert.equal(res.data.created, preset.items.length);
  const hit = (await listEquipments(env, ctx, { q: 'エバポレーター' })).data.equipments;
  assert.equal(hit.length, 1);
  assert.equal(hit[0].management_number, 'EQ-EVAP-001');
});
