// 機器（研究室の装置）のCRUDと一括取り込み。
// 「どの機器で測ったか」を記録に残せるようにするための台帳。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること。
import { ulid } from '../ulid.mjs';
import { commitWithAudit } from '../audit.mjs';

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
  const stmt = env.DB.prepare(INSERT_SQL).bind(...insertArgs(id, ctx.tenantId, row, nowIso));
  await commitWithAudit(env, ctx, [stmt], {
    action: 'equipment.create', targetType: 'equipment', targetId: id,
    after: { ...row },
  }, nowIso);
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
  // 監査は1件にまとめて、作った id の束と件数だけを残す
  await commitWithAudit(env, ctx, rows.map((row, i) => (
    env.DB.prepare(INSERT_SQL).bind(...insertArgs(ids[i], ctx.tenantId, row, nowIso))
  )), {
    action: 'equipment.bulk', targetType: 'equipment', targetId: '',
    after: { ids, count: ids.length },
  }, nowIso);
  return { status: 201, data: { created: ids.length, ids } };
}

export async function patchEquipment(env, ctx, id, body, nowIso = new Date().toISOString()) {
  // 監査の before を取るために先に現在行を引く（無ければ従来どおり404）
  const current = await env.DB.prepare(
    `SELECT ${COLUMNS}
       FROM equipments
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.tenantId).first();
  if (!current) return { status: 404, data: { error: 'not_found' } };

  const sets = [];
  const args = [];
  const put = (column, value) => { sets.push(`${column} = ?`); args.push(value); };
  const changes = [];

  if (body?.name !== undefined) {
    const name = text(body.name, 300);
    if (!name) return { status: 400, data: { error: 'name_required' } };
    put('name', name);
    changes.push(['name', name]);
  }
  if (body?.category !== undefined) {
    const v = text(body.category, 200);
    put('category', v);
    changes.push(['category', v]);
  }
  if (body?.capacity !== undefined) {
    const v = text(body.capacity, 200);
    put('capacity', v);
    changes.push(['capacity', v]);
  }
  if (body?.temperature_range !== undefined) {
    const v = text(body.temperature_range, 200);
    put('temperature_range', v);
    changes.push(['temperature_range', v]);
  }
  if (body?.pressure_range !== undefined) {
    const v = text(body.pressure_range, 200);
    put('pressure_range', v);
    changes.push(['pressure_range', v]);
  }
  if (body?.manufacturer !== undefined) {
    const v = text(body.manufacturer, 200);
    put('manufacturer', v);
    changes.push(['manufacturer', v]);
  }
  if (body?.model_number !== undefined) {
    const v = text(body.model_number, 200);
    put('model_number', v);
    changes.push(['model_number', v]);
  }
  if (body?.management_number !== undefined) {
    const v = text(body.management_number, 100);
    put('management_number', v);
    changes.push(['management_number', v]);
  }
  if (body?.notes !== undefined) {
    const v = text(body.notes, 20000);
    put('notes', v);
    changes.push(['notes', v]);
  }
  if (!sets.length) return { status: 400, data: { error: 'no_fields' } };

  // 監査の before/after には「変わった列」だけを入れる
  const before = {};
  const after = {};
  for (const [column, value] of changes) {
    const oldVal = current[column] ?? null;
    if (oldVal !== (value ?? null)) {
      before[column] = oldVal;
      after[column] = value ?? null;
    }
  }

  put('updated_at', nowIso);
  args.push(id, ctx.tenantId);
  const stmt = env.DB.prepare(
    `UPDATE equipments SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(...args);
  const { results } = await commitWithAudit(env, ctx, [stmt], {
    action: 'equipment.update', targetType: 'equipment', targetId: id, before, after,
  }, nowIso);
  if (!results[0].meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return await getEquipment(env, ctx, id);
}

export async function deleteEquipment(env, ctx, id, nowIso = new Date().toISOString()) {
  // 監査の before を取るために先に対象行を引く（無ければ従来どおり404）
  const current = await env.DB.prepare(
    `SELECT name, model_number, management_number FROM equipments
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.tenantId).first();
  if (!current) return { status: 404, data: { error: 'not_found' } };
  const stmt = env.DB.prepare(
    `UPDATE equipments SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(nowIso, nowIso, id, ctx.tenantId);
  const { results } = await commitWithAudit(env, ctx, [stmt], {
    action: 'equipment.delete', targetType: 'equipment', targetId: id,
    before: {
      name: current.name,
      model_number: current.model_number ?? '',
      management_number: current.management_number ?? '',
    },
  }, nowIso);
  if (!results[0].meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { ok: true, id } };
}
