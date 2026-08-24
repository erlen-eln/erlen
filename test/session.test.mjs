// セッション→ctx の組み立て。ここが緩むと「ログインできる他人」が生まれる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './d1-adapter.mjs';
import { ensureUser, loadContext } from '../src/session.mjs';
import { signSession, SESSION_COOKIE, SESSION_TTL_MS } from '../src/auth.mjs';

const SECRET = 's'.repeat(48);
const NOW = Date.parse('2026-07-01T00:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();

function makeEnv(overrides = {}) {
  return {
    DB: createTestDb(),
    OWNER_EMAIL: 'owner@example.com',
    SESSION_SECRET: SECRET,
    ...overrides,
  };
}

async function request(env, { email = 'owner@example.com', expMs = NOW + SESSION_TTL_MS } = {}) {
  const value = await signSession({ email, expMs }, env.SESSION_SECRET);
  return new Request('https://erlen.example/api/me', {
    headers: { cookie: `${SESSION_COOKIE}=${value}` },
  });
}

test('初回ログインでテナント1行＋ユーザー1行が自動でできる', async () => {
  const env = makeEnv();
  const user = await ensureUser(env, { sub: 'sub-1', email: 'owner@example.com', name: '所有者' }, NOW_ISO);
  assert.equal(user.id, 'sub-1');
  assert.equal(user.role, 'owner');
  assert.match(user.tenant_id, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'tenant_idはULID');

  const tenants = env.DB.__raw.prepare('SELECT id, name, created_at FROM tenants').all();
  assert.equal(tenants.length, 1);
  assert.equal(tenants[0].id, user.tenant_id);
  assert.equal(tenants[0].created_at, NOW_ISO);
  // node:sqliteの行はnullプロトタイプなので、素のオブジェクトへ写してから比べる
  const users = env.DB.__raw.prepare('SELECT id, email, role FROM users').all().map((r) => ({ ...r }));
  assert.deepEqual(users, [{ id: 'sub-1', email: 'owner@example.com', role: 'owner' }]);
});

test('2回目以降は作り直さず既存を返す', async () => {
  const env = makeEnv();
  const first = await ensureUser(env, { sub: 'sub-1', email: 'owner@example.com' }, NOW_ISO);
  const second = await ensureUser(env, { sub: 'sub-1', email: 'owner@example.com' }, '2026-08-01T00:00:00.000Z');
  assert.equal(second.tenant_id, first.tenant_id);
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM tenants').get().n, 1);
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});

test('正しいCookieならctxが組み上がる', async () => {
  const env = makeEnv();
  await ensureUser(env, { sub: 'sub-1', email: 'owner@example.com', name: '所有者' }, NOW_ISO);
  const r = await loadContext(await request(env), env, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ctx.userId, 'sub-1');
  assert.equal(r.ctx.email, 'owner@example.com');
  assert.equal(r.ctx.role, 'owner');
  assert.match(r.ctx.tenantId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('Cookieなし・期限切れ・別secretは401', async () => {
  const env = makeEnv();
  await ensureUser(env, { sub: 'sub-1', email: 'owner@example.com' }, NOW_ISO);
  const bare = new Request('https://erlen.example/api/me');
  assert.deepEqual(await loadContext(bare, env, NOW), { ok: false, status: 401, error: 'unauthorized' });

  const expired = await request(env, { expMs: NOW - 1 });
  assert.equal((await loadContext(expired, env, NOW)).status, 401);

  const forged = await signSession({ email: 'owner@example.com', expMs: NOW + 1000 }, 'o'.repeat(48));
  const req = new Request('https://erlen.example/api/me', {
    headers: { cookie: `${SESSION_COOKIE}=${forged}` },
  });
  assert.equal((await loadContext(req, env, NOW)).status, 401);
});

test('OWNER_EMAIL以外は、Cookieが有効でも403（後からvarsを変えたら即締め出す）', async () => {
  const env = makeEnv();
  await ensureUser(env, { sub: 'sub-1', email: 'owner@example.com' }, NOW_ISO);
  const req = await request(env);
  env.OWNER_EMAIL = 'someone-else@example.com';
  assert.deepEqual(await loadContext(req, env, NOW), { ok: false, status: 403, error: 'forbidden' });

  env.OWNER_EMAIL = '';
  assert.equal((await loadContext(req, env, NOW)).status, 403, 'OWNER_EMAIL未設定なら誰も入れない');
});

test('OWNER_EMAILの大小文字・前後空白は無視して照合する', async () => {
  const env = makeEnv({ OWNER_EMAIL: '  Owner@Example.com  ' });
  await ensureUser(env, { sub: 'sub-1', email: 'owner@example.com' }, NOW_ISO);
  assert.equal((await loadContext(await request(env), env, NOW)).ok, true);
});

test('昇格された追加オーナーは通るが、role列を書き換えただけの行は403', async () => {
  const env = makeEnv();
  const owner = await ensureUser(env, { sub: 'sub-1', email: 'owner@example.com' }, NOW_ISO);
  const put = (role, grantedAt) => env.DB.__raw.prepare(
    `INSERT INTO users (id, tenant_id, email, name, role, created_at, owner_granted_by, owner_granted_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?)`
  ).run('sub-2', owner.tenant_id, 'second@example.com', role, NOW_ISO, 'sub-1', grantedAt);

  // 昇格の記録が無いのに role だけ 'owner'（DBを直接いじった形）は締め出す
  put('owner', null);
  const req = await request(env, { email: 'second@example.com' });
  assert.deepEqual(await loadContext(req, env, NOW), { ok: false, status: 403, error: 'forbidden' });

  // 正規に昇格された行なら、OWNER_EMAILと違っても owner として通る
  env.DB.__raw.prepare('UPDATE users SET owner_granted_at = ? WHERE id = ?').run(NOW_ISO, 'sub-2');
  const ok = await loadContext(req, env, NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.ctx.role, 'owner');
  assert.equal(ok.ctx.email, 'second@example.com');
});

test('users行がまだ無い（DB初期化前）なら401', async () => {
  const env = makeEnv();
  assert.equal((await loadContext(await request(env), env, NOW)).status, 401);
});

// ---- デモセッション（公開デモ機のDEMO_MODE="1"だけ） ------------------
// users行を持たない閲覧者。テナントはオーナーの行から引き、ロールは viewer 固定。
async function demoRequest(env, email = 'guest@example.com') {
  const value = await signSession(
    { email, expMs: NOW + SESSION_TTL_MS, demo: true }, env.SESSION_SECRET
  );
  return new Request('https://erlen.example/api/me', {
    headers: { cookie: `${SESSION_COOKIE}=${value}` },
  });
}

test('DEMO_MODE="1" のデモセッションは viewer のctxになる（テナントはオーナーのもの）', async () => {
  const env = makeEnv({ DEMO_MODE: '1' });
  const owner = await ensureUser(env, { sub: 'sub-1', email: 'owner@example.com' }, NOW_ISO);
  const r = await loadContext(await demoRequest(env), env, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ctx.userId, 'demo');
  assert.equal(r.ctx.role, 'viewer');
  assert.equal(r.ctx.demo, true);
  assert.equal(r.ctx.name, '');
  assert.equal(r.ctx.email, 'guest@example.com');
  assert.equal(r.ctx.tenantId, owner.tenant_id, 'オーナーのテナントを見る');
  // users行は1件のまま（デモは行を作らない）
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});

test('DEMO_MODE が "1" でなければ、発行済みのデモCookieは即座に401', async () => {
  const env = makeEnv({ DEMO_MODE: '1' });
  await ensureUser(env, { sub: 'sub-1', email: 'owner@example.com' }, NOW_ISO);
  const req = await demoRequest(env);
  assert.equal((await loadContext(req, env, NOW)).ok, true);

  for (const value of ['0', '', 'true', undefined]) {
    env.DEMO_MODE = value;
    assert.deepEqual(await loadContext(req, env, NOW),
      { ok: false, status: 401, error: 'unauthorized' }, `DEMO_MODE=${value}`);
  }
});

test('デモセッションでも、オーナー行が無ければ401（テナントを引けない）', async () => {
  const env = makeEnv({ DEMO_MODE: '1' });
  assert.equal((await loadContext(await demoRequest(env), env, NOW)).status, 401);
});

test('デモの印はCookieの署名の中にある（後から付け足せない）', async () => {
  const env = makeEnv({ DEMO_MODE: '1' });
  await ensureUser(env, { sub: 'sub-1', email: 'owner@example.com' }, NOW_ISO);
  // 素のセッション（demo無し）は、招待されていないので users を引いて401
  const plain = await request(env, { email: 'guest@example.com' });
  assert.equal((await loadContext(plain, env, NOW)).status, 401);
});
