// 閲覧範囲（プロジェクト）の判定。ここがノートブックの見える・見えないの唯一の実装。
//
// 個々のAPIに「見えるかどうか」を書き散らすと、新しいAPIを足したときに必ず抜ける。
// worker.mjs の viewer ガードと同じ考え方で、SQLの断片を1か所で作って各APIが末尾に足すだけにする。
//
// 規則
//   ・オーナー（追加オーナーを含む）は全部見える → 空の断片を返すので、SQLは今までと1文字も変わらない
//   ・notebooks.project_id が NULL なら、テナントの全員が見える（プロジェクト機能を入れる前と同じ）
//   ・project_id が入っていたら、project_members に自分の行がある人だけが見える
//
// 見えない相手には「存在しない」ように振る舞わせたいので、呼び出し側は
// この条件で0件になったときに 403 ではなく 404 を返すこと。
//
// 【鉄則】ここが作る断片にも tenant_id = ? が入っていること（test/tenant-scope.test.mjs が実行時SQLを検査する）。

const EMPTY = { sql: '', args: [] };

// オーナーは素通し。判定を1か所にまとめておく（role名の比較を散らかさない）。
// 公開デモの閲覧者（ctx.demo）も同じく全部見える＝デモで見せたいのは中身なので
// プロジェクトで隠す意味がない。書き込みは worker.mjs の一括ガードが viewer として断る
export function seesEverything(ctx) {
  return ctx?.role === 'owner' || ctx?.demo === true;
}

// notebooks を直接引くSQL用。alias は notebooks に付けた別名（別名なしなら 'notebooks'）
export function notebookVisibility(ctx, alias = 'notebooks') {
  if (seesEverything(ctx)) return EMPTY;
  return {
    sql: ` AND (${alias}.project_id IS NULL OR EXISTS (
             SELECT 1 FROM project_members pm
              WHERE pm.tenant_id = ? AND pm.project_id = ${alias}.project_id AND pm.user_id = ?))`,
    args: [ctx.tenantId, ctx.userId],
  };
}

// pages を引くSQL用。ページの所属ノートブックが見えるかどうかで判定する。
// notebooks を JOIN していないクエリでも使えるよう EXISTS で書く
export function pageVisibility(ctx, alias = 'pages') {
  if (seesEverything(ctx)) return EMPTY;
  return {
    sql: ` AND EXISTS (
             SELECT 1 FROM notebooks nbv
              WHERE nbv.id = ${alias}.notebook_id AND nbv.tenant_id = ?
                AND (nbv.project_id IS NULL OR EXISTS (
                  SELECT 1 FROM project_members pm
                   WHERE pm.tenant_id = ? AND pm.project_id = nbv.project_id AND pm.user_id = ?)))`,
    args: [ctx.tenantId, ctx.tenantId, ctx.userId],
  };
}

// attachments を id で直接引くSQL用。ページ→ノートブックとたどって判定する
export function attachmentVisibility(ctx, alias = 'attachments') {
  if (seesEverything(ctx)) return EMPTY;
  const page = pageVisibility(ctx, 'pv');
  return {
    sql: ` AND EXISTS (
             SELECT 1 FROM pages pv
              WHERE pv.id = ${alias}.page_id AND pv.tenant_id = ?${page.sql})`,
    args: [ctx.tenantId, ...page.args],
  };
}

// プロジェクトそのものが見えるかどうか（プロジェクト一覧・単体で使う）。
// 閲覧可能メンバーに入っていれば見える
export function projectVisibility(ctx, alias = 'projects') {
  if (seesEverything(ctx)) return EMPTY;
  return {
    sql: ` AND EXISTS (
             SELECT 1 FROM project_members pm
              WHERE pm.tenant_id = ? AND pm.project_id = ${alias}.id AND pm.user_id = ?)`,
    args: [ctx.tenantId, ctx.userId],
  };
}
