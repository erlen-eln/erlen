// 静的アセットのサイズガード。
// Cloudflare Workers Assets は「1ファイル25MiBまで」。これを超えたファイルが public/ に入ると
// デプロイがまるごと失敗する（購入者は原因が分からないまま詰まる）。
// 同梱しているKetcher（構造式エディタ）の main.js は22MB台で上限に近いので、
// 版を上げたときに黙って超えることがある。出荷前にここで止める。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// Cloudflare Workers Assets の1ファイル上限（25MiB）
export const MAX_ASSET_BYTES = 26_214_400;

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

test('public/ の全ファイルが25MiB未満（Workers Assetsの1ファイル上限）', () => {
  const files = listFiles(PUBLIC_DIR);
  assert.ok(files.length > 0, 'public/ が空（アセットの配置場所が変わっていないか確認する）');
  const tooBig = files
    .map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), size: statSync(f).size }))
    .filter((x) => x.size >= MAX_ASSET_BYTES)
    .map((x) => `${x.file} (${x.size} bytes)`);
  assert.deepEqual(tooBig, [], `25MiB以上のアセット:\n${tooBig.join('\n')}`);
});

test('Ketcherは編集画面が読む2本が実在する（版上げでファイル名が変わると白紙になる）', () => {
  const editorHtml = path.join(PUBLIC_DIR, 'ketcher/editor.html');
  const html = readFileSync(editorHtml, 'utf8');
  // editor.html が名指ししている js / css が本当に置いてあることを確かめる
  const refs = [...html.matchAll(/\.\/(static\/(?:js|css)\/[A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2, 'editor.htmlがKetcherのjs/cssを読んでいない');
  for (const ref of refs) {
    assert.ok(existsSync(path.join(PUBLIC_DIR, 'ketcher', ref)), `public/ketcher/${ref} が無い`);
  }
});

test('RDKit（SMILESから構造式を描くWASM）が同梱されている', () => {
  // CDNは使わない。この2本が欠けると、SMILESしか無い行（PubChem補完・溶媒プリセット）の
  // 構造式が出なくなる。復旧は `npm run prepare:rdkit`
  for (const name of ['RDKit_minimal.js', 'RDKit_minimal.wasm']) {
    const file = path.join(PUBLIC_DIR, 'rdkit', name);
    assert.ok(existsSync(file), `public/rdkit/${name} が無い（npm run prepare:rdkit で入れる）`);
    assert.ok(statSync(file).size > 1024, `public/rdkit/${name} が空に近い`);
  }
});

test('画面が読むRDKitのURLは同梱物と一致する（版上げでのファイル名ずれを止める）', () => {
  const src = readFileSync(path.join(ROOT, 'web/src/components/rdkit.ts'), 'utf8');
  for (const url of ['/rdkit/RDKit_minimal.js', '/rdkit/RDKit_minimal.wasm']) {
    assert.ok(src.includes(`'${url}'`), `web/src/components/rdkit.ts が ${url} を指していない`);
    assert.ok(existsSync(path.join(PUBLIC_DIR, url.slice(1))), `${url} の実体が public/ に無い`);
  }
  // 外部ホストへ逃がしていないこと（研究室のネットワークは外へ出られないことがある）
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(src), 'rdkit.ts が外部URLを読んでいる');
});

test('Ketcherは選抜同梱（duo/popupエントリを持ち込んでいない）', () => {
  // 3エントリ全部を入れると68MBになる。mainエントリ以外は使わないので入れない
  const names = listFiles(path.join(PUBLIC_DIR, 'ketcher')).map((f) => path.basename(f));
  for (const banned of ['duo', 'popup']) {
    assert.ok(!names.some((n) => n.startsWith(`${banned}.`)),
      `${banned}エントリが混ざっている（mainだけを選抜すること）`);
  }
});
