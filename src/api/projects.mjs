// プロジェクト（ノートブックの束）と、その閲覧可能メンバーの管理。
// 各関数は {status, data} を返すだけの素の関数（Responseを作らない）。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること（test/tenant-scope.test.mjs が検査する）。
//
// 見える・見えないの判定そのものは src/access.mjs が持っている。ここはそれを使うだけ。
// 作成・変更・メンバー設定はオーナー専用（可否の判定は worker.mjs 側でまとめて行う）。
import { ulid } from '../ulid.mjs';
import { projectVisibility } from '../access.mjs';

const COLUMNS = 'p.id, p.name, p.description, p.created_at, p.updated_at';

function text(value, max = 4000) {
  return String(value ?? '').slice(0, max).trim();
}

// 一覧。自分に見えるプロジェクトだけを返す。
// ノートブック数を添えるのは、画面が「空のプロジェクト」を見分けられるようにするため
export async function listProjects(env, ctx) {
  const vis = projectVisibility(ctx, 'p');
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
            (SELECT COUNT(*) FROM notebooks nb
              WHERE nb.tenant_id = p.tenant_id AND nb.project_id = p.id
                AND nb.deleted_at IS NULL) AS notebook_count
       FROM projects p
      WHERE p.tenant_id = ? AND p.deleted_at IS NULL${vis.sql}
      ORDER BY p.created_at ASC`
  ).bind(ctx.tenantId, ...vis.args).all();
  return { status: 200, data: { projects: results ?? [] } };
}

// 閲覧可能メンバーの一覧（user_idと、画面に出すためのメール・名前）
async function membersOf(env, ctx, projectId) {
  const { results } = await env.DB.prepare(
    `SELECT pm.user_id, u.email, u.name, u.role
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id AND u.tenant_id = pm.tenant_id AND u.deleted_at IS NULL
      WHERE pm.tenant_id = ? AND pm.project_id = ?
      ORDER BY u.created_at ASC`
  ).bind(ctx.tenantId, projectId).all();
  return (results ?? []).map((row) => ({
    user_id: row.user_id,
    email: row.email,
    name: row.name ?? '',
    role: row.role,
  }));
}

export async function getProject(env, ctx, id) {
  const vis = projectVisibility(ctx, 'p');
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS}
       FROM projects p
      WHERE p.id = ? AND p.tenant_id = ? AND p.deleted_at IS NULL${vis.sql}`
  ).bind(id, ctx.tenantId, ...vis.args).first();
  if (!row) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { project: row, members: await membersOf(env, ctx, id) } };
}

export async function createProject(env, ctx, body, nowIso = new Date().toISOString()) {
  const name = text(body?.name, 200);
  if (!name) return { status: 400, data: { error: 'name_required' } };
  const id = ulid();
  await env.DB.prepare(
    `INSERT INTO projects (id, tenant_id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, ctx.tenantId, name, text(body?.description), nowIso, nowIso).run();
  const created = await getProject(env, ctx, id);
  return { ...created, status: 201 };
}

export async function patchProject(env, ctx, id, body, nowIso = new Date().toISOString()) {
  const sets = [];
  const args = [];
  if (body?.name !== undefined) {
    const name = text(body.name, 200);
    if (!name) return { status: 400, data: { error: 'name_required' } };
    sets.push('name = ?');
    args.push(name);
  }
  if (body?.description !== undefined) {
    sets.push('description = ?');
    args.push(text(body.description));
  }
  if (!sets.length) return { status: 400, data: { error: 'no_fields' } };
  sets.push('updated_at = ?');
  args.push(nowIso, id, ctx.tenantId);
  const res = await env.DB.prepare(
    `UPDATE projects SET ${sets.join(', ')}
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(...args).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return await getProject(env, ctx, id);
}

// 論理削除。配下のノートブックは消さず、project_id を外して「プロジェクトなし」に戻す。
// プロジェクトを畳んだだけで実験記録が誰からも見えなくなる、という事故を起こさないため
export async function deleteProject(env, ctx, id, nowIso = new Date().toISOString()) {
  const res = await env.DB.prepare(
    `UPDATE projects SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(nowIso, nowIso, id, ctx.tenantId).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE notebooks SET project_id = NULL, updated_at = ?
        WHERE project_id = ? AND tenant_id = ? AND deleted_at IS NULL`
    ).bind(nowIso, id, ctx.tenantId),
    env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND tenant_id = ?')
      .bind(id, ctx.tenantId),
  ]);
  return { status: 200, data: { ok: true, id } };
}

// 閲覧可能メンバーの一括置換。差分APIにすると「消し忘れ」で見えてはいけない人が残る。
// 画面のチェックボックスの状態をそのまま送ってもらい、丸ごと入れ替える。
// オーナーは行が無くても全部見えるので、ここに入れる必要はない（入れても害はない）
export async function putProjectMembers(env, ctx, id, body, nowIso = new Date().toISOString()) {
  const project = await env.DB.prepare(
    'SELECT id FROM projects WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL'
  ).bind(id, ctx.tenantId).first();
  if (!project) return { status: 404, data: { error: 'not_found' } };

  const raw = Array.isArray(body?.user_ids) ? body.user_ids : null;
  if (!raw) return { status: 400, data: { error: 'user_ids_required' } };
  const wanted = [...new Set(raw.map((v) => String(v ?? '').slice(0, 100)).filter(Boolean))];
  if (wanted.length > 200) return { status: 400, data: { error: 'too_many_members', limit: 200 } };

  // 自テナントに実在する生きたユーザーだけを受け付ける。
  // 知らないIDが混ざっていたら黙って捨てず、400で突き返す（設定した気になるのを防ぐ）
  if (wanted.length) {
    const holes = wanted.map(() => '?').join(', ');
    const { results } = await env.DB.prepare(
      `SELECT id FROM users
        WHERE tenant_id = ? AND deleted_at IS NULL AND id IN (${holes})`
    ).bind(ctx.tenantId, ...wanted).all();
    if ((results ?? []).length !== wanted.length) {
      return { status: 400, data: { error: 'unknown_user' } };
    }
  }

  const statements = [
    env.DB.prepare('DELETE FROM project_members WHERE tenant_id = ? AND project_id = ?')
      .bind(ctx.tenantId, id),
    ...wanted.map((userId) => env.DB.prepare(
      `INSERT INTO project_members (id, tenant_id, project_id, user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(ulid(), ctx.tenantId, id, userId, nowIso)),
  ];
  await env.DB.batch(statements);
  return { status: 200, data: { members: await membersOf(env, ctx, id) } };
}
