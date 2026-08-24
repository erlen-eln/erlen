// 実験ページのCRUD。1実験＝1ページ。
// status='closed'（記録の確定）にすると本文も分子も編集できなくなる（409）。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること。
//
// 所属ノートブックが見えない人には、ページも存在しないように振る舞う（src/access.mjs）。
import { ulid } from '../ulid.mjs';
import { listMolecules } from './molecules.mjs';
import { notebookVisibility, pageVisibility } from '../access.mjs';

const COLUMNS = 'id, notebook_id, user_id, title, content, status, experiment_date, created_at, updated_at';
// 一覧では本文（content）を返さない。ページが増えたときの転送量を抑えるため
const LIST_COLUMNS = 'id, notebook_id, title, status, experiment_date, created_at, updated_at';

function text(value, max = 200000) {
  return String(value ?? '').slice(0, max);
}

export async function listPages(env, ctx, notebookId) {
  const nbVis = notebookVisibility(ctx, 'notebooks');
  const notebook = await env.DB.prepare(
    `SELECT id FROM notebooks
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${nbVis.sql}`
  ).bind(notebookId, ctx.tenantId, ...nbVis.args).first();
  if (!notebook) return { status: 404, data: { error: 'notebook_not_found' } };
  const { results } = await env.DB.prepare(
    `SELECT ${LIST_COLUMNS}
       FROM pages
      WHERE tenant_id = ? AND notebook_id = ? AND deleted_at IS NULL
      ORDER BY experiment_date DESC, created_at DESC`
  ).bind(ctx.tenantId, notebookId).all();
  return { status: 200, data: { pages: results ?? [] } };
}

// ページ単体。画面はこれ1本で「本文＋試薬表」を描けるよう、分子も同梱して返す
export async function getPage(env, ctx, pageId) {
  const vis = pageVisibility(ctx, 'pages');
  const page = await env.DB.prepare(
    `SELECT ${COLUMNS}
       FROM pages
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${vis.sql}`
  ).bind(pageId, ctx.tenantId, ...vis.args).first();
  if (!page) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { page, molecules: await listMolecules(env, ctx, pageId) } };
}

export async function createPage(env, ctx, notebookId, body, nowIso = new Date().toISOString()) {
  const title = text(body?.title, 300).trim();
  if (!title) return { status: 400, data: { error: 'title_required' } };
  const nbVis = notebookVisibility(ctx, 'notebooks');
  const notebook = await env.DB.prepare(
    `SELECT id FROM notebooks
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${nbVis.sql}`
  ).bind(notebookId, ctx.tenantId, ...nbVis.args).first();
  if (!notebook) return { status: 404, data: { error: 'notebook_not_found' } };

  const id = ulid();
  await env.DB.prepare(
    `INSERT INTO pages
       (id, tenant_id, notebook_id, user_id, title, content, status, experiment_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', 'draft', ?, ?, ?)`
  ).bind(id, ctx.tenantId, notebookId, ctx.userId, title,
    text(body?.experiment_date, 30), nowIso, nowIso).run();
  const created = await getPage(env, ctx, id);
  return { ...created, status: 201 };
}

export async function patchPage(env, ctx, pageId, body, nowIso = new Date().toISOString()) {
  const vis = pageVisibility(ctx, 'pages');
  const current = await env.DB.prepare(
    `SELECT id, status FROM pages
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${vis.sql}`
  ).bind(pageId, ctx.tenantId, ...vis.args).first();
  if (!current) return { status: 404, data: { error: 'not_found' } };
  // 確定済みは中身を変えられない。
  // ただし「確定を取り消す」（status を draft へ戻すだけの指示）は通す。
  // 画面に取り消しボタンがあり、締めたあとに書き足しが要ると分かることは実際にある。
  // 中身の変更と同時には受け付けない（取り消しを経ずに書き換える抜け道を作らないため）。
  if (current.status === 'closed') {
    const onlyReopen = body?.status === 'draft'
      && body?.title === undefined
      && body?.content === undefined
      && body?.experiment_date === undefined;
    if (!onlyReopen) return { status: 409, data: { error: 'page_closed' } };
  }

  const sets = [];
  const args = [];
  if (body?.title !== undefined) {
    const title = text(body.title, 300).trim();
    if (!title) return { status: 400, data: { error: 'title_required' } };
    sets.push('title = ?');
    args.push(title);
  }
  if (body?.content !== undefined) {
    sets.push('content = ?');
    args.push(text(body.content));
  }
  if (body?.status !== undefined) {
    if (!['draft', 'closed'].includes(body.status)) {
      return { status: 400, data: { error: 'invalid_status' } };
    }
    sets.push('status = ?');
    args.push(body.status);
  }
  if (body?.experiment_date !== undefined) {
    sets.push('experiment_date = ?');
    args.push(text(body.experiment_date, 30));
  }
  if (!sets.length) return { status: 400, data: { error: 'no_fields' } };
  sets.push('updated_at = ?');
  args.push(nowIso, pageId, ctx.tenantId);

  const res = await env.DB.prepare(
    `UPDATE pages SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(...args).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return await getPage(env, ctx, pageId);
}

// 論理削除。確定済みでも一覧から下げることはできる（記録自体は残る）
export async function deletePage(env, ctx, pageId, nowIso = new Date().toISOString()) {
  const vis = pageVisibility(ctx, 'pages');
  const res = await env.DB.prepare(
    `UPDATE pages SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${vis.sql}`
  ).bind(nowIso, nowIso, pageId, ctx.tenantId, ...vis.args).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { ok: true, id: pageId } };
}
