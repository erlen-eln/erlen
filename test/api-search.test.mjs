// 全文検索。日本語のFTS5（trigram）と、3文字未満のLIKEフォールバックの両方を実機のSQLiteで確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, sqlMissingTenantScope } from './d1-adapter.mjs';
import { createNotebook } from '../src/api/notebooks.mjs';
import { createPage, patchPage, deletePage } from '../src/api/pages.mjs';
import {
  searchPages, ftsPhrase, likePattern, makeSnippet, queryLength, MIN_FTS_LENGTH, SEARCH_LIMIT,
} from '../src/api/search.mjs';

// ノート1冊＋ページ数枚を仕込む
async function setup() {
  const t = createTestEnv();
  const nb = (await createNotebook(t.env, t.ctx, { title: '有機合成2026' })).data.notebook;
  const make = async (title, content) => {
    const page = (await createPage(t.env, t.ctx, nb.id, { title })).data.page;
    if (content) await patchPage(t.env, t.ctx, page.id, { content });
    return page;
  };
  const p1 = await make('アルドール縮合', '水素化ナトリウムでメチル化した。THF中、0度で3時間。収率72%。');
  const p2 = await make('鈴木カップリング', 'Pd(PPh3)4を触媒に、炭酸カリウム水溶液で還流。');
  const p3 = await make('メチル化の再現実験', 'ヨウ化メチルを2.0当量。');
  return { ...t, notebookId: nb.id, nbTitle: '有機合成2026', p1, p2, p3 };
}

test('検索語の長さはコードポイントで数える（日本語1文字を1と数える）', () => {
  assert.equal(queryLength('メチル'), 3);
  assert.equal(queryLength('ab'), 2);
  assert.equal(queryLength(''), 0);
  assert.equal(MIN_FTS_LENGTH, 3);
});

test('FTSのクエリは演算子として解釈されないフレーズに包む', () => {
  assert.equal(ftsPhrase('メチル化'), '"メチル化"');
  // AND / OR / * が演算子にならないこと、" が閉じられないことを確かめる
  assert.equal(ftsPhrase('a OR b'), '"a OR b"');
  assert.equal(ftsPhrase('a" OR "b'), '"a"" OR ""b"');
});

test('LIKEのパターンはワイルドカードを打ち消す', () => {
  assert.equal(likePattern('ab'), '%ab%');
  assert.equal(likePattern('100%'), '%100\\%%');
  assert.equal(likePattern('a_b'), '%a\\_b%');
  assert.equal(likePattern('a\\b'), '%a\\\\b%');
});

test('抜粋は一致位置の周りを切り出す', () => {
  assert.equal(makeSnippet('短い本文', 'x'), '短い本文');
  assert.equal(makeSnippet('  改行\nと 空白は\t畳む ', 'x'), '改行 と 空白は 畳む');
  assert.equal(makeSnippet('', 'x'), '');
  const long = `${'あ'.repeat(200)}目印${'い'.repeat(200)}`;
  const snippet = makeSnippet(long, '目印', 40);
  assert.ok(snippet.includes('目印'), '一致した語が抜粋に入っている');
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'));
  assert.equal([...snippet].length, 42, '前後の…を除いて指定の長さ');
  // 一致しない語でも先頭から出す（検索結果が空欄にならないように）
  assert.ok(makeSnippet(long, 'ない語', 40).startsWith('あ'));
});

test('日本語でFTSヒットする（本文・タイトルの両方）', async () => {
  const { env, ctx, p1, p3 } = await setup();
  const res = await searchPages(env, ctx, { q: 'メチル化' });
  assert.equal(res.status, 200);
  assert.equal(res.data.mode, 'fts');
  const ids = res.data.results.map((r) => r.pageId).sort();
  assert.deepEqual(ids, [p1.id, p3.id].sort(), '本文ヒットとタイトルヒットの両方が出る');

  const one = res.data.results.find((r) => r.pageId === p1.id);
  assert.equal(one.pageTitle, 'アルドール縮合');
  assert.equal(one.notebookTitle, '有機合成2026');
  assert.equal(one.notebookId, p1.notebook_id);
  assert.ok(one.snippet.includes('メチル化'));
  assert.ok(one.updatedAt);

  // 英字3文字もtrigramで引ける
  assert.equal((await searchPages(env, ctx, { q: 'THF' })).data.results.length, 1);
  // 該当なしは空配列（エラーにしない）
  assert.deepEqual((await searchPages(env, ctx, { q: '存在しない語句' })).data.results, []);
});

test('2文字以下はLIKEへフォールバックする', async () => {
  const { env, ctx, p1 } = await setup();
  const res = await searchPages(env, ctx, { q: '0度' });
  assert.equal(res.data.mode, 'like');
  assert.deepEqual(res.data.results.map((r) => r.pageId), [p1.id]);

  // trigramでは引けない2文字が、LIKEなら引ける（フォールバックが効いていることの証明）
  const two = await searchPages(env, ctx, { q: '還流' });
  assert.equal(two.data.mode, 'like');
  assert.equal(two.data.results.length, 1);
});

test('検索語が空なら400', async () => {
  const { env, ctx } = await setup();
  assert.equal((await searchPages(env, ctx, { q: '' })).status, 400);
  assert.equal((await searchPages(env, ctx, { q: '   ' })).status, 400);
  assert.equal((await searchPages(env, ctx, {})).data.error, 'query_required');
});

test('テナント分離: よそのノートは1件も出ない（FTSでもLIKEでも）', async () => {
  const { env, ctx, otherCtx } = await setup();
  // よそのテナントにも同じ語を含むページを作る
  const otherNb = (await createNotebook(env, otherCtx, { title: 'よその研究室' })).data.notebook;
  const otherPage = (await createPage(env, otherCtx, otherNb.id, { title: 'メチル化の秘密' })).data.page;
  await patchPage(env, otherCtx, otherPage.id, { content: '還流した。' });

  const mine = await searchPages(env, ctx, { q: 'メチル化' });
  assert.ok(!mine.data.results.some((r) => r.pageId === otherPage.id));
  const mineLike = await searchPages(env, ctx, { q: '還流' });
  assert.ok(!mineLike.data.results.some((r) => r.pageId === otherPage.id));
  // よそからは自分のが出ないこと（逆向きも）
  assert.deepEqual(
    (await searchPages(env, otherCtx, { q: 'メチル化' })).data.results.map((r) => r.pageTitle),
    ['メチル化の秘密']
  );
});

test('削除したページは検索に出ない', async () => {
  const { env, ctx, p1, p3 } = await setup();
  await deletePage(env, ctx, p1.id);
  const res = await searchPages(env, ctx, { q: 'メチル化' });
  assert.deepEqual(res.data.results.map((r) => r.pageId), [p3.id]);
});

test('本文を書き換えたら検索結果も追随する（FTSトリガの結線確認）', async () => {
  const { env, ctx, p2 } = await setup();
  assert.equal((await searchPages(env, ctx, { q: '炭酸カリウム' })).data.results.length, 1);
  await patchPage(env, ctx, p2.id, { content: 'リン酸カリウムに変更した。' });
  assert.equal((await searchPages(env, ctx, { q: '炭酸カリウム' })).data.results.length, 0);
  assert.equal((await searchPages(env, ctx, { q: 'リン酸カリウム' })).data.results.length, 1);
});

test('結果は上位50件まで', async () => {
  const t = createTestEnv();
  const nb = (await createNotebook(t.env, t.ctx, { title: '大量' })).data.notebook;
  for (let i = 0; i < 55; i++) {
    await createPage(t.env, t.ctx, nb.id, { title: `再結晶テスト${i}` });
  }
  const res = await searchPages(t.env, t.ctx, { q: '再結晶' });
  assert.equal(res.data.results.length, SEARCH_LIMIT);
});

test('発行された全SQLに tenant_id 条件が入っている', async () => {
  const { env, ctx, DB } = await setup();
  await searchPages(env, ctx, { q: 'メチル化' });
  await searchPages(env, ctx, { q: '還流' });
  assert.deepEqual(sqlMissingTenantScope(DB.__sql), []);
});
