#!/usr/bin/env node
// 配布zipを作る道具。
//   node scripts/package.mjs        … テストを走らせてから dist-zip/erlen-<version>.zip を作る
//   node scripts/package.mjs --skip-tests … 検証用（出荷には使わない）
//
// 【設計の意図】
// ・zipを作る前に必ず npm test を走らせ、1件でも赤なら作らない（赤い配布物を出さないための門）
// ・zip書き出しは外部依存なしの自前実装。Windows/macOS/Linuxで同じ結果になる
//   （PowerShellのCompress-Archiveやzipコマンドの有無に左右されない）
// ・node_modules を入れないので、購入者は展開後に `npm ci` を1回実行する必要がある
//   （この案内は README.md / SETUP.md §1 に書いてある）
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'dist-zip');

// zipに入れないもの。
// ・開発の副産物（.git / node_modules / .wrangler / dist-zip）
// ・利用者の環境ごとの資産（.dev.vars / .env / backups / logs）
// ・上流リポジトリの運営だけに要るもの（.github）。CI・Issueテンプレート・リリース手順は
//   受け取った人には関係がなく、入れると「タグを打つとReleaseが作られる」設定まで配ってしまう。
//   ソース丸ごとが欲しい人には、GitHubがReleaseに自動で付ける "Source code (zip)" がある
const EXCLUDE_DIRS = new Set([
  '.git',
  '.github',
  'node_modules',
  '.wrangler',
  'dist-zip',
  'backups',
  'logs',
]);
const EXCLUDE_FILES = new Set([
  '.dev.vars',
  '.env',
  '.DS_Store',
  'Thumbs.db',
]);

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
// zip内のトップフォルダ。展開すると erlen/ が1つできる。
// 製品名は package.json の name が正本（改名したらzipの名前も自動で追随する）
const TOP = pkg.name;
const zipName = `${TOP}-${version}.zip`;

// ---------------------------------------------------------------- テストの門

function runTests() {
  console.log('テストを実行します（赤が1件でもあればzipは作りません）…\n');
  // npm経由でのspawnSyncはWindowsでENOENTになる（npmの実体はnpm.cmd）。
  // node本体のテストランナーを直接叩く。ディレクトリ指定やglobはNodeの版で挙動が変わるので、
  // テストファイルをこちらで列挙して渡す（0件実行の偽緑も同時に防げる）
  const testFiles = readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => path.join('test', f));
  if (testFiles.length < 10) {
    console.error(`✗ テストファイルが見つかりません（${testFiles.length}件）。test/ の場所を確認してください`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, ['--test', ...testFiles], { cwd: ROOT, stdio: 'inherit' });
  if (r.error) {
    console.error(`\n✗ テストを起動できませんでした: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error('\n✗ テストが失敗しました。修正してから作り直してください（zipは作っていません）');
    process.exit(1);
  }
  console.log('\n✓ テスト全緑\n');
}

// ------------------------------------------------------------ ファイルの収集

function collect(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...collect(path.join(dir, entry.name), `${prefix}${entry.name}/`));
    } else {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      out.push({ abs: path.join(dir, entry.name), name: `${prefix}${entry.name}` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ zip書き出し

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS形式の日時（zipのヘッダはこの形式しか持たない）
function dosDateTime(mtime) {
  const d = new Date(mtime);
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = readFileSync(entry.abs);
    const nameBuf = Buffer.from(`${TOP}/${entry.name}`, 'utf8');
    const { time, date } = dosDateTime(statSync(entry.abs).mtime);
    const crc = crc32(raw);

    // 縮まないファイル（すでに圧縮済みの画像など）は無圧縮で入れる
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0x0800, 6);   // フラグ: ファイル名はUTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);       // extra field なし
    chunks.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);         // version made by
    dir.writeUInt16LE(20, 6);         // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);         // extra
    dir.writeUInt16LE(0, 32);         // comment
    dir.writeUInt16LE(0, 34);         // disk number
    dir.writeUInt16LE(0, 36);         // internal attrs
    // external attrs（Unixの通常ファイル・644）。<<16 は符号付きになるので >>>0 で戻す
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

// ------------------------------------------------------------------------ 実行

if (!process.argv.includes('--skip-tests')) runTests();
else console.warn('△ --skip-tests が指定されています。出荷用のzipはテストを通してから作ること\n');

const entries = collect(ROOT);
if (!entries.length) {
  console.error('✗ zipに入れるファイルが1つもありません');
  process.exit(1);
}

// 出荷前の最終確認: 除外したはずのものが混ざっていないか
const leaked = entries.filter((e) => EXCLUDE_FILES.has(path.basename(e.name))
  || e.name.split('/').some((seg) => EXCLUDE_DIRS.has(seg)));
if (leaked.length) {
  console.error(`✗ 除外対象が混ざっています: ${leaked.map((e) => e.name).join(', ')}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, zipName);
if (existsSync(outPath)) rmSync(outPath);

const rawTotal = entries.reduce((sum, e) => sum + statSync(e.abs).size, 0);
const zip = buildZip(entries);
writeFileSync(outPath, zip);

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
console.log('配布zipを作成しました');
console.log(`  ファイル: ${path.relative(ROOT, outPath).split(path.sep).join('/')}`);
console.log(`  版      : ${version}`);
console.log(`  件数    : ${entries.length}ファイル（zip内のトップフォルダ: ${TOP}/）`);
console.log(`  展開後  : ${mb(rawTotal)}`);
console.log(`  zip     : ${mb(zip.length)}`);
console.log('');
console.log('購入者側の手順: zipを展開 → そのフォルダでClaude Codeを開く →');
console.log('  guides/setup.html の依頼文を渡す（node_modulesは同梱していないので、AIが npm ci を実行します）');
