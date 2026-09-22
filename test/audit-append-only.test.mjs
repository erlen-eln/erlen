import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv } from './d1-adapter.mjs';
import { createNotebook } from '../src/api/notebooks.mjs';
import { createPage } from '../src/api/pages.mjs';

// page_revisions と同じ守り方。audit_events は追記専用で、UPDATE/DELETE はトリガが abort する
test('audit_events は追記専用（UPDATE/DELETEはトリガでabort）', async () => {
  const { env, ctx, DB } = createTestEnv();
  const nb = (await createNotebook(env, ctx, { title: 'ノート' })).data.notebook;
  const page = (await createPage(env, ctx, nb.id, { title: '実験' })).data.page;
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
