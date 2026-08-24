// 添付ファイル（スペクトルのPDF・NMRの生データ・写真など）。
// 実体はR2（env.ATTACHMENTS）、台帳はD1の attachments テーブル。この2つを食い違わせないのが仕事。
//
// 設計の約束ごと
//   1. R2キーは att/{tenant_id}/{page_id}/{ulid}。キーの先頭にテナントを入れておくと、
//      取り違えが起きても「別テナントのキーを引いている」ことが目で分かる。
//   2. 削除は台帳の論理削除だけ。R2の実体は消さない（実験ノートの記録は消さないのが原則）。
//      間違って消しても、台帳のdeleted_atを戻せば復活できる。
//   3. アップロードは生ボディで受ける（multipartは解かない）。ファイル名は ?filename= で受け取る。
//      画面は fetch(file) をそのまま投げるだけでよく、パーサを自作しなくて済む。
//   4. 確定済み（status='closed'）のページには足せない。ページの締めと添付の締めを揃えるため。
// 【鉄則】このファイルの全SQLに tenant_id = ? が入っていること。
//
// 所属ノートブックが見えない人には、添付も存在しないように振る舞う（src/access.mjs）。
import { ulid } from '../ulid.mjs';
import { attachmentVisibility, pageVisibility } from '../access.mjs';

const COLUMNS = 'id, page_id, user_id, file_name, file_size, mime_type, sha256, created_at';

// 添付1件あたりの上限。vars.MAX_ATTACHMENT_MB（既定25MB）で決まる。
// R2の無料枠と、Workerが1リクエストで抱えられるメモリの両方に配慮した既定値。
export const DEFAULT_MAX_ATTACHMENT_MB = 25;

export function maxAttachmentBytes(env) {
  const mb = Number(env?.MAX_ATTACHMENT_MB);
  const safe = Number.isFinite(mb) && mb > 0 ? Math.min(mb, 100) : DEFAULT_MAX_ATTACHMENT_MB;
  return Math.floor(safe * 1024 * 1024);
}

// ファイル名の掃除。ディレクトリ区切り・制御文字・前後の空白を落とす。
// 全部落ちて空になったら既定名にする（名前の無い行を作らない）
export function sanitizeFileName(value, fallback = 'attachment') {
  const raw = String(value ?? '')
    .replace(/[\\/]+/g, '_')                    // ディレクトリ区切りは潰す（../ を作らせない）
    .replace(/[\u0000-\u001f\u007f]/g, '')      // 制御文字（ヘッダに混ぜられると危ない）
    .replace(/^\.+/, '')                       // 先頭のドット（隠しファイル・相対指定）
    .trim()
    .slice(0, 200);
  return raw || fallback;
}

// Content-Type から型だけを取り出す（charset等のパラメータは捨てる）
export function sanitizeMimeType(value) {
  const type = String(value ?? '').split(';')[0].trim().toLowerCase().slice(0, 120);
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(type) ? type : 'application/octet-stream';
}

// 中身の指紋。あとから「この添付は差し替えられていないか」を確かめる材料になる
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function r2Key(tenantId, pageId, id) {
  return `att/${tenantId}/${pageId}/${id}`;
}

// 書き込んでよいページか（存在する・自分のテナント・確定していない）を確かめる
async function writablePage(env, ctx, pageId) {
  const vis = pageVisibility(ctx, 'pages');
  const page = await env.DB.prepare(
    `SELECT id, status FROM pages
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${vis.sql}`
  ).bind(pageId, ctx.tenantId, ...vis.args).first();
  if (!page) return { error: { status: 404, data: { error: 'not_found' } } };
  if (page.status === 'closed') return { error: { status: 409, data: { error: 'page_closed' } } };
  return { page };
}

export async function listAttachments(env, ctx, pageId) {
  const vis = pageVisibility(ctx, 'pages');
  const page = await env.DB.prepare(
    `SELECT id FROM pages
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${vis.sql}`
  ).bind(pageId, ctx.tenantId, ...vis.args).first();
  if (!page) return { status: 404, data: { error: 'not_found' } };
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM attachments
      WHERE tenant_id = ? AND page_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC`
  ).bind(ctx.tenantId, pageId).all();
  return { status: 200, data: { attachments: results ?? [] } };
}

// アップロード。worker.mjs が読み切った本体（ArrayBuffer）を受け取る。
// R2へ先に置いてから台帳を書く。逆順にすると「台帳にあるのに実体が無い」行ができてしまう
// （この順なら最悪でも「実体はあるが台帳に無い＝見えないゴミ」で済み、記録の整合は崩れない）。
export async function createAttachment(env, ctx, pageId, input, nowIso = new Date().toISOString()) {
  const { error } = await writablePage(env, ctx, pageId);
  if (error) return error;

  const bytes = input?.bytes;
  if (!bytes || bytes.byteLength === 0) return { status: 400, data: { error: 'empty_body' } };
  const limit = maxAttachmentBytes(env);
  if (bytes.byteLength > limit) {
    return { status: 413, data: { error: 'file_too_large', limit_bytes: limit } };
  }
  if (!env.ATTACHMENTS) return { status: 503, data: { error: 'storage_unavailable' } };

  const id = ulid();
  const key = r2Key(ctx.tenantId, pageId, id);
  const fileName = sanitizeFileName(input?.fileName);
  const mimeType = sanitizeMimeType(input?.contentType);
  const sha256 = await sha256Hex(bytes);

  await env.ATTACHMENTS.put(key, bytes, {
    httpMetadata: { contentType: mimeType },
    // R2側にも素性を残しておく。台帳が壊れてもキーだけで中身の見当がつく
    customMetadata: { tenantId: ctx.tenantId, pageId, sha256 },
  });

  await env.DB.prepare(
    `INSERT INTO attachments
       (id, tenant_id, page_id, user_id, r2_key, file_name, file_size, mime_type, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, ctx.tenantId, pageId, ctx.userId, key, fileName, bytes.byteLength, mimeType, sha256, nowIso).run();

  // 添付を足したこともページの更新として扱う（一覧の並びが実態とずれないように）
  await env.DB.prepare(
    `UPDATE pages SET updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).bind(nowIso, pageId, ctx.tenantId).run();

  return {
    status: 201,
    data: {
      attachment: {
        id, page_id: pageId, user_id: ctx.userId, file_name: fileName,
        file_size: bytes.byteLength, mime_type: mimeType, sha256, created_at: nowIso,
      },
    },
  };
}

// ダウンロード用の引き当て。
// ここはバイナリを返す唯一の経路なので、api層は「台帳の行」と「R2のオブジェクト」を返すだけにして、
// ストリームの組み立て（Content-Disposition等）は worker.mjs に任せる。
// 【重要】R2キーは台帳から取る。URLのidから組み立てると、テナント検査を素通りできてしまう。
export async function getAttachment(env, ctx, attachmentId) {
  const vis = attachmentVisibility(ctx, 'attachments');
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS}, r2_key FROM attachments
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${vis.sql}`
  ).bind(attachmentId, ctx.tenantId, ...vis.args).first();
  if (!row) return { status: 404, data: { error: 'not_found' } };
  if (!env.ATTACHMENTS) return { status: 503, data: { error: 'storage_unavailable' } };

  const object = await env.ATTACHMENTS.get(row.r2_key);
  // 台帳にあるのにR2に無い＝実体が失われている。404で伏せず、原因が分かる名前で返す
  if (!object) return { status: 410, data: { error: 'object_missing' } };
  return { status: 200, data: { attachment: row, object } };
}

// 論理削除。R2の実体は残す（消えた添付を「記録として消えていない」状態に保つため）
export async function deleteAttachment(env, ctx, attachmentId, nowIso = new Date().toISOString()) {
  const vis = attachmentVisibility(ctx, 'attachments');
  const res = await env.DB.prepare(
    `UPDATE attachments SET deleted_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL${vis.sql}`
  ).bind(nowIso, attachmentId, ctx.tenantId, ...vis.args).run();
  if (!res.meta?.changes) return { status: 404, data: { error: 'not_found' } };
  return { status: 200, data: { ok: true, id: attachmentId } };
}
