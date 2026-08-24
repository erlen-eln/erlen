// Erlen Worker: 入口。ここは「HTTPの結線」だけを行い、判断は各モジュールに置く。
//   認証まわり  … src/auth.mjs（純関数）＋ src/session.mjs（ctxの組み立て・ログイン可否）
//   権限        … このファイルの一括ガード（viewerは書き込み不可・メンバー管理はownerだけ）
//   業務ロジック … src/api/*.mjs（{status, data} を返すだけの素の関数。単体テスト済み）
// 画面（public/）は ASSETS バインディングへ丸投げする。
import {
  googleAuthUrl, parseCookies, safeNextPath, signSession, validSessionSecret,
  verifyGoogleIdToken, newToken,
  SESSION_COOKIE, STATE_COOKIE, NEXT_COOKIE, SESSION_TTL_MS,
} from './auth.mjs';
import { loadContext, resolveLogin } from './session.mjs';
import { health } from './api/health.mjs';
import {
  createInvitation, listMembers, patchMember, removeMember, revokeInvitation,
} from './api/members.mjs';
import {
  listNotebooks, getNotebook, createNotebook, patchNotebook, deleteNotebook,
} from './api/notebooks.mjs';
import {
  createProject, deleteProject, getProject, listProjects, patchProject, putProjectMembers,
} from './api/projects.mjs';
import { listPages, getPage, createPage, patchPage, deletePage } from './api/pages.mjs';
import { saveMolecules } from './api/molecules.mjs';
import { lookupCompound } from './api/pubchem.mjs';
import {
  createAttachment, deleteAttachment, getAttachment, listAttachments, maxAttachmentBytes,
} from './api/attachments.mjs';
import { searchPages } from './api/search.mjs';
import { buildPageReport } from './api/report.mjs';
import {
  bulkCreateReagents, createReagent, deleteReagent, getReagent, listReagents, patchReagent,
} from './api/reagents.mjs';
import {
  createStock, deleteStock, getStock, listStocks, patchStock,
} from './api/stocks.mjs';
import {
  bulkCreateEquipments, createEquipment, deleteEquipment, getEquipment, listEquipments,
  patchEquipment,
} from './api/equipments.mjs';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

// api/*.mjs が返す {status, data} をResponseへ。
// 添付のダウンロード（バイナリ）と印刷レポート（HTML）だけはJSONに載せられないので、
// handleApi の中で組み立てたResponseをそのまま通す。Responseを作るのはこのファイルだけ、は保つ。
const respond = (result) => (result instanceof Response ? result : json(result.data, result.status));

// 添付の実体を返す。R2のオブジェクトをそのまま流す（Workerのメモリに載せ直さない）
function attachmentResponse({ attachment, object }) {
  const name = attachment.file_name;
  // ファイル名はRFC 5987形式で渡す。日本語のファイル名がブラウザで文字化けしないため。
  // 対応していないブラウザ向けに、ASCIIへ落とした素のfilenameも併記する
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': attachment.mime_type || 'application/octet-stream',
      'content-length': String(attachment.file_size),
      'content-disposition':
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      // 実験記録なので、共有キャッシュには絶対に残さない
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

// Cookieの共通属性。HttpOnly（JSから読めない）＋Secure（HTTPSのみ）＋SameSite=Lax（CSRF対策）
const COOKIE_FLAGS = 'Path=/; HttpOnly; Secure; SameSite=Lax';

async function readJson(request) {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}

// ---- Googleログイン ----------------------------------------------------
async function handleAuth(request, env, url, nowMs) {
  const { pathname } = url;

  if (request.method === 'GET' && pathname === '/auth/login') {
    if (!validSessionSecret(env.SESSION_SECRET) || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      // セットアップ未完了。doctorで何が足りないか分かる
      return json({ error: 'setup_incomplete' }, 503);
    }
    const state = newToken();
    const headers = new Headers({
      location: googleAuthUrl({
        clientId: env.GOOGLE_CLIENT_ID,
        redirectUri: `${env.BASE_URL}/auth/callback`,
        state, // stateとnonceを同じ値にして、突き合わせを1回で済ませる
      }),
    });
    headers.append('set-cookie', `${STATE_COOKIE}=${state}; Max-Age=600; ${COOKIE_FLAGS}`);
    headers.append('set-cookie',
      `${NEXT_COOKIE}=${safeNextPath(url.searchParams.get('next'))}; Max-Age=600; ${COOKIE_FLAGS}`);
    return new Response(null, { status: 302, headers });
  }

  if (request.method === 'GET' && pathname === '/auth/callback') {
    const back = (q) => new Response(null, { status: 302, headers: { location: `${env.BASE_URL}/app${q}` } });
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookies = parseCookies(request.headers.get('cookie'));
    // stateがCookieと一致しない＝別サイトから飛ばされた認可コード。必ず捨てる
    if (!code || !state || state !== cookies[STATE_COOKIE]) return back('?login=error');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${env.BASE_URL}/auth/callback`,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      console.error('erlen google token exchange failed', tokenRes.status);
      return back('?login=error');
    }
    let claims;
    try {
      const tokenBody = await tokenRes.json();
      claims = await verifyGoogleIdToken(tokenBody.id_token, {
        clientId: env.GOOGLE_CLIENT_ID,
        expectedNonce: state,
        nowMs,
      });
    } catch {
      return back('?login=error');
    }
    if (!claims) return back('?login=error');

    const email = String(claims.email ?? '').toLowerCase();
    // メール確認済みでないGoogleアカウントは、そもそも本人性が担保できないので通さない
    if (!claims.email_verified) return back('?login=denied');

    // オーナー本人／既存メンバー／招待の受諾のどれかなら成立。判定は session.mjs（純関数つき）。
    // DEMO_MODE="1"（公開デモ機だけ）のときは、どれにも当たらない人を閲覧専用として通す
    const login = await resolveLogin(env, {
      sub: String(claims.sub),
      email,
      name: String(claims.name ?? ''),
    }, new Date(nowMs).toISOString(), { demoMode: env.DEMO_MODE === '1' });
    if (!login.ok) {
      // メールは一致するがGoogleのsubが違う＝別アカウントでの成りすまし。
      // 画面へ戻さず、その場で断る（何が起きたか分かるように理由も返す）
      if (login.status === 403) return json({ error: 'forbidden', reason: login.reason }, 403);
      return back('?login=denied');
    }

    // デモで通った人のCookieには demo の印を入れる（users行が無いので、これが唯一の身元）
    const value = await signSession(
      { email, expMs: nowMs + SESSION_TTL_MS, demo: login.session?.demo === true },
      env.SESSION_SECRET
    );
    const dest = safeNextPath(cookies[NEXT_COOKIE]);
    const headers = new Headers({ location: `${env.BASE_URL}${dest}` });
    headers.append('set-cookie', `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_TTL_MS / 1000}; ${COOKIE_FLAGS}`);
    headers.append('set-cookie', `${STATE_COOKIE}=; Max-Age=0; ${COOKIE_FLAGS}`);
    headers.append('set-cookie', `${NEXT_COOKIE}=; Max-Age=0; ${COOKIE_FLAGS}`);
    return new Response(null, { status: 302, headers });
  }

  if (request.method === 'POST' && pathname === '/auth/logout') {
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
    headers.append('set-cookie', `${SESSION_COOKIE}=; Max-Age=0; ${COOKIE_FLAGS}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return json({ error: 'not_found' }, 404);
}

// 台帳3種（試薬マスタ・試薬在庫・機器）のルート表。
// 3つとも「一覧＋?q=検索 / 新規 / 単体 / 部分更新 / 論理削除」の同じ形をしているので、
// 同じコードを3回書かずに表で持つ（handleApiの中で1か所だけ読む）。
// bulk（プリセットの一括取り込み）は試薬マスタと機器だけが持つ。
// Mapにしているのは、URLの文字列でObjectを引くと constructor などを拾ってしまうため。
const LEDGERS = new Map([
  ['reagents', {
    list: listReagents, get: getReagent, create: createReagent,
    patch: patchReagent, remove: deleteReagent, bulk: bulkCreateReagents,
  }],
  ['stocks', {
    list: listStocks, get: getStock, create: createStock,
    patch: patchStock, remove: deleteStock, bulk: null,
  }],
  ['equipments', {
    list: listEquipments, get: getEquipment, create: createEquipment,
    patch: patchEquipment, remove: deleteEquipment, bulk: bulkCreateEquipments,
  }],
]);

// ---- /api/*（要ログイン） ---------------------------------------------
// seg は pathname を '/' で割った配列（例 ['api','notebooks','01H...','pages']）
// url はクエリ文字列を読むAPI（/api/pubchem）のために渡している
async function handleApi(request, env, url, seg, ctx) {
  const method = request.method;

  if (seg.length === 2 && seg[1] === 'me' && method === 'GET') {
    return {
      status: 200,
      data: { email: ctx.email, name: ctx.name, role: ctx.role, demo: ctx.demo === true },
    };
  }

  // ---- メンバー管理（GETの一覧は誰でも見られる。変更はオーナーだけ） ----
  if (seg[1] === 'members' || seg[1] === 'invitations') {
    if (seg.length === 2 && seg[1] === 'members' && method === 'GET') {
      return await listMembers(env, ctx);
    }
    if (ctx.role !== 'owner') return { status: 403, data: { error: 'forbidden' } };

    if (seg.length === 2 && seg[1] === 'invitations' && method === 'POST') {
      const parsed = await readJson(request);
      if (!parsed.ok) return { status: 400, data: { error: 'bad_json' } };
      return await createInvitation(env, ctx, parsed.body);
    }
    if (seg.length === 3 && seg[1] === 'invitations' && method === 'DELETE') {
      return await revokeInvitation(env, ctx, seg[2]);
    }
    if (seg.length === 3 && seg[1] === 'members') {
      if (method === 'PATCH') {
        const parsed = await readJson(request);
        if (!parsed.ok) return { status: 400, data: { error: 'bad_json' } };
        return await patchMember(env, ctx, seg[2], parsed.body);
      }
      if (method === 'DELETE') return await removeMember(env, ctx, seg[2]);
    }
    return { status: 405, data: { error: 'method_not_allowed' } };
  }

  // ---- プロジェクト（一覧・単体の閲覧は誰でも。作成・変更・閲覧可能メンバーの設定はオーナーだけ） ----
  // 一覧と単体は「自分に見えるものだけ」が返るので、権限で切り分けずに通してよい。
  // 見えないプロジェクトは 403 ではなく 404 になる（存在ごと隠す）
  if (seg[1] === 'projects') {
    if (seg.length === 2 && method === 'GET') return await listProjects(env, ctx);
    if (seg.length === 3 && method === 'GET') return await getProject(env, ctx, seg[2]);
    if (ctx.role !== 'owner') return { status: 403, data: { error: 'forbidden' } };

    if (seg.length === 2 && method === 'POST') {
      const parsed = await readJson(request);
      if (!parsed.ok) return { status: 400, data: { error: 'bad_json' } };
      return await createProject(env, ctx, parsed.body);
    }
    if (seg.length === 3 && method === 'PATCH') {
      const parsed = await readJson(request);
      if (!parsed.ok) return { status: 400, data: { error: 'bad_json' } };
      return await patchProject(env, ctx, seg[2], parsed.body);
    }
    if (seg.length === 3 && method === 'DELETE') return await deleteProject(env, ctx, seg[2]);
    // 閲覧可能メンバーは一括置換（PUT）。差分APIにすると消し忘れで見えてはいけない人が残る
    if (seg.length === 4 && seg[3] === 'members' && method === 'PUT') {
      const parsed = await readJson(request);
      if (!parsed.ok) return { status: 400, data: { error: 'bad_json' } };
      return await putProjectMembers(env, ctx, seg[2], parsed.body);
    }
    return { status: 405, data: { error: 'method_not_allowed' } };
  }

  // /api/pubchem?type=cas|name|smiles&q=...（試薬の分子量などの自動補完）
  if (seg.length === 2 && seg[1] === 'pubchem') {
    if (method !== 'GET') return { status: 405, data: { error: 'method_not_allowed' } };
    return await lookupCompound(env, ctx, {
      type: url.searchParams.get('type'),
      q: url.searchParams.get('q'),
    });
  }

  // /api/search?q=...（ページの全文検索）
  if (seg.length === 2 && seg[1] === 'search') {
    if (method !== 'GET') return { status: 405, data: { error: 'method_not_allowed' } };
    return await searchPages(env, ctx, { q: url.searchParams.get('q') });
  }

  // /api/attachments/:id（ダウンロードと削除）。
  // GETはバイナリを返す特例。api層は台帳の行とR2のオブジェクトを返すだけで、
  // ストリームの組み立てはここで行う（テナント検査は api層が済ませている）。
  if (seg.length === 3 && seg[1] === 'attachments') {
    if (method === 'GET') {
      const found = await getAttachment(env, ctx, seg[2]);
      return found.status === 200 ? attachmentResponse(found.data) : found;
    }
    if (method === 'DELETE') return await deleteAttachment(env, ctx, seg[2]);
    return { status: 405, data: { error: 'method_not_allowed' } };
  }

  // /api/reagents, /api/stocks, /api/equipments（台帳3種。形が同じなので1か所で捌く）
  const ledger = seg.length >= 2 ? LEDGERS.get(seg[1]) : undefined;
  if (ledger && (seg.length === 2 || seg.length === 3)) {
    // 一覧（?q=で絞り込み）と新規作成
    if (seg.length === 2) {
      if (method === 'GET') return await ledger.list(env, ctx, { q: url.searchParams.get('q') });
      if (method === 'POST') {
        const parsed = await readJson(request);
        if (!parsed.ok) return { status: 400, data: { error: 'bad_json' } };
        return await ledger.create(env, ctx, parsed.body);
      }
      return { status: 405, data: { error: 'method_not_allowed' } };
    }
    // プリセットの一括取り込み（試薬マスタと機器だけが持つ）。IDはULIDなので 'bulk' と衝突しない
    if (seg[2] === 'bulk') {
      if (!ledger.bulk) return { status: 404, data: { error: 'not_found' } };
      if (method !== 'POST') return { status: 405, data: { error: 'method_not_allowed' } };
      const parsed = await readJson(request);
      if (!parsed.ok) return { status: 400, data: { error: 'bad_json' } };
      return await ledger.bulk(env, ctx, parsed.body);
    }
    const id = seg[2];
    if (method === 'GET') return await ledger.get(env, ctx, id);
    if (method === 'PATCH') {
      const parsed = await readJson(request);
      if (!parsed.ok) return { status: 400, data: { error: 'bad_json' } };
      return await ledger.patch(env, ctx, id, parsed.body);
    }
    if (method === 'DELETE') return await ledger.remove(env, ctx, id);
    return { status: 405, data: { error: 'method_not_allowed' } };
  }

  // /api/notebooks
  if (seg.length === 2 && seg[1] === 'notebooks') {
    if (method === 'GET') return await listNotebooks(env, ctx);
    if (method === 'POST') {
      const parsed = await readJson(request);
      if (!parsed.ok) return { status: 400, data: { error: 'bad_json' } };
      return await createNotebook(env, ctx, parsed.body);
    }
    return { status: 405, data: { error: 'method_not_allowed' } };
  }

  // /api/notebooks/:id
  if (seg.length === 3 && seg[1] === 'notebooks') {
    const id = seg[2];
    if (method === 'GET') return await getNotebook(env, ctx, id);
    if (method === 'PATCH') {
      const parsed = await readJson(request);
      if (!parsed.ok) return { status: 400, data: { error: 'bad_json' } };
      return await patchNotebook(env, ctx, id, parsed.body);
    }
    if (method === 'DELETE') return await deleteNotebook(env, ctx, id);
    return { status: 405, data: { error: 'method_not_allowed' } };
  }

  // /api/notebooks/:id/pages
  if (seg.length === 4 && seg[1] === 'notebooks' && seg[3] === 'pages') {
    if (method === 'GET') return await listPages(env, ctx, seg[2]);
    if (method === 'POST') {
      const parsed = await readJson(request);
      if (!parsed.ok) return { status: 400, data: { error: 'bad_json' } };
      return await createPage(env, ctx, seg[2], parsed.body);
    }
    return { status: 405, data: { error: 'method_not_allowed' } };
  }

  // /api/pages/:id
  if (seg.length === 3 && seg[1] === 'pages') {
    const id = seg[2];
    if (method === 'GET') return await getPage(env, ctx, id);
    if (method === 'PATCH') {
      const parsed = await readJson(request);
      if (!parsed.ok) return { status: 400, data: { error: 'bad_json' } };
      return await patchPage(env, ctx, id, parsed.body);
    }
    if (method === 'DELETE') return await deletePage(env, ctx, id);
    return { status: 405, data: { error: 'method_not_allowed' } };
  }

  // /api/pages/:id/molecules
  if (seg.length === 4 && seg[1] === 'pages' && seg[3] === 'molecules') {
    if (method === 'PUT') {
      const parsed = await readJson(request);
      if (!parsed.ok) return { status: 400, data: { error: 'bad_json' } };
      return await saveMolecules(env, ctx, seg[2], parsed.body);
    }
    return { status: 405, data: { error: 'method_not_allowed' } };
  }

  // /api/pages/:id/attachments（一覧とアップロード）
  if (seg.length === 4 && seg[1] === 'pages' && seg[3] === 'attachments') {
    if (method === 'GET') return await listAttachments(env, ctx, seg[2]);
    if (method === 'POST') {
      // multipartは解かない。本体はファイルそのもの、ファイル名は ?filename= で受け取る。
      // 本体を読む前にContent-Lengthで足切りする（上限超えのファイルをメモリに載せないため）
      const limit = maxAttachmentBytes(env);
      const declared = Number(request.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > limit) {
        return { status: 413, data: { error: 'file_too_large', limit_bytes: limit } };
      }
      return await createAttachment(env, ctx, seg[2], {
        bytes: await request.arrayBuffer(),
        contentType: request.headers.get('content-type'),
        fileName: url.searchParams.get('filename'),
      });
    }
    return { status: 405, data: { error: 'method_not_allowed' } };
  }

  // /api/pages/:id/report（印刷用HTML。JSONではないのでここでResponseを組む）
  if (seg.length === 4 && seg[1] === 'pages' && seg[3] === 'report') {
    if (method !== 'GET') return { status: 405, data: { error: 'method_not_allowed' } };
    // ?lang=en のときだけ英語。未指定・それ以外は既定の日本語（buildPageReport側の既定に委ねる）
    const lang = url.searchParams.get('lang');
    const report = await buildPageReport(env, ctx, seg[2], undefined, lang === 'en' ? 'en' : 'ja');
    return report.status === 200 ? htmlResponse(report.data.html) : report;
  }

  return { status: 404, data: { error: 'not_found' } };
}

export default {
  async fetch(request, env) {
    const nowMs = Date.now();
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith('/auth/')) return await handleAuth(request, env, url, nowMs);

    // 死活確認だけはログイン不要
    if (pathname === '/api/health') return respond(health(env));

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const sess = await loadContext(request, env, nowMs);
      if (!sess.ok) return json({ error: sess.error }, sess.status);
      // 閲覧専用（viewer）は書き込みを一切通さない。
      // 個々のAPIには権限チェックを書かず、この1行に寄せる（書き漏らしを構造で防ぐ）
      if (sess.ctx.role === 'viewer' && request.method !== 'GET') {
        return json({ error: 'forbidden' }, 403);
      }
      const seg = pathname.split('/').filter(Boolean);
      try {
        return respond(await handleApi(request, env, url, seg, sess.ctx));
      } catch (e) {
        // 想定外の例外はログにだけ詳細を出し、外へは素っ気なく返す
        console.error('erlen api error', pathname, e?.message);
        return json({ error: 'internal_error' }, 500);
      }
    }

    // 画面の入口。実体は public/app/（web/ をViteでビルドしたもの）にある
    if (pathname === '/') {
      return Response.redirect(new URL('/app/', url).toString(), 302);
    }

    // それ以外は静的アセット（public/）
    if (env.ASSETS) return await env.ASSETS.fetch(request);
    return json({ error: 'not_found' }, 404);
  },
};
