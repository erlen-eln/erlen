// ページ改訂履歴（page_revisions）の閲覧API。書き込みは src/revisions.mjs だけが行う。
// ここは読むだけ。他のAPIと同じく {status, data} を返す素の関数（Responseはworker.mjsが作る）。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること。
//
// 「そのページが見える人」なら誰でも読める（src/access.mjs の断片で先にページを引く）。
// 見えない相手には404（存在ごと隠す）
import { pageVisibility } from '../access.mjs';

// ページが見えるかの判定（一覧・単体で共通）。見えるならその行を返す
async function visiblePage(env, ctx, pageId) {
  const vis = pageVisibility(ctx, 'pages');
  return env.DB.prepare(
    `SELECT id FROM pages
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${vis.sql}`
  ).bind(pageId, ctx.tenantId, ...vis.args).first();
}

// GET /api/pages/:id/revisions — 版の一覧（本文は載せない。rev_no昇順）
export async function listPageRevisions(env, ctx, pageId) {
  if (!await visiblePage(env, ctx, pageId)) return { status: 404, data: { error: 'not_found' } };
  const { results } = await env.DB.prepare(
    `SELECT rev_no, author_user_id, created_at
       FROM page_revisions
      WHERE tenant_id = ? AND page_id = ?
      ORDER BY rev_no ASC`
  ).bind(ctx.tenantId, pageId).all();
  return { status: 200, data: { revisions: results ?? [] } };
}

// GET /api/pages/:id/revisions/:revNo — その版のスナップショット（{page, molecules}）
export async function getPageRevision(env, ctx, pageId, revNo) {
  if (!await visiblePage(env, ctx, pageId)) return { status: 404, data: { error: 'not_found' } };
  const n = Number(revNo);
  if (!Number.isInteger(n) || n < 1) return { status: 400, data: { error: 'invalid_rev_no' } };
  const row = await env.DB.prepare(
    `SELECT rev_no, snapshot
       FROM page_revisions
      WHERE tenant_id = ? AND page_id = ? AND rev_no = ?`
  ).bind(ctx.tenantId, pageId, n).first();
  if (!row) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { rev_no: row.rev_no, snapshot: JSON.parse(row.snapshot) } };
}
