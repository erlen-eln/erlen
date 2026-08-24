// Windows環境の配線ガード（過去の実障害から持ち込んだ型）。再発すると購入者が構築で詰まる。
// ①npm testのglobはダブルクォート（シングルクォートはcmdで展開されず0件実行の偽緑になる）
// ②CLIスクリプトはspawnSync('npm')禁止（npmの実体はnpm.cmdのためENOENT）。
//   wrangler呼び出しはlib-wrangler.mjsのrunWrangler＝JS本体をnodeで直接起動する
// ③doctorの未置換値検査はコメント除去後に行う（コメント内の例文を誤検出するため）
// ④UTF-8 BOM（Windowsのエディタ保存）でwrangler.jsoncのJSON.parseが壊れないこと
// ⑤ROOT導出はfileURLToPath（URL.pathnameはWindowsで/C:/...形の壊れたパスになる）
// ⑥ソースの改行はLF（.gitattributesで固定。CRLFが混ざるとdiffが壊れる）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgRaw = readFileSync(path.join(ROOT, 'package.json'), 'utf8');
const doctorSrc = readFileSync(path.join(ROOT, 'scripts/doctor.mjs'), 'utf8');
const BOM = String.fromCharCode(0xFEFF);

test('npm testのglobがシングルクォートでない（cmdで展開されず0件緑になる）', () => {
  assert.ok(!pkgRaw.includes("'test/**"), 'package.jsonのtestスクリプトはダブルクォートのglobにする');
  assert.ok(pkgRaw.includes('\\"test/**/*.test.mjs\\"'));
});

test('CLIスクリプトにspawnSync(npm)が無い（WindowsでENOENT）', () => {
  for (const f of readdirSync(path.join(ROOT, 'scripts'))) {
    if (!f.endsWith('.mjs')) continue;
    const src = readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
    assert.ok(!src.includes("spawnSync('npm'"), `${f}: npm経由でなくlib-wranglerのrunWranglerを使う`);
  }
});

test('runWranglerはwranglerのJS本体をnodeで直接起動する（ソース検査）', () => {
  const src = readFileSync(path.join(ROOT, 'scripts/lib-wrangler.mjs'), 'utf8');
  assert.match(src, /process\.execPath/);
  assert.match(src, /'wrangler', 'bin', 'wrangler\.js'/);
  assert.ok(!src.includes('shell:'), 'shell経由はcmd.exeのクオートで引数が壊れるため禁止');
});

test('doctorの未置換値検査がコメント除去後のテキストに対して行われる（ソース検査）', () => {
  assert.match(doctorSrc, /stripJsoncComments\(readFileSync\(path\.join\(ROOT, 'wrangler\.jsonc'\)/);
  assert.match(doctorSrc, /\\uFEFF/, 'doctor実装側にBOM除去があること');
});

test('doctorのコメント除去: コメント内の例文とBOMは消え、値の未置換は残る', () => {
  const strip = (text) => text.replace(/^\uFEFF/, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  const sample = [
    `${BOM}{`,
    '  // ★ 例: "https://erlen.your-domain.example"',
    '  "BASE_URL": "https://erlen.your-domain.example",',
    '  "OWNER_EMAIL": "you@example.com" // https:// はコメントではない',
    '}',
  ].join('\n');
  const stripped = strip(sample);
  assert.equal((stripped.match(/your-domain\.example/g) ?? []).length, 1,
    'コメント内の例文だけが消え、値側の1件は検出されること');
  assert.ok(stripped.includes('you@example.com'));
  assert.ok(stripped.startsWith('{'), 'BOMが剥がれていること');
});

test('wrangler.jsoncはBOM付き・コメント付きでも読める（doctorと同じ手順）', () => {
  const raw = readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
  const strip = (text) => text.replace(/^\uFEFF/, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  const parse = (text) => JSON.parse(strip(text).replace(/,(\s*[}\]])/g, '$1'));
  const config = parse(`${BOM}${raw}`);
  assert.equal(config.name, 'erlen');
  assert.equal(config.main, 'src/worker.mjs');
  assert.equal(config.assets.binding, 'ASSETS');
  assert.deepEqual(config.assets.run_worker_first, ['/api/*', '/auth/*']);
  assert.equal(config.d1_databases[0].binding, 'DB');
});

test('scriptsのROOT導出がfileURLToPathである（URL.pathnameはWindowsで壊れる）', () => {
  for (const f of readdirSync(path.join(ROOT, 'scripts'))) {
    if (!f.endsWith('.mjs')) continue;
    const src = readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
    assert.ok(!src.includes('.pathname'), `${f}: new URL(...).pathnameはWindowsで/C:/...形になる`);
    assert.match(src, /fileURLToPath\(import\.meta\.url\)/);
  }
});

test('配布ファイルの改行はLF・BOMなし', () => {
  const targets = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.wrangler') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(mjs|json|jsonc|sql|html|md)$/.test(entry.name)) targets.push(p);
    }
  };
  walk(ROOT);
  assert.ok(targets.length > 10);
  for (const file of targets) {
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes('\r\n'), `${path.relative(ROOT, file)}: CRLFが混ざっている`);
    assert.ok(!raw.startsWith(BOM), `${path.relative(ROOT, file)}: BOMが付いている`);
  }
});

test('.gitattributesで改行をLFに固定している', () => {
  assert.match(readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'), /\*\s+text=auto\s+eol=lf/);
});
