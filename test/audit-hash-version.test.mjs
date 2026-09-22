// 監査ハッシュの版分け（hash_version）の検査。
// v1 の正規形は1文字も変えない（v1.4.0 までの既存行が検証できなくなるから）。
// v2 は v1 の並びの末尾に policy・reason_code を足すだけ。
// v1 の行と v2 の行が混在する列でも、行ごとの版で検証すれば連鎖は繋がる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv } from './d1-adapter.mjs';
import {
  AUDIT_ACTIONS, canonicalize, commitWithAudit, hashEvent,
} from '../src/audit.mjs';
import { verifyChain } from '../scripts/verify-audit.mjs';
import { createNotebook } from '../src/api/notebooks.mjs';

const NOW = '2026-07-22T00:00:00.000Z';

// 検査用の固定イベント（v1.4.0 で書かれた行と同じ形。policy/reason_code/hash_version は無い）
const EV1 = {
  tenant_id: 'T1', seq: 1, actor_user_id: 'u1', actor_email: 'a@example.com',
  action: 'page.update', target_type: 'page', target_id: 'P1',
  page_id: 'P1', before_json: '{"a":1}', after_json: null,
  reason: 'r', request_id: 'req-1', at: '2026-01-01T00:00:00.000Z', prev_hash: 'prev',
};

test('v1 の正規形は変わっていない（版未指定・1・hash_version=1 はすべて同じ）', () => {
  // 並びを固定する（プロパティの順・欠損時の null/'' 置き方まで含めて）
  const expected = '["T1",1,"u1","a@example.com","page.update","page","P1","P1",'
    + '"{\\"a\\":1}",null,"r","req-1","2026-01-01T00:00:00.000Z","prev"]';
  assert.equal(canonicalize(EV1), expected, '版未指定は v1');
  assert.equal(canonicalize(EV1, 1), expected, '版 1 は v1');
  // v1 の行は、たまたま新しい列の値を持っていても正規形に入らない
  const withExtra = { ...EV1, hash_version: 1, policy: 'GMP', reason_code: 'X' };
  assert.equal(canonicalize(withExtra, 1), expected, 'v1 の正規形は policy/reason_code を無視する');
});

test('既知の入力からは既知の v1 ハッシュが出る（実装が変わると壊れる）', async () => {
  // 上の EV1 から出るハッシュ。canonicalize の並びか digest の方式が変われば合わなくなる
  const KNOWN_V1 = 'f1612e5253d2fc897f3ed7fd369e1b9d0209e0f1e10ac31afcdc67cf61ca8fca';
  assert.equal(await hashEvent(EV1), KNOWN_V1);
  // hash_version を明示しても同じ（行が版を持っていても v1 として計算される）
  assert.equal(await hashEvent({ ...EV1, hash_version: 1 }), KNOWN_V1);
});

test('v2 は v1 の末尾に policy・reason_code を足すだけ', () => {
  const ev2 = { ...EV1, hash_version: 2, policy: 'GMP', reason_code: 'FIX' };
  const expected = '["T1",1,"u1","a@example.com","page.update","page","P1","P1",'
    + '"{\\"a\\":1}",null,"r","req-1","2026-01-01T00:00:00.000Z","prev","GMP","FIX"]';
  assert.equal(canonicalize(ev2, 2), expected);
  // policy / reason_code が無い v2 の行は空文字として並ぶ
  const ev2empty = { ...EV1, hash_version: 2 };
  assert.equal(
    canonicalize(ev2empty, 2),
    '["T1",1,"u1","a@example.com","page.update","page","P1","P1",'
      + '"{\\"a\\":1}",null,"r","req-1","2026-01-01T00:00:00.000Z","prev","",""]'
  );
});

test('hashEvent は行の hash_version を見て分岐し、v2 の値を変えるとハッシュが変わる', async () => {
  const ev2 = { ...EV1, hash_version: 2, policy: 'GMP', reason_code: 'FIX' };
  const h2 = await hashEvent(ev2);
  assert.notEqual(h2, await hashEvent(EV1), 'v1 と v2 は同じ入力でも別のハッシュ');
  assert.notEqual(h2, await hashEvent({ ...ev2, policy: 'GLP' }), 'policy でハッシュが変わる');
  assert.notEqual(h2, await hashEvent({ ...ev2, reason_code: 'OTHER' }), 'reason_code でハッシュが変わる');
  // 版の指定が無い・おかしい値でも 1 に倒れる（既存行は hash_version を持たない前提でも動く）
  assert.equal(await hashEvent({ ...EV1, hash_version: undefined }), await hashEvent(EV1));
});

test('新しい書き込みは hash_version=2 で policy・reason_code を持ち、混在列も検証できる', async () => {
  const { env, ctx, DB } = createTestEnv();
  const tid = ctx.tenantId;

  // seq=1: v1.4.0 で書かれた行を再現するため、v1 の形で直接入れる
  const ev1 = {
    tenant_id: tid, seq: 1, actor_user_id: 'u-old', actor_email: 'old@example.com',
    action: 'page.create', target_type: 'page', target_id: 'P-OLD',
    page_id: 'P-OLD', before_json: null, after_json: null,
    reason: '', request_id: '', at: NOW, prev_hash: '',
  };
  const h1 = await hashEvent(ev1); // hash_version 未指定 → v1 で計算
  DB.__raw.prepare(
    `INSERT INTO audit_events
       (id, tenant_id, seq, actor_user_id, actor_email, action, target_type, target_id,
        page_id, before_json, after_json, reason, request_id, at, prev_hash, hash,
        hash_version, policy, reason_code)
     VALUES ('EV-OLD', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '', '')`
  ).run(
    tid, ev1.actor_user_id, ev1.actor_email, ev1.action, ev1.target_type,
    ev1.target_id, ev1.page_id, ev1.before_json, ev1.after_json,
    ev1.reason, ev1.request_id, ev1.at, ev1.prev_hash, h1
  );

  // seq=2 以降は新しいコードが書く → hash_version=2。policy/reason_code も乗る
  await createNotebook(env, ctx, { title: 'N1' }, NOW);
  const nb = DB.__raw.prepare(
    `SELECT id FROM notebooks WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(tid);
  await commitWithAudit(env, ctx, [
    env.DB.prepare(
      `UPDATE notebooks SET title = ? WHERE id = ? AND tenant_id = ?`
    ).bind('N1改', nb.id, tid),
  ], {
    action: 'notebook.update', targetType: 'notebook', targetId: nb.id,
    before: { title: 'N1' }, after: { title: 'N1改' },
    policy: 'GMP', reasonCode: 'FIX',
  }, NOW);

  const rows = DB.__raw.prepare(
    `SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY seq`
  ).all(tid);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].hash_version, 1, '直接入れた行は v1');
  assert.equal(rows[1].hash_version, 2, '新しい書き込みは v2');
  assert.equal(rows[2].hash_version, 2);
  assert.equal(rows[2].policy, 'GMP', 'ev.policy が行に入る');
  assert.equal(rows[2].reason_code, 'FIX', 'ev.reasonCode が行に入る');
  // 版をまたいでも prev_hash → hash の鎖は繋がる
  assert.equal(rows[1].prev_hash, rows[0].hash);
  assert.equal(rows[2].prev_hash, rows[1].hash);
  const verdict = await verifyChain(rows);
  assert.deepEqual({ ok: verdict.ok, count: verdict.count }, { ok: true, count: 3 });
});

test('v2 の行の policy / reason_code を書き換えると検証が検出する', async () => {
  const { env, ctx, DB } = createTestEnv();
  await createNotebook(env, ctx, { title: 'N' }, NOW);
  const nb = DB.__raw.prepare(
    `SELECT id FROM notebooks WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(ctx.tenantId);
  await commitWithAudit(env, ctx, [
    env.DB.prepare(
      `UPDATE notebooks SET title = ? WHERE id = ? AND tenant_id = ?`
    ).bind('N2', nb.id, ctx.tenantId),
  ], {
    action: 'notebook.update', targetType: 'notebook', targetId: nb.id,
    policy: 'GMP', reasonCode: 'FIX',
  }, NOW);

  const base = DB.__raw.prepare(
    `SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY seq`
  ).all(ctx.tenantId);
  assert.equal((await verifyChain(base)).ok, true, '元の列は通る');

  // policy を書き換えた列は検証に通らない
  const tamperedPolicy = base.map((r, i) => (i === 1 ? { ...r, policy: 'GLP' } : r));
  const v1 = await verifyChain(tamperedPolicy);
  assert.equal(v1.ok, false);
  assert.equal(v1.seq, 2, 'policy の書き換えは seq=2 で検出される');

  // reason_code を書き換えた列も検証に通らない
  const tamperedCode = base.map((r, i) => (i === 1 ? { ...r, reason_code: 'X' } : r));
  const v2 = await verifyChain(tamperedCode);
  assert.equal(v2.ok, false);
  assert.equal(v2.seq, 2, 'reason_code の書き換えは seq=2 で検出される');
});

test('規制まわりの action 名が AUDIT_ACTIONS に登録されている', () => {
  for (const action of [
    'policy.create', 'policy.update', 'policy.delete', 'policy.set_tenant_default',
    'project.policy_assign',
    'reason_code.create', 'reason_code.update', 'reason_code.delete',
  ]) {
    assert.ok(AUDIT_ACTIONS.includes(action), `AUDIT_ACTIONS に ${action} がある`);
  }
});
