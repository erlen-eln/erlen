// wrangler.jsoncのsecret一覧コメントの完全性ガード。
// コードが参照するsecretが一覧から漏れると、購入者が再構築したときにその機能が黙って死ぬ。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wranglerSrc = readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');

// src/が env.<NAME> で参照するsecret（wrangler secret put で入れるもの）の台帳。
// 新しいsecretを増やしたら、ここと wrangler.jsonc のコメントの両方に足す
const CODE_REFERENCED_SECRETS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'SESSION_SECRET',
];

// wrangler.jsoncのvarsで宣言する（secretではない）設定。secret台帳と混同しないための対照表
const DECLARED_VARS = ['BASE_URL', 'OWNER_EMAIL', 'MAX_ATTACHMENT_MB', 'DEMO_MODE'];

function srcEnvNames() {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.mjs')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) {
          names.add(m[1]);
        }
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return names;
}

test('wrangler.jsonc: コード参照のあるsecretは全て記載されている', () => {
  const missing = CODE_REFERENCED_SECRETS.filter((name) => !wranglerSrc.includes(name));
  assert.deepEqual(missing, [], `wrangler.jsoncに記載の無いsecret: ${missing.join(', ')}`);
});

test('コードが読むenv.<NAME>は、secret台帳かvarsかバインディングのどれかに載っている', () => {
  const bindings = ['DB', 'ASSETS', 'ATTACHMENTS'];
  const known = new Set([...CODE_REFERENCED_SECRETS, ...DECLARED_VARS, ...bindings]);
  const unknown = [...srcEnvNames()].filter((n) => !known.has(n));
  assert.deepEqual(unknown, [],
    `台帳に無いenv参照: ${unknown.join(', ')}（wrangler.jsoncとこのテストの両方に足すこと）`);
});

test('宣言したvars・バインディングはwrangler.jsoncに実在する', () => {
  for (const name of DECLARED_VARS) {
    assert.ok(wranglerSrc.includes(`"${name}"`), `varsに ${name} がありません`);
  }
  for (const binding of ['"DB"', '"ASSETS"', '"ATTACHMENTS"']) {
    assert.ok(wranglerSrc.includes(binding), `バインディング ${binding} がありません`);
  }
});

test('wrangler.jsonc: secret値そのものは書かれていない（名前だけの一覧）', () => {
  const at = wranglerSrc.indexOf('// secrets');
  assert.ok(at >= 0, 'secretsコメント節が見つからない');
  const tail = wranglerSrc.slice(at);
  assert.ok(!/(?:KEY|TOKEN|SECRET|ID)\s*[=:]\s*["'][A-Za-z0-9+/_-]{16,}/.test(tail),
    'secretsコメント節に値らしき文字列が混入している');
});

test('配布物に個人固有の値が焼き込まれていない', () => {
  // 購入者に配るzipなので、開発者本人のメール・ドメイン・実IDが混ざってはいけない
  const files = [
    path.join(ROOT, 'wrangler.jsonc'),
    path.join(ROOT, 'package.json'),
    path.join(ROOT, 'scripts/doctor.mjs'),
  ];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/[A-Za-z0-9._%+-]+@(?:gmail|outlook|yahoo)\.[a-z.]+/i.test(src),
      `${path.basename(file)}: 実在しそうな個人メールが書かれている`);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(src),
      `${path.basename(file)}: 実IDらしきUUIDが書かれている`);
  }
});
