// 分子（試薬と生成物）の一括保存。
// 画面の表は行を足したり消したりするので、1行ずつのAPIではなく「表まるごと置き換え」で保存する。
// 保存が通ったら、そのページの状態を page_revisions へスナップショットとして追記する（改ざん検知の土台）。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること。
//
// listMolecules は getPage が可視性を確かめたあとにしか呼ばれない（pages.mjs）。
// saveMolecules は外から直接叩かれる入口なので、ここでも見えるページかを確かめる。
import { ulid } from '../ulid.mjs';
import { pageVisibility } from '../access.mjs';

export const MOLECULE_COLUMNS = [
  'id', 'role', 'name', 'smiles', 'molfile', 'svg', 'cas_number',
  'molecular_weight', 'density', 'purity', 'equivalents',
  'mass', 'moles', 'volume', 'molarity',
  'is_reference', 'yield_percent', 'sort_order',
  'created_at', 'updated_at',
].join(', ');

// 保存対象の列（idと時刻は別扱い）。並び順はINSERT/UPDATEで共用する
const FIELDS = [
  'role', 'name', 'smiles', 'molfile', 'svg', 'cas_number',
  'molecular_weight', 'density', 'purity', 'equivalents',
  'mass', 'moles', 'volume', 'molarity',
  'is_reference', 'yield_percent', 'sort_order',
];

function text(value, max = 100000) {
  return String(value ?? '').slice(0, max);
}

// 数値欄は「空欄＝null」を許す（未測定の質量など）。数値にならない入力もnullへ倒す
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 1行ぶんの入力を、DBに入れてよい形へ正規化する
export function normalizeMolecule(input, index) {
  return {
    id: typeof input?.id === 'string' && input.id ? input.id : null,
    role: input?.role === 'product' ? 'product' : 'reactant',
    name: text(input?.name, 300),
    smiles: text(input?.smiles, 20000),
    molfile: text(input?.molfile),
    svg: text(input?.svg),
    cas_number: text(input?.cas_number, 40),
    molecular_weight: num(input?.molecular_weight),
    density: num(input?.density),
    purity: num(input?.purity) ?? 100,
    equivalents: num(input?.equivalents) ?? 1.0,
    mass: num(input?.mass),
    moles: num(input?.moles),
    volume: num(input?.volume),
    molarity: num(input?.molarity),
    is_reference: input?.is_reference ? 1 : 0,
    yield_percent: num(input?.yield_percent),
    sort_order: num(input?.sort_order) ?? index,
  };
}

export async function listMolecules(env, ctx, pageId) {
  const { results } = await env.DB.prepare(
    `SELECT ${MOLECULE_COLUMNS}
       FROM molecules
      WHERE tenant_id = ? AND page_id = ? AND deleted_at IS NULL
      ORDER BY sort_order ASC, created_at ASC`
  ).bind(ctx.tenantId, pageId).all();
  return results ?? [];
}

// 表の一括置換保存。
//   既存行（idが一致）→ UPDATE
//   新規行（id無し・未知のid）→ INSERT
//   入力から消えた既存行 → 論理削除
// 最後にページのupdated_atを進め、page_revisionsへスナップショットを1件追記する。
// これらは env.DB.batch() の1発（＝1トランザクション）で流すので、途中で失敗しても中途半端にならない。
export async function saveMolecules(env, ctx, pageId, body, nowIso = new Date().toISOString()) {
  const input = Array.isArray(body?.molecules) ? body.molecules : Array.isArray(body) ? body : null;
  if (!input) return { status: 400, data: { error: 'molecules_required' } };

  const vis = pageVisibility(ctx, 'pages');
  const page = await env.DB.prepare(
    `SELECT id, notebook_id, user_id, title, content, status, experiment_date, created_at
       FROM pages
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${vis.sql}`
  ).bind(pageId, ctx.tenantId, ...vis.args).first();
  if (!page) return { status: 404, data: { error: 'not_found' } };
  // 確定済みのページは中身を変えられない（実験ノートの締め）
  if (page.status === 'closed') return { status: 409, data: { error: 'page_closed' } };

  const existing = await env.DB.prepare(
    `SELECT id FROM molecules
      WHERE tenant_id = ? AND page_id = ? AND deleted_at IS NULL`
  ).bind(ctx.tenantId, pageId).all();
  const existingIds = new Set((existing.results ?? []).map((r) => r.id));

  const rows = input.map((row, i) => normalizeMolecule(row, i));
  const statements = [];
  const saved = [];
  const keptIds = new Set();

  for (const row of rows) {
    const isUpdate = row.id && existingIds.has(row.id);
    const id = isUpdate ? row.id : ulid();
    keptIds.add(id);
    const values = FIELDS.map((f) => row[f]);
    if (isUpdate) {
      statements.push(env.DB.prepare(
        `UPDATE molecules
            SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND page_id = ? AND deleted_at IS NULL`
      ).bind(...values, nowIso, id, ctx.tenantId, pageId));
    } else {
      statements.push(env.DB.prepare(
        `INSERT INTO molecules
           (id, tenant_id, page_id, ${FIELDS.join(', ')}, created_at, updated_at)
         VALUES (${new Array(FIELDS.length + 5).fill('?').join(', ')})`
      ).bind(id, ctx.tenantId, pageId, ...values, nowIso, nowIso));
    }
    saved.push({ ...row, id });
  }

  // 入力に残らなかった既存行は論理削除
  for (const id of existingIds) {
    if (keptIds.has(id)) continue;
    statements.push(env.DB.prepare(
      `UPDATE molecules SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND page_id = ? AND deleted_at IS NULL`
    ).bind(nowIso, nowIso, id, ctx.tenantId, pageId));
  }

  statements.push(env.DB.prepare(
    `UPDATE pages SET updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(nowIso, pageId, ctx.tenantId));

  // 改訂番号は「今ある最大＋1」。同時保存が競合してもUNIQUE(page_id, rev_no)で弾かれる
  const last = await env.DB.prepare(
    `SELECT COALESCE(MAX(rev_no), 0) AS rev_no
       FROM page_revisions
      WHERE tenant_id = ? AND page_id = ?`
  ).bind(ctx.tenantId, pageId).first();
  const revNo = Number(last?.rev_no ?? 0) + 1;
  const snapshot = JSON.stringify({
    page: { ...page, updated_at: nowIso },
    molecules: saved,
  });
  statements.push(env.DB.prepare(
    `INSERT INTO page_revisions
       (id, tenant_id, page_id, rev_no, author_user_id, snapshot, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(ulid(), ctx.tenantId, pageId, revNo, ctx.userId, snapshot, nowIso));

  await env.DB.batch(statements);
  return {
    status: 200,
    data: { molecules: await listMolecules(env, ctx, pageId), rev_no: revNo },
  };
}
