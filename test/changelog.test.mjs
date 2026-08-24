// 変更履歴の単一ソース検査。
// CHANGELOG.json が正本で、guides/update.html はそこから機械生成する。
// 「版を上げたのに履歴を書き忘れた」「update.html だけ手で直して食い違った」を出荷前に止める。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/api/health.mjs';
import {
  CHANGELOG_PATH, UPDATE_HTML_PATH, RELEASED_VERSION, loadChangelog, releasedOnly, renderUpdateHtml,
} from '../scripts/render-changelog.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = loadChangelog();
// 版番号を持つ＝すでに配った版。作業中の分は先頭に "unreleased" として1つだけ置ける
const released = releasedOnly(entries);

test('CHANGELOG.jsonは配列で、各要素が version / date / ja / en を持つ', () => {
  assert.ok(Array.isArray(entries), 'CHANGELOG.jsonは配列であること');
  assert.ok(released.length >= 4, `版が少なすぎる: ${released.length}件`);
  for (const entry of entries) {
    assert.match(entry.version, /^(?:\d+\.\d+\.\d+|unreleased)$/, `版の形式が不正: ${entry.version}`);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `${entry.version}: dateはYYYY-MM-DD`);
    assert.ok(Array.isArray(entry.ja) && entry.ja.length > 0, `${entry.version}: jaが空`);
    assert.ok(Array.isArray(entry.en) && entry.en.length > 0, `${entry.version}: enが空`);
    for (const line of [...entry.ja, ...entry.en]) {
      assert.ok(typeof line === 'string' && line.trim() !== '',
        `${entry.version}: 空の行がある`);
    }
  }
});

test('ja と en の件数は版ごとに一致する（訳し漏れを止める）', () => {
  const mismatches = entries
    .filter((e) => e.ja.length !== e.en.length)
    .map((e) => `${e.version}: ja=${e.ja.length} en=${e.en.length}`);
  assert.deepEqual(mismatches, [], `ja/enの件数が食い違う版:\n${mismatches.join('\n')}`);
});

test('en側に日本語（かな・漢字）が混ざっていない', () => {
  const jp = /[぀-ヿ一-鿿]/;
  const offenders = [];
  for (const entry of entries) {
    for (const line of entry.en) {
      if (jp.test(line)) offenders.push(`${entry.version}: ${line.slice(0, 40)}`);
    }
  }
  assert.deepEqual(offenders, [], `en側に日本語が混ざっている:\n${offenders.join('\n')}`);
});

test('先頭が最新版（版は降順に並んでいる）', () => {
  const num = (v) => v.split('.').map(Number);
  for (let i = 1; i < released.length; i++) {
    const [aMa, aMi, aPa] = num(released[i - 1].version);
    const [bMa, bMi, bPa] = num(released[i].version);
    const newer = aMa !== bMa ? aMa > bMa : aMi !== bMi ? aMi > bMi : aPa > bPa;
    assert.ok(newer, `並びが降順でない: ${released[i - 1].version} の次に ${released[i].version}`);
  }
});

test('作業中エントリ（unreleased）は先頭に1つだけ', () => {
  // 途中に挟まると「どの版に入ったのか」が読めなくなる
  const unreleased = entries.filter((e) => !RELEASED_VERSION.test(e.version));
  assert.ok(unreleased.length <= 1, `unreleasedが複数ある: ${unreleased.length}件`);
  if (unreleased.length === 1) {
    assert.equal(entries[0].version, 'unreleased', 'unreleasedは配列の先頭に置く');
  }
});

test('最新のリリース版 = package.json の version = health の VERSION', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(released[0].version, pkg.version, 'CHANGELOG.jsonの最新版がpackage.jsonと違う');
  assert.equal(released[0].version, VERSION, 'CHANGELOG.jsonの最新版がhealth.mjsのVERSIONと違う');
});

test('guides/update.html は CHANGELOG.json から生成した内容と一致する', () => {
  const current = readFileSync(UPDATE_HTML_PATH, 'utf8');
  const expected = renderUpdateHtml(current, entries);
  assert.equal(current, expected,
    'guides/update.html が古い。node scripts/render-changelog.mjs を実行すること');
});

test('update.html の data-latest-version と最新版の見出しが載っている', () => {
  const html = readFileSync(UPDATE_HTML_PATH, 'utf8');
  assert.ok(html.includes(`data-latest-version="${released[0].version}"`),
    'data-latest-version が最新版になっていない');
  assert.ok(html.includes(`<strong>v${released[0].version}</strong>`),
    '最新版の見出しが履歴に無い');
  // 未リリース分は配布物へ出さない（利用者の手元にはまだ入っていない）
  assert.ok(!html.includes('unreleased'), 'update.html に未リリースのエントリが出ている');
  // 販売サイト側の履歴ページへの案内（リンクにはしない＝オフラインで開く配布物なので）
  assert.ok(html.includes('erlen.jp/changelog'), '/changelog への案内が消えている');
});

test('CHANGELOG.json は BOM無しUTF-8（Windowsのエディタ経由で壊さない）', () => {
  const buf = readFileSync(CHANGELOG_PATH);
  assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), 'BOMが付いている');
});
