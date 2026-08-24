// メンバー管理API（招待・権限変更・除名）。
// 誤って自分を消す・オーナーを降格する・二重に招待する、を全部止められていること。
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMember, createTestEnv, sqlMissingTenantScope } from './d1-adapter.mjs';
import {
  createInvitation, listMembers, patchMember, removeMember, revokeInvitation, normalizeEmail,
} from '../src/api/members.mjs';
import { loadContext } from '../src/session.mjs';
import { signSession, SESSION_COOKIE, SESSION_TTL_MS } from '../src/auth.mjs';

const NOW = '2026-07-05T00:00:00.000Z';

test('メールの正規化は小文字＋trim', () => {
  assert.equal(normalizeEmail('  Member@Example.COM '), 'member@example.com');
  assert.equal(normalizeEmail(undefined), '');
});

test('一覧は参加済みメンバーと未受諾の招待をまとめて返す', async () => {
  const { env, ctx } = createTestEnv();
  addMember(env, { id: 'sub-e', email: 'editor@example.com', name: '助教', role: 'editor' });
  await createInvitation(env, ctx, { email: 'new@example.com', role: 'viewer' }, NOW);

  const r = await listMembers(env, ctx);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.members.map((m) => [m.kind, m.email, m.role, m.status]), [
    ['member', 'owner@example.com', 'owner', 'active'],
    ['member', 'editor@example.com', 'editor', 'active'],
    ['invitation', 'new@example.com', 'viewer', 'pending'],
  ]);
  // 自分の行には印が付く（画面が「あなた」と出し、除名ボタンを出さないため）
  assert.deepEqual(r.data.members.map((m) => m.is_self), [true, false, false]);
});

test('一覧はよそのテナントのメンバーを混ぜない', async () => {
  const { env, ctx, otherCtx } = createTestEnv();
  addMember(env, {
    id: 'sub-yoso', email: 'yoso@example.com', role: 'editor', tenantId: otherCtx.tenantId,
  });
  const r = await listMembers(env, ctx);
  assert.deepEqual(r.data.members.map((m) => m.email), ['owner@example.com']);
  assert.deepEqual(sqlMissingTenantScope(env.DB.__sql), []);
});

test('招待の作成: 既定はeditor・小文字に正規化される', async () => {
  const { env, ctx } = createTestEnv();
  const r = await createInvitation(env, ctx, { email: '  Member@Example.com ' }, NOW);
  assert.equal(r.status, 201);
  assert.equal(r.data.invitation.email, 'member@example.com');
  assert.equal(r.data.invitation.role, 'editor');
  assert.match(r.data.invitation.id, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'idはULID');

  const row = env.DB.__raw.prepare('SELECT tenant_id, invited_by, accepted_at FROM invitations').get();
  assert.equal(row.tenant_id, ctx.tenantId);
  assert.equal(row.invited_by, ctx.userId);
  assert.equal(row.accepted_at, null);
});

test('招待の作成: 形の壊れたメール・知らないロールは400', async () => {
  const { env, ctx } = createTestEnv();
  assert.equal((await createInvitation(env, ctx, { email: 'not-an-email' }, NOW)).status, 400);
  assert.equal((await createInvitation(env, ctx, { email: '' }, NOW)).status, 400);
  const bad = await createInvitation(env, ctx, { email: 'a@example.com', role: 'owner' }, NOW);
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'invalid_role');
});

test('招待の作成: 自分自身・既存メンバー・二重招待は409', async () => {
  const { env, ctx } = createTestEnv();
  const self = await createInvitation(env, ctx, { email: 'OWNER@example.com' }, NOW);
  assert.equal(self.status, 409);
  assert.equal(self.data.error, 'already_member');

  addMember(env, { id: 'sub-e', email: 'editor@example.com', role: 'editor' });
  assert.equal((await createInvitation(env, ctx, { email: 'editor@example.com' }, NOW)).status, 409);

  assert.equal((await createInvitation(env, ctx, { email: 'new@example.com' }, NOW)).status, 201);
  const twice = await createInvitation(env, ctx, { email: 'new@example.com' }, NOW);
  assert.equal(twice.status, 409);
  assert.equal(twice.data.error, 'already_invited');
});

test('部分UNIQUEインデックス: 取り消し後は同じアドレスを招待し直せる', async () => {
  const { env, ctx } = createTestEnv();
  const first = await createInvitation(env, ctx, { email: 'new@example.com' }, NOW);
  assert.equal((await revokeInvitation(env, ctx, first.data.invitation.id, NOW)).status, 200);

  const again = await createInvitation(env, ctx, { email: 'new@example.com', role: 'viewer' }, NOW);
  assert.equal(again.status, 201, '取り消し済みは部分UNIQUEの対象外');
  // 台帳としては2行（取り消し1・pending1）残り、一覧に出るのはpendingだけ
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM invitations').get().n, 2);
  const list = await listMembers(env, ctx);
  assert.equal(list.data.members.filter((m) => m.kind === 'invitation').length, 1);
});

test('部分UNIQUEインデックスはDBの側でも二重pendingを止める', async () => {
  const { env, ctx } = createTestEnv();
  await createInvitation(env, ctx, { email: 'new@example.com' }, NOW);
  // アプリの409をすり抜けて直接INSERTしても、インデックスが弾く
  assert.throws(() => {
    env.DB.__raw.prepare(
      `INSERT INTO invitations (id, tenant_id, email, role, invited_by, created_at)
       VALUES (?, ?, ?, 'editor', ?, ?)`
    ).run('DUP', ctx.tenantId, 'new@example.com', ctx.userId, NOW);
  }, /UNIQUE/);
});

test('招待の取り消し: 無い招待・よそのテナントの招待は404', async () => {
  const { env, ctx, otherCtx } = createTestEnv();
  const made = await createInvitation(env, ctx, { email: 'new@example.com' }, NOW);
  assert.equal((await revokeInvitation(env, otherCtx, made.data.invitation.id, NOW)).status, 404);
  assert.equal((await revokeInvitation(env, ctx, 'NOPE', NOW)).status, 404);

  assert.equal((await revokeInvitation(env, ctx, made.data.invitation.id, NOW)).status, 200);
  assert.equal((await revokeInvitation(env, ctx, made.data.invitation.id, NOW)).status, 404, '2回目は無い');
});

test('ロール変更: editor⇄viewer は通り、主オーナーと自分自身は409', async () => {
  const { env, ctx } = createTestEnv();
  addMember(env, { id: 'sub-e', email: 'editor@example.com', role: 'editor' });

  const r = await patchMember(env, ctx, 'sub-e', { role: 'viewer' });
  assert.equal(r.status, 200);
  assert.equal(r.data.member.role, 'viewer');
  assert.equal(env.DB.__raw.prepare('SELECT role FROM users WHERE id = ?').get('sub-e').role, 'viewer');

  const self = await patchMember(env, ctx, ctx.userId, { role: 'viewer' });
  assert.equal(self.status, 409);
  assert.equal(self.data.error, 'owner_immutable');
  assert.equal((await patchMember(env, ctx, 'sub-e', { role: 'boss' })).status, 400, '知らないロール');
  assert.equal((await patchMember(env, ctx, 'NOPE', { role: 'viewer' })).status, 404);
});

test('オーナーへの昇格: owner_granted_* が刻まれ、降格すると消える', async () => {
  const { env, ctx } = createTestEnv();
  addMember(env, { id: 'sub-e', email: 'editor@example.com', role: 'editor' });

  const up = await patchMember(env, ctx, 'sub-e', { role: 'owner' }, NOW);
  assert.equal(up.status, 200);
  assert.equal(up.data.member.role, 'owner');
  const granted = env.DB.__raw
    .prepare('SELECT role, owner_granted_by, owner_granted_at FROM users WHERE id = ?').get('sub-e');
  assert.equal(granted.role, 'owner');
  assert.equal(granted.owner_granted_by, ctx.userId);
  assert.equal(granted.owner_granted_at, NOW);

  // 昇格した人は loadContext でも owner として通る（session.mjs の締め出しに引っかからない）
  const cookie = `${SESSION_COOKIE}=${await signSession(
    { email: 'editor@example.com', expMs: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET
  )}`;
  const request = new Request('https://erlen.example/api/me', { headers: { cookie } });
  const sess = await loadContext(request, env);
  assert.equal(sess.ok, true);
  assert.equal(sess.ctx.role, 'owner');

  // 降格すると昇格の記録も消える（roleとgrantedが食い違った行を残さない）
  const down = await patchMember(env, ctx, 'sub-e', { role: 'editor' }, NOW);
  assert.equal(down.status, 200);
  const after = env.DB.__raw
    .prepare('SELECT role, owner_granted_by, owner_granted_at FROM users WHERE id = ?').get('sub-e');
  assert.equal(after.role, 'editor');
  assert.equal(after.owner_granted_by, null);
  assert.equal(after.owner_granted_at, null);
});

test('追加オーナーは降格も除名もできるが、主オーナーはどちらもできない', async () => {
  const { env, ctx } = createTestEnv();
  addMember(env, { id: 'sub-e', email: 'editor@example.com', role: 'editor' });
  await patchMember(env, ctx, 'sub-e', { role: 'owner' }, NOW);

  // 追加オーナーが、主オーナーを降格・除名しようとしても通らない
  const second = {
    userId: 'sub-e', tenantId: ctx.tenantId, email: 'editor@example.com', name: '', role: 'owner',
  };
  assert.equal((await patchMember(env, second, ctx.userId, { role: 'viewer' })).status, 409);
  assert.equal((await removeMember(env, second, ctx.userId, NOW)).status, 409);

  // 主オーナーからは、追加オーナーを除名できる
  assert.equal((await removeMember(env, ctx, 'sub-e', NOW)).status, 200);
  assert.deepEqual((await listMembers(env, ctx)).data.members.map((m) => m.email), ['owner@example.com']);
});

test('一覧は主オーナーの行に印を付ける（画面が操作を隠すため）', async () => {
  const { env, ctx } = createTestEnv();
  addMember(env, { id: 'sub-e', email: 'editor@example.com', role: 'editor' });
  await patchMember(env, ctx, 'sub-e', { role: 'owner' }, NOW);

  const r = await listMembers(env, ctx);
  assert.deepEqual(
    r.data.members.map((m) => [m.email, m.role, m.is_primary_owner]),
    [['owner@example.com', 'owner', true], ['editor@example.com', 'owner', false]]
  );
});

test('除名: 論理削除で、その人のセッションは次の一手で落ちる', async () => {
  const { env, ctx } = createTestEnv();
  addMember(env, { id: 'sub-e', email: 'editor@example.com', role: 'editor' });

  const cookie = `${SESSION_COOKIE}=${await signSession(
    { email: 'editor@example.com', expMs: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET
  )}`;
  const request = new Request('https://erlen.example/api/me', { headers: { cookie } });
  assert.equal((await loadContext(request, env)).ok, true, '除名前は通る');

  assert.equal((await removeMember(env, ctx, 'sub-e', NOW)).status, 200);
  const after = await loadContext(request, env);
  assert.deepEqual(after, { ok: false, status: 401, error: 'unauthorized' }, 'Cookieが残っていても入れない');

  // 記録は消さない（行は残り、deleted_atが入るだけ）
  assert.equal(env.DB.__raw.prepare('SELECT deleted_at FROM users WHERE id = ?').get('sub-e').deleted_at, NOW);
  assert.deepEqual((await listMembers(env, ctx)).data.members.map((m) => m.email), ['owner@example.com']);
});

test('除名: オーナー自身・よそのテナントの人は消せない', async () => {
  const { env, ctx, otherCtx } = createTestEnv();
  const self = await removeMember(env, ctx, ctx.userId, NOW);
  assert.equal(self.status, 409);
  assert.equal(self.data.error, 'owner_immutable');

  addMember(env, {
    id: 'sub-yoso', email: 'yoso@example.com', role: 'editor', tenantId: otherCtx.tenantId,
  });
  assert.equal((await removeMember(env, ctx, 'sub-yoso', NOW)).status, 404);
  assert.equal((await removeMember(env, ctx, 'NOPE', NOW)).status, 404);
});

test('メンバー管理の全SQLがtenant_idで絞られている', async () => {
  const { env, ctx } = createTestEnv();
  addMember(env, { id: 'sub-e', email: 'editor@example.com', role: 'editor' });
  const made = await createInvitation(env, ctx, { email: 'new@example.com' }, NOW);
  await listMembers(env, ctx);
  await patchMember(env, ctx, 'sub-e', { role: 'viewer' });
  await revokeInvitation(env, ctx, made.data.invitation.id, NOW);
  await removeMember(env, ctx, 'sub-e', NOW);
  assert.deepEqual(sqlMissingTenantScope(env.DB.__sql), []);
});
