// 監査証跡（audit_events）の閲覧API。書き込みは src/audit.mjs だけが行う。ここは読むだけ。
// 他のAPIと同じく {status, data} を返す素の関数（Responseはworker.mjsが作る）。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること。
//
// 権限の置き場:
//   /api/audit と /api/audit/export … worker.mjs がオーナーだけに絞る（403はそこで返す）
//   /api/pages/:id/audit            … 「そのページが見える人」なら読める（src/access.mjs の断片）
import { pageVisibility } from '../access.mjs';

const COLUMNS = `id, tenant_id, seq, actor_user_id, actor_email, action, target_type, target_id,
  page_id, before_json, after_json, reason, request_id, at, prev_hash, hash`;

// limit の足切り。変な値・0・負数は既定値へ、上限は200
function limitOf(params, fallback, max = 200) {
  const n = Number(params.get('limit'));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

// 値が入っていたときだけ条件を足す（空文字・未指定は無視）
function pushIf(conds, args, sql, value) {
  const v = String(value ?? '').trim();
  if (v) {
    conds.push(sql);
    args.push(v);
  }
}

// GET /api/audit — オーナー専用の全体閲覧。seq 降順（新しい順）。
// ページングは keyset（before_seq）。1件多めに取って「続きがあるか」を判定する。
export async function listAuditEvents(env, ctx, params) {
  // tenant_id はSQLの字面に必ず書く（test/tenant-scope.test.mjs の静的検査）。
  // それ以外の絞り込みは「値が入っているものだけ」AND で足す（足す側も固定の断片だけ）
  const conds = [];
  const args = [ctx.tenantId];
  pushIf(conds, args, 'target_type = ?', params.get('target_type'));
  pushIf(conds, args, 'target_id = ?', params.get('target_id'));
  const actor = String(params.get('actor') ?? '').trim();
  if (actor) {
    // actor はメールでもユーザーID（Google sub）でも引けるようにする
    conds.push('(actor_user_id = ? OR actor_email = ?)');
    args.push(actor, actor);
  }
  pushIf(conds, args, 'at >= ?', params.get('from'));
  pushIf(conds, args, 'at <= ?', params.get('to'));
  const beforeSeq = Number(params.get('before_seq'));
  if (Number.isFinite(beforeSeq) && beforeSeq > 0) {
    conds.push('seq < ?');
    args.push(Math.floor(beforeSeq));
  }
  const limit = limitOf(params, 50);
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM audit_events
      WHERE tenant_id = ?${conds.map((c) => ` AND ${c}`).join('')}
      ORDER BY seq DESC
      LIMIT ?`
  ).bind(...args, limit + 1).all();
  const rows = results ?? [];
  const events = rows.slice(0, limit);
  return {
    status: 200,
    data: {
      events,
      // 次ページは ?before_seq=<この値> で引く。続きが無いときは null
      next_before_seq: rows.length > limit && events.length ? events[events.length - 1].seq : null,
    },
  };
}

// GET /api/pages/:id/audit — そのページに紐づく事象だけ。
// 先にページの可視性を判定し、見えない相手には404（存在ごと隠す）
export async function listPageAudit(env, ctx, pageId, params) {
  const vis = pageVisibility(ctx, 'pages');
  const page = await env.DB.prepare(
    `SELECT id FROM pages
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${vis.sql}`
  ).bind(pageId, ctx.tenantId, ...vis.args).first();
  if (!page) return { status: 404, data: { error: 'not_found' } };

  const limit = limitOf(params, 100);
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM audit_events
      WHERE tenant_id = ? AND (page_id = ? OR (target_type = 'page' AND target_id = ?))
      ORDER BY seq DESC
      LIMIT ?`
  ).bind(ctx.tenantId, pageId, pageId, limit).all();
  return { status: 200, data: { events: results ?? [] } };
}

// GET /api/audit/export — オーナー専用の全量エクスポート。seq 昇順（古い順）。
// 1行1事象のJSONLを返すので、api層は {lines:[...]} を返し、worker.mjs が繋いで流す。
export async function exportAuditEvents(env, ctx, params) {
  const conds = [];
  const args = [ctx.tenantId];
  pushIf(conds, args, 'at >= ?', params.get('from'));
  pushIf(conds, args, 'at <= ?', params.get('to'));
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM audit_events
      WHERE tenant_id = ?${conds.map((c) => ` AND ${c}`).join('')}
      ORDER BY seq ASC`
  ).bind(...args).all();
  return { status: 200, data: { lines: (results ?? []).map((row) => JSON.stringify(row)) } };
}
