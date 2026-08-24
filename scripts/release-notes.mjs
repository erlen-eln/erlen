#!/usr/bin/env node
// GitHub Releases の本文を CHANGELOG.json から組み立てる道具。
//
//   node scripts/release-notes.mjs v1.3.0                     … 標準出力へ書く
//   node scripts/release-notes.mjs v1.3.0 --out notes.md      … ファイルへ書く
//   node scripts/release-notes.mjs                            … package.json の版を使う
//
// 【設計の意図】
// ・変更履歴の正本は CHANGELOG.json ひとつ（guides/update.html も erlen.jp/changelog も
//   そこから作る）。Release本文だけ手書きにすると、利用者が「自分の版に何が入っているか」を
//   3か所で違う答えで読むことになる
// ・この道具は同時に**タグの検算**でもある。タグ・package.json・CHANGELOG.json の3つが
//   揃っていなければ exit 1 で落ちる。.github/workflows/release.yml は zip を作る前にこれを
//   呼ぶので、打ち間違えたタグのままリリースが公開されることはない
// ・出力は ja / en の両方を必ず載せる（README と同じ流儀。利用者に日本語話者以外が居る）
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChangelog, releasedOnly, RELEASED_VERSION } from './render-changelog.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NL = '\n';

// 「v1.3.0」でも「1.3.0」でも受ける（GITHUB_REF_NAME は v 付きで来る）
export function normalizeVersion(tag) {
  const version = String(tag ?? '').trim().replace(/^v/, '');
  if (!RELEASED_VERSION.test(version)) {
    throw new Error(`版の形式が不正です: "${tag}"（vX.Y.Z の形で渡してください）`);
  }
  return version;
}

export function packageVersion(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

// タグ・package.json・CHANGELOG.json の3点が揃っているかを見る。
// 揃っていなければ理由を1件目だけでなく全部返す（直す往復を減らすため）
export function checkVersion(entries, version, pkgVersion) {
  const problems = [];
  if (version !== pkgVersion) {
    problems.push(`タグ v${version} と package.json の version (${pkgVersion}) が違います`);
  }
  const released = releasedOnly(entries);
  const latest = released[0]?.version;
  if (latest !== version) {
    problems.push(`CHANGELOG.json の最新のリリース版 (${latest ?? 'なし'}) が v${version} ではありません`
      + '（先頭のエントリがまだ "unreleased" のままではありませんか）');
  }
  if (!released.some((e) => e.version === version)) {
    problems.push(`CHANGELOG.json に ${version} のエントリがありません`);
  }
  return problems;
}

export function findEntry(entries, version) {
  const entry = releasedOnly(entries).find((e) => e.version === version);
  if (!entry) throw new Error(`CHANGELOG.json に ${version} のエントリがありません`);
  return entry;
}

// Release本文（Markdown）。見出しは日本語→英語の順で、READMEの並びに合わせる
export function renderReleaseNotes(entries, version) {
  const entry = findEntry(entries, version);
  const bullets = (lines) => lines.map((line) => `- ${line}`).join(NL);
  return [
    `## 変更点（v${version}・${entry.date}）`,
    '',
    bullets(entry.ja),
    '',
    `## What's changed (v${version})`,
    '',
    bullets(entry.en),
    '',
    '---',
    '',
    '### 使いはじめる',
    '',
    `下の \`erlen-${version}.zip\` を展開して、そのフォルダでAIコーディングエージェントを開き、`,
    '「Erlenをセットアップしてください」と頼んでください。',
    '`node_modules` は同梱していないので、最初に `npm ci` が走ります。',
    '手順は `README.md` と `SETUP.md`、人向けの案内は `guides/setup.html` にあります。',
    'すでに使っている人の更新手順は `guides/update.html` です。',
    '',
    '### Getting started',
    '',
    `Download \`erlen-${version}.zip\`, unzip it, open your AI coding agent in that folder and ask it`,
    'to "set up Erlen". `node_modules` is not bundled, so `npm ci` runs first.',
    'See `README.md` and `SETUP.md`; `guides/setup.html` is the human-facing walkthrough,',
    'and `guides/update.html` covers upgrading an existing deployment.',
    '',
    'Licensed under the Apache License 2.0. / ライセンスは Apache License 2.0 です。',
    '',
  ].join(NL);
}

// --------------------------------------------------------------------- 実行部

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
  if (outIndex >= 0 && !outPath) {
    console.error('✗ --out の後ろに書き出し先のパスを付けてください');
    process.exit(1);
  }
  // --out の値（次の引数）はバージョンと取り違えないよう外す
  const positional = args.filter((a, i) => !a.startsWith('--') && !(outIndex >= 0 && i === outIndex + 1));

  let version;
  try {
    version = normalizeVersion(positional[0] ?? packageVersion());
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }

  const entries = loadChangelog();
  const problems = checkVersion(entries, version, packageVersion());
  if (problems.length) {
    console.error('✗ リリースの前提が揃っていません（Releaseは作りません）');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('  直し方は docs/MAINTAINING.md の「リリース手順」を見てください');
    process.exit(1);
  }

  const notes = renderReleaseNotes(entries, version);
  if (outPath) {
    writeFileSync(outPath, notes);
    console.log(`リリースノートを書き出しました: ${outPath}（v${version}）`);
  } else {
    process.stdout.write(notes);
  }
}
