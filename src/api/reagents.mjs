// 試薬マスタ（研究室で使う試薬の定義）のCRUDと一括取り込み。
// ここに登録しておくと、反応テーブルの「マスタから挿入」で分子量や構造式ごと引き写せる。
// 各関数は {status, data} を返すだけの素の関数（Responseはworker.mjsが作る）。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること（test/tenant-scope.test.mjs が検査する）。
import { ulid } from '../ulid.mjs';
import { commitWithAudit } from '../audit.mjs';
import { sha256Hex } from './attachments.mjs';

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

// 構造式（molfile/svg）は大きいので、監査証跡にはハッシュと文字数だけを入れる
// （pages.mjs が本文を content_sha256/content_len で記録するのと同じ扱い）。
// 値1つぶんの {sha256, len} を返す
async function blobAudit(value) {
  return {
    sha256: await sha256Hex(new TextEncoder().encode(value ?? '')),
    len: String(value ?? '').length,
  };
}

// 新規作成の after。構造式だけハッシュ化し、残りはそのまま入れる
async function createSnapshot(row) {
  const { molfile, svg, ...rest } = row;
  const m = await blobAudit(molfile);
  const s = await blobAudit(svg);
  return {
    ...rest,
    molfile_sha256: m.sha256, molfile_len: m.len,
    svg_sha256: s.sha256, svg_len: s.len,
  };
}

// 部分更新で「変わった列」を before/after に1列ぶん記録する
async function trackChange(before, after, current, column, value) {
  const oldVal = current[column] ?? null;
  const newVal = value ?? null;
  if (oldVal === newVal) return;
  if (column === 'molfile' || column === 'svg') {
    const b = await blobAudit(oldVal);
    before[`${column}_sha256`] = b.sha256;
    before[`${column}_len`] = b.len;
    const a = await blobAudit(newVal);
    after[`${column}_sha256`] = a.sha256;
    after[`${column}_len`] = a.len;
    return;
  }
  before[column] = oldVal;
  after[column] = newVal;
}

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
  const stmt = env.DB.prepare(INSERT_SQL).bind(...insertArgs(id, ctx.tenantId, row, nowIso));
  await commitWithAudit(env, ctx, [stmt], {
    action: 'reagent.create', targetType: 'reagent', targetId: id,
    after: await createSnapshot(row),
  }, nowIso);
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
  // batchは1発が1トランザクション。途中で落ちても半端に入らない。
  // 監査は1件にまとめて、作った id の束と件数だけを残す
  await commitWithAudit(env, ctx, rows.map((row, i) => (
    env.DB.prepare(INSERT_SQL).bind(...insertArgs(ids[i], ctx.tenantId, row, nowIso))
  )), {
    action: 'reagent.bulk', targetType: 'reagent', targetId: '',
    after: { ids, count: ids.length },
  }, nowIso);
  return { status: 201, data: { created: ids.length, ids } };
}

export async function patchReagent(env, ctx, id, body, nowIso = new Date().toISOString()) {
  // 監査の before を取るために先に現在行を引く（無ければ従来どおり404）
  const current = await env.DB.prepare(
    `SELECT ${COLUMNS}
       FROM reagent_masters
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
  if (body?.cas_number !== undefined) {
    const v = text(body.cas_number, 40);
    put('cas_number', v);
    changes.push(['cas_number', v]);
  }
  if (body?.molecular_weight !== undefined) {
    const v = num(body.molecular_weight);
    put('molecular_weight', v);
    changes.push(['molecular_weight', v]);
  }
  if (body?.purity !== undefined) {
    const v = num(body.purity);
    put('purity', v);
    changes.push(['purity', v]);
  }
  if (body?.density !== undefined) {
    const v = num(body.density);
    put('density', v);
    changes.push(['density', v]);
  }
  if (body?.smiles !== undefined) {
    const v = text(body.smiles, 20000);
    put('smiles', v);
    changes.push(['smiles', v]);
  }
  if (body?.molfile !== undefined) {
    const v = raw(body.molfile);
    put('molfile', v);
    changes.push(['molfile', v]);
  }
  if (body?.svg !== undefined) {
    const v = raw(body.svg);
    put('svg', v);
    changes.push(['svg', v]);
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
  for (const [column, value] of changes) await trackChange(before, after, current, column, value);

  put('updated_at', nowIso);
  args.push(id, ctx.tenantId);
  const stmt = env.DB.prepare(
    `UPDATE reagent_masters SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(...args);
  const { results } = await commitWithAudit(env, ctx, [stmt], {
    action: 'reagent.update', targetType: 'reagent', targetId: id, before, after,
  }, nowIso);
  if (!results[0].meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return await getReagent(env, ctx, id);
}

// 論理削除。在庫（reagent_stocks）が参照していても消してよい。
// 在庫側は表示名をマスタから引けなくなるだけで、行そのものは残る（現物は棚にあるため）
export async function deleteReagent(env, ctx, id, nowIso = new Date().toISOString()) {
  // 監査の before を取るために先に対象行を引く（無ければ従来どおり404）
  const current = await env.DB.prepare(
    `SELECT name, cas_number FROM reagent_masters
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.tenantId).first();
  if (!current) return { status: 404, data: { error: 'not_found' } };
  const stmt = env.DB.prepare(
    `UPDATE reagent_masters SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(nowIso, nowIso, id, ctx.tenantId);
  const { results } = await commitWithAudit(env, ctx, [stmt], {
    action: 'reagent.delete', targetType: 'reagent', targetId: id,
    before: { name: current.name, cas_number: current.cas_number },
  }, nowIso);
  if (!results[0].meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { ok: true, id } };
}
