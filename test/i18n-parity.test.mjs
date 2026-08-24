// web/src/i18n.ts の ja/en 辞書パリティ検査。
//
// i18n.ts は TypeScript（`as const` を使う）で、この製品のnpm依存は wrangler だけに絞ってある
// （ts-node等は入れない）。Node自体のTS型ストリッピングは Node のバージョンによって挙動が違う
// （下限の engines: ">=22.5.0" では素の `.ts` importが通らない環境がある）ため、ここでは
// ビルドや型ストリッピングに頼らず、ソースをテキストとして読んで正規表現でキーを抜き出す
// 「スクリプト検査」方式にする。誰の環境でも同じ結果になることを優先している。
//
// en側は i18n.ts 側で `Record<MessageKey, string>` として型付けてあるので、
// npm run typecheck:web を通せばキーの過不足はコンパイル時にも検出される。
// このテストはそれをビルドなしでも機械検査できるようにする、二重の安全網。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const I18N_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/src/i18n.ts');
const source = readFileSync(I18N_PATH, 'utf8');

// `const ja = { ... } as const;` と `const en: Record<...> = { ... };` の中身だけを切り出す。
// どちらも「次の `};` または `} as const;`」までを1ブロックとして扱う。
function extractBlock(varName) {
  const startRe = new RegExp(`const ${varName}\\b[^=]*=\\s*\\{`);
  const startMatch = startRe.exec(source);
  assert.ok(startMatch, `i18n.ts に "const ${varName} = {" が見つからない`);
  const bodyStart = startMatch.index + startMatch[0].length;
  const closeRe = /\n\}(?:\s*as const)?;/;
  closeRe.lastIndex = bodyStart;
  const closeMatch = source.slice(bodyStart).match(closeRe);
  assert.ok(closeMatch, `${varName} ブロックの閉じ "};" が見つからない`);
  return source.slice(bodyStart, bodyStart + closeMatch.index);
}

// 各行 `  'key.name': '値...',` からキーと値（先頭の1組のクォート内。値自体にシングルクォートの
// エスケープが入っていても最初のクォート対だけを見れば十分＝'key': の直後から行末カンマの前まで拾う）
function extractEntries(block) {
  const entries = new Map();
  const lineRe = /^\s*'([a-zA-Z0-9_.]+)':\s*(.+?),?\s*$/gm;
  let m;
  while ((m = lineRe.exec(block))) {
    entries.set(m[1], m[2]);
  }
  return entries;
}

const jaBlock = extractBlock('ja');
const enBlock = extractBlock('en');
const jaEntries = extractEntries(jaBlock);
const enEntries = extractEntries(enBlock);

test('ja辞書からキーが1件以上読み取れている（正規表現の抽出漏れの自己検査）', () => {
  // 現状284キー（2026-08-18時点）。将来増減しても大きく崩れていないことだけ見る（キー数の下限）
  assert.ok(jaEntries.size > 250, `抽出できたjaキー数が少なすぎる: ${jaEntries.size}`);
});

test('en辞書のキー集合はja辞書と完全一致する', () => {
  const jaKeys = new Set(jaEntries.keys());
  const enKeys = new Set(enEntries.keys());

  const missingInEn = [...jaKeys].filter((k) => !enKeys.has(k));
  const extraInEn = [...enKeys].filter((k) => !jaKeys.has(k));

  assert.deepEqual(missingInEn, [], `enに無いキー: ${missingInEn.join(', ')}`);
  assert.deepEqual(extraInEn, [], `jaに無いのにenにあるキー: ${extraInEn.join(', ')}`);
  assert.equal(enEntries.size, jaEntries.size);
});

test('{{placeholder}}はja/enで同じ名前の組が使われている', () => {
  const placeholderNames = (value) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

  const mismatches = [];
  for (const [key, jaValue] of jaEntries) {
    const enValue = enEntries.get(key);
    if (enValue === undefined) continue; // 前のテストで既に検出済み
    const jaNames = placeholderNames(jaValue);
    const enNames = placeholderNames(enValue);
    if (JSON.stringify(jaNames) !== JSON.stringify(enNames)) {
      mismatches.push(`${key}: ja=[${jaNames}] en=[${enNames}]`);
    }
  }
  assert.deepEqual(mismatches, [], `プレースホルダが食い違うキー:\n${mismatches.join('\n')}`);
});

test('en辞書の値は空文字であるべきsave.idle以外すべて非空', () => {
  const emptyKeys = [...enEntries.entries()]
    .filter(([key, value]) => key !== 'save.idle' && value.replace(/^'|'$/g, '') === '')
    .map(([key]) => key);
  assert.deepEqual(emptyKeys, []);
});
