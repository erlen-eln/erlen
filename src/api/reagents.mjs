// 試薬マスタ（研究室で使う試薬の定義）のCRUDと一括取り込み。
// ここに登録しておくと、反応テーブルの「マスタから挿入」で分子量や構造式ごと引き写せる。
// 各関数は {status, data} を返すだけの素の関数（Responseはworker.mjsが作る）。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること（test/tenant-scope.test.mjs が検査する）。
import { ulid } from '../ulid.mjs';

const COLUMNS = [
  'id', 'name', 'cas_number', 'molecular_weight', 'purity', 'density',
  'smiles', 'molfile', 'svg', 'notes', 'created_at', 'updated_at',
].join(', ');

// 一括取り込み（プリセット）の1回あたりの上限。
// D1のbatchは1発が1トランザクションなので、大きすぎる束を投げないための歯止め。
export const BULK_LIMIT = 100;

function text(value, max = 4000) {
  return String(value ?? '').slice(0, max).trim();
}

// 構造式（molfile/svg）は改行や前後の空白に意味があるのでtrimしない
function raw(value, max = 100000) {
  return String(value ?? '').slice(0, max);
}

// 数値欄は「空欄＝null（未記入）」を許す。数値にならない入力もnullへ倒す
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// LIKEの部分一致パターン。%・_・\ は打ち消す（ESCAPE '\' と対で使う）
export function likePattern(q) {
  return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// 1件ぶんの入力を、DBに入れてよい形へ整える（新規作成と一括取り込みで共用）
export function normalizeReagent(input) {
  return {
    name: text(input?.name, 300),
    cas_number: text(input?.cas_number, 40),
    molecular_weight: num(input?.molecular_weight),
    purity: num(input?.purity),
    density: num(input?.density),
    smiles: text(input?.smiles, 20000),
    molfile: raw(input?.molfile),
    svg: raw(input?.svg),
    notes: text(input?.notes, 20000),
  };
}

const INSERT_SQL = `INSERT INTO reagent_masters
    (id, tenant_id, name, cas_number, molecular_weight, purity, density,
     smiles, molfile, svg, notes, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const insertArgs = (id, tenantId, row, nowIso) => [
  id, tenantId, row.name, row.cas_number, row.molecular_weight, row.purity, row.density,
  row.smiles, row.molfile, row.svg, row.notes, nowIso, nowIso,
];

// 一覧。?q= があれば名前とCAS番号の部分一致で絞る（更新の新しい順）
export async function listReagents(env, ctx, { q } = {}) {
  const query = text(q, 100);
  if (query) {
    const pattern = likePattern(query);
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS}
         FROM reagent_masters
        WHERE tenant_id = ? AND deleted_at IS NULL
          AND (name LIKE ? ESCAPE '\\' OR cas_number LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC`
    ).bind(ctx.tenantId, pattern, pattern).all();
    return { status: 200, data: { reagents: results ?? [] } };
  }
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS}
       FROM reagent_masters
      WHERE tenant_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC`
  ).bind(ctx.tenantId).all();
  return { status: 200, data: { reagents: results ?? [] } };
}

export async function getReagent(env, ctx, id) {
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS}
       FROM reagent_masters
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.tenantId).first();
  if (!row) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { reagent: row } };
}

export async function createReagent(env, ctx, body, nowIso = new Date().toISOString()) {
  const row = normalizeReagent(body);
  if (!row.name) return { status: 400, data: { error: 'name_required' } };
  const id = ulid();
  await env.DB.prepare(INSERT_SQL).bind(...insertArgs(id, ctx.tenantId, row, nowIso)).run();
  const created = await getReagent(env, ctx, id);
  return { ...created, status: 201 };
}

// プリセット（public/presets/solvents.json）の取り込み口。
// 同じ名前の試薬が既にあっても弾かない。「グレード違いを別行で持ちたい」は普通にあるので、
// 重複するかどうかは利用者の判断に任せる（消したければ論理削除できる）。
export async function bulkCreateReagents(env, ctx, body, nowIso = new Date().toISOString()) {
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length === 0) return { status: 400, data: { error: 'items_required' } };
  if (items.length > BULK_LIMIT) {
    return { status: 400, data: { error: 'too_many_items', limit: BULK_LIMIT } };
  }
  const rows = items.map((item) => normalizeReagent(item));
  const missing = rows.findIndex((row) => !row.name);
  if (missing >= 0) return { status: 400, data: { error: 'name_required', index: missing } };

  const ids = rows.map(() => ulid());
  // batchは1発が1トランザクション。途中で落ちても半端に入らない
  await env.DB.batch(rows.map((row, i) => (
    env.DB.prepare(INSERT_SQL).bind(...insertArgs(ids[i], ctx.tenantId, row, nowIso))
  )));
  return { status: 201, data: { created: ids.length, ids } };
}

export async function patchReagent(env, ctx, id, body, nowIso = new Date().toISOString()) {
  const sets = [];
  const args = [];
  const put = (column, value) => { sets.push(`${column} = ?`); args.push(value); };

  if (body?.name !== undefined) {
    const name = text(body.name, 300);
    if (!name) return { status: 400, data: { error: 'name_required' } };
    put('name', name);
  }
  if (body?.cas_number !== undefined) put('cas_number', text(body.cas_number, 40));
  if (body?.molecular_weight !== undefined) put('molecular_weight', num(body.molecular_weight));
  if (body?.purity !== undefined) put('purity', num(body.purity));
  if (body?.density !== undefined) put('density', num(body.density));
  if (body?.smiles !== undefined) put('smiles', text(body.smiles, 20000));
  if (body?.molfile !== undefined) put('molfile', raw(body.molfile));
  if (body?.svg !== undefined) put('svg', raw(body.svg));
  if (body?.notes !== undefined) put('notes', text(body.notes, 20000));
  if (!sets.length) return { status: 400, data: { error: 'no_fields' } };

  put('updated_at', nowIso);
  args.push(id, ctx.tenantId);
  const res = await env.DB.prepare(
    `UPDATE reagent_masters SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(...args).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return await getReagent(env, ctx, id);
}

// 論理削除。在庫（reagent_stocks）が参照していても消してよい。
// 在庫側は表示名をマスタから引けなくなるだけで、行そのものは残る（現物は棚にあるため）
export async function deleteReagent(env, ctx, id, nowIso = new Date().toISOString()) {
  const res = await env.DB.prepare(
    `UPDATE reagent_masters SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(nowIso, nowIso, id, ctx.tenantId).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { ok: true, id } };
}
