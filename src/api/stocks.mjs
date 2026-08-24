// 試薬在庫（棚にある現物のボトル1本＝1行）のCRUD。
// マスタ（reagent_masters）に紐づけてもよいし、マスタに無い試薬なら custom_reagent_name だけでもよい。
// 一覧はマスタをLEFT JOINして、画面がそのまま描ける形（display_name・分子量つき）で返す。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること。
import { ulid } from '../ulid.mjs';

// 一覧・単体で返す列。
// display_name … マスタ名が最優先、無ければカスタム名（画面はこれをそのまま出す）
// 論理削除したマスタもJOINの対象にする。棚の現物は残っているので、
// 「マスタを消したら在庫の名前が消えた」という見え方にはしない。
const SELECT_SQL = `SELECT
    s.id, s.reagent_master_id, s.custom_reagent_name, s.manufacturer, s.lot_number,
    s.received_date, s.is_opened, s.storage_location, s.remaining_amount, s.remaining_unit,
    s.notes, s.created_at, s.updated_at,
    COALESCE(NULLIF(m.name, ''), s.custom_reagent_name) AS display_name,
    m.name AS master_name,
    m.cas_number AS cas_number,
    -- SMILESだけ持ってくる（画面がRDKitで構造式サムネを描くため）。
    -- 保存済みのSVGは1件あたり数KB〜あるので一覧には載せない。棚の一覧で要るのは小さな絵だけ
    m.smiles AS smiles,
    m.molecular_weight AS molecular_weight,
    m.density AS density,
    m.purity AS purity
  FROM reagent_stocks s
  LEFT JOIN reagent_masters m ON m.id = s.reagent_master_id AND m.tenant_id = s.tenant_id`;

function text(value, max = 4000) {
  return String(value ?? '').slice(0, max).trim();
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function likePattern(q) {
  return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// 紐づけ先のマスタが自分のテナントに実在するか確かめる。
// 空文字・未指定は「マスタに紐づけない在庫」を意味するのでnullを返す
async function resolveMasterId(env, ctx, value) {
  const id = text(value, 40);
  if (!id) return { ok: true, id: null };
  const row = await env.DB.prepare(
    `SELECT id FROM reagent_masters
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.tenantId).first();
  if (!row) return { ok: false };
  return { ok: true, id };
}

export async function listStocks(env, ctx, { q } = {}) {
  const query = text(q, 100);
  if (query) {
    const pattern = likePattern(query);
    const { results } = await env.DB.prepare(
      `${SELECT_SQL}
        WHERE s.tenant_id = ? AND s.deleted_at IS NULL
          AND (m.name LIKE ? ESCAPE '\\'
            OR s.custom_reagent_name LIKE ? ESCAPE '\\'
            OR s.manufacturer LIKE ? ESCAPE '\\'
            OR s.lot_number LIKE ? ESCAPE '\\'
            OR s.storage_location LIKE ? ESCAPE '\\')
        ORDER BY s.updated_at DESC`
    ).bind(ctx.tenantId, pattern, pattern, pattern, pattern, pattern).all();
    return { status: 200, data: { stocks: results ?? [] } };
  }
  const { results } = await env.DB.prepare(
    `${SELECT_SQL}
      WHERE s.tenant_id = ? AND s.deleted_at IS NULL
      ORDER BY s.updated_at DESC`
  ).bind(ctx.tenantId).all();
  return { status: 200, data: { stocks: results ?? [] } };
}

export async function getStock(env, ctx, id) {
  const row = await env.DB.prepare(
    `${SELECT_SQL}
      WHERE s.id = ? AND s.tenant_id = ? AND s.deleted_at IS NULL`
  ).bind(id, ctx.tenantId).first();
  if (!row) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { stock: row } };
}

export async function createStock(env, ctx, body, nowIso = new Date().toISOString()) {
  const master = await resolveMasterId(env, ctx, body?.reagent_master_id);
  if (!master.ok) return { status: 400, data: { error: 'reagent_master_not_found' } };
  const customName = text(body?.custom_reagent_name, 300);
  // マスタにも紐づかず名前も無い在庫は、あとから誰にも分からなくなるので断る
  if (!master.id && !customName) return { status: 400, data: { error: 'reagent_required' } };

  const id = ulid();
  await env.DB.prepare(
    `INSERT INTO reagent_stocks
       (id, tenant_id, reagent_master_id, custom_reagent_name, manufacturer, lot_number,
        received_date, is_opened, storage_location, remaining_amount, remaining_unit,
        notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, ctx.tenantId, master.id, customName,
    text(body?.manufacturer, 200), text(body?.lot_number, 100),
    text(body?.received_date, 30), body?.is_opened ? 1 : 0,
    text(body?.storage_location, 200), num(body?.remaining_amount),
    text(body?.remaining_unit, 20), text(body?.notes, 20000), nowIso, nowIso
  ).run();
  const created = await getStock(env, ctx, id);
  return { ...created, status: 201 };
}

export async function patchStock(env, ctx, id, body, nowIso = new Date().toISOString()) {
  const current = await env.DB.prepare(
    `SELECT reagent_master_id, custom_reagent_name FROM reagent_stocks
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.tenantId).first();
  if (!current) return { status: 404, data: { error: 'not_found' } };

  const sets = [];
  const args = [];
  const put = (column, value) => { sets.push(`${column} = ?`); args.push(value); };

  // 部分更新でも「マスタにも紐づかず名前も無い在庫」を作らせない。
  // 書く前に、更新後がどうなるかを組み立てて判定する
  let masterId = current.reagent_master_id ?? null;
  let customName = String(current.custom_reagent_name ?? '');
  if (body?.reagent_master_id !== undefined) {
    const master = await resolveMasterId(env, ctx, body.reagent_master_id);
    if (!master.ok) return { status: 400, data: { error: 'reagent_master_not_found' } };
    masterId = master.id;
    put('reagent_master_id', master.id);
  }
  if (body?.custom_reagent_name !== undefined) {
    customName = text(body.custom_reagent_name, 300);
    put('custom_reagent_name', customName);
  }
  if (!masterId && !customName) return { status: 400, data: { error: 'reagent_required' } };
  if (body?.manufacturer !== undefined) put('manufacturer', text(body.manufacturer, 200));
  if (body?.lot_number !== undefined) put('lot_number', text(body.lot_number, 100));
  if (body?.received_date !== undefined) put('received_date', text(body.received_date, 30));
  if (body?.is_opened !== undefined) put('is_opened', body.is_opened ? 1 : 0);
  if (body?.storage_location !== undefined) put('storage_location', text(body.storage_location, 200));
  if (body?.remaining_amount !== undefined) put('remaining_amount', num(body.remaining_amount));
  if (body?.remaining_unit !== undefined) put('remaining_unit', text(body.remaining_unit, 20));
  if (body?.notes !== undefined) put('notes', text(body.notes, 20000));
  if (!sets.length) return { status: 400, data: { error: 'no_fields' } };

  put('updated_at', nowIso);
  args.push(id, ctx.tenantId);
  const res = await env.DB.prepare(
    `UPDATE reagent_stocks SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(...args).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return await getStock(env, ctx, id);
}

export async function deleteStock(env, ctx, id, nowIso = new Date().toISOString()) {
  const res = await env.DB.prepare(
    `UPDATE reagent_stocks SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(nowIso, nowIso, id, ctx.tenantId).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { ok: true, id } };
}
