// 配布物の残渣ゼロゲート（出荷可否の機械判定）。
// 購入者へzipで渡すリポジトリなので、開発者固有の文字列が1つでも混ざっていたら出荷しない。
// 対象は「zipに入る全テキストファイル」＝ public/app/ のビルド成果物も public/ketcher/ も含む。
//
// 【このテスト自身が引っかからないための書き方】
// 検査語をそのまま書くとこのファイル自体が残渣を含むことになるので、
// 文字列連結で組み立てている（'tsdb' + '328' の形）。語を足すときも同じ書き方にすること。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 走査から外すディレクトリ（zipにも入らないもの）
const SKIP_DIRS = new Set(['.git', 'node_modules', '.wrangler', 'dist-zip', 'backups', 'logs']);

// 開発者固有の文字列。配布物のどこにも出てはいけない
const DEV_TOKENS = [
  'tsdb' + '328',
  'gakushi' + 'ai',
  'satoshi' + 'chihiro',
  'chem' + 'toollab',
  '2nd' + '-Brain',
];

// 個人メールとみなすドメイン（同梱OSSの作者連絡先などは対象外にしたいので、消費者向けだけを見る）。
// 【重要】必ず '@' から始まる形にすること。
// 先頭を [A-Za-z0-9._%+-]+ にすると、22MBの圧縮済みJSを走査するときに
// 破滅的バックトラッキングで固まる（実際に固まった）。ローカル部は後から短い窓で拾う
const PERSONAL_MAIL_DOMAIN = /@(?:gmail|googlemail|outlook|hotmail|icloud)\.com\b|@yahoo\.(?:co\.jp|com)\b/g;
const LOCAL_PART = /[A-Za-z0-9._%+-]{1,64}$/;

// 実IDらしきUUID。wrangler.jsoncのdatabase_idが埋まったまま出荷される事故を止める
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

// 正当な文字列の除外リスト。同梱物（Ketcher等）のライセンス表記のように、
// 開発者固有ではないのに検査へ引っかかるものだけをここへ足す。
// 検査語そのものを削って逃げないこと（それでは検査が意味を失う）。
const ALLOWED = [
  // 例: { file: 'public/ketcher/static/js/main.xxxx.js.LICENSE.txt', token: '...' },
];

function isAllowed(relPath, token) {
  return ALLOWED.some((x) => x.file === relPath && x.token === token);
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...listFiles(path.join(dir, entry.name)));
    } else {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

// バイナリ（画像・フォント等）は走査しない。先頭にNULバイトがあるものをバイナリとみなす
function readTextOrNull(file) {
  const buf = readFileSync(file);
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

const FILES = listFiles(ROOT);

// 走査は1回だけ（22MBのKetcherを何度も読み直さない）。結果を各テストが見る
const SCAN = (() => {
  const dev = [];
  const mail = [];
  const uuid = [];
  let scanned = 0;
  for (const file of FILES) {
    const text = readTextOrNull(file);
    if (text === null) continue;
    scanned += 1;
    const relPath = rel(file);

    for (const token of DEV_TOKENS) {
      if (text.includes(token) && !isAllowed(relPath, token)) dev.push(`${relPath}: ${token}`);
    }

    PERSONAL_MAIL_DOMAIN.lastIndex = 0;
    for (let m = PERSONAL_MAIL_DOMAIN.exec(text); m; m = PERSONAL_MAIL_DOMAIN.exec(text)) {
      // ドメインの手前64文字だけを見てローカル部を拾う（全文への貪欲マッチを避ける）
      const local = text.slice(Math.max(0, m.index - 64), m.index).match(LOCAL_PART);
      if (!local) continue;
      const address = `${local[0]}${m[0]}`;
      if (!isAllowed(relPath, address)) mail.push(`${relPath}: ${address}`);
    }

    const hit = text.match(UUID);
    if (hit && !isAllowed(relPath, hit[0])) uuid.push(`${relPath}: ${hit[0]}`);
  }
  return { dev, mail, uuid, scanned };
})();

test('配布物に開発者固有の文字列が無い（zipに入る全テキストを走査）', () => {
  assert.deepEqual(SCAN.dev, [], `開発者固有の残渣:\n${SCAN.dev.join('\n')}`);
});

test('配布物に実在しそうな個人メールが無い', () => {
  assert.deepEqual(SCAN.mail, [], `個人メールの残渣:\n${SCAN.mail.join('\n')}`);
});

test('配布物に実IDらしきUUIDが無い（database_idの埋め残し）', () => {
  assert.deepEqual(SCAN.uuid, [], `UUIDらしき値:\n${SCAN.uuid.join('\n')}`);
});

test('wrangler.jsoncの★は未置換のまま出荷される（購入者が自分の値を入れる）', () => {
  const src = readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
  for (const marker of [
    'REPLACE_WITH_YOUR_D1_DATABASE_ID',
    'REPLACE_WITH_YOUR_WORKER_URL',
    'REPLACE_WITH_YOUR_EMAIL',
  ]) {
    assert.ok(src.includes(marker), `★のプレースホルダー ${marker} が消えている（自分の値を焼き込んでいないか）`);
  }
});

test('走査が実際に効いている（対象ファイルが十分あり、大物も読めている）', () => {
  // SKIP_DIRSの書き間違いで0件走査の偽緑になるのを防ぐ
  assert.ok(FILES.length > 40, `走査対象が少なすぎる: ${FILES.length}件`);
  assert.ok(SCAN.scanned > 40, `テキストとして読めたファイルが少なすぎる: ${SCAN.scanned}件`);
  const ketcher = FILES.filter((f) => rel(f).startsWith('public/ketcher/'));
  assert.ok(ketcher.length >= 5, 'public/ketcher/ が走査対象に入っていない');
  const app = FILES.filter((f) => rel(f).startsWith('public/app/'));
  assert.ok(app.length >= 2, 'public/app/ のビルド成果物が走査対象に入っていない');
});

// ここから下は「配布キットとして欠けが無いか」の検品。
// 1つでも欠けると購入者の一本道が途切れる
test('配布キットの必須ファイルが揃っている', () => {
  const required = [
    'README.md',
    'SETUP.md',
    // Apache-2.0 で公開するので、全文（LICENSE）と帰属（NOTICE）は配布物の一部。
    // 表記の欠落そのものがライセンス違反なので、検品は test/licensing.test.mjs にもある
    'LICENSE',
    'NOTICE',
    'AI_CONSTITUTION.md',
    'CLAUDE.md',
    'CHANGELOG.json',
    'guides/setup.html',
    'guides/update.html',
    '.claude/skills/erlen-setup/SKILL.md',
    '.claude/skills/erlen-update/SKILL.md',
    '.claude/skills/erlen-backup/SKILL.md',
    'scripts/doctor.mjs',
    'scripts/package.mjs',
    'package.json',
    'package-lock.json',
    'wrangler.jsonc',
  ];
  const missing = required.filter((f) => !existsSync(path.join(ROOT, f)));
  assert.deepEqual(missing, [], `配布キットに欠けているファイル: ${missing.join(', ')}`);
});

test('guidesは自己完結している（外部ホストへの依存が無い）', () => {
  for (const name of ['setup.html', 'update.html']) {
    const html = readFileSync(path.join(ROOT, 'guides', name), 'utf8');
    assert.ok(!/(?:src|href)\s*=\s*["']https?:\/\//i.test(html),
      `guides/${name}: 外部URLを読み込んでいる（オフラインで開けなくなる）`);
    assert.ok(html.includes('<style>'), `guides/${name}: CSSが同梱されていない`);
    assert.ok(html.includes('copy-button'), `guides/${name}: 依頼文のコピーボタンが無い`);
    assert.ok(/<code>[\s\S]*SETUP\.md/.test(html), `guides/${name}: AIへ渡す依頼文が無い`);
  }
});

test('同梱スキルにfrontmatterのname/descriptionがある', () => {
  for (const name of ['erlen-setup', 'erlen-update', 'erlen-backup']) {
    const src = readFileSync(path.join(ROOT, '.claude/skills', name, 'SKILL.md'), 'utf8');
    assert.ok(src.startsWith('---\n'), `${name}: frontmatterで始まっていない`);
    const end = src.indexOf('\n---\n', 4);
    assert.ok(end > 0, `${name}: frontmatterが閉じていない`);
    const front = src.slice(4, end);
    assert.match(front, new RegExp(`^name:\\s*${name}$`, 'm'), `${name}: nameがフォルダ名と一致しない`);
    assert.match(front, /^description:\s*\S/m, `${name}: descriptionが無い`);
  }
});

test('package.mjsの除外リストに生成物と購入者ごとの資産が入っている', () => {
  const src = readFileSync(path.join(ROOT, 'scripts/package.mjs'), 'utf8');
  for (const name of ['dist-zip', 'node_modules', '.wrangler', '.dev.vars', 'backups', 'logs']) {
    assert.ok(src.includes(`'${name}'`), `package.mjsの除外リストに ${name} が無い`);
  }
});

test('dist-zip/ はgit管理外（zipをコミットしない）', () => {
  const ignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^dist-zip\/$/m, '.gitignoreに dist-zip/ が無い');
});

test('配布物のサイズが常識の範囲（大物の混入を検出する）', () => {
  const total = FILES.reduce((sum, f) => sum + statSync(f).size, 0);
  // Ketcher同梱で25MB前後。60MBを超えたら何かが混ざっている
  assert.ok(total < 60 * 1024 * 1024, `配布物が大きすぎる: ${(total / 1024 / 1024).toFixed(1)}MB`);
});
