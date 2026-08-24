// 研究室メンバーの管理（招待・権限変更・除名）。
// 各関数は {status, data} を返すだけの素の関数（Responseを作らない）。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること（test/tenant-scope.test.mjs が検査する）。
//
// 招待メールは送らない（この製品はメール基盤を持たない）。
// 招待を作ったら、相手に「そのアドレスのGoogleアカウントで /auth/login からログインして」と
// 口頭・チャットで伝えてもらう。初回ログインのときに /auth/callback が招待を見つけて受諾する。
import { ulid } from '../ulid.mjs';

// 招待で渡せる権限。invitations.role のCHECK（migrations/0002_members.sql）と揃える。
// オーナーは招待では渡さない（参加してもらってから昇格させる）
export const ROLES = ['editor', 'viewer'];

// 参加済みメンバーに付け替えられる権限。オーナーはここにだけ現れる
export const ASSIGNABLE_ROLES = ['owner', 'editor', 'viewer'];

// メールの正規化。小文字＋前後の空白落とし。招待も照合もこの形で行う
export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase().slice(0, 320);
}

function validEmail(value) {
  // 厳密な検証はしない（RFCどおりに書くと実在アドレスを弾く）。形だけ見る
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function ownerEmailOf(env) {
  return String(env?.OWNER_EMAIL ?? '').trim().toLowerCase();
}

// 主オーナー（この環境を設置した人）かどうか。
// 主オーナーは降格も除名もできない。オーナーが1人も居ないテナントを作らせないための最後の砦
export function isPrimaryOwner(env, email) {
  const owner = ownerEmailOf(env);
  return Boolean(owner) && normalizeEmail(email) === owner;
}

// メンバー一覧（参加済みユーザー＋未受諾の招待）を1本のリストにして返す。
// 画面はこれをそのまま表に流すだけでよい
export async function listMembers(env, ctx) {
  const users = await env.DB.prepare(
    `SELECT id, email, name, role, created_at, owner_granted_at
       FROM users
      WHERE tenant_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC`
  ).bind(ctx.tenantId).all();

  const invites = await env.DB.prepare(
    `SELECT id, email, role, created_at
       FROM invitations
      WHERE tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at ASC`
  ).bind(ctx.tenantId).all();

  const members = [
    ...(users.results ?? []).map((row) => ({
      kind: 'member',
      id: row.id,
      email: row.email,
      name: row.name ?? '',
      role: row.role,
      status: 'active',
      created_at: row.created_at,
      // 自分自身の行は画面で「（あなた）」と出し、除名ボタンを出さない
      is_self: row.id === ctx.userId,
      // 設置者の行。画面はこれを見て権限セレクトと除名ボタンを丸ごと隠す
      is_primary_owner: isPrimaryOwner(env, row.email),
      owner_granted_at: row.owner_granted_at ?? null,
    })),
    ...(invites.results ?? []).map((row) => ({
      kind: 'invitation',
      id: row.id,
      email: row.email,
      name: '',
      role: row.role,
      status: 'pending',
      created_at: row.created_at,
      is_self: false,
      is_primary_owner: false,
      owner_granted_at: null,
    })),
  ];
  return { status: 200, data: { members } };
}

// 招待を作る。オーナー専用（可否の判定は worker.mjs 側でまとめて行う）
export async function createInvitation(env, ctx, body, nowIso = new Date().toISOString()) {
  const email = normalizeEmail(body?.email);
  if (!validEmail(email)) return { status: 400, data: { error: 'invalid_email' } };
  const role = body?.role === undefined ? 'editor' : String(body.role);
  if (!ROLES.includes(role)) return { status: 400, data: { error: 'invalid_role' } };
  // 自分自身（オーナー）は招待できない
  if (email === ownerEmailOf(env) || email === normalizeEmail(ctx.email)) {
    return { status: 409, data: { error: 'already_member' } };
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE tenant_id = ? AND email = ? AND deleted_at IS NULL`
  ).bind(ctx.tenantId, email).first();
  if (existing) return { status: 409, data: { error: 'already_member' } };

  const pending = await env.DB.prepare(
    `SELECT id FROM invitations
      WHERE tenant_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL`
  ).bind(ctx.tenantId, email).first();
  if (pending) return { status: 409, data: { error: 'already_invited' } };

  const id = ulid();
  await env.DB.prepare(
    `INSERT INTO invitations (id, tenant_id, email, role, invited_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, ctx.tenantId, email, role, ctx.userId, nowIso).run();

  return {
    status: 201,
    data: {
      invitation: {
        kind: 'invitation',
        id,
        email,
        name: '',
        role,
        status: 'pending',
        created_at: nowIso,
        is_self: false,
      },
    },
  };
}

// 招待の取り消し。行は消さず revoked_at を刻む（誰をいつ招待したかの記録を残すため）
export async function revokeInvitation(env, ctx, id, nowIso = new Date().toISOString()) {
  const res = await env.DB.prepare(
    `UPDATE invitations SET revoked_at = ?
      WHERE id = ? AND tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`
  ).bind(nowIso, id, ctx.tenantId).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { ok: true, id } };
}

async function findMember(env, ctx, id) {
  return env.DB.prepare(
    `SELECT id, email, name, role, created_at, owner_granted_at
       FROM users
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(id, ctx.tenantId).first();
}

// 権限の変更（owner / editor / viewer）。オーナー専用（可否の判定は worker.mjs 側）。
// オーナーへ引き上げるときは owner_granted_* を必ず一緒に刻む。
// session.mjs はこの列が入っている行しか owner として通さないので、
// role だけを書き換えた行（DBの直接編集など）は締め出されたままになる。
export async function patchMember(env, ctx, id, body, nowIso = new Date().toISOString()) {
  const role = String(body?.role ?? '');
  if (!ASSIGNABLE_ROLES.includes(role)) return { status: 400, data: { error: 'invalid_role' } };
  const target = await findMember(env, ctx, id);
  if (!target) return { status: 404, data: { error: 'not_found' } };
  // 主オーナー（設置者）は動かせない。自分自身も動かせない（自己降格でオーナーが消えるのを防ぐ）
  if (isPrimaryOwner(env, target.email) || target.id === ctx.userId) {
    return { status: 409, data: { error: 'owner_immutable' } };
  }

  const grantedAt = role === 'owner' ? (target.owner_granted_at ?? nowIso) : null;
  const grantedBy = role === 'owner' ? ctx.userId : null;
  await env.DB.prepare(
    `UPDATE users SET role = ?, owner_granted_by = ?, owner_granted_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(role, grantedBy, grantedAt, id, ctx.tenantId).run();
  return {
    status: 200,
    data: {
      member: {
        kind: 'member',
        id: target.id,
        email: target.email,
        name: target.name ?? '',
        role,
        status: 'active',
        created_at: target.created_at,
        is_self: false,
        is_primary_owner: false,
        owner_granted_at: grantedAt,
      },
    },
  };
}

// 除名。論理削除（deleted_at）だけを行い、その人が書いた記録は消さない。
// セッションCookieが残っていても、session.mjs の引き当てが deleted_at IS NULL なので次の一手で落ちる
export async function removeMember(env, ctx, id, nowIso = new Date().toISOString()) {
  const target = await findMember(env, ctx, id);
  if (!target) return { status: 404, data: { error: 'not_found' } };
  // 主オーナー（設置者）と自分自身は除名できない。追加オーナーは除名できる
  if (isPrimaryOwner(env, target.email) || target.id === ctx.userId) {
    return { status: 409, data: { error: 'owner_immutable' } };
  }
  await env.DB.prepare(
    `UPDATE users SET deleted_at = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(nowIso, id, ctx.tenantId).run();
  return { status: 200, data: { ok: true, id } };
}
