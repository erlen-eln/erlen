// OSS公開（Apache-2.0）のライセンス表記ゲート。
//
// 同梱物を配る以上、表記の欠落はそのままライセンス違反になる。人の目視では必ず抜けるので、
// 「全文がそこにあるか」「帰属が書いてあるか」を機械で見張る。
//
// ・Apache-2.0 §4 … 再配布時に (a) ライセンス全文の複製 (b) 元のNOTICEの内容の再掲 が必須。
//   → public/ketcher/LICENSE と public/ketcher/NOTICE を上流から同梱している
// ・BSD 3-Clause §2 … バイナリ形式での再配布は著作権表示・条件文・免責事項の再掲が必須。
//   → public/rdkit/LICENSE（scripts/copy-rdkit.mjs が .js/.wasm と対でコピーする）
// ・CAS登録番号は American Chemical Society がライセンスを求めるため同梱しない
// ・機器プリセットに実在の製品名（各社の商標）を入れない
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('ルートに Apache-2.0 の全文がある（LICENSE）', () => {
  const text = read('LICENSE');
  assert.match(text, /Apache License\s+Version 2\.0, January 2004/, 'Apache-2.0の全文ではない');
  assert.match(text, /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/);
  // 付録の雛形（Copyright [yyyy] [name of copyright owner]）を埋め忘れていないこと
  assert.ok(!text.includes('[name of copyright owner]'), 'LICENSEの著作権者が雛形のまま');
  assert.match(text, /Copyright 2026 Gakushi Kobayashi/, '著作権者の表記が無い');
});

test('ルートに NOTICE があり、同梱物の帰属が書いてある', () => {
  const notice = read('NOTICE');
  assert.match(notice, /Copyright 2026 Gakushi Kobayashi/, 'Erlen本体の著作権表示が無い');
  assert.match(notice, /Apache License, Version 2\.0/, '本体のライセンス名が無い');
  // 同梱している第三者OSSの帰属（消すとライセンス違反になる）
  assert.match(notice, /Ketcher/, 'Ketcherの帰属が無い');
  assert.match(notice, /EPAM Systems/, 'Ketcherの著作権者が無い');
  assert.match(notice, /RDKit/, 'RDKitの帰属が無い');
  assert.match(notice, /BSD 3-Clause/, 'RDKitのライセンス名が無い');
  // 私的プロジェクトである旨（所属組織とは無関係）の定型文
  assert.match(notice, /not affiliated with any organization/, '私的プロジェクトの定型文（英）が無い');
  assert.match(notice, /所属組織とは無関係です/, '私的プロジェクトの定型文（日）が無い');
});

test('READMEにライセンス節と免責・私的プロジェクトの定型文がある', () => {
  const readme = read('README.md');
  assert.match(readme, /Apache License 2\.0|Apache-2\.0/, 'READMEにライセンス名が無い');
  assert.match(readme, /所属組織とは無関係です/, 'READMEに私的プロジェクトの定型文（日）が無い');
  assert.match(readme, /not affiliated with any organization/, 'READMEに私的プロジェクトの定型文（英）が無い');
  assert.match(readme, /Gakushi Kobayashi/, 'READMEに責任者の表記が無い');
  // 旧EULAへの参照が残っていないこと（Apache-2.0と真正面から矛盾する）
  assert.ok(!/EULA/.test(readme), 'READMEにEULAへの参照が残っている');
});

test('EULA.md が残っていない（再配布禁止条項はApache-2.0と両立しない）', () => {
  assert.ok(!existsSync(path.join(ROOT, 'EULA.md')), 'EULA.md が残っている');
});

test('Ketcher（Apache-2.0）のLICENSEとNOTICEを同梱している', () => {
  const license = read('public/ketcher/LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/, 'Apache-2.0の全文ではない');
  const notice = read('public/ketcher/NOTICE');
  assert.match(notice, /Ketcher/);
  assert.match(notice, /Copyright \(C\) 2018 EPAM Systems/, '上流NOTICEの著作権表示が無い');
});

test('RDKit.js（BSD 3-Clause）のLICENSEを同梱している', () => {
  const license = read('public/rdkit/LICENSE');
  assert.match(license, /BSD 3-Clause License/);
  assert.match(license, /Greg Landrum/, 'BSDの著作権表示が無い');
  assert.match(license, /THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS/, '免責事項が無い');
  // .js / .wasm と対で置く仕掛けがスクリプト側に入っていること
  const script = read('scripts/copy-rdkit.mjs');
  assert.match(script, /'LICENSE'/, 'copy-rdkit.mjs がLICENSEをコピーしていない');
});

test('機器プリセットに実在の製品名（各社の商標）が入っていない', () => {
  const preset = JSON.parse(read('public/presets/equipments.json'));
  // OSS公開時に総称へ置き換えた5件。再発したらここで止める
  const BRANDS = ['BUCHI', 'Rotavapor', 'Waters', 'ACQUITY', 'Alliance',
    'Shimadzu', 'IRSpirit', 'JASCO', 'V-730', 'HORIBA', 'LAQUA'];
  const hits = [];
  for (const item of preset.items) {
    const blob = `${item.manufacturer ?? ''} ${item.model_number ?? ''} ${item.name ?? ''} ${item.notes ?? ''}`;
    for (const brand of BRANDS) {
      if (blob.includes(brand)) hits.push(`${item.management_number}: ${brand}`);
    }
  }
  assert.deepEqual(hits, [], `実在の製品名が残っている:\n${hits.join('\n')}`);
});
