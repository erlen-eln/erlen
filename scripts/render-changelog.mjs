#!/usr/bin/env node
// 変更履歴の単一ソース化。CHANGELOG.json から guides/update.html の
// 「変更履歴」節（<section id="history">）を丸ごと組み直して書き戻す。
//
//   node scripts/render-changelog.mjs           … 書き戻す
//   node scripts/render-changelog.mjs --check   … 差分があれば exit 1（テストと同じ判定）
//
// 【設計の意図】
// ・履歴を手書きする場所を1つに減らす。update.html（配布物）と販売サイトの /changelog が
//   食い違うと、購入者が「自分の版に何が入っているか」を信じられなくなる
// ・CHANGELOG.json の「版番号を持つ先頭のエントリ」が最新版。package.json の version と
//   health.mjs の VERSION もそれと一致していること（test/changelog.test.mjs が検査する）。
//   先頭には作業中の `"version": "unreleased"` を1つだけ置いてよく、それは配布物には出さない
// ・update.html は購入者のPCでオフラインで開く。**外部URLをリンクにしない**
//   （test/dist-clean.test.mjs が href="http…" を落とす）。案内は素のテキストで書く
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.json');
export const UPDATE_HTML_PATH = path.join(ROOT, 'guides/update.html');

// 節の開始タグから </section> までを1つの塊として掴む。
// class/aria/data-* の並びが変わっても拾えるよう、id="history" を持つ section だけを見る
const SECTION_RE = /<section\b[^>]*\bid="history"[^>]*>[\s\S]*?<\/section>/;

const NL = '\n';

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function loadChangelog(file = CHANGELOG_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// 版番号（x.y.z）を持つ＝すでに配った版。
// 先頭には `"version": "unreleased"` の作業中エントリを1つだけ置いてよい。
// 配布物の update.html には未リリース分を出さない（利用者の手元にはまだ入っていないため）
export const RELEASED_VERSION = /^\d+\.\d+\.\d+$/;
export const isReleased = (entry) => RELEASED_VERSION.test(entry.version);
export const releasedOnly = (entries) => entries.filter(isReleased);

// CHANGELOG.json → <section id="history"> のHTML。
// 日付は CHANGELOG.json が持つが、update.html の見た目は従来どおり版番号だけにする
// （日付まで並べるのは販売サイトの /changelog 側の仕事）
export function renderHistorySection(allEntries) {
  const entries = releasedOnly(allEntries);
  const latest = entries[0]?.version ?? '';
  const blocks = entries.map((entry) => {
    const items = entry.ja
      .map((line) => `              <li>${escapeHtml(line)}</li>`)
      .join(NL);
    return [
      `            <p><strong>v${escapeHtml(entry.version)}</strong></p>`,
      '            <ul>',
      items,
      '            </ul>',
    ].join(NL);
  }).join(NL + NL);

  // 【罠】先頭行にインデントを付けないこと。差し替えるのは <section から </section> までで、
  // その手前の空白は元のHTMLに残る。付けると実行のたびに字下げが伸びていく（実際にやった）
  return [
    '<section class="step" id="history" aria-labelledby="history-title"'
      + ` data-latest-version="${escapeHtml(latest)}">`,
    '          <div class="step-head">',
    '            <span class="step-no" aria-hidden="true">＋</span>',
    '            <div>',
    '              <span class="step-kicker">変更履歴</span>',
    '              <h2 id="history-title">この版で変わったこと</h2>',
    '            </div>',
    '          </div>',
    '          <div class="step-body">',
    '            <p class="callout">最新の履歴は https://erlen.jp/changelog でも公開しています。</p>',
    blocks,
    '          </div>',
    '        </section>',
  ].join(NL);
}

// 既存のHTMLの #history 節だけを差し替えた全文を返す（他の場所は1文字も触らない）
export function renderUpdateHtml(html, entries) {
  if (!SECTION_RE.test(html)) {
    throw new Error('guides/update.html に <section id="history"> が見つかりません');
  }
  // 置換文字列の $& や $1 が解釈されないよう、関数形式で渡す
  return html.replace(SECTION_RE, () => renderHistorySection(entries));
}

// スクリプトとして直接叩かれたときだけ実行する（テストからは import して関数だけ使う）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = loadChangelog();
  const current = readFileSync(UPDATE_HTML_PATH, 'utf8');
  const next = renderUpdateHtml(current, entries);
  if (process.argv.includes('--check')) {
    if (current === next) {
      console.log('✓ guides/update.html は CHANGELOG.json と一致しています');
    } else {
      console.error('✗ guides/update.html が CHANGELOG.json と食い違っています');
      console.error('  node scripts/render-changelog.mjs を実行して書き戻してください');
      process.exit(1);
    }
  } else if (current === next) {
    console.log('変更はありません（guides/update.html は最新です）');
  } else {
    writeFileSync(UPDATE_HTML_PATH, next);
    console.log(`guides/update.html の変更履歴を更新しました（最新版 v${releasedOnly(entries)[0].version}）`);
  }
}
