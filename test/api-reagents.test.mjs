// 試薬マスタ（reagent_masters）のCRUD・検索・一括取り込み・テナント分離。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestEnv, sqlMissingTenantScope } from './d1-adapter.mjs';
import {
  BULK_LIMIT, bulkCreateReagents, createReagent, deleteReagent, getReagent,
  likePattern, listReagents, normalizeReagent, patchReagent,
} from '../src/api/reagents.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('normalizeReagentは入力を安全な形に整える', () => {
  const row = normalizeReagent({
    name: '  トルエン  ',
    cas_number: '108-88-3',
    molecular_weight: '92.14', // 文字列の数値も受ける
    purity: '',                // 空欄はnull（未記入）
    density: 'abc',            // 数値にならない入力もnull
  });
  assert.equal(row.name, 'トルエン');
  assert.equal(row.molecular_weight, 92.14);
  assert.equal(row.purity, null);
  assert.equal(row.density, null);
  assert.equal(row.smiles, '');
  assert.equal(row.molfile, '');
});

test('likePatternは % _ \\ を打ち消す（検索語が万能一致にならない）', () => {
  assert.equal(likePattern('100%'), '%100\\%%');
  assert.equal(likePattern('a_b'), '%a\\_b%');
});

test('作成・取得・更新・論理削除の一巡', async () => {
  const { env, ctx, DB } = createTestEnv();
  const created = await createReagent(env, ctx, {
    name: 'トルエン', cas_number: '108-88-3', molecular_weight: 92.14, density: 0.867,
  }, '2026-07-10T00:00:00.000Z');
  assert.equal(created.status, 201);
  const id = created.data.reagent.id;
  assert.equal(created.data.reagent.name, 'トルエン');
  assert.equal(created.data.reagent.molecular_weight, 92.14);

  assert.equal((await getReagent(env, ctx, id)).status, 200);

  const patched = await patchReagent(env, ctx, id, { purity: 99.5, notes: '脱水品' },
    '2026-07-11T00:00:00.000Z');
  assert.equal(patched.status, 200);
  assert.equal(patched.data.reagent.purity, 99.5);
  assert.equal(patched.data.reagent.notes, '脱水品');
  assert.equal(patched.data.reagent.updated_at, '2026-07-11T00:00:00.000Z');

  assert.equal((await deleteReagent(env, ctx, id)).status, 200);
  assert.equal((await getReagent(env, ctx, id)).status, 404, '論理削除後は404');
  assert.equal((await listReagents(env, ctx)).data.reagents.length, 0);
  // 行そのものは残っている（消さないのがこの製品の原則）
  assert.equal(DB.__raw.prepare('SELECT COUNT(*) AS n FROM reagent_masters').get().n, 1);
  assert.equal((await deleteReagent(env, ctx, id)).status, 404, '二重削除は404');
});

test('必須・空更新のはじき方', async () => {
  const { env, ctx } = createTestEnv();
  assert.equal((await createReagent(env, ctx, { name: '   ' })).status, 400);
  assert.deepEqual((await createReagent(env, ctx, {})).data, { error: 'name_required' });

  const id = (await createReagent(env, ctx, { name: 'アセトン' })).data.reagent.id;
  assert.deepEqual((await patchReagent(env, ctx, id, {})).data, { error: 'no_fields' });
  assert.deepEqual((await patchReagent(env, ctx, id, { name: '' })).data, { error: 'name_required' });
  assert.equal((await patchReagent(env, ctx, 'NOPE', { name: 'x' })).status, 404);
});

test('一覧は更新の新しい順・?q=で名前とCASを部分一致', async () => {
  const { env, ctx } = createTestEnv();
  await createReagent(env, ctx, { name: 'トルエン', cas_number: '108-88-3' }, '2026-07-01T00:00:00.000Z');
  await createReagent(env, ctx, { name: 'アセトン', cas_number: '67-64-1' }, '2026-07-02T00:00:00.000Z');
  await createReagent(env, ctx, { name: 'ベンゼン', cas_number: '71-43-2' }, '2026-07-03T00:00:00.000Z');

  assert.deepEqual(
    (await listReagents(env, ctx)).data.reagents.map((r) => r.name),
    ['ベンゼン', 'アセトン', 'トルエン']
  );
  assert.deepEqual(
    (await listReagents(env, ctx, { q: 'トル' })).data.reagents.map((r) => r.name), ['トルエン']
  );
  assert.deepEqual(
    (await listReagents(env, ctx, { q: '67-64' })).data.reagents.map((r) => r.name), ['アセトン']
  );
  assert.deepEqual((await listReagents(env, ctx, { q: '該当なし' })).data.reagents, []);
  assert.equal((await listReagents(env, ctx, { q: '  ' })).data.reagents.length, 3, '空白だけの検索は全件');
});

test('一括取り込み: 100件まで・name必須・同名でも入る', async () => {
  const { env, ctx } = createTestEnv();
  const many = (n) => ({ items: Array.from({ length: n }, (_, i) => ({ name: `試薬${i}` })) });

  const ok = await bulkCreateReagents(env, ctx, {
    items: [
      { name: 'ヘキサン', cas_number: '110-54-3', molecular_weight: 86.18 },
      { name: 'ヘキサン' }, // 同名でも弾かない（グレード違いは利用者の判断）
    ],
  }, '2026-07-20T00:00:00.000Z');
  assert.equal(ok.status, 201);
  assert.equal(ok.data.created, 2);
  assert.equal((await listReagents(env, ctx)).data.reagents.length, 2);

  assert.equal((await bulkCreateReagents(env, ctx, many(BULK_LIMIT))).status, 201);
  const tooMany = await bulkCreateReagents(env, ctx, many(BULK_LIMIT + 1));
  assert.equal(tooMany.status, 400);
  assert.deepEqual(tooMany.data, { error: 'too_many_items', limit: 100 });

  const missing = await bulkCreateReagents(env, ctx, { items: [{ name: 'A' }, { cas_number: '1-1-1' }] });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.data, { error: 'name_required', index: 1 });

  assert.equal((await bulkCreateReagents(env, ctx, { items: [] })).status, 400);
  assert.equal((await bulkCreateReagents(env, ctx, {})).status, 400);
  // 上限超え・name欠落のときは1件も入っていないこと
  assert.equal((await listReagents(env, ctx)).data.reagents.length, 2 + BULK_LIMIT);
});

test('別テナントの試薬は見えない・触れない', async () => {
  const { env, ctx, otherCtx, DB } = createTestEnv();
  const mine = (await createReagent(env, ctx, { name: 'うちの試薬' })).data.reagent.id;
  await createReagent(env, otherCtx, { name: 'よその試薬' });

  assert.deepEqual((await listReagents(env, ctx)).data.reagents.map((r) => r.name), ['うちの試薬']);
  assert.equal((await getReagent(env, otherCtx, mine)).status, 404);
  assert.equal((await patchReagent(env, otherCtx, mine, { name: '乗っ取り' })).status, 404);
  assert.equal((await deleteReagent(env, otherCtx, mine)).status, 404);
  assert.equal((await getReagent(env, ctx, mine)).data.reagent.name, 'うちの試薬');
  assert.deepEqual(sqlMissingTenantScope(DB.__sql), []);
});

test('同梱プリセット（public/presets/solvents.json）はそのまま一括取り込みできる', async () => {
  const preset = JSON.parse(readFileSync(path.join(ROOT, 'public/presets/solvents.json'), 'utf8'));
  assert.ok(Array.isArray(preset.items) && preset.items.length > 0);
  assert.ok(preset.items.length <= BULK_LIMIT, `プリセットは${BULK_LIMIT}件以内にする`);
  assert.equal(preset.meta.count, preset.items.length);
  for (const item of preset.items) {
    assert.ok(String(item.name ?? '').trim(), 'name必須');
    // 日本語名で出す約束（画面の一覧がアルファベット順に見えないようにするため）
    assert.match(item.name, /[ぁ-んァ-ヶ一-龥]/, `日本語名になっていない: ${item.name}`);
  }

  const { env, ctx } = createTestEnv();
  const res = await bulkCreateReagents(env, ctx, preset);
  assert.equal(res.status, 201);
  assert.equal(res.data.created, preset.items.length);
  const list = (await listReagents(env, ctx, { q: 'トルエン' })).data.reagents;
  assert.equal(list.length, 1);
  // CAS登録番号はプリセットに同梱しない（理由は test/licensing.test.mjs）。
  // 取り込み直後は空欄で、必要なら画面のPubChem補完か手入力で埋める
  assert.equal(list[0].cas_number, '');
  assert.equal(list[0].molecular_weight, 92.14);
});

test('同梱プリセットにCAS登録番号が入っていない（空欄で配る）', () => {
  // CAS登録番号は American Chemical Society がライセンスを求めるため、
  // 公開リポジトリで再配布しない。フィールド自体は残す（画面もAPIも空文字を許す）
  const preset = JSON.parse(readFileSync(path.join(ROOT, 'public/presets/solvents.json'), 'utf8'));
  const filled = preset.items
    .filter((item) => String(item.cas_number ?? '').trim() !== '')
    .map((item) => `${item.name}: ${item.cas_number}`);
  assert.deepEqual(filled, [], `プリセットにCAS登録番号が残っている:\n${filled.join('\n')}`);
  for (const item of preset.items) {
    assert.ok('cas_number' in item, `${item.name}: cas_number フィールドごと消さない（画面が参照する）`);
  }
});
