// セッションCookie → 利用者コンテキスト（ctx）の組み立てと、ログイン可否の判定。
// /api/* は全てここを通り、ctx = {userId, tenantId, role, email, name} を受け取る。
// 以降のSQLは必ず ctx.tenantId で絞る（tenant_id = ? を書き忘れないこと）。
//
// テナントは1つ（オーナーのテナント）だけ。メンバーは招待制で、
// users への行作成は必ず「招待の受諾＝招待済みアドレスでの初回ログイン」を経由する。
import { parseCookies, verifySession, SESSION_COOKIE } from './auth.mjs';
import { ulid } from './ulid.mjs';

// 認証済みユーザーを1人ぶん引く。
// users は「テナントの入口」なので、この1本だけは tenant_id で絞れない（絞る材料がまだ無い）。
// ここで得た tenant_id を、以降の全SQLの必須条件として使う。
async function findUserByEmail(env, email) {
  return env.DB.prepare(
    `SELECT id, tenant_id, email, name, role, owner_granted_at
       FROM users
      WHERE email = ? AND deleted_at IS NULL`
  ).bind(email).first();
}

// 招待の引き当ても「テナントの入口」。ログインしようとしている人のメールしか手がかりが無いので、
// ここも tenant_id では絞れない（絞れる材料はこの行の中にある）。入口はこのファイルの2本だけ。
async function findPendingInvitation(env, email) {
  return env.DB.prepare(
    `SELECT id, tenant_id, email, role
       FROM invitations
      WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at DESC`
  ).bind(email).first();
}

// ログイン成功時の初回セットアップ。テナント1行＋ユーザー1行を同時に作る。
// 2回目以降は既存行をそのまま返す（この道を通れるのはオーナーだけ）。
export async function ensureUser(env, { sub, email, name = '' }, nowIso) {
  const existing = await findUserByEmail(env, email);
  if (existing) return existing;
  const tenantId = ulid();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
      .bind(tenantId, name || email, nowIso),
    env.DB.prepare(
      `INSERT INTO users (id, tenant_id, email, name, role, created_at)
       VALUES (?, ?, ?, ?, 'owner', ?)`
    ).bind(sub, tenantId, email, name, nowIso),
  ]);
  return { id: sub, tenant_id: tenantId, email, name, role: 'owner' };
}

// ---- ログイン可否の判定（純関数） -------------------------------------
// DBを引いた結果（user / invitation）を受け取って、何をすべきかだけを決める。
// HTTPもDBも触らないので、そのまま単体テストできる（test/login-decision.test.mjs）。
//   bootstrap … OWNER_EMAIL本人。users/tenantsが無ければ作ってログイン
//   login     … 既にメンバー。そのままログイン
//   accept    … 招待を受諾してメンバーになり、ログイン
//   forbidden … メールは一致するがGoogleのsubが違う（別アカウントでの成りすまし）→ 403
//   demo      … 招待されていないが DEMO_MODE="1"（公開デモ）→ 閲覧専用で通す
//   deny      … 招待されていない → ?login=denied
export function decideLogin({
  ownerEmail, email, sub, user = null, invitation = null, demoMode = false,
}) {
  const owner = String(ownerEmail ?? '').trim().toLowerCase();
  const addr = String(email ?? '').trim().toLowerCase();
  const subject = String(sub ?? '');
  if (!addr || !subject) return { action: 'deny', reason: 'no_identity' };

  // ①オーナー本人は従来どおり無条件で通す（OWNER_EMAILは設置者が握っている値なので、
  //   Googleアカウントを作り直しても締め出されないようにする）
  if (owner && addr === owner) return { action: 'bootstrap' };
  // ②メールが一致する行が既にあるのに users.id（＝Googleのsub）が違う。
  //   「同じアドレスの別Googleアカウント」なので、黙って乗り換えさせない
  if (user && user.id !== subject) {
    return { action: 'forbidden', status: 403, reason: 'sub_mismatch' };
  }
  if (user) return { action: 'login', user };
  if (invitation) return { action: 'accept', invitation };
  // ③デモモード（公開デモ機だけで "1" にする）。招待の無い人を閲覧専用として通す。
  //   オーナー・既存メンバー・招待済みの判定より必ず後ろに置くこと
  //   （デモ機であってもオーナーはオーナーとして入れる）
  if (demoMode) return { action: 'demo' };
  return { action: 'deny', reason: 'not_invited' };
}

// 招待の受諾。users行を作り、招待に受諾時刻を刻む（招待行は履歴として残す）。
// 一度除名された人を招待し直した場合は、伏せてある行を起こす
// （users.email はUNIQUEなので、作り直しはできない）。
// このとき users.id を新しいsubへ差し替える。別のGoogleアカウントで戻ってきた場合、
// 以前に書いた記録の作成者idは古いsubのまま残る（記録そのものは消さないので、履歴は追える）。
async function acceptInvitation(env, invitation, { sub, email, name }, nowIso) {
  const buried = await env.DB.prepare(
    'SELECT id FROM users WHERE email = ? AND tenant_id = ?'
  ).bind(email, invitation.tenant_id).first();

  await env.DB.batch([
    buried
      // 戻ってきた人の権限は招待の内容で上書きする。
      // 昇格の記録（owner_granted_*）も一緒に落とす。以前オーナーだった人が
      // editorとして招待し直されたのに昇格の痕跡だけ残る、という食い違いを作らない
      ? env.DB.prepare(
        `UPDATE users SET id = ?, name = ?, role = ?, deleted_at = NULL,
                          owner_granted_by = NULL, owner_granted_at = NULL
          WHERE email = ? AND tenant_id = ?`
      ).bind(sub, name, invitation.role, email, invitation.tenant_id)
      : env.DB.prepare(
        `INSERT INTO users (id, tenant_id, email, name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(sub, invitation.tenant_id, email, name, invitation.role, nowIso),
    env.DB.prepare(
      `UPDATE invitations SET accepted_at = ?
        WHERE id = ? AND tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`
    ).bind(nowIso, invitation.id, invitation.tenant_id),
  ]);
  return {
    id: sub, tenant_id: invitation.tenant_id, email, name, role: invitation.role,
  };
}

// /auth/callback から呼ぶ入口。DBを引いて decideLogin に判断させ、必要な書き込みまで済ませる。
// 成功は {ok:true, user}（デモは {ok:true, session}）、失敗は {ok:false, status, reason}
export async function resolveLogin(env, { sub, email, name = '' }, nowIso, { demoMode = false } = {}) {
  const addr = String(email ?? '').trim().toLowerCase();
  const user = await findUserByEmail(env, addr);
  const invitation = user ? null : await findPendingInvitation(env, addr);
  const decision = decideLogin({
    ownerEmail: env.OWNER_EMAIL, email: addr, sub, user, invitation, demoMode,
  });

  switch (decision.action) {
    case 'bootstrap':
      return { ok: true, user: await ensureUser(env, { sub, email: addr, name }, nowIso) };
    case 'login':
      return { ok: true, user: decision.user };
    case 'accept':
      return {
        ok: true,
        user: await acceptInvitation(env, decision.invitation, { sub, email: addr, name }, nowIso),
      };
    // デモは users にも tenants にも一切書かない（DBが汚れない・メンバー一覧に出ない）。
    // 身元はCookieの中だけに持ち、ロールは loadContext が viewer 固定で与える
    case 'demo':
      return { ok: true, session: { email: addr, demo: true } };
    case 'forbidden':
      return { ok: false, status: 403, reason: decision.reason };
    default:
      return { ok: false, status: 401, reason: decision.reason };
  }
}

// リクエストからctxを作る。失敗は {ok:false, status, error} で返し、呼び出し側がJSONにする。
export async function loadContext(request, env, nowMs = Date.now()) {
  const cookie = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  const claims = await verifySession(cookie, nowMs, env.SESSION_SECRET);
  if (!claims) return { ok: false, status: 401, error: 'unauthorized' };

  const email = String(claims.email).toLowerCase();
  // OWNER_EMAIL未設定は設定不備。誰も通さない（オーナー不在のテナントを作らせない）
  const owner = String(env.OWNER_EMAIL ?? '').trim().toLowerCase();
  if (!owner) return { ok: false, status: 403, error: 'forbidden' };

  // ---- デモセッション（公開デモ機だけ） ----
  // users行を持たないので、テナントはオーナーの行から引く。ロールは viewer 固定＝
  // worker.mjs の一括ガードがGET以外を403で断る。
  // DEMO_MODE を "1" 以外に戻した瞬間、発行済みのデモCookieはここで全部失効する
  if (claims.demo === true) {
    if (env.DEMO_MODE !== '1') return { ok: false, status: 401, error: 'unauthorized' };
    const row = await env.DB.prepare(
      `SELECT tenant_id FROM users
        WHERE email = ? AND role = 'owner' AND deleted_at IS NULL`
    ).bind(owner).first();
    if (!row) return { ok: false, status: 401, error: 'unauthorized' };
    return {
      ok: true,
      ctx: {
        userId: 'demo', tenantId: row.tenant_id, email, name: '', role: 'viewer', demo: true,
      },
    };
  }

  // 誰がログインできるかは users テーブルが正本（招待の受諾でしか行は増えない）。
  // 除名（deleted_at）された人は、Cookieが残っていてもここで落ちる
  const user = await findUserByEmail(env, email);
  if (!user) return { ok: false, status: 401, error: 'unauthorized' };
  // オーナーとして通れるのは2種類だけ。
  //   ①主オーナー … vars.OWNER_EMAIL 本人（後からOWNER_EMAILを変えたら旧オーナーは即座に締め出される）
  //   ②追加オーナー … オーナーが昇格させた人。昇格の事実は owner_granted_at に刻んである
  // DBを直接触って users.role だけを 'owner' に書き換えても、②の条件は満たせない
  if (user.role === 'owner' && email !== owner && !user.owner_granted_at) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  return {
    ok: true,
    ctx: {
      userId: user.id,
      tenantId: user.tenant_id,
      email: user.email,
      name: user.name ?? '',
      role: user.role,
    },
  };
}
