// 監査連鎖の検査ロジック（scripts/verify-audit.mjs の verifyChain）を直接試す。
//   正しい列 → ok:true と件数
//   after_json を1行書き換える → その seq を名指して落ちる
//   seq を欠かせる → 欠番として検出する
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyChain } from '../scripts/verify-audit.mjs';
import { createTestEnv } from './d1-adapter.mjs';
import { createNotebook, patchNotebook } from '../src/api/notebooks.mjs';
import { createPage, patchPage } from '../src/api/pages.mjs';

async function makeRows() {
  const { env, ctx, DB } = createTestEnv();
  const nb = await createNotebook(env, ctx, { title: '検査帳' });
  const pg = await createPage(env, ctx, nb.data.notebook.id, { title: 'P1' });
  await patchPage(env, ctx, pg.data.page.id, { content: '本文' });
  await patchNotebook(env, ctx, nb.data.notebook.id, { title: '検査帳・改' });
  return DB.__raw.prepare('SELECT * FROM audit_events ORDER BY tenant_id, seq').all();
}

test('正しい連鎖は ok:true と件数を返す（順不同でも内部でソートする）', async () => {
  const rows = await makeRows();
  const verdict = await verifyChain(rows);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.count, 4);

  // 引数の並びに依存しない（逆順で渡しても同じ結果）
  const reversed = await verifyChain([...rows].reverse());
  assert.equal(reversed.ok, true);
});

test('1行の after_json を書き換えると、その seq を名指しして落ちる', async () => {
  const rows = await makeRows();
  const victim = rows[1]; // seq=2
  victim.after_json = '{"tampered":true}';
  const verdict = await verifyChain(rows);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.seq, victim.seq);
  assert.match(verdict.reason, /hash/);
});

test('seq を飛ばすと欠番として検出する', async () => {
  const rows = await makeRows();
  rows.splice(1, 1); // seq=2 の行を抜く
  const verdict = await verifyChain(rows);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.seq, 3); // 期待seq=2の位置でseq=3が現れた
  assert.match(verdict.reason, /欠番|seq/);
});

test('prev_hash を壊すとその seq を名指しする', async () => {
  const rows = await makeRows();
  rows[2].prev_hash = 'f'.repeat(64);
  const verdict = await verifyChain(rows);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.seq, 3);
});
