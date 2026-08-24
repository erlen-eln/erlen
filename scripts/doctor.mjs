#!/usr/bin/env node
// 公開前の設定検査。「動かない理由」を先に潰すための道具。秘密値そのものは表示しない。
//   npm run doctor         … 手元のファイルだけ検査（オフラインで完結）
//   npm run doctor:remote  … Cloudflare側（secrets・migrations適用状態）も検査
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWrangler } from './lib-wrangler.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const warnings = [];
const ok = (message) => console.log(`✓ ${message}`);
const fail = (message) => failures.push(message);
const warn = (message) => warnings.push(message);

function stripJsoncComments(text) {
  // WindowsのエディタがつけるUTF-8 BOMはJSON.parseを壊すので先に剥がす。
  // コメント除去を先にやらないと、コメント内の例文を未置換値と誤検出する
  return text.replace(/^\uFEFF/, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function parseJsonc(file) {
  return JSON.parse(stripJsoncComments(readFileSync(file, 'utf8'))
    .replace(/,(\s*[}\]])/g, '$1'));
}

// ① Node.jsの版
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 5)) ok(`Node.js ${process.versions.node}`);
else fail(`Node.js 22.5.0以上が必要です（現在 ${process.versions.node}）`);

try {
  const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  if (version) ok(`Erlen v${version}`);
  else warn('package.jsonにversionがありません');
} catch (e) {
  warn(`package.jsonを読めません: ${e.message}`);
}

let config = null;
try {
  config = parseJsonc(path.join(ROOT, 'wrangler.jsonc'));
  ok('wrangler.jsoncを読み込み');
} catch (e) {
  fail(`wrangler.jsoncを読めません: ${e.message}`);
}

if (config) {
  // ② 未置換のプレースホルダー（コメントを外した「値」だけを見る）
  const raw = stripJsoncComments(readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8'));
  const placeholders = raw.match(/REPLACE[_-][A-Z0-9_-]+|YOUR-[A-Z0-9-]+|your-domain\.example|you@example\.com/g) ?? [];
  if (placeholders.length) {
    fail(`wrangler.jsoncに未置換値があります: ${[...new Set(placeholders)].join(', ')}`);
  } else ok('wrangler.jsoncのプレースホルダーなし');

  // ③ ★必須のvars
  const vars = config.vars ?? {};
  for (const name of ['BASE_URL', 'OWNER_EMAIL']) {
    if (!String(vars[name] ?? '').trim()) fail(`${name}をwrangler.jsoncへ設定してください`);
  }
  if (String(vars.BASE_URL ?? '').endsWith('/')) {
    fail('BASE_URLの末尾のスラッシュを外してください（リダイレクトURIが二重スラッシュになります）');
  }
  // 未置換のプレースホルダーは②で名指し済み。ここで形式まで重ねて叱らない
  // （初回セットアップの「まだ埋めていないだけ」の状態を、2件の赤に見せないため）
  const ownerEmail = String(vars.OWNER_EMAIL ?? '');
  if (ownerEmail && !ownerEmail.startsWith('REPLACE') && !ownerEmail.includes('@')) {
    fail('OWNER_EMAILはGoogleアカウントのメールアドレスにしてください');
  }

  // ③b デモモード（必須varsではない。"1" のときだけ、気づけるように注意を1行出す）
  if (String(vars.DEMO_MODE ?? '') === '1') {
    warn('DEMO_MODE="1" です。招待していない人もGoogleログインで全データを閲覧できます'
      + '（書き込みは403で断ります）。自分のノートとして使うなら "0" に戻してください');
  }

  // ④ バインディング
  const db = config.d1_databases?.find((x) => x.binding === 'DB');
  if (!db?.database_id) fail('D1のDBバインディングとdatabase_idが必要です');
  else ok(`D1バインディング DB（${db.database_name}）`);
  if (!config.r2_buckets?.some((x) => x.binding === 'ATTACHMENTS')) {
    fail('添付ファイル用のR2バインディング ATTACHMENTS が必要です');
  }
  if (config.assets?.binding !== 'ASSETS') fail('assets.binding は ASSETS にしてください');

  if (!existsSync(path.join(ROOT, 'migrations')) ||
      !readdirSync(path.join(ROOT, 'migrations')).some((f) => f.endsWith('.sql'))) {
    fail('migrations/ に .sql がありません');
  }

  // ⑤ Cloudflare側（--remoteのときだけ）
  if (process.argv.includes('--remote')) {
    let r = null;
    try {
      r = runWrangler(['secret', 'list', '--format=json']);
    } catch (e) {
      fail(`Cloudflareのsecret一覧を取得できません: ${e.message}`);
    }
    if (r && r.status !== 0) {
      // spawn自体の失敗時はstderr/stdoutがnullのことがある
      const detail = (r.stderr || r.stdout || r.error?.message || '原因不明').trim();
      fail(`Cloudflareのsecret一覧を取得できません: ${detail.slice(0, 300)}`);
    } else if (r) {
      try {
        const start = r.stdout.indexOf('[');
        const rows = JSON.parse(r.stdout.slice(start));
        const names = new Set(rows.map((x) => x.name));
        for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET']) {
          if (!names.has(name)) fail(`Cloudflare secret ${name} がありません`);
        }
        if (!failures.some((x) => x.includes('Cloudflare secret'))) ok('必須Cloudflare secretsが存在');
      } catch (e) {
        fail(`secret一覧の解析に失敗しました: ${e.message}`);
      }
    }

    if (db?.database_name) {
      let m = null;
      try {
        m = runWrangler(['d1', 'migrations', 'list', db.database_name, '--remote']);
      } catch (e) {
        fail(`migrationsの適用状態を取得できません: ${e.message}`);
      }
      if (m && m.status !== 0) {
        const detail = (m.stderr || m.stdout || '原因不明').trim();
        fail(`migrationsの適用状態を取得できません: ${detail.slice(0, 300)}`);
      } else if (m) {
        const out = `${m.stdout}${m.stderr}`;
        const pending = readdirSync(path.join(ROOT, 'migrations'))
          .filter((f) => f.endsWith('.sql'))
          .filter((f) => out.includes(f));
        if (/No migrations to apply/i.test(out) && !pending.length) ok('D1のmigrationsは適用済み');
        else if (pending.length) {
          fail(`未適用のmigrationがあります（${pending.join(', ')}）: `
            + `npm exec -- wrangler d1 migrations apply ${db.database_name} --remote`);
        } else warn('migrationsの適用状態を判定できませんでした（出力形式が想定と違います）');
      }
    }
  } else {
    warn('Cloudflare側は未検査です。初回公開前に npm run doctor:remote を実行してください');
  }
}

for (const message of warnings) console.warn(`△ ${message}`);
if (failures.length) {
  for (const message of failures) console.error(`✗ ${message}`);
  console.error(`\ndoctor: ${failures.length}件を修正してから公開してください`);
  process.exit(1);
}
console.log('\ndoctor: 公開前検査に合格しました');
