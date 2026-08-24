#!/usr/bin/env node
// RDKit.js（構造式をSMILESから描くWASM）を public/rdkit/ へ取り込む道具。
//
//   npm run prepare:rdkit
//
// 【なぜコピーするのか】
// ・CDNは使わない。研究室のネットワークは外へ出られないことがあるし、
//   実験記録の画面が第三者のサーバに依存するのは筋が悪い（Ketcherと同じ流儀）。
// ・@rdkit/rdkit は devDependency に留める。コピーした2本をgitにコミットするので、
//   利用者は npm ci をしなくても構造式が描ける（画面のビルド成果物と同じ扱い）。
//
// 【LICENSE も必ず一緒に持ってくる】
// RDKit.js は BSD 3-Clause。第2項が「バイナリ形式での再配布は、著作権表示・条件文・
// 免責事項をドキュメント等に再掲すること」を要求する。.js と .wasm の同梱はまさに
// バイナリ再配布なので、public/rdkit/LICENSE を欠かすとライセンス違反になる。
// test/licensing.test.mjs が実在を見張っている。
//
// 【版を上げるとき】
//   npm i -D @rdkit/rdkit@<版> && npm run prepare:rdkit && npm test
// test/asset-size.test.mjs が「25MiB超のアセットが無いこと」と
// 「public/rdkit/ の2本が揃っていること」を見張っているので、取りこぼしはそこで止まる。
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'node_modules/@rdkit/rdkit/dist');
const DEST = path.join(ROOT, 'public/rdkit');

// 画面が読むのはこの2本だけ。RDKit_minimal.js が同じ場所の .wasm を取りに来る
// （取りに来る先は web/src/components/rdkit.ts の locateFile で明示している）
const FILES = ['RDKit_minimal.js', 'RDKit_minimal.wasm'];

// dist ではなくパッケージ直下にあるもの（BSD 3-Clause の全文）。再配布の必須要件
const PKG_ROOT = path.join(ROOT, 'node_modules/@rdkit/rdkit');

if (!existsSync(SRC)) {
  console.error('✗ node_modules/@rdkit/rdkit がありません。先に `npm i -D @rdkit/rdkit` を実行してください');
  process.exit(1);
}

mkdirSync(DEST, { recursive: true });

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'node_modules/@rdkit/rdkit/package.json'), 'utf8'));
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

for (const name of FILES) {
  const from = path.join(SRC, name);
  if (!existsSync(from)) {
    console.error(`✗ ${name} が @rdkit/rdkit の dist にありません（版が変わってファイル名が変わった可能性）`);
    process.exit(1);
  }
  copyFileSync(from, path.join(DEST, name));
  console.log(`  ${name}  ${mb(statSync(from).size)}`);
}

// BSD 3-Clause の全文（著作権表示・条件文・免責事項）。2本のバイナリと必ず対で置く
{
  const from = path.join(PKG_ROOT, 'LICENSE');
  if (!existsSync(from)) {
    console.error('✗ node_modules/@rdkit/rdkit/LICENSE がありません（BSD 3-Clauseの全文は再配布の必須要件）');
    process.exit(1);
  }
  copyFileSync(from, path.join(DEST, 'LICENSE'));
  console.log('  LICENSE  （BSD 3-Clause 全文）');
}

// どの版を焼いたのかを残す。版上げの差分がgitで見えるようにするため
writeFileSync(
  path.join(DEST, 'VERSION.txt'),
  `@rdkit/rdkit ${pkg.version}\n`
  + '同梱物: RDKit_minimal.js / RDKit_minimal.wasm / LICENSE（scripts/copy-rdkit.mjs がコピー）\n'
  + 'ライセンス: BSD 3-Clause（RDKit本体と同じ・全文は同じフォルダの LICENSE）\n',
  'utf8'
);

console.log(`✓ public/rdkit/ を更新しました（@rdkit/rdkit ${pkg.version}）`);
