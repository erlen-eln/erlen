// 実験ページのCRUD。1実験＝1ページ。
// status='closed'（記録の確定）にすると本文も分子も編集できなくなる（409）。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること。
//
// 所属ノートブックが見えない人には、ページも存在しないように振る舞う（src/access.mjs）。
import { ulid } from '../ulid.mjs';
import { listMolecules } from './molecules.mjs';
import { notebookVisibility, pageVisibility } from '../access.mjs';
import { sha256Hex } from './attachments.mjs';
import { commitWithAudit } from '../audit.mjs';
import { revisionStatement } from '../revisions.mjs';

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
  const experimentDate = text(body?.experiment_date, 30);
  const stmt = env.DB.prepare(
    `INSERT INTO pages
       (id, tenant_id, notebook_id, user_id, title, content, status, experiment_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', 'draft', ?, ?, ?)`
  ).bind(id, ctx.tenantId, notebookId, ctx.userId, title,
    experimentDate, nowIso, nowIso);
  await commitWithAudit(env, ctx, [stmt], {
    action: 'page.create', targetType: 'page', targetId: id, pageId: id,
    after: { title, experiment_date: experimentDate, notebook_id: notebookId },
  }, nowIso);
  const created = await getPage(env, ctx, id);
  return { ...created, status: 201 };
}

export async function patchPage(env, ctx, pageId, body, nowIso = new Date().toISOString()) {
  const vis = pageVisibility(ctx, 'pages');
  // 監査証跡の before と改訂スナップショットのために、変更前の列を引いておく
  const current = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM pages
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
  // 監査証跡に入れる「変わった項目」の before/after と、更新後のページ内容をここで確定させる
  const before = {};
  const after = {};
  const next = {
    title: current.title,
    content: current.content,
    status: current.status,
    experiment_date: current.experiment_date,
  };
  let contentChanged = false;
  if (body?.title !== undefined) {
    const title = text(body.title, 300).trim();
    if (!title) return { status: 400, data: { error: 'title_required' } };
    sets.push('title = ?');
    args.push(title);
    next.title = title;
    if (title !== current.title) {
      before.title = current.title;
      after.title = title;
    }
  }
  if (body?.content !== undefined) {
    const content = text(body.content);
    sets.push('content = ?');
    args.push(content);
    next.content = content;
    contentChanged = content !== current.content;
  }
  if (body?.status !== undefined) {
    if (!['draft', 'closed'].includes(body.status)) {
      return { status: 400, data: { error: 'invalid_status' } };
    }
    sets.push('status = ?');
    args.push(body.status);
    next.status = body.status;
  }
  if (body?.experiment_date !== undefined) {
    const date = text(body.experiment_date, 30);
    sets.push('experiment_date = ?');
    args.push(date);
    next.experiment_date = date;
    if (date !== current.experiment_date) {
      before.experiment_date = current.experiment_date;
      after.experiment_date = date;
    }
  }
  if (!sets.length) return { status: 400, data: { error: 'no_fields' } };
  sets.push('updated_at = ?');
  args.push(nowIso, pageId, ctx.tenantId);

  // 本文そのものは監査証跡に入れない（自動保存ごとに最大200KBが積み上がるため）。
  // ハッシュと文字数だけを記録し、実体は page_revisions のスナップショットが持つ
  if (contentChanged) {
    before.content_sha256 = await sha256Hex(new TextEncoder().encode(current.content));
    before.content_len = current.content.length;
    after.content_sha256 = await sha256Hex(new TextEncoder().encode(next.content));
    after.content_len = next.content.length;
  }

  // status の遷移は専用の action で記録する（確定・確定取消は特に追跡したい操作）
  let ev;
  if (body?.status === 'closed' && current.status !== 'closed') {
    ev = { action: 'page.close', before: { status: current.status }, after: { status: 'closed' } };
  } else if (body?.status === 'draft' && current.status === 'closed') {
    ev = {
      action: 'page.reopen',
      before: { status: 'closed' },
      after: { status: 'draft' },
      reason: body?.reason ? text(body.reason, 500) : '',
    };
  } else {
    ev = { action: 'page.update', before, after };
  }

  const statements = [env.DB.prepare(
    `UPDATE pages SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(...args)];

  // 本文・タイトル・実験日のいずれかが変わったときは改訂履歴も同じ batch に載せる。
  // 形は molecules.mjs のスナップショットに揃えて { page, molecules }。
  // ただし page.updated_at は保存のたびに変わるのでスナップショットからは外す
  // （入れると「直前の版と同一なら書かない」判定が永久に効かなくなる）
  if (contentChanged || before.title !== undefined || before.experiment_date !== undefined) {
    const rev = await revisionStatement(env, ctx, pageId, {
      page: {
        id: current.id, notebook_id: current.notebook_id, user_id: current.user_id,
        title: next.title, content: next.content, status: next.status,
        experiment_date: next.experiment_date, created_at: current.created_at,
      },
      molecules: await listMolecules(env, ctx, pageId),
    }, nowIso);
    if (rev.stmt) statements.push(rev.stmt);
  }

  const { results } = await commitWithAudit(env, ctx, statements, {
    ...ev, targetType: 'page', targetId: pageId, pageId,
  }, nowIso);
  if (!results[0].meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return await getPage(env, ctx, pageId);
}

// 論理削除。確定済みでも一覧から下げることはできる（記録自体は残る）
export async function deletePage(env, ctx, pageId, nowIso = new Date().toISOString()) {
  const vis = pageVisibility(ctx, 'pages');
  // 監査証跡に残す before（title/status）を取るため、消す前に行を引く
  const current = await env.DB.prepare(
    `SELECT id, title, status FROM pages
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${vis.sql}`
  ).bind(pageId, ctx.tenantId, ...vis.args).first();
  if (!current) return { status: 404, data: { error: 'not_found' } };
  const stmt = env.DB.prepare(
    `UPDATE pages SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${vis.sql}`
  ).bind(nowIso, nowIso, pageId, ctx.tenantId, ...vis.args);
  const { results } = await commitWithAudit(env, ctx, [stmt], {
    action: 'page.delete', targetType: 'page', targetId: pageId, pageId,
    before: { title: current.title, status: current.status },
  }, nowIso);
  if (!results[0].meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { ok: true, id: pageId } };
}
