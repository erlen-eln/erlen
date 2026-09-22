// ページ改訂履歴（page_revisions）へのスナップショット追記。
// 反応テーブル保存（api/molecules.mjs）と本文編集（api/pages.mjs patchPage）の両方がここを使う。
// 採番ロジック（今ある最大 rev_no ＋ 1）はこの1か所だけに置く。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること。
import { ulid } from './ulid.mjs';

// page_revisions への INSERT 文を組み立てる。
// 直前の行の snapshot と文字列が完全一致するなら書かない（stmt = null で返す）。
// 画面の自動保存が1.5秒間隔で走るため、同じ内容の版が積み上がるのを防ぐ。
// 呼び出し側は revNo（採番した版番号、または書かなかったときのその時点の最新版番号）を
// 応答に使える。
export async function revisionStatement(env, ctx, pageId, snapshotObj, nowIso) {
  const last = await env.DB.prepare(
    `SELECT rev_no, snapshot FROM page_revisions
      WHERE tenant_id = ? AND page_id = ?
      ORDER BY rev_no DESC LIMIT 1`
  ).bind(ctx.tenantId, pageId).first();
  const lastRev = Number(last?.rev_no ?? 0);
  const snapshot = JSON.stringify(snapshotObj);
  if (last && last.snapshot === snapshot) return { stmt: null, revNo: lastRev };
  const revNo = lastRev + 1;
  const stmt = env.DB.prepare(
    `INSERT INTO page_revisions
       (id, tenant_id, page_id, rev_no, author_user_id, snapshot, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(ulid(), ctx.tenantId, pageId, revNo, ctx.userId, snapshot, nowIso);
  return { stmt, revNo };
}
