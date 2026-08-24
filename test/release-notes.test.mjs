// GitHub Releases の本文づくりと、タグの検算の検査。
//
// このスクリプトは .github/workflows/release.yml から、zipを作る前に呼ばれる。
// ここが甘いと「タグは v1.4.0 なのに中身は 1.3.0」という配布物が世に出る。
// つまりこのテストは、リリース事故を止める門そのもの。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChangelog, releasedOnly } from '../scripts/render-changelog.mjs';
import {
  normalizeVersion, packageVersion, checkVersion, findEntry, renderReleaseNotes,
} from '../scripts/release-notes.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = loadChangelog();
const latest = releasedOnly(entries)[0].version;

test('タグ名は v 付きでも無しでも受ける', () => {
  assert.equal(normalizeVersion('v1.3.0'), '1.3.0');
  assert.equal(normalizeVersion('1.3.0'), '1.3.0');
  assert.equal(normalizeVersion(' v10.20.30 '), '10.20.30');
});

test('版の形になっていないタグは拒否する', () => {
  for (const bad of ['', 'v1.3', 'latest', 'v1.3.0-beta', 'unreleased', undefined, null]) {
    assert.throws(() => normalizeVersion(bad), `拒否されるべきタグが通った: ${bad}`);
  }
});

test('package.json の version を読める', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageVersion(), pkg.version);
});

test('いまのリポジトリは v<最新版> のタグを打てる状態にある', () => {
  // タグ・package.json・CHANGELOG.json の3点が揃っていること。
  // 版を上げたのに片方を直し忘れた、をここで止める
  assert.deepEqual(checkVersion(entries, latest, packageVersion()), []);
});

test('タグと package.json が食い違ったら理由を返す', () => {
  const problems = checkVersion(entries, '9.9.9', packageVersion());
  assert.ok(problems.length >= 2, `検出が甘い: ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => p.includes('package.json')), 'package.jsonとの不一致を挙げていない');
  assert.ok(problems.some((p) => p.includes('CHANGELOG.json')), 'CHANGELOG.jsonとの不一致を挙げていない');
});

test('CHANGELOG.json の先頭が unreleased のままならリリースを止める', () => {
  // 版を上げるのを忘れてタグだけ打った、という一番ありがちな事故
  const fake = [
    { version: 'unreleased', date: '2026-09-01', ja: ['作業中'], en: ['work in progress'] },
    { version: '1.3.0', date: '2026-08-22', ja: ['既出'], en: ['shipped'] },
  ];
  const problems = checkVersion(fake, '1.4.0', '1.4.0');
  assert.ok(problems.length > 0, 'unreleasedのままなのに通してしまった');
  assert.ok(problems.some((p) => p.includes('unreleased')), 'unreleasedである旨を伝えていない');
});

test('未リリース（unreleased）のエントリは本文に採らない', () => {
  const fake = [
    { version: 'unreleased', date: '2026-09-01', ja: ['まだ配っていない'], en: ['not shipped'] },
    { version: '1.3.0', date: '2026-08-22', ja: ['配った'], en: ['shipped'] },
  ];
  assert.throws(() => findEntry(fake, 'unreleased'), 'unreleasedのノートを作れてしまった');
  const notes = renderReleaseNotes(fake, '1.3.0');
  assert.ok(!notes.includes('まだ配っていない'), '未リリース分が本文に混ざっている');
});

test('本文に ja と en の箇条書きが両方載る', () => {
  const entry = findEntry(entries, latest);
  const notes = renderReleaseNotes(entries, latest);
  for (const line of entry.ja) assert.ok(notes.includes(`- ${line}`), `ja が抜けている: ${line}`);
  for (const line of entry.en) assert.ok(notes.includes(`- ${line}`), `en が抜けている: ${line}`);
  assert.ok(notes.includes(`v${latest}`), '版番号が本文に無い');
  assert.ok(notes.includes(entry.date), '日付が本文に無い');
});

test('本文に受け取った人の次の一歩（zip名と依頼文）が載る', () => {
  const notes = renderReleaseNotes(entries, latest);
  assert.ok(notes.includes(`erlen-${latest}.zip`), '添付zipの名前が本文に無い');
  assert.ok(notes.includes('SETUP.md'), '手順書への案内が無い');
  assert.ok(notes.includes('npm ci'), 'node_modules同梱なしの注意が無い');
  assert.ok(/Apache License 2\.0/.test(notes), 'ライセンスの明示が無い');
});

test('本文にメールアドレスや秘密が混ざらない', () => {
  const notes = renderReleaseNotes(entries, latest);
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(notes), 'メールアドレスが入っている');
  assert.ok(!/SESSION_SECRET|CLIENT_SECRET/.test(notes), '秘密の名前が入っている');
});

test('CHANGELOG.json に無い版のノートは作れない', () => {
  assert.throws(() => renderReleaseNotes(entries, '9.9.9'));
});
