// 監査証跡（audit_events）への書き込みを集めたモジュール。
// audit_events に INSERT するのはこのファイルだけにする（読む側のAPIは別に作る）。
//
// 記録の形（21 CFR 11.10(e) / ER-ES 指針の真正性に対応する機能）:
//   - 追記専用。UPDATE/DELETE は migrations/0005_audit.sql のトリガが拒否する
//   - tenant_id ごとの連番 seq（UNIQUE(tenant_id, seq)）で欠番・重複を識別できる
//   - prev_hash → hash の連鎖で「過去の行が書き換わった」ことを識別できる
//   - 書き込みは業務SQLと同じ env.DB.batch() に載せる
//
// 【重要】D1 の batch は1トランザクションなので、監査が書けなければ業務も書けない
// （＝監査の無い書き込みは残らない、が狙いの性質）。
// ただし test/d1-adapter.mjs の batch は逐次 run() でトランザクションを模していないので、
// この性質に依存したテスト（「batch の途中で失敗したら業務側の行も残らない」など）は書かないこと。
import { ulid } from './ulid.mjs';

// 記録する操作の名前の一覧。この指示書（pages/molecules）と次の指示書（残りのAPIとauth）で使う全量。
// 一覧への照合は呼び出し側やテストが行う。ここで未知の action を弾くと、
// 名前の付け忘れで「監査の無い書き込み」ができてしまうので、登録外でも記録は止めない。
export const AUDIT_ACTIONS = [
  'page.create', 'page.update', 'page.close', 'page.reopen', 'page.delete',
  'molecules.replace',
  'notebook.create', 'notebook.update', 'notebook.delete',
  'project.create', 'project.update', 'project.delete', 'project.members_replace',
  'invitation.create', 'invitation.revoke', 'invitation.accept',
  'member.role_change', 'member.promote_owner', 'member.remove',
  'attachment.create', 'attachment.delete',
  'reagent.create', 'reagent.bulk', 'reagent.update', 'reagent.delete',
  'stock.create', 'stock.update', 'stock.delete',
  'equipment.create', 'equipment.bulk', 'equipment.update', 'equipment.delete',
  'tenant.bootstrap',
  'auth.login', 'auth.login_denied', 'auth.login_forbidden', 'auth.login_error', 'auth.logout',
  'policy.create', 'policy.update', 'policy.delete', 'policy.set_tenant_default',
  'project.policy_assign',
  'reason_code.create', 'reason_code.update', 'reason_code.delete',
];

// ハッシュ連鎖の対象列を固定順の配列にした正規形（鍵順の曖昧さを消すため）。
// 【重要】正規形には版（hash_version）がある。migrations/0006 で audit_events に
// policy / reason_code 列が増えたが、それ以前に書かれた行は新しい列を含めずに
// ハッシュされている。版を分けないと既存の行が検証に通らなくなる。
//   版が未指定または 1 … 従来の14項目（この並びは絶対に変えない）
//   版 2              … 上の末尾に policy, reason_code を足した16項目
// null はそのまま null で入る（undefined と区別しない・決定的）。
export function canonicalize(ev, version = 1) {
  const base = [
    ev.tenant_id, ev.seq, ev.actor_user_id, ev.actor_email, ev.action,
    ev.target_type, ev.target_id, ev.page_id ?? null,
    ev.before_json ?? null, ev.after_json ?? null,
    ev.reason, ev.request_id, ev.at, ev.prev_hash,
  ];
  if (Number(version) >= 2) {
    base.push(ev.policy ?? '', ev.reason_code ?? '');
  }
  return JSON.stringify(base);
}

// 正規形の SHA-256（hex）。書き方は src/api/attachments.mjs の sha256Hex と同じ。
// 鎖の検証（scripts/verify-audit.mjs）もこの関数を import して使う（実装を2か所に持たない）。
// 各行の hash_version（未指定・NULL なら 1）を見て正規形を選ぶので、
// v1 の行と v2 の行が混在した列もそのまま検証できる（連鎖は版をまたいで繋がる）。
export async function hashEvent(ev) {
  const version = Number(ev.hash_version ?? 1);
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(canonicalize(ev, version))
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ctx（session.mjs が組み立てる {userId, tenantId, email, name, role}）から記録者を取り出す。
// request_id は worker.mjs が ctx.requestId に cf-ray を入れたときだけ入る（未設定なら ''）。
// ctx の無い場面（ログイン拒否など）は呼び出し側が { userId: 'anonymous', ... } を組み立てる。
export function actorOf(ctx) {
  return {
    userId: ctx?.userId ?? 'anonymous',
    email: ctx?.email ?? '',
    requestId: ctx?.requestId ?? '',
  };
}

// テナントの末尾の行を読み、seq+1・prev_hash・hash を決めて、
// bind 済みで未実行の INSERT 文と、書くはずの行内容（event）を返す。
// ev = { action, targetType, targetId, pageId?, before?, after?, reason?, policy?, reasonCode? }
// before/after はオブジェクトで受け取り JSON.stringify して格納する。未指定は NULL。
// policy / reasonCode は、その時点で効いていた規制方針と選ばれた理由コード。
// 渡されなければ空文字（規制モードが無い環境では呼び出し側は何も渡さない）。
// at は引数 nowIso（各 API が既定引数で持っているサーバ時刻）をそのまま使う。
// 新しく書く行は hash_version = 2（policy と reason_code を正規形に含める版）。
export async function buildAuditStatement(env, actor, tenantId, ev, nowIso) {
  const last = await env.DB.prepare(
    `SELECT seq, hash FROM audit_events
      WHERE tenant_id = ?
      ORDER BY seq DESC LIMIT 1`
  ).bind(tenantId).first();
  const event = {
    id: ulid(),
    tenant_id: tenantId,
    seq: Number(last?.seq ?? 0) + 1,
    actor_user_id: String(actor?.userId ?? 'anonymous'),
    actor_email: String(actor?.email ?? ''),
    action: String(ev.action),
    target_type: String(ev.targetType ?? ''),
    target_id: String(ev.targetId ?? ''),
    page_id: ev.pageId ?? null,
    before_json: ev.before === undefined ? null : JSON.stringify(ev.before),
    after_json: ev.after === undefined ? null : JSON.stringify(ev.after),
    reason: String(ev.reason ?? ''),
    request_id: String(actor?.requestId ?? ''),
    at: nowIso,
    prev_hash: String(last?.hash ?? ''),
    hash_version: 2,
    policy: String(ev.policy ?? ''),
    reason_code: String(ev.reasonCode ?? ''),
  };
  event.hash = await hashEvent(event);
  const stmt = env.DB.prepare(
    `INSERT INTO audit_events
       (id, tenant_id, seq, actor_user_id, actor_email, action, target_type, target_id,
        page_id, before_json, after_json, reason, request_id, at, prev_hash, hash,
        hash_version, policy, reason_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    event.id, event.tenant_id, event.seq, event.actor_user_id, event.actor_email,
    event.action, event.target_type, event.target_id, event.page_id,
    event.before_json, event.after_json, event.reason, event.request_id,
    event.at, event.prev_hash, event.hash,
    event.hash_version, event.policy, event.reason_code
  );
  return { stmt, event };
}

// 再試行してよい失敗は UNIQUE(tenant_id, seq) の競合だけ。
// 同時に2つの書き込みが同じ末尾を読むと後発がここで弾かれる（連番を欠番にしないための仕組み）。
function isSeqConflict(e) {
  return /unique/i.test(String(e?.message ?? e));
}

// 業務の文の列の末尾に監査 INSERT を添えて batch で流す共通経路。
// seq 競合で失敗したら末尾を読み直して1回だけ組み直す。2回目も失敗したらそのまま例外を投げる
// （worker.mjs の既存の例外処理が 500 として拾う）。
async function commit(env, actor, tenantId, statements, ev, nowIso) {
  let { stmt, event } = await buildAuditStatement(env, actor, tenantId, ev, nowIso);
  let out;
  try {
    out = await env.DB.batch([...statements, stmt]);
  } catch (e) {
    if (!isSeqConflict(e)) throw e;
    ({ stmt, event } = await buildAuditStatement(env, actor, tenantId, ev, nowIso));
    out = await env.DB.batch([...statements, stmt]);
  }
  // results[i] が statements[i] の実行結果になるように、末尾の監査分を落として返す
  return { results: out.slice(0, statements.length), event };
}

// 業務の書き込みと監査の記録を1つの batch で流す。戻り値の results[i] は statements[i] の結果。
export async function commitWithAudit(env, ctx, statements, ev, nowIso) {
  return commit(env, actorOf(ctx), ctx.tenantId, statements, ev, nowIso);
}

// 業務の書き込みを伴わない事象（ログイン成否・ログアウト等）の記録。
// ctx を持たない経路から呼べるよう actor を直接受け取る。
export async function recordAudit(env, actor, tenantId, ev, nowIso) {
  const { event } = await commit(env, actor, tenantId, [], ev, nowIso);
  return { event };
}
