import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv } from './d1-adapter.mjs';
import { createPage, patchPage, deletePage } from '../src/api/pages.mjs';
import {
  AUDIT_ACTIONS, actorOf, canonicalize, commitWithAudit, hashEvent, recordAudit,
} from '../src/audit.mjs';

const NOW = '2026-09-22T00:00:00.000Z';
const TENANT = 'T0000000000000000000000000';

async function setup() {
  const t = createTestEnv();
  // 前提のノートブックは監査経路を通さず直接置く。
  // このファイルが見るのはページ操作の記録で、ノートブック作成の監査（notebook.create）は
  // 各テストの件数・連番の前提をずらすノイズになるため
  t.DB.__raw.prepare(
    `INSERT INTO notebooks (id, tenant_id, user_id, title, created_at, updated_at)
     VALUES ('NB-SETUP-1', ?, 'google-sub-1', 'ノート', ?, ?)`
  ).run(TENANT, NOW, NOW);
  return { ...t, notebookId: 'NB-SETUP-1' };
}

// 検査用の読み出しは __raw で行う（アプリのSQLログ __sql を汚さない）
function auditRows(DB, tenantId = TENANT) {
  return DB.__raw.prepare(
    'SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY seq'
  ).all(tenantId);
}

test('hashEvent は決定的（同じ入力→同じ hash・1文字違えば別の hash）', async () => {
  const ev = {
    tenant_id: TENANT, seq: 1, actor_user_id: 'google-sub-1', actor_email: 'owner@example.com',
    action: 'page.update', target_type: 'page', target_id: 'P1',
    page_id: 'P1', before_json: null, after_json: '{"a":1}',
    reason: '', request_id: '', at: NOW, prev_hash: '',
  };
  const h1 = await hashEvent(ev);
  const h2 = await hashEvent({ ...ev });
  assert.equal(h1, h2, '同じ内容は同じ hash');
  assert.match(h1, /^[0-9a-f]{64}$/);

  const h3 = await hashEvent({ ...ev, action: 'page.delete' });
  assert.notEqual(h1, h3, '1項目でも違えば別の hash');

  // canonicalize は固定順の配列にする（鍵順の違いで hash が変わらない）
  const parsed = JSON.parse(canonicalize(ev));
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 14);
  assert.equal(canonicalize(ev), canonicalize({ ...ev }));
});

test('ページを3回書き換えると audit_events の seq が 1,2,3 の連番になる', async () => {
  const { env, ctx, notebookId, DB } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '実験' }, NOW)).data.page;
  await patchPage(env, ctx, page.id, { content: 'a' }, '2026-09-22T01:00:00.000Z');
  await patchPage(env, ctx, page.id, { content: 'b' }, '2026-09-22T02:00:00.000Z');

  const rows = auditRows(DB);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.action), ['page.create', 'page.update', 'page.update']);
});

test('各行の prev_hash が直前の行の hash と一致し、hash は再計算に一致する', async () => {
  const { env, ctx, notebookId, DB } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '実験' }, NOW)).data.page;
  await patchPage(env, ctx, page.id, { content: 'a' }, '2026-09-22T01:00:00.000Z');
  await patchPage(env, ctx, page.id, { status: 'closed' }, '2026-09-22T02:00:00.000Z');

  const rows = auditRows(DB);
  assert.equal(rows[0].prev_hash, '', '最初の行の prev_hash は空');
  assert.equal(rows[1].prev_hash, rows[0].hash);
  assert.equal(rows[2].prev_hash, rows[1].hash);
  for (const row of rows) {
    assert.equal(await hashEvent(row), row.hash, `seq=${row.seq} の hash が再計算と一致`);
  }
});

test('commitWithAudit の戻り値 results[i] は業務側 statements[i] の実行結果', async () => {
  const { env, ctx, notebookId, DB } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '実験' }, NOW)).data.page;

  const stmt = env.DB.prepare(
    'UPDATE pages SET title = ? WHERE id = ? AND tenant_id = ?'
  ).bind('改名', page.id, ctx.tenantId);
  const { results, event } = await commitWithAudit(env, ctx, [stmt], {
    action: 'page.update', targetType: 'page', targetId: page.id, pageId: page.id,
  }, '2026-09-22T03:00:00.000Z');

  assert.equal(results.length, 1, '監査分は results に含めない');
  assert.equal(results[0].meta.changes, 1, '業務側（UPDATE）の結果がそのまま返る');
  assert.equal(event.action, 'page.update');
  assert.equal(event.seq, 2, 'createPage の seq=1 の次が採番される');
  assert.equal(DB.__raw.prepare('SELECT title FROM pages WHERE id = ?').get(page.id).title, '改名');
});

test('seq 競合では末尾を読み直して1回だけ組み直す。2回目も失敗したら例外', async () => {
  const { env, ctx, notebookId, DB } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '実験' }, NOW)).data.page;

  // 1回目の batch だけ UNIQUE 競合を起こす（同時書き込みの再現）
  const realBatch = env.DB.batch.bind(env.DB);
  let calls = 0;
  env.DB.batch = async (stmts) => {
    calls += 1;
    if (calls === 1) {
      throw new Error('UNIQUE constraint failed: audit_events.tenant_id, audit_events.seq');
    }
    return realBatch(stmts);
  };
  const stmt = env.DB.prepare(
    'UPDATE pages SET title = ? WHERE id = ? AND tenant_id = ?'
  ).bind('改名', page.id, ctx.tenantId);
  const { results, event } = await commitWithAudit(env, ctx, [stmt], {
    action: 'page.update', targetType: 'page', targetId: page.id, pageId: page.id,
  }, '2026-09-22T04:00:00.000Z');
  assert.equal(calls, 2, '組み直して再実行した');
  assert.equal(results[0].meta.changes, 1);
  assert.equal(event.seq, 2);

  // 2回連続で失敗したらそのまま例外を投げる（worker.mjs の例外処理が拾う側）
  let calls2 = 0;
  env.DB.batch = async () => {
    calls2 += 1;
    throw new Error('UNIQUE constraint failed: audit_events.tenant_id, audit_events.seq');
  };
  await assert.rejects(
    commitWithAudit(env, ctx, [], {
      action: 'page.update', targetType: 'page', targetId: page.id,
    }, '2026-09-22T05:00:00.000Z'),
    /UNIQUE/
  );
  assert.equal(calls2, 2, '再試行は1回だけ');
});

test('recordAudit は業務の書き込みを伴わない事象を1行だけ記録する', async () => {
  const { env, ctx, DB } = await setup();
  const { event } = await recordAudit(env, actorOf(ctx), ctx.tenantId, {
    action: 'auth.login', targetType: 'session',
    after: { sub: 'google-sub-1', demo: false },
  }, NOW);
  assert.equal(event.seq, 1);
  assert.equal(event.actor_user_id, 'google-sub-1');

  const rows = auditRows(DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'auth.login');
  assert.equal(rows[0].target_type, 'session');
  assert.equal(rows[0].prev_hash, '');
  assert.equal(rows[0].hash, event.hash);
  assert.deepEqual(JSON.parse(rows[0].after_json), { sub: 'google-sub-1', demo: false });
});

test('ページの各操作は決められた action で記録され、本文は hash と長さだけ', async () => {
  const { env, ctx, notebookId, DB } = await setup();
  const page = (await createPage(env, ctx, notebookId, {
    title: '実験A', experiment_date: '2026-09-01',
  }, NOW)).data.page;
  await patchPage(env, ctx, page.id, { content: '秘密の手順' }, '2026-09-22T01:00:00.000Z');
  await patchPage(env, ctx, page.id, { status: 'closed' }, '2026-09-22T02:00:00.000Z');
  await patchPage(env, ctx, page.id, { status: 'draft', reason: '追記のため' }, '2026-09-22T03:00:00.000Z');
  await deletePage(env, ctx, page.id, '2026-09-22T04:00:00.000Z');

  const rows = auditRows(DB);
  assert.deepEqual(rows.map((r) => r.action), [
    'page.create', 'page.update', 'page.close', 'page.reopen', 'page.delete',
  ]);
  for (const row of rows) {
    assert.ok(AUDIT_ACTIONS.includes(row.action), `${row.action} は一覧にある名前`);
    assert.equal(row.actor_user_id, 'google-sub-1');
    assert.equal(row.actor_email, 'owner@example.com');
    assert.equal(row.target_type, 'page');
    assert.equal(row.target_id, page.id);
    assert.equal(row.page_id, page.id);
  }

  // page.create: after に title / experiment_date / notebook_id
  assert.deepEqual(JSON.parse(rows[0].after_json), {
    title: '実験A', experiment_date: '2026-09-01', notebook_id: notebookId,
  });

  // page.update: 変わった項目だけ。本文は SHA-256 と文字数（本文そのものは入らない）
  const updBefore = JSON.parse(rows[1].before_json);
  const updAfter = JSON.parse(rows[1].after_json);
  assert.equal(updBefore.content_len, 0);
  assert.equal(updAfter.content_len, 5);
  assert.match(updAfter.content_sha256, /^[0-9a-f]{64}$/);
  assert.ok(!rows[1].after_json.includes('秘密'), '本文そのものは監査証跡に入れない');

  // page.close / page.reopen: before/after は status のみ。reopen には reason
  assert.deepEqual(JSON.parse(rows[2].before_json), { status: 'draft' });
  assert.deepEqual(JSON.parse(rows[2].after_json), { status: 'closed' });
  assert.deepEqual(JSON.parse(rows[3].before_json), { status: 'closed' });
  assert.deepEqual(JSON.parse(rows[3].after_json), { status: 'draft' });
  assert.equal(rows[3].reason, '追記のため');

  // page.delete: before に title / status
  assert.deepEqual(JSON.parse(rows[4].before_json), { title: '実験A', status: 'draft' });
});

test('存在しないページへの書き込み（404）は監査を書かない', async () => {
  const { env, ctx, DB } = await setup();
  assert.equal((await patchPage(env, ctx, 'NOPE', { title: 'x' })).status, 404);
  assert.equal((await deletePage(env, ctx, 'NOPE')).status, 404);
  assert.equal(auditRows(DB).length, 0);
});
