// ページの全文検索。
//
// 土台は pages_fts（migrations/0001_init.sql の FTS5・tokenize='trigram'）。
// trigramは「3文字の並び」で索引を作るので、日本語でも分かち書き無しに部分一致できる。
// ただし裏を返すと2文字以下の語は索引に載らない。「THF」は引けるが「酢」は引けない。
// そこで、3文字未満のときだけ LIKE '%語%' の総なめへ落とす（件数が少ない個人ノートなら十分速い）。
//
// FTSの索引にはtenant_idが入っていない（pagesのtitle/contentだけを持つ仮想表）。
// だから必ず pages と突き合わせて tenant_id で絞る。ここを外すと他人のノートが出る。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること。
//
// 閲覧範囲（プロジェクト）でも絞る。検索は「隠したはずのノートが抜け道で出てくる」
// もっとも起きやすい場所なので、access.mjs の条件をここにも必ず通す。

import { pageVisibility } from '../access.mjs';

// 1回に返す上限。これ以上は検索語を足してもらう
export const SEARCH_LIMIT = 50;

// trigramの索引が効く最小の長さ（コードポイント数）
export const MIN_FTS_LENGTH = 3;

// 抜粋の長さ
const SNIPPET_LENGTH = 120;

export function queryLength(q) {
  return [...String(q ?? '')].length;
}

// FTS5のクエリ文字列を作る。
// 利用者の入力をそのまま渡すと AND / OR / NEAR / * などが演算子として解釈されてしまうので、
// 二重引用符で括ったフレーズ1本にして、中の " だけを "" へ逃がす。
export function ftsPhrase(q) {
  return `"${String(q).replace(/"/g, '""')}"`;
}

// LIKEの部分一致パターン。%・_・\ は打ち消す（ESCAPE '\' と対で使う）
export function likePattern(q) {
  return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// 抜粋。見つかった位置の前後を切り出す（無ければ本文の先頭）。
// 改行と連続空白は1つの空白へ畳む（一覧の行の高さを揃えるため）
export function makeSnippet(content, q, length = SNIPPET_LENGTH) {
  const flat = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const chars = [...flat];
  if (chars.length <= length) return flat;

  const at = flat.toLowerCase().indexOf(String(q ?? '').toLowerCase());
  if (at < 0) return `${chars.slice(0, length).join('')}…`;
  // 一致位置の少し手前から切る。頭から切ったのでなければ先頭に…を付ける
  const head = [...flat.slice(0, at)].length;
  const start = Math.max(0, head - Math.floor(length / 4));
  const body = chars.slice(start, start + length).join('');
  return `${start > 0 ? '…' : ''}${body}${start + length < chars.length ? '…' : ''}`;
}

function toResult(row, q) {
  return {
    pageId: row.id,
    notebookId: row.notebook_id,
    notebookTitle: row.notebook_title ?? '',
    pageTitle: row.title,
    snippet: makeSnippet(row.content, q),
    updatedAt: row.updated_at,
  };
}

// GET /api/search?q=...
export async function searchPages(env, ctx, params) {
  const q = String(params?.q ?? '').trim().slice(0, 200);
  if (!q) return { status: 400, data: { error: 'query_required' } };

  const useFts = queryLength(q) >= MIN_FTS_LENGTH;
  const vis = pageVisibility(ctx, 'p');
  let rows = [];

  if (useFts) {
    // rank は一致の良さ（小さいほど良い）。FTS5が付ける隠し列
    const { results } = await env.DB.prepare(
      // pages_fts に別名は付けられない（MATCHもrankも表名でしか書けない）
      `SELECT p.id, p.notebook_id, p.title, p.content, p.updated_at, n.title AS notebook_title
         FROM pages_fts
         JOIN pages p ON p.rowid = pages_fts.rowid
         LEFT JOIN notebooks n ON n.id = p.notebook_id AND n.tenant_id = p.tenant_id
        WHERE pages_fts MATCH ?
          AND p.tenant_id = ? AND p.deleted_at IS NULL${vis.sql}
        ORDER BY pages_fts.rank, p.updated_at DESC
        LIMIT ?`
    ).bind(ftsPhrase(q), ctx.tenantId, ...vis.args, SEARCH_LIMIT).all();
    rows = results ?? [];
  } else {
    // 2文字以下。trigramの索引に載らないので総なめする
    const pattern = likePattern(q);
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.notebook_id, p.title, p.content, p.updated_at, n.title AS notebook_title
         FROM pages p
         LEFT JOIN notebooks n ON n.id = p.notebook_id AND n.tenant_id = p.tenant_id
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL${vis.sql}
          AND (p.title LIKE ? ESCAPE '\\' OR p.content LIKE ? ESCAPE '\\')
        ORDER BY p.updated_at DESC
        LIMIT ?`
    ).bind(ctx.tenantId, ...vis.args, pattern, pattern, SEARCH_LIMIT).all();
    rows = results ?? [];
  }

  return {
    status: 200,
    data: {
      query: q,
      mode: useFts ? 'fts' : 'like', // 画面が「2文字なので簡易検索です」と出せるように返す
      results: rows.map((row) => toResult(row, q)),
    },
  };
}
