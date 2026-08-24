// ノートブック（実験ノートの冊子）のCRUD。
// 各関数は {status, data} を返すだけの素の関数にしてあるので、Responseを作らずにテストできる。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること（test/tenant-scope.test.mjs が検査する）。
//
// 閲覧範囲（プロジェクト）の判定は src/access.mjs に寄せてある。
// 見えないノートブックは 403 ではなく 404 を返す（存在ごと隠す）。
import { ulid } from '../ulid.mjs';
import { notebookVisibility } from '../access.mjs';

const COLUMNS = 'id, title, description, project_id, sort_order, created_at, updated_at';

// 文字列の入力を整える。undefinedは「指定なし」、それ以外は文字列化してトリムする
function text(value, max = 4000) {
  return String(value ?? '').slice(0, max).trim();
}

// project_id の入力を検証する。'' と null は「プロジェクトなし」、
// 実在しないIDは400（黙ってNULLに落とすと、設定した気になったまま全員に見えてしまう）
async function resolveProjectId(env, ctx, value) {
  const id = text(value, 100);
  if (!id) return { ok: true, id: null };
  const found = await env.DB.prepare(
    'SELECT id FROM projects WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.tenantId).first();
  if (!found) return { ok: false };
  return { ok: true, id };
}

export async function listNotebooks(env, ctx) {
  const vis = notebookVisibility(ctx, 'notebooks');
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS}
       FROM notebooks
      WHERE tenant_id = ? AND deleted_at IS NULL${vis.sql}
      ORDER BY sort_order ASC, updated_at DESC`
  ).bind(ctx.tenantId, ...vis.args).all();
  return { status: 200, data: { notebooks: results ?? [] } };
}

export async function getNotebook(env, ctx, id) {
  const vis = notebookVisibility(ctx, 'notebooks');
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS}
       FROM notebooks
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${vis.sql}`
  ).bind(id, ctx.tenantId, ...vis.args).first();
  if (!row) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { notebook: row } };
}

export async function createNotebook(env, ctx, body, nowIso = new Date().toISOString()) {
  const title = text(body?.title, 200);
  if (!title) return { status: 400, data: { error: 'title_required' } };
  const project = await resolveProjectId(env, ctx, body?.project_id);
  if (!project.ok) return { status: 400, data: { error: 'project_not_found' } };
  const id = ulid();
  await env.DB.prepare(
    `INSERT INTO notebooks
       (id, tenant_id, user_id, title, description, project_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, ctx.tenantId, ctx.userId, title, text(body?.description), project.id, 0, nowIso, nowIso)
    .run();
  return await getNotebook(env, ctx, id).then((r) => ({ ...r, status: 201 }));
}

export async function patchNotebook(env, ctx, id, body, nowIso = new Date().toISOString()) {
  // 見えないノートブックは触らせない。ここを飛ばすと、存在しないはずのIDを
  // 当てずっぽうで叩かれたときに「更新できた／できない」で存在が漏れる
  const current = await getNotebook(env, ctx, id);
  if (current.status !== 200) return current;

  const sets = [];
  const args = [];
  if (body?.title !== undefined) {
    const title = text(body.title, 200);
    if (!title) return { status: 400, data: { error: 'title_required' } };
    sets.push('title = ?');
    args.push(title);
  }
  if (body?.description !== undefined) {
    sets.push('description = ?');
    args.push(text(body.description));
  }
  if (body?.project_id !== undefined) {
    const project = await resolveProjectId(env, ctx, body.project_id);
    if (!project.ok) return { status: 400, data: { error: 'project_not_found' } };
    sets.push('project_id = ?');
    args.push(project.id);
  }
  if (body?.sort_order !== undefined) {
    sets.push('sort_order = ?');
    args.push(Number.isFinite(Number(body.sort_order)) ? Math.trunc(Number(body.sort_order)) : 0);
  }
  if (!sets.length) return { status: 400, data: { error: 'no_fields' } };
  sets.push('updated_at = ?');
  args.push(nowIso, id, ctx.tenantId);
  const res = await env.DB.prepare(
    `UPDATE notebooks SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(...args).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  // プロジェクトを付け替えた直後は自分から見えなくなっていることがある（オーナー以外）。
  // その場合も更新自体は成功しているので、素っ気なく ok だけ返す
  const after = await getNotebook(env, ctx, id);
  return after.status === 200 ? after : { status: 200, data: { ok: true, id } };
}

// 論理削除。実験ノートは物理削除しない（deleted_atを入れるだけ）。
// 配下のページも同時に伏せる（一覧から消えるだけで、中身は残る）
export async function deleteNotebook(env, ctx, id, nowIso = new Date().toISOString()) {
  const current = await getNotebook(env, ctx, id);
  if (current.status !== 200) return current;
  const res = await env.DB.prepare(
    `UPDATE notebooks SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(nowIso, nowIso, id, ctx.tenantId).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  await env.DB.prepare(
    `UPDATE pages SET deleted_at = ?, updated_at = ?
      WHERE notebook_id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(nowIso, nowIso, id, ctx.tenantId).run();
  return { status: 200, data: { ok: true, id } };
}
