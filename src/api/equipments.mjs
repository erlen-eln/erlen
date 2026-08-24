// 機器（研究室の装置）のCRUDと一括取り込み。
// 「どの機器で測ったか」を記録に残せるようにするための台帳。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること。
import { ulid } from '../ulid.mjs';

const COLUMNS = [
  'id', 'name', 'category', 'capacity', 'temperature_range', 'pressure_range',
  'manufacturer', 'model_number', 'management_number', 'notes', 'created_at', 'updated_at',
].join(', ');

// 一括取り込み（プリセット）の1回あたりの上限。reagents.mjs と同じ値
export const BULK_LIMIT = 100;

function text(value, max = 4000) {
  return String(value ?? '').slice(0, max).trim();
}

export function likePattern(q) {
  return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function normalizeEquipment(input) {
  return {
    name: text(input?.name, 300),
    category: text(input?.category, 200),
    capacity: text(input?.capacity, 200),
    temperature_range: text(input?.temperature_range, 200),
    pressure_range: text(input?.pressure_range, 200),
    manufacturer: text(input?.manufacturer, 200),
    model_number: text(input?.model_number, 200),
    management_number: text(input?.management_number, 100),
    notes: text(input?.notes, 20000),
  };
}

const INSERT_SQL = `INSERT INTO equipments
    (id, tenant_id, name, category, capacity, temperature_range, pressure_range,
     manufacturer, model_number, management_number, notes, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const insertArgs = (id, tenantId, row, nowIso) => [
  id, tenantId, row.name, row.category, row.capacity, row.temperature_range, row.pressure_range,
  row.manufacturer, row.model_number, row.management_number, row.notes, nowIso, nowIso,
];

// 一覧。?q= があれば名前・分類・メーカー・型番・管理番号の部分一致で絞る
export async function listEquipments(env, ctx, { q } = {}) {
  const query = text(q, 100);
  if (query) {
    const pattern = likePattern(query);
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS}
         FROM equipments
        WHERE tenant_id = ? AND deleted_at IS NULL
          AND (name LIKE ? ESCAPE '\\'
            OR category LIKE ? ESCAPE '\\'
            OR manufacturer LIKE ? ESCAPE '\\'
            OR model_number LIKE ? ESCAPE '\\'
            OR management_number LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC`
    ).bind(ctx.tenantId, pattern, pattern, pattern, pattern, pattern).all();
    return { status: 200, data: { equipments: results ?? [] } };
  }
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS}
       FROM equipments
      WHERE tenant_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC`
  ).bind(ctx.tenantId).all();
  return { status: 200, data: { equipments: results ?? [] } };
}

export async function getEquipment(env, ctx, id) {
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS}
       FROM equipments
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.tenantId).first();
  if (!row) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { equipment: row } };
}

export async function createEquipment(env, ctx, body, nowIso = new Date().toISOString()) {
  const row = normalizeEquipment(body);
  if (!row.name) return { status: 400, data: { error: 'name_required' } };
  const id = ulid();
  await env.DB.prepare(INSERT_SQL).bind(...insertArgs(id, ctx.tenantId, row, nowIso)).run();
  const created = await getEquipment(env, ctx, id);
  return { ...created, status: 201 };
}

// プリセット（public/presets/equipments.json）の取り込み口。
// 試薬マスタと同じく、同名でも弾かない（同型機を2台持っている研究室は普通にある）
export async function bulkCreateEquipments(env, ctx, body, nowIso = new Date().toISOString()) {
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length === 0) return { status: 400, data: { error: 'items_required' } };
  if (items.length > BULK_LIMIT) {
    return { status: 400, data: { error: 'too_many_items', limit: BULK_LIMIT } };
  }
  const rows = items.map((item) => normalizeEquipment(item));
  const missing = rows.findIndex((row) => !row.name);
  if (missing >= 0) return { status: 400, data: { error: 'name_required', index: missing } };

  const ids = rows.map(() => ulid());
  await env.DB.batch(rows.map((row, i) => (
    env.DB.prepare(INSERT_SQL).bind(...insertArgs(ids[i], ctx.tenantId, row, nowIso))
  )));
  return { status: 201, data: { created: ids.length, ids } };
}

export async function patchEquipment(env, ctx, id, body, nowIso = new Date().toISOString()) {
  const sets = [];
  const args = [];
  const put = (column, value) => { sets.push(`${column} = ?`); args.push(value); };

  if (body?.name !== undefined) {
    const name = text(body.name, 300);
    if (!name) return { status: 400, data: { error: 'name_required' } };
    put('name', name);
  }
  if (body?.category !== undefined) put('category', text(body.category, 200));
  if (body?.capacity !== undefined) put('capacity', text(body.capacity, 200));
  if (body?.temperature_range !== undefined) put('temperature_range', text(body.temperature_range, 200));
  if (body?.pressure_range !== undefined) put('pressure_range', text(body.pressure_range, 200));
  if (body?.manufacturer !== undefined) put('manufacturer', text(body.manufacturer, 200));
  if (body?.model_number !== undefined) put('model_number', text(body.model_number, 200));
  if (body?.management_number !== undefined) put('management_number', text(body.management_number, 100));
  if (body?.notes !== undefined) put('notes', text(body.notes, 20000));
  if (!sets.length) return { status: 400, data: { error: 'no_fields' } };

  put('updated_at', nowIso);
  args.push(id, ctx.tenantId);
  const res = await env.DB.prepare(
    `UPDATE equipments SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(...args).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return await getEquipment(env, ctx, id);
}

export async function deleteEquipment(env, ctx, id, nowIso = new Date().toISOString()) {
  const res = await env.DB.prepare(
    `UPDATE equipments SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(nowIso, nowIso, id, ctx.tenantId).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { ok: true, id } };
}
