import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv } from './d1-adapter.mjs';
import { createPage } from '../src/api/pages.mjs';

// page_revisions と同じ守り方。audit_events は追記専用で、UPDATE/DELETE はトリガが abort する
test('audit_events は追記専用（UPDATE/DELETEはトリガでabort）', async () => {
  const { env, ctx, DB } = createTestEnv();
  // 前提のノートブックは監査経路を通さず直接置く（このテストは件数「1」を前提にしている）
  DB.__raw.prepare(
    `INSERT INTO notebooks (id, tenant_id, user_id, title, created_at, updated_at)
     VALUES ('NB-SETUP-1', 'T0000000000000000000000000', 'google-sub-1', 'ノート', ?, ?)`
  ).run('2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
  const page = (await createPage(env, ctx, 'NB-SETUP-1', { title: '実験' })).data.page;
  assert.ok(page.id);

  // page.create で1行書かれているはず
  assert.equal(DB.__raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 1);

  assert.throws(
    () => DB.__raw.prepare("UPDATE audit_events SET reason = 'x'").run(),
    /append-only/
  );
  assert.throws(
    () => DB.__raw.prepare('DELETE FROM audit_events').run(),
    /append-only/
  );
  assert.equal(DB.__raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 1);
});
