// 印刷用レポート。中身の網羅より「利用者の打った文字が生のHTMLとして出ないこと」を重く見る。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, sqlMissingTenantScope } from './d1-adapter.mjs';
import { createNotebook } from '../src/api/notebooks.mjs';
import { createPage, patchPage } from '../src/api/pages.mjs';
import { saveMolecules } from '../src/api/molecules.mjs';
import { createAttachment } from '../src/api/attachments.mjs';
import { buildPageReport, escapeHtml, safeSvg, yieldPercent } from '../src/api/report.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><text x="4" y="20">Ph</text></svg>';

async function setup() {
  const t = createTestEnv();
  const nb = (await createNotebook(t.env, t.ctx, { title: '有機合成2026' })).data.notebook;
  const page = (await createPage(t.env, t.ctx, nb.id, {
    title: 'アルドール縮合', experiment_date: '2026-07-20',
  })).data.page;
  await patchPage(t.env, t.ctx, page.id, { content: '室温で3時間撹拌した。\n析出物を濾取。' });
  await saveMolecules(t.env, t.ctx, page.id, {
    molecules: [
      {
        role: 'reactant', name: 'ベンズアルデヒド', cas_number: '100-52-7',
        molecular_weight: 106.12, mass: 106.12, moles: 1, equivalents: 1,
        is_reference: 1, smiles: 'O=Cc1ccccc1', svg: SVG,
      },
      { role: 'reactant', name: 'アセトン', molecular_weight: 58.08, equivalents: 3 },
      { role: 'product', name: 'カルコン', molecular_weight: 208.26, moles: 0.72 },
    ],
  });
  return { ...t, notebookId: nb.id, pageId: page.id };
}

test('HTMLエスケープ', () => {
  assert.equal(escapeHtml('<b>"a"&\'b\'</b>'), '&lt;b&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/b&gt;');
  assert.equal(escapeHtml(null), '');
});

test('SVGの検問: XML宣言つきでも通す（Ketcherの出力は宣言から始まる）', () => {
  // 実測: ketcher.generateImage は <?xml version="1.0" encoding="UTF-8"?> から始まるSVGを返す。
  // 宣言をそのままHTMLへ埋めると表に文字が出るので、<svg から始まる形へ削って返す
  assert.equal(safeSvg(`<?xml version="1.0" encoding="UTF-8"?>\n${SVG}`), SVG);
  assert.equal(safeSvg(`<!DOCTYPE svg>\n${SVG}`), SVG);
  // 宣言に見せかけて本文を混ぜたものは通さない
  assert.equal(safeSvg(`<b>x</b>${SVG}`), '');
  assert.equal(safeSvg(`<?xml version="1.0"?><script>alert(1)</script>${SVG}`), '');
});

test('SVGの検問: スクリプトを持ち込めるものは丸ごと捨てる', () => {
  assert.equal(safeSvg(SVG), SVG);
  assert.equal(safeSvg('<svg><script>alert(1)</script></svg>'), '');
  assert.equal(safeSvg('<svg onload="alert(1)"></svg>'), '');
  assert.equal(safeSvg('<svg><foreignObject><body></body></foreignObject></svg>'), '');
  assert.equal(safeSvg('<svg><a href="javascript:alert(1)">x</a></svg>'), '');
  assert.equal(safeSvg('<div>svgではない</div>'), '');
  assert.equal(safeSvg(''), '');
});

test('収率は保存値優先・無ければ基準物質のmmolから出す', () => {
  assert.equal(yieldPercent({ yield_percent: 65, moles: 0.5 }, 1), 65);
  assert.equal(yieldPercent({ yield_percent: null, moles: 0.72 }, 1), 72);
  assert.equal(yieldPercent({ yield_percent: null, moles: 0.72 }, null), null);
  assert.equal(yieldPercent({ yield_percent: null, moles: null }, 1), null);
});

test('レポートに見出し・試薬・収率・本文・添付が載る', async () => {
  const { env, ctx, pageId } = await setup();
  await createAttachment(env, ctx, pageId, {
    bytes: new ArrayBuffer(2048), contentType: 'application/pdf', fileName: '1H-NMR.pdf',
  });

  const res = await buildPageReport(env, ctx, pageId, '2026-07-25T09:00:00.000Z');
  assert.equal(res.status, 200);
  assert.equal(res.data.title, 'アルドール縮合');
  const html = res.data.html;

  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<title>アルドール縮合</title>'));
  assert.ok(html.includes('有機合成2026'), 'ノートブック名');
  assert.ok(html.includes('2026-07-20'), '実験日');
  assert.ok(html.includes('2026-07-25T09:00:00.000Z'), '出力日時');
  assert.ok(html.includes('原料 (Reactants)') && html.includes('生成物 (Products)'));
  assert.ok(html.includes('ベンズアルデヒド') && html.includes('アセトン') && html.includes('カルコン'));
  assert.ok(html.includes('100-52-7'), 'CAS番号');
  assert.ok(html.includes('O=Cc1ccccc1'), 'SMILES');
  assert.ok(html.includes(SVG), '構造式SVGがそのまま埋まっている');
  assert.ok(html.includes('72.0'), '収率が基準物質のmmolから出ている');
  assert.ok(html.includes('室温で3時間撹拌した。'), '本文');
  assert.ok(html.includes('1H-NMR.pdf') && html.includes('2.0 KB'), '添付一覧');
  assert.ok(html.includes('page-break-inside: avoid'), '行が改ページで割れない指定');
  assert.ok(html.includes('基準物質: ベンズアルデヒド'));
});

test('利用者の文字列は生のHTMLにならない（XSS）', async () => {
  const { env, ctx, notebookId } = await setup();
  const evil = '<script>alert(1)</script>';
  const page = (await createPage(env, ctx, notebookId, { title: `題${evil}` })).data.page;
  await patchPage(env, ctx, page.id, { content: `本文${evil}` });
  await saveMolecules(env, ctx, page.id, {
    molecules: [{ name: `試薬${evil}`, smiles: evil, svg: '<svg><script>alert(2)</script></svg>' }],
  });
  await createAttachment(env, ctx, page.id, {
    bytes: new ArrayBuffer(4), contentType: 'text/plain', fileName: `${evil}.txt`,
  });

  const html = (await buildPageReport(env, ctx, page.id)).data.html;
  assert.ok(!html.includes('<script>alert(1)</script>'), 'タイトル・本文・試薬名・ファイル名');
  assert.ok(!html.includes('<script>alert(2)</script>'), '仕込まれたSVGは丸ごと捨てられている');
  // SMILESは2か所に出る。構造式の列（画像が無いときの代わり）と、試薬名の下の添え書き
  assert.equal(html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g).length, 6,
    'タイトル2か所（title要素とh1）＋本文＋試薬名＋SMILES2か所＋ファイル名のうちエスケープ済みで出る');
});

test('SVGが無くSMILESがある行は、構造式の列にSMILESを文字で出す', async () => {
  // 構造式の絵はブラウザ側（RDKit.js）で描いている。レポートはWorkerで組むので絵を作れない。
  // PubChem補完やプリセット取込で入った「SMILESはあるが画像が無い」行が空欄にならないことを見る
  const { env, ctx, notebookId } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '画像なし' })).data.page;
  await saveMolecules(env, ctx, page.id, {
    molecules: [{ name: '安息香酸', smiles: 'OC(=O)c1ccccc1', svg: '' }],
  });

  const html = (await buildPageReport(env, ctx, page.id)).data.html;
  assert.match(html, /<td class="structure"><span class="smiles">OC\(=O\)c1ccccc1<\/span><\/td>/,
    '構造式の列にSMILESが入っている');
});

test('SMILESも画像も無い行は構造式の列が「—」のまま', async () => {
  const { env, ctx, notebookId } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '素材なし' })).data.page;
  await saveMolecules(env, ctx, page.id, { molecules: [{ name: '未記入', smiles: '', svg: '' }] });

  const html = (await buildPageReport(env, ctx, page.id)).data.html;
  assert.match(html, /<td class="structure"><span class="empty">—<\/span><\/td>/);
});

test('保存済みのSVGがあるときはSMILESではなく絵を出す（Ketcherで描いた行）', async () => {
  const { env, ctx, notebookId } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '絵つき' })).data.page;
  await saveMolecules(env, ctx, page.id, {
    molecules: [{ name: 'トルエン', smiles: 'Cc1ccccc1', svg: '<svg><circle r="1"/></svg>' }],
  });

  const html = (await buildPageReport(env, ctx, page.id)).data.html;
  assert.ok(html.includes('<td class="structure"><svg><circle r="1"/></svg></td>'), '絵がそのまま出る');
  assert.ok(!html.includes('<span class="smiles">'), 'SMILESの逃げ道は使われない');
});

test('分子も添付も無いページでも組める', async () => {
  const { env, ctx, notebookId } = await setup();
  const page = (await createPage(env, ctx, notebookId, { title: '空のページ' })).data.page;
  const res = await buildPageReport(env, ctx, page.id);
  assert.equal(res.status, 200);
  assert.ok(res.data.html.includes('記載なし'));
  assert.ok(res.data.html.includes('添付はありません'));
  assert.ok(res.data.html.includes('基準物質は指定されていません'));
});

test('無いページ・よそのテナントのページは404', async () => {
  const { env, ctx, otherCtx, pageId } = await setup();
  assert.equal((await buildPageReport(env, ctx, 'NOPE')).status, 404);
  assert.equal((await buildPageReport(env, otherCtx, pageId)).status, 404);
});

test('発行された全SQLに tenant_id 条件が入っている', async () => {
  const { env, ctx, pageId, DB } = await setup();
  await buildPageReport(env, ctx, pageId);
  assert.deepEqual(sqlMissingTenantScope(DB.__sql), []);
});

// ---- 日英切り替え（?lang=en → worker.mjsが渡すlang引数） ----

test('lang未指定・"ja"は今までどおり日本語で組まれる', async () => {
  const { env, ctx, pageId } = await setup();
  const html = (await buildPageReport(env, ctx, pageId, undefined, 'ja')).data.html;
  assert.ok(html.includes('<html lang="ja">'));
  assert.ok(html.includes('原料 (Reactants)') && html.includes('生成物 (Products)'));
  assert.ok(html.includes('印刷する'));
  assert.ok(html.includes('作成中'), '未確定ページは「作成中」');
  assert.ok(!html.includes('確定済み'));
});

test('lang="en"のときは見出し・ラベル・単位が英語で組まれる', async () => {
  const { env, ctx, pageId } = await setup();
  const html = (await buildPageReport(env, ctx, pageId, '2026-07-25T09:00:00.000Z', 'en')).data.html;
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(html.includes('<title>アルドール縮合</title>'), 'タイトル自体は利用者の入力なので訳さない');
  assert.ok(html.includes('Print'));
  assert.ok(html.includes('Erlen / Electronic Lab Notebook'));
  assert.ok(html.includes('Notebook</div>') && html.includes('Experiment date</div>')
    && html.includes('Recorded by</div>') && html.includes('Status</div>')
    && html.includes('Last updated</div>') && html.includes('Generated at</div>'));
  assert.ok(html.includes('Reactants</h2>') && html.includes('Products</h2>'));
  assert.ok(html.includes('Notes</h2>') && html.includes('Attachments</h2>'));
  assert.ok(html.includes('In progress'), '未確定ページのステータス');
  assert.ok(html.includes('Structure') && html.includes('CAS No.') && html.includes('MW<br>g/mol')
    && html.includes('Equiv.') && html.includes('Yield<br>%'));
  assert.ok(html.includes('Reference substance: ベンズアルデヒド'));
  assert.ok(html.includes('mmol taken as the theoretical yield'));
  assert.ok(!html.includes('原料') && !html.includes('生成物') && !html.includes('印刷する'),
    '日本語の見出し・ラベルが残っていない');
});

test('lang="en"で未知の言語コードを渡すと日本語にフォールバックする', async () => {
  const { env, ctx, pageId } = await setup();
  const html = (await buildPageReport(env, ctx, pageId, undefined, 'fr')).data.html;
  assert.ok(html.includes('<html lang="ja">'));
  assert.ok(html.includes('原料 (Reactants)'));
});

test('英語でも添付ファイルサイズ・確定済みバッジ・基準物質なしの文言が出る', async () => {
  const { env, ctx, notebookId } = await setup();
  const p = (await createPage(env, ctx, notebookId, { title: 'No reference EN' })).data.page;
  await saveMolecules(env, ctx, p.id, { molecules: [{ role: 'product', name: 'X', moles: 0.5 }] });
  await createAttachment(env, ctx, p.id, {
    bytes: new ArrayBuffer(2048), contentType: 'application/pdf', fileName: 'spec.pdf',
  });
  await patchPage(env, ctx, p.id, { status: 'closed' });

  const html = (await buildPageReport(env, ctx, p.id, undefined, 'en')).data.html;
  assert.ok(html.includes('No reference substance is set'));
  assert.ok(html.includes('Finalized'));
  assert.ok(html.includes('spec.pdf') && html.includes('2.0 KB'));
});
