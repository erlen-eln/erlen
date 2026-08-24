// 添付ファイル。R2はインメモリの代役（test/r2-adapter.mjs）で、D1は本物のSQLite。
// 「上げたバイト列がそのまま降りてくる」ことを毎回確かめる（実験の生データなので1バイトも変えない）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, sqlMissingTenantScope } from './d1-adapter.mjs';
import { createNotebook } from '../src/api/notebooks.mjs';
import { createPage, patchPage } from '../src/api/pages.mjs';
import {
  createAttachment, deleteAttachment, getAttachment, listAttachments,
  maxAttachmentBytes, sanitizeFileName, sanitizeMimeType, sha256Hex, r2Key,
} from '../src/api/attachments.mjs';

async function setup(opts) {
  const t = createTestEnv(opts);
  const nb = (await createNotebook(t.env, t.ctx, { title: 'ノート' })).data.notebook;
  const page = (await createPage(t.env, t.ctx, nb.id, { title: '実験' })).data.page;
  return { ...t, notebookId: nb.id, pageId: page.id };
}

// 実験データのつもりのバイト列（テキストではないものを混ぜる）
function sampleBytes(size = 64) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 37) % 256;
  return bytes.buffer;
}

async function readAll(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

test('上限バイト数はMAX_ATTACHMENT_MBから決まる（未設定・変な値は既定25MB）', () => {
  assert.equal(maxAttachmentBytes({ MAX_ATTACHMENT_MB: '25' }), 26_214_400);
  assert.equal(maxAttachmentBytes({ MAX_ATTACHMENT_MB: '1' }), 1_048_576);
  assert.equal(maxAttachmentBytes({}), 26_214_400);
  assert.equal(maxAttachmentBytes({ MAX_ATTACHMENT_MB: 'たくさん' }), 26_214_400);
  assert.equal(maxAttachmentBytes({ MAX_ATTACHMENT_MB: '-5' }), 26_214_400);
});

test('ファイル名とMIMEの掃除', () => {
  // 区切り文字が消えていればパスにはならない（R2キーはULIDなので、この名前は表示専用）
  assert.equal(sanitizeFileName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(sanitizeFileName('.hidden'), 'hidden');
  assert.equal(sanitizeFileName('  '), 'attachment');
  assert.equal(sanitizeFileName('1H-NMR スペクトル.pdf'), '1H-NMR スペクトル.pdf');
  assert.equal(sanitizeMimeType('application/pdf; charset=utf-8'), 'application/pdf');
  assert.equal(sanitizeMimeType('でたらめ'), 'application/octet-stream');
  assert.equal(sanitizeMimeType(undefined), 'application/octet-stream');
});

test('アップロード→ダウンロードでバイト列が一致する', async () => {
  const { env, ctx, pageId, R2 } = await setup();
  const bytes = sampleBytes(1024);

  const created = await createAttachment(env, ctx, pageId, {
    bytes, contentType: 'application/pdf', fileName: '1H-NMR.pdf',
  }, '2026-07-20T00:00:00.000Z');
  assert.equal(created.status, 201);
  const att = created.data.attachment;
  assert.equal(att.file_name, '1H-NMR.pdf');
  assert.equal(att.file_size, 1024);
  assert.equal(att.mime_type, 'application/pdf');
  assert.equal(att.sha256, await sha256Hex(bytes));
  // R2キーはテナントとページで区切られている
  assert.equal(R2.__store.has(r2Key(ctx.tenantId, pageId, att.id)), true);

  const got = await getAttachment(env, ctx, att.id);
  assert.equal(got.status, 200);
  assert.equal(got.data.attachment.file_name, '1H-NMR.pdf');
  const downloaded = await readAll(got.data.object.body);
  assert.deepEqual(downloaded, new Uint8Array(bytes), 'バイト列が1バイトも変わっていない');
});

test('一覧は追加順・削除は論理削除（R2の実体は残す）', async () => {
  const { env, ctx, pageId, R2 } = await setup();
  const a = (await createAttachment(env, ctx, pageId,
    { bytes: sampleBytes(8), contentType: 'text/csv', fileName: 'a.csv' },
    '2026-07-20T00:00:00.000Z')).data.attachment;
  const b = (await createAttachment(env, ctx, pageId,
    { bytes: sampleBytes(16), contentType: 'image/png', fileName: 'b.png' },
    '2026-07-21T00:00:00.000Z')).data.attachment;

  const list = await listAttachments(env, ctx, pageId);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.attachments.map((x) => x.file_name), ['a.csv', 'b.png']);

  const removed = await deleteAttachment(env, ctx, a.id, '2026-07-22T00:00:00.000Z');
  assert.equal(removed.status, 200);
  assert.deepEqual(
    (await listAttachments(env, ctx, pageId)).data.attachments.map((x) => x.id), [b.id]
  );
  assert.equal(R2.__store.has(r2Key(ctx.tenantId, pageId, a.id)), true, 'R2の実体は残っている');
  assert.equal((await getAttachment(env, ctx, a.id)).status, 404, '消した添付は引けない');
  // 二度目の削除は404（既に消えている）
  assert.equal((await deleteAttachment(env, ctx, a.id)).status, 404);
});

test('上限を超えるファイルは413（R2にも台帳にも残さない）', async () => {
  const { env, ctx, pageId, R2, DB } = await setup();
  env.MAX_ATTACHMENT_MB = '1';
  const tooBig = new ArrayBuffer(1024 * 1024 + 1);

  const res = await createAttachment(env, ctx, pageId, {
    bytes: tooBig, contentType: 'application/octet-stream', fileName: 'huge.bin',
  });
  assert.equal(res.status, 413);
  assert.equal(res.data.error, 'file_too_large');
  assert.equal(res.data.limit_bytes, 1024 * 1024);
  assert.equal(R2.__store.size, 0);
  assert.equal(DB.__raw.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 0);

  // ちょうど上限は通る
  assert.equal((await createAttachment(env, ctx, pageId, {
    bytes: new ArrayBuffer(1024 * 1024), contentType: 'application/octet-stream', fileName: 'ok.bin',
  })).status, 201);
});

test('空のボディは400', async () => {
  const { env, ctx, pageId } = await setup();
  assert.equal((await createAttachment(env, ctx, pageId, { bytes: new ArrayBuffer(0) })).status, 400);
});

test('確定済み(closed)のページには添付できない（409）', async () => {
  const { env, ctx, pageId } = await setup();
  await patchPage(env, ctx, pageId, { status: 'closed' });
  const res = await createAttachment(env, ctx, pageId, {
    bytes: sampleBytes(8), contentType: 'text/plain', fileName: 'memo.txt',
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.error, 'page_closed');
});

test('テナント越えは404（一覧・追加・取得・削除のどれも通さない）', async () => {
  const { env, ctx, otherCtx, pageId } = await setup();
  const att = (await createAttachment(env, ctx, pageId,
    { bytes: sampleBytes(8), contentType: 'text/plain', fileName: 'memo.txt' })).data.attachment;

  assert.equal((await listAttachments(env, otherCtx, pageId)).status, 404);
  assert.equal((await createAttachment(env, otherCtx, pageId,
    { bytes: sampleBytes(8), fileName: 'x.txt' })).status, 404);
  assert.equal((await getAttachment(env, otherCtx, att.id)).status, 404);
  assert.equal((await deleteAttachment(env, otherCtx, att.id)).status, 404);
  // 自分からはちゃんと引ける（検査が単に全部404にしているのではないことの確認）
  assert.equal((await getAttachment(env, ctx, att.id)).status, 200);
});

test('台帳にあるのにR2から実体が消えていたら410', async () => {
  const { env, ctx, pageId, R2 } = await setup();
  const att = (await createAttachment(env, ctx, pageId,
    { bytes: sampleBytes(8), contentType: 'text/plain', fileName: 'memo.txt' })).data.attachment;
  R2.__store.clear();
  const res = await getAttachment(env, ctx, att.id);
  assert.equal(res.status, 410);
  assert.equal(res.data.error, 'object_missing');
});

test('R2バインディングが無い環境では503（画面が「保存できた」と誤解しない）', async () => {
  const { env, ctx, pageId } = await setup();
  delete env.ATTACHMENTS;
  assert.equal((await createAttachment(env, ctx, pageId,
    { bytes: sampleBytes(8), fileName: 'x.txt' })).status, 503);
});

test('発行された全SQLに tenant_id 条件が入っている', async () => {
  const { env, ctx, pageId, DB } = await setup();
  const att = (await createAttachment(env, ctx, pageId,
    { bytes: sampleBytes(8), contentType: 'text/plain', fileName: 'memo.txt' })).data.attachment;
  await listAttachments(env, ctx, pageId);
  await getAttachment(env, ctx, att.id);
  await deleteAttachment(env, ctx, att.id);
  assert.deepEqual(sqlMissingTenantScope(DB.__sql), []);
});
