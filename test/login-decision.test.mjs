// ログイン可否の判定。ここが緩むと「招待していない人が入れる」か「招待した人が入れない」。
// decideLogin は純関数なのでDB抜きで4分岐を、resolveLogin は実SQLiteで受諾の副作用まで見る。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './d1-adapter.mjs';
import { decideLogin, resolveLogin, ensureUser } from '../src/session.mjs';

const OWNER = 'owner@example.com';
const NOW_ISO = '2026-07-01T00:00:00.000Z';
const TENANT = 'T0000000000000000000000000';

// ---- 純関数（4分岐＋sub不一致） --------------------------------------
test('①OWNER_EMAIL本人は bootstrap（初回はテナントごと作る）', () => {
  const d = decideLogin({ ownerEmail: OWNER, email: OWNER, sub: 'sub-owner' });
  assert.equal(d.action, 'bootstrap');
  // 大小文字・前後空白は無視して照合する
  assert.equal(decideLogin({ ownerEmail: '  Owner@Example.COM ', email: OWNER, sub: 's' }).action, 'bootstrap');
});

test('②既存メンバー（users行あり）は login', () => {
  const user = { id: 'sub-a', tenant_id: TENANT, email: 'a@example.com', role: 'editor' };
  const d = decideLogin({ ownerEmail: OWNER, email: 'a@example.com', sub: 'sub-a', user });
  assert.equal(d.action, 'login');
  assert.equal(d.user, user);
});

test('③招待済み（users行なし・pending招待あり）は accept', () => {
  const invitation = { id: 'INV1', tenant_id: TENANT, email: 'b@example.com', role: 'viewer' };
  const d = decideLogin({ ownerEmail: OWNER, email: 'b@example.com', sub: 'sub-b', invitation });
  assert.equal(d.action, 'accept');
  assert.equal(d.invitation.role, 'viewer');
});

test('④どれでもない人は deny', () => {
  const d = decideLogin({ ownerEmail: OWNER, email: 'stranger@example.com', sub: 'sub-x' });
  assert.equal(d.action, 'deny');
  assert.equal(d.reason, 'not_invited');
  // メールもsubも無い（IDトークンが壊れている）ときも通さない
  assert.equal(decideLogin({ ownerEmail: OWNER, email: '', sub: '' }).action, 'deny');
});

test('メールは一致するがGoogleのsubが違うなら403（同アドレスの別アカウント）', () => {
  const user = { id: 'sub-a', tenant_id: TENANT, email: 'a@example.com', role: 'editor' };
  const d = decideLogin({ ownerEmail: OWNER, email: 'a@example.com', sub: 'sub-IMPOSTOR', user });
  assert.equal(d.action, 'forbidden');
  assert.equal(d.status, 403);
  assert.equal(d.reason, 'sub_mismatch');
});

test('オーナーはsubが変わっても締め出さない（OWNER_EMAILは設置者が握る値）', () => {
  const user = { id: 'old-sub', tenant_id: TENANT, email: OWNER, role: 'owner' };
  assert.equal(decideLogin({ ownerEmail: OWNER, email: OWNER, sub: 'new-sub', user }).action, 'bootstrap');
});

// ---- DBを繋いだ実挙動 -------------------------------------------------
function makeEnv() {
  return { DB: createTestDb(), OWNER_EMAIL: OWNER };
}

async function bootstrapOwner(env) {
  return ensureUser(env, { sub: 'sub-owner', email: OWNER, name: '所有者' }, NOW_ISO);
}

function invite(env, tenantId, email, role = 'editor') {
  env.DB.__raw.prepare(
    `INSERT INTO invitations (id, tenant_id, email, role, invited_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`INV-${email}`, tenantId, email, role, 'sub-owner', NOW_ISO);
}

test('resolveLogin: オーナーの初回ログインでテナントとユーザーができる', async () => {
  const env = makeEnv();
  const r = await resolveLogin(env, { sub: 'sub-owner', email: 'Owner@Example.com', name: '所有者' }, NOW_ISO);
  assert.equal(r.ok, true);
  assert.equal(r.user.role, 'owner');
  assert.equal(r.user.email, OWNER, 'メールは小文字に正規化して保存する');
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM tenants').get().n, 1);
});

test('resolveLogin: 招待済みアドレスの初回ログインで受諾（users作成＋accepted_at記録）', async () => {
  const env = makeEnv();
  const owner = await bootstrapOwner(env);
  invite(env, owner.tenant_id, 'member@example.com', 'viewer');

  const r = await resolveLogin(env, { sub: 'sub-m', email: 'Member@Example.com', name: '院生' }, NOW_ISO);
  assert.equal(r.ok, true);
  assert.equal(r.user.id, 'sub-m');
  assert.equal(r.user.role, 'viewer', '招待のロールがそのまま付く');
  assert.equal(r.user.tenant_id, owner.tenant_id, 'オーナーのテナントに入る');

  const row = env.DB.__raw.prepare('SELECT accepted_at FROM invitations WHERE email = ?')
    .get('member@example.com');
  assert.equal(row.accepted_at, NOW_ISO);

  // 2回目のログインは既存メンバーとして通る（招待は増えない・users行も増えない）
  const again = await resolveLogin(env, { sub: 'sub-m', email: 'member@example.com' }, '2026-08-01T00:00:00.000Z');
  assert.equal(again.ok, true);
  assert.equal(again.user.role, 'viewer');
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
});

test('resolveLogin: 取り消し済み・受諾済みの招待では入れない', async () => {
  const env = makeEnv();
  const owner = await bootstrapOwner(env);
  env.DB.__raw.prepare(
    `INSERT INTO invitations (id, tenant_id, email, role, invited_by, created_at, revoked_at)
     VALUES (?, ?, ?, 'editor', 'sub-owner', ?, ?)`
  ).run('INV-R', owner.tenant_id, 'revoked@example.com', NOW_ISO, NOW_ISO);

  const r = await resolveLogin(env, { sub: 'sub-r', email: 'revoked@example.com' }, NOW_ISO);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(r.reason, 'not_invited');
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});

test('resolveLogin: 招待も無い人は入れない', async () => {
  const env = makeEnv();
  await bootstrapOwner(env);
  const r = await resolveLogin(env, { sub: 'sub-x', email: 'stranger@example.com' }, NOW_ISO);
  assert.deepEqual(r, { ok: false, status: 401, reason: 'not_invited' });
});

test('resolveLogin: 除名された人は招待し直せば戻れる（伏せた行を起こす）', async () => {
  const env = makeEnv();
  const owner = await bootstrapOwner(env);
  env.DB.__raw.prepare(
    `INSERT INTO users (id, tenant_id, email, name, role, created_at, deleted_at)
     VALUES (?, ?, ?, '', 'editor', ?, ?)`
  ).run('sub-gone', owner.tenant_id, 'gone@example.com', NOW_ISO, NOW_ISO);

  // 除名されたままでは入れない
  const denied = await resolveLogin(env, { sub: 'sub-gone', email: 'gone@example.com' }, NOW_ISO);
  assert.equal(denied.ok, false);

  invite(env, owner.tenant_id, 'gone@example.com', 'viewer');
  const again = await resolveLogin(env, { sub: 'sub-gone', email: 'gone@example.com', name: '出戻り' }, NOW_ISO);
  assert.equal(again.ok, true);
  assert.equal(again.user.role, 'viewer', '招待し直したロールになる');
  // users.email はUNIQUEなので、行は増えず起き上がるだけ
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  const row = env.DB.__raw.prepare('SELECT role, deleted_at FROM users WHERE email = ?').get('gone@example.com');
  assert.equal(row.deleted_at, null);
  assert.equal(row.role, 'viewer');
});

test('resolveLogin: sub不一致は403で断る（メールだけ知っている別アカウント）', async () => {
  const env = makeEnv();
  const owner = await bootstrapOwner(env);
  invite(env, owner.tenant_id, 'member@example.com');
  await resolveLogin(env, { sub: 'sub-m', email: 'member@example.com' }, NOW_ISO);

  const r = await resolveLogin(env, { sub: 'sub-OTHER', email: 'member@example.com' }, NOW_ISO);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.reason, 'sub_mismatch');
});

// ---- デモモード（DEMO_MODE="1" の公開デモ機だけ） --------------------
test('demoMode=false のままなら、招待されていない人は今までどおり deny', () => {
  const d = decideLogin({ ownerEmail: OWNER, email: 'stranger@example.com', sub: 'sub-x', demoMode: false });
  assert.equal(d.action, 'deny');
  assert.equal(d.reason, 'not_invited');
  // 既定値（引数を渡さない）でも deny のまま
  assert.equal(decideLogin({ ownerEmail: OWNER, email: 'stranger@example.com', sub: 'sub-x' }).action, 'deny');
});

test('demoMode=true なら、招待されていない人は demo', () => {
  const d = decideLogin({ ownerEmail: OWNER, email: 'stranger@example.com', sub: 'sub-x', demoMode: true });
  assert.equal(d.action, 'demo');
});

test('demoMode でも身元の無いIDトークンは通さない', () => {
  assert.equal(decideLogin({ ownerEmail: OWNER, email: '', sub: '', demoMode: true }).action, 'deny');
  assert.equal(decideLogin({ ownerEmail: OWNER, email: 'a@example.com', sub: '', demoMode: true }).action, 'deny');
});

test('demoMode でもオーナー・既存メンバー・招待者の判定が勝つ', () => {
  assert.equal(
    decideLogin({ ownerEmail: OWNER, email: OWNER, sub: 's', demoMode: true }).action, 'bootstrap'
  );
  const user = { id: 'sub-a', tenant_id: TENANT, email: 'a@example.com', role: 'editor' };
  assert.equal(
    decideLogin({ ownerEmail: OWNER, email: 'a@example.com', sub: 'sub-a', user, demoMode: true }).action,
    'login'
  );
  const invitation = { id: 'INV1', tenant_id: TENANT, email: 'b@example.com', role: 'viewer' };
  assert.equal(
    decideLogin({ ownerEmail: OWNER, email: 'b@example.com', sub: 'sub-b', invitation, demoMode: true }).action,
    'accept'
  );
  // 成りすまし（sub不一致）は demoMode でも403のまま
  assert.equal(
    decideLogin({ ownerEmail: OWNER, email: 'a@example.com', sub: 'sub-IMPOSTOR', user, demoMode: true }).action,
    'forbidden'
  );
});

test('resolveLogin: demoはusersにもtenantsにも1行も作らない', async () => {
  const env = makeEnv();
  await bootstrapOwner(env);
  const before = env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  const r = await resolveLogin(env, { sub: 'sub-demo', email: 'Guest@Example.com', name: '見学者' },
    NOW_ISO, { demoMode: true });
  assert.equal(r.ok, true);
  assert.equal(r.user, undefined, 'デモはuserを返さない（users行が無い）');
  assert.deepEqual({ ...r.session }, { email: 'guest@example.com', demo: true });

  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM users').get().n, before,
    'デモログインでusers行が増えている');
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM invitations').get().n, 0);
});

test('resolveLogin: demoMode を渡さなければ従来どおり401（既定はオフ）', async () => {
  const env = makeEnv();
  await bootstrapOwner(env);
  const r = await resolveLogin(env, { sub: 'sub-demo', email: 'guest@example.com' }, NOW_ISO);
  assert.deepEqual(r, { ok: false, status: 401, reason: 'not_invited' });
});
