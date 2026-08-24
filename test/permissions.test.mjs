// 権限マトリクス（owner / editor / viewer）をHTTPの入口から検査する。
// 個々のAPIには権限チェックを書かず worker.mjs の一括ガードに寄せているので、
// 「新しいAPIを足したら権限が抜けていた」を防げるのはこのテストだけ。ここは手厚く見る。
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { addMember, createTestEnv } from './d1-adapter.mjs';
import { signSession, SESSION_COOKIE, SESSION_TTL_MS } from '../src/auth.mjs';

const BASE = 'https://erlen.example.workers.dev';

async function cookieFor(env, email) {
  const value = await signSession({ email, expMs: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET);
  return `${SESSION_COOKIE}=${value}`;
}

// owner（既定）＋editor＋viewerが居る研究室を1つ作る。ノートとページも1枚ずつ用意する
async function makeLab() {
  const { env, ctx } = createTestEnv();
  env.ASSETS = { fetch: async () => new Response('app') };
  addMember(env, { id: 'sub-editor', email: 'editor@example.com', name: '助教', role: 'editor' });
  addMember(env, { id: 'sub-viewer', email: 'viewer@example.com', name: '見学', role: 'viewer' });

  const cookies = {
    owner: await cookieFor(env, 'owner@example.com'),
    editor: await cookieFor(env, 'editor@example.com'),
    viewer: await cookieFor(env, 'viewer@example.com'),
  };

  const nb = (await (await call('/api/notebooks', {
    env, cookie: cookies.owner, method: 'POST', body: { title: '有機合成2026' },
  })).json()).notebook;
  const page = (await (await call(`/api/notebooks/${nb.id}/pages`, {
    env, cookie: cookies.owner, method: 'POST', body: { title: 'アルドール縮合' },
  })).json()).page;
  const invitation = (await (await call('/api/invitations', {
    env, cookie: cookies.owner, method: 'POST', body: { email: 'pending@example.com' },
  })).json()).invitation;

  // 台帳3種（試薬マスタ・試薬在庫・機器）も1件ずつ用意する
  const reagent = (await (await call('/api/reagents', {
    env, cookie: cookies.owner, method: 'POST', body: { name: 'トルエン', cas_number: '108-88-3' },
  })).json()).reagent;
  const stock = (await (await call('/api/stocks', {
    env, cookie: cookies.owner, method: 'POST', body: { reagent_master_id: reagent.id, lot_number: 'L-1' },
  })).json()).stock;
  const equipment = (await (await call('/api/equipments', {
    env, cookie: cookies.owner, method: 'POST', body: { name: 'エバポレーター' },
  })).json()).equipment;

  // プロジェクトも1件。閲覧可能メンバーは空のまま（＝オーナーにしか見えない状態）
  const project = (await (await call('/api/projects', {
    env, cookie: cookies.owner, method: 'POST', body: { name: '共同研究A' },
  })).json()).project;

  return { env, ctx, cookies, nb, page, invitation, reagent, stock, equipment, project };
}

function call(path, { env, cookie, method = 'GET', body } = {}) {
  const headers = { cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return worker.fetch(new Request(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

test('GET系は3ロールとも200（閲覧は誰でもできる）', async () => {
  const { env, cookies, nb, page, reagent, stock, equipment } = await makeLab();
  const paths = [
    '/api/reagents',
    `/api/reagents/${reagent.id}`,
    '/api/reagents?q=トルエン',
    '/api/stocks',
    `/api/stocks/${stock.id}`,
    '/api/equipments',
    `/api/equipments/${equipment.id}`,
    '/api/me',
    '/api/members',
    '/api/projects',
    '/api/notebooks',
    `/api/notebooks/${nb.id}`,
    `/api/notebooks/${nb.id}/pages`,
    `/api/pages/${page.id}`,
    `/api/pages/${page.id}/attachments`,
    `/api/pages/${page.id}/report`,
    '/api/search?q=アルドール',
  ];
  for (const role of ['owner', 'editor', 'viewer']) {
    for (const path of paths) {
      const res = await call(path, { env, cookie: cookies[role] });
      assert.equal(res.status, 200, `${role} GET ${path}`);
    }
  }
});

// 書き込み系の代表エンドポイント一覧。viewerとデモの両方が同じ列で403になることを見る
// （2つのテストで別々の一覧を持つと、片方だけ育って穴が空く）
function writeEndpoints({ nb, page, invitation, reagent, stock, equipment, project }) {
  return [
    ['POST', '/api/projects', { name: 'x' }],
    ['PATCH', `/api/projects/${project.id}`, { name: 'x' }],
    ['DELETE', `/api/projects/${project.id}`, undefined],
    ['PUT', `/api/projects/${project.id}/members`, { user_ids: ['sub-viewer'] }],
    ['POST', '/api/reagents', { name: 'x' }],
    ['POST', '/api/reagents/bulk', { items: [{ name: 'x' }] }],
    ['PATCH', `/api/reagents/${reagent.id}`, { name: 'x' }],
    ['DELETE', `/api/reagents/${reagent.id}`, undefined],
    ['POST', '/api/stocks', { custom_reagent_name: 'x' }],
    ['PATCH', `/api/stocks/${stock.id}`, { lot_number: 'x' }],
    ['DELETE', `/api/stocks/${stock.id}`, undefined],
    ['POST', '/api/equipments', { name: 'x' }],
    ['POST', '/api/equipments/bulk', { items: [{ name: 'x' }] }],
    ['PATCH', `/api/equipments/${equipment.id}`, { name: 'x' }],
    ['DELETE', `/api/equipments/${equipment.id}`, undefined],
    ['POST', '/api/notebooks', { title: 'x' }],
    ['PATCH', `/api/notebooks/${nb.id}`, { title: 'x' }],
    ['DELETE', `/api/notebooks/${nb.id}`, undefined],
    ['POST', `/api/notebooks/${nb.id}/pages`, { title: 'x' }],
    ['PATCH', `/api/pages/${page.id}`, { content: 'x' }],
    ['DELETE', `/api/pages/${page.id}`, undefined],
    ['PUT', `/api/pages/${page.id}/molecules`, { molecules: [] }],
    ['POST', `/api/pages/${page.id}/attachments?filename=x.txt`, { a: 1 }],
    ['DELETE', '/api/attachments/ANY', undefined],
    ['POST', '/api/invitations', { email: 'x@example.com' }],
    ['DELETE', `/api/invitations/${invitation.id}`, undefined],
    ['PATCH', '/api/members/sub-editor', { role: 'viewer' }],
    ['DELETE', '/api/members/sub-editor', undefined],
  ];
}

test('viewerは書き込み系を全て403（代表エンドポイント）', async () => {
  const lab = await makeLab();
  const { env, cookies } = lab;
  const writes = writeEndpoints(lab);
  for (const [method, path, body] of writes) {
    const res = await call(path, { env, cookie: cookies.viewer, method, body });
    assert.equal(res.status, 403, `viewer ${method} ${path}`);
    assert.deepEqual(await res.json(), { error: 'forbidden' });
  }
  // 何も書かれていないこと（403が「弾いたふり」になっていない）
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM notebooks WHERE deleted_at IS NULL').get().n, 1);
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM invitations').get().n, 1);
  assert.equal(
    env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL').get().n, 1
  );
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM project_members').get().n, 0);
  for (const table of ['reagent_masters', 'reagent_stocks', 'equipments']) {
    const n = env.DB.__raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`).get().n;
    assert.equal(n, 1, `${table}: viewerの書き込みが通っている`);
  }
});

test('editorは台帳3種を書ける（試薬・在庫・機器はowner限定にしない）', async () => {
  const { env, cookies, reagent, stock, equipment } = await makeLab();
  const writes = [
    ['POST', '/api/reagents', { name: '助教の試薬' }, 201],
    ['POST', '/api/reagents/bulk', { items: [{ name: 'まとめて1' }, { name: 'まとめて2' }] }, 201],
    ['PATCH', `/api/reagents/${reagent.id}`, { purity: 99 }, 200],
    ['POST', '/api/stocks', { custom_reagent_name: '助教の在庫' }, 201],
    ['PATCH', `/api/stocks/${stock.id}`, { is_opened: true }, 200],
    ['POST', '/api/equipments', { name: '助教の機器' }, 201],
    ['POST', '/api/equipments/bulk', { items: [{ name: 'まとめて機器' }] }, 201],
    ['PATCH', `/api/equipments/${equipment.id}`, { manufacturer: 'BUCHI' }, 200],
    ['DELETE', `/api/stocks/${stock.id}`, undefined, 200],
    ['DELETE', `/api/equipments/${equipment.id}`, undefined, 200],
    ['DELETE', `/api/reagents/${reagent.id}`, undefined, 200],
  ];
  for (const [method, path, body, expected] of writes) {
    const res = await call(path, { env, cookie: cookies.editor, method, body });
    assert.equal(res.status, expected, `editor ${method} ${path}`);
  }
});

test('台帳3種の知らないメソッド・形は405/404（穴を開けない）', async () => {
  const { env, cookies, reagent } = await makeLab();
  assert.equal((await call('/api/reagents', { env, cookie: cookies.owner, method: 'PUT', body: {} })).status, 405);
  assert.equal((await call(`/api/reagents/${reagent.id}`, {
    env, cookie: cookies.owner, method: 'POST', body: {},
  })).status, 405);
  // 在庫にbulkは無い
  assert.equal((await call('/api/stocks/bulk', {
    env, cookie: cookies.owner, method: 'POST', body: { items: [{ name: 'x' }] },
  })).status, 404);
  assert.equal((await call('/api/equipments/bulk', { env, cookie: cookies.owner })).status, 405);
  // 深すぎるパスは素通しせず404
  assert.equal((await call('/api/reagents/a/b', { env, cookie: cookies.owner })).status, 404);
  // URLの文字列でルート表を引くときに、Objectの継承プロパティを拾わないこと
  assert.equal((await call('/api/constructor', { env, cookie: cookies.owner })).status, 404);
  // ログインしていなければ401
  assert.equal((await call('/api/reagents', { env })).status, 401);
});

test('editorはノートを書けるが、メンバー管理とプロジェクト設定は403', async () => {
  const { env, cookies, nb, page, invitation, project } = await makeLab();
  assert.equal((await call('/api/notebooks', {
    env, cookie: cookies.editor, method: 'POST', body: { title: '助教のノート' },
  })).status, 201);
  assert.equal((await call(`/api/pages/${page.id}`, {
    env, cookie: cookies.editor, method: 'PATCH', body: { content: '追記' },
  })).status, 200, 'テナント内なら他人のページも編集できる');
  assert.equal((await call(`/api/notebooks/${nb.id}`, {
    env, cookie: cookies.editor, method: 'DELETE',
  })).status, 200);

  const denied = [
    ['POST', '/api/invitations', { email: 'x@example.com' }],
    ['DELETE', `/api/invitations/${invitation.id}`, undefined],
    ['PATCH', '/api/members/sub-viewer', { role: 'editor' }],
    ['DELETE', '/api/members/sub-viewer', undefined],
    ['POST', '/api/projects', { name: 'x' }],
    ['PATCH', `/api/projects/${project.id}`, { name: 'x' }],
    ['DELETE', `/api/projects/${project.id}`, undefined],
    ['PUT', `/api/projects/${project.id}/members`, { user_ids: [] }],
  ];
  for (const [method, path, body] of denied) {
    const res = await call(path, { env, cookie: cookies.editor, method, body });
    assert.equal(res.status, 403, `editor ${method} ${path}`);
    assert.deepEqual(await res.json(), { error: 'forbidden' });
  }
  // プロジェクトそのものは、閲覧可能メンバーでなければ「存在しない」（403ではなく404）
  assert.equal((await call(`/api/projects/${project.id}`, { env, cookie: cookies.editor })).status, 404);
});

test('ownerはプロジェクトと閲覧可能メンバーを一通り通せる', async () => {
  const { env, cookies, nb, project } = await makeLab();

  assert.equal((await call(`/api/projects/${project.id}`, { env, cookie: cookies.owner })).status, 200);
  assert.equal((await call(`/api/projects/${project.id}`, {
    env, cookie: cookies.owner, method: 'PATCH', body: { description: '共同研究の記録' },
  })).status, 200);

  const set = await call(`/api/projects/${project.id}/members`, {
    env, cookie: cookies.owner, method: 'PUT', body: { user_ids: ['sub-editor'] },
  });
  assert.equal(set.status, 200);
  assert.deepEqual((await set.json()).members.map((m) => m.email), ['editor@example.com']);

  // ノートブックをプロジェクトへ入れると、部外のviewerからは消える
  await call(`/api/notebooks/${nb.id}`, {
    env, cookie: cookies.owner, method: 'PATCH', body: { project_id: project.id },
  });
  const asViewer = await (await call('/api/notebooks', { env, cookie: cookies.viewer })).json();
  assert.deepEqual(asViewer.notebooks, []);
  const asEditor = await (await call('/api/notebooks', { env, cookie: cookies.editor })).json();
  assert.deepEqual(asEditor.notebooks.map((n) => n.title), ['有機合成2026']);
  // 部外のviewerは直リンクでも404（存在ごと隠す）
  assert.equal((await call(`/api/notebooks/${nb.id}`, { env, cookie: cookies.viewer })).status, 404);

  assert.equal((await call(`/api/projects/${project.id}`, {
    env, cookie: cookies.owner, method: 'DELETE',
  })).status, 200);
});

test('プロジェクトAPIの知らないメソッド・形は405/404（穴を開けない）', async () => {
  const { env, cookies, project } = await makeLab();
  assert.equal((await call('/api/projects', {
    env, cookie: cookies.owner, method: 'PUT', body: {},
  })).status, 405);
  assert.equal((await call(`/api/projects/${project.id}/members`, {
    env, cookie: cookies.owner, method: 'POST', body: { user_ids: [] },
  })).status, 405);
  assert.equal((await call('/api/projects/a/b/c', { env, cookie: cookies.owner })).status, 405);
  assert.equal((await call('/api/projects/NOPE', { env, cookie: cookies.owner })).status, 404);
  assert.equal((await call('/api/projects', { env })).status, 401);
});

test('ownerはメンバー管理を一通り通せる', async () => {
  const { env, cookies, invitation } = await makeLab();
  const created = await call('/api/invitations', {
    env, cookie: cookies.owner, method: 'POST', body: { email: 'new@example.com', role: 'viewer' },
  });
  assert.equal(created.status, 201);

  assert.equal((await call(`/api/invitations/${invitation.id}`, {
    env, cookie: cookies.owner, method: 'DELETE',
  })).status, 200);
  assert.equal((await call('/api/members/sub-viewer', {
    env, cookie: cookies.owner, method: 'PATCH', body: { role: 'editor' },
  })).status, 200);
  assert.equal((await call('/api/members/sub-editor', {
    env, cookie: cookies.owner, method: 'DELETE',
  })).status, 200);

  const list = await (await call('/api/members', { env, cookie: cookies.owner })).json();
  assert.deepEqual(list.members.map((m) => [m.email, m.role, m.status]), [
    ['owner@example.com', 'owner', 'active'],
    ['viewer@example.com', 'editor', 'active'],
    ['new@example.com', 'viewer', 'pending'],
  ]);
});

test('除名された人はCookieが残っていても401（次のリクエストで落ちる）', async () => {
  const { env, cookies } = await makeLab();
  assert.equal((await call('/api/notebooks', { env, cookie: cookies.editor })).status, 200);
  await call('/api/members/sub-editor', { env, cookie: cookies.owner, method: 'DELETE' });
  const res = await call('/api/notebooks', { env, cookie: cookies.editor });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('メンバー管理APIの知らないメソッド・形は405/404（穴を開けない）', async () => {
  const { env, cookies } = await makeLab();
  assert.equal((await call('/api/members', { env, cookie: cookies.owner, method: 'POST', body: {} })).status, 405);
  assert.equal((await call('/api/invitations', { env, cookie: cookies.owner })).status, 405);
  assert.equal((await call('/api/members/a/b', { env, cookie: cookies.owner, method: 'DELETE' })).status, 405);
  // ログインしていなければ権限以前に401
  assert.equal((await call('/api/members', { env })).status, 401);
});

// ---- 公開デモ（DEMO_MODE="1"）------------------------------------------
// users行を持たないデモの閲覧者にも、viewerと同じ一括ガードが効くこと。
// 「デモだから」と別扱いにした瞬間に穴が開くので、書き込み28本を丸ごと回す
async function demoCookie(env) {
  const value = await signSession(
    { email: 'guest@example.com', expMs: Date.now() + SESSION_TTL_MS, demo: true },
    env.SESSION_SECRET
  );
  return `${SESSION_COOKIE}=${value}`;
}

test('デモの閲覧者は書き込み系を全て403（viewerと同じ列を回す）', async () => {
  const lab = await makeLab();
  const { env } = lab;
  env.DEMO_MODE = '1';
  const cookie = await demoCookie(env);

  for (const [method, path, body] of writeEndpoints(lab)) {
    const res = await call(path, { env, cookie, method, body });
    assert.equal(res.status, 403, `demo ${method} ${path}`);
    assert.deepEqual(await res.json(), { error: 'forbidden' });
  }
  // 何も書かれていないこと（403が「弾いたふり」になっていない）
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM notebooks WHERE deleted_at IS NULL').get().n, 1);
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM invitations').get().n, 1);
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM project_members').get().n, 0);
  // デモはusersを1行も増やさない（オーナー＋editor＋viewerの3人のまま）
  assert.equal(env.DB.__raw.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3);
});

test('デモの閲覧者はGET系を読める（/api/me は demo:true）', async () => {
  const lab = await makeLab();
  const { env, nb, page } = lab;
  env.DEMO_MODE = '1';
  const cookie = await demoCookie(env);

  for (const path of [
    '/api/me', '/api/members', '/api/projects', '/api/notebooks',
    `/api/notebooks/${nb.id}`, `/api/notebooks/${nb.id}/pages`, `/api/pages/${page.id}`,
    `/api/pages/${page.id}/report`, '/api/search?q=アルドール',
    '/api/reagents', '/api/stocks', '/api/equipments',
  ]) {
    assert.equal((await call(path, { env, cookie })).status, 200, `demo GET ${path}`);
  }

  const me = await (await call('/api/me', { env, cookie })).json();
  assert.deepEqual(me, { email: 'guest@example.com', name: '', role: 'viewer', demo: true });
});

test('/api/me の demo は通常のログインでは false', async () => {
  const { env, cookies } = await makeLab();
  const me = await (await call('/api/me', { env, cookie: cookies.owner })).json();
  assert.equal(me.demo, false);
  assert.equal(me.role, 'owner');
});

test('DEMO_MODE を切れば、デモCookieはその場で401（デモ機を閉じる手段）', async () => {
  const lab = await makeLab();
  const { env } = lab;
  env.DEMO_MODE = '1';
  const cookie = await demoCookie(env);
  assert.equal((await call('/api/notebooks', { env, cookie })).status, 200);

  env.DEMO_MODE = '0';
  const res = await call('/api/notebooks', { env, cookie });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('/api/health は DEMO_MODE をそのまま映す（未ログインでも読める）', async () => {
  const { env } = await makeLab();
  const off = await (await call('/api/health', { env })).json();
  assert.equal(off.demo, false);
  env.DEMO_MODE = '1';
  const on = await (await call('/api/health', { env })).json();
  assert.equal(on.demo, true);
  assert.equal(on.ok, true);
});
