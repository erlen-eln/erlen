// PubChem照会（src/api/pubchem.mjs）の検査。
// 外部APIは絶対に本当には叩かない。globalThis.fetch を差し替えて、
//   ・キャッシュに当たったら外に出ないこと（＝呼び出し回数0）
//   ・外れたら正しいURLを叩いて結果をキャッシュすること
//   ・外部が落ちている／該当なしのときは 200 found:false で返し、キャッシュしないこと
// を確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, sqlMissingTenantScope } from './d1-adapter.mjs';
import {
  lookupCompound, extractCasNumber, parseNumber, cacheKey, normalizeQuery, CACHE_TTL_MS,
} from '../src/api/pubchem.mjs';

const NOW = '2026-07-10T00:00:00.000Z';

// URLの一部→返すJSON の対応表でfetchを作る。当たらないURLは404扱い
function mockFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    for (const [needle, body] of Object.entries(routes)) {
      if (!String(url).includes(needle)) continue;
      if (body === 'boom') throw new Error('network down');
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{"Fault":{}}', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

// 安息香酸（CAS 65-85-0）を返す一式
const BENZOIC = {
  'xref/RN/65-85-0/cids': { IdentifierList: { CID: [243] } },
  'compound/cid/243/property': {
    PropertyTable: {
      Properties: [{
        CID: 243,
        MolecularFormula: 'C7H6O2',
        MolecularWeight: '122.12',
        CanonicalSMILES: 'C1=CC=C(C=C1)C(=O)O',
        InChI: 'InChI=1S/C7H6O2/c8-7(9)6-4-2-1-3-5-6/h1-5H,(H,8,9)',
        ExactMass: '122.036779430',
        XLogP: 1.9,
        IUPACName: 'benzoic acid',
      }],
    },
  },
  'compound/cid/243/synonyms': {
    InformationList: { Information: [{ CID: 243, Synonym: ['benzoic acid', '65-85-0', 'E210'] }] },
  },
};

// テストの間だけ fetch を差し替える
async function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('入力の検査: 知らないtypeと空のqは400', async () => {
  const { env, ctx } = createTestEnv();
  assert.equal((await lookupCompound(env, ctx, { type: 'inchi', q: 'x' }, NOW)).status, 400);
  assert.equal((await lookupCompound(env, ctx, { type: '', q: 'x' }, NOW)).status, 400);
  assert.equal((await lookupCompound(env, ctx, { type: 'cas', q: '   ' }, NOW)).status, 400);
  assert.deepEqual(
    (await lookupCompound(env, ctx, { type: 'cas', q: '' }, NOW)).data,
    { error: 'query_required' }
  );
});

test('小道具: CAS抽出・数値変換・キャッシュキー・トリム', () => {
  assert.equal(extractCasNumber(['benzoic acid', '65-85-0']), '65-85-0');
  assert.equal(extractCasNumber(['benzoic acid', '1-2-3']), null, 'CASの桁数に合わないものは拾わない');
  assert.equal(extractCasNumber(undefined), null);
  assert.equal(parseNumber('122.12'), 122.12);
  assert.equal(parseNumber(1.9), 1.9);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('N/A'), null);
  // SMILESは大文字小文字で別の分子。キャッシュキーでも潰さない
  assert.equal(cacheKey('smiles', 'CCO'), 'CCO');
  assert.equal(cacheKey('name', 'Benzoic Acid'), 'benzoic acid');
  assert.equal(normalizeQuery('  65-85-0 \n'), '65-85-0');
});

test('キャッシュ外れ: 外部を叩いて補完結果を返し、pubchem_cacheへ保存する', async () => {
  const { env, ctx, DB } = createTestEnv();
  const fetchMock = mockFetch(BENZOIC);
  const res = await withFetch(fetchMock, () => lookupCompound(env, ctx, { type: 'cas', q: '65-85-0' }, NOW));

  assert.equal(res.status, 200);
  assert.equal(res.data.found, true);
  assert.equal(res.data.cached, false);
  assert.equal(res.data.compound.molecular_weight, 122.12);
  assert.equal(res.data.compound.cas_number, '65-85-0');
  assert.equal(res.data.compound.formula, 'C7H6O2');
  assert.equal(res.data.compound.name, 'benzoic acid');
  assert.equal(res.data.compound.smiles, 'C1=CC=C(C=C1)C(=O)O');
  assert.equal(res.data.compound.xlogp, 1.9);

  // CID解決→物性＋同義語の3本だけ。余計な外部アクセスをしていない
  assert.equal(fetchMock.calls.length, 3);
  assert.ok(fetchMock.calls[0].startsWith('https://pubchem.ncbi.nlm.nih.gov/rest/pug/'));

  const row = DB.__raw.prepare('SELECT * FROM pubchem_cache').get();
  assert.equal(row.query_type, 'cas');
  assert.equal(row.query, '65-85-0');
  assert.equal(row.fetched_at, NOW);
  assert.equal(JSON.parse(row.response).compound.molecular_weight, 122.12);
});

test('キャッシュ当たり: 期限内は外部に一切出ない', async () => {
  const { env, ctx } = createTestEnv();
  await withFetch(mockFetch(BENZOIC), () => lookupCompound(env, ctx, { type: 'cas', q: '65-85-0' }, NOW));

  const later = new Date(Date.parse(NOW) + CACHE_TTL_MS - 1000).toISOString();
  const blowUp = mockFetch({}); // 呼ばれたら回数で分かる
  const res = await withFetch(blowUp, () => lookupCompound(env, ctx, { type: 'cas', q: '65-85-0' }, later));

  assert.equal(blowUp.calls.length, 0, '期限内のキャッシュで外部照会が消えていること');
  assert.equal(res.data.cached, true);
  assert.equal(res.data.compound.molecular_weight, 122.12);
});

test('キャッシュの寿命切れ（30日）は引き直す', async () => {
  const { env, ctx } = createTestEnv();
  await withFetch(mockFetch(BENZOIC), () => lookupCompound(env, ctx, { type: 'cas', q: '65-85-0' }, NOW));

  const expired = new Date(Date.parse(NOW) + CACHE_TTL_MS + 1000).toISOString();
  const again = mockFetch(BENZOIC);
  const res = await withFetch(again, () => lookupCompound(env, ctx, { type: 'cas', q: '65-85-0' }, expired));

  assert.equal(res.data.cached, false);
  assert.ok(again.calls.length > 0, '期限切れなら外部を引き直す');
});

test('壊れたキャッシュ行は無かったことにして引き直す', async () => {
  const { env, ctx, DB } = createTestEnv();
  DB.__raw.prepare(
    'INSERT INTO pubchem_cache (query_type, query, response, fetched_at) VALUES (?, ?, ?, ?)'
  ).run('cas', '65-85-0', '{壊れたJSON', NOW);

  const fetchMock = mockFetch(BENZOIC);
  const res = await withFetch(fetchMock, () => lookupCompound(env, ctx, { type: 'cas', q: '65-85-0' }, NOW));
  assert.equal(res.data.found, true);
  assert.ok(fetchMock.calls.length > 0);
});

test('該当なし: 200 found:false を返し、キャッシュしない（打ち間違いを覚え込まない）', async () => {
  const { env, ctx, DB } = createTestEnv();
  const fetchMock = mockFetch({}); // 全部404
  const res = await withFetch(fetchMock, () => lookupCompound(env, ctx, { type: 'name', q: 'ないやつ' }, NOW));

  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { found: false, cached: false });
  assert.equal(DB.__raw.prepare('SELECT COUNT(*) AS n FROM pubchem_cache').get().n, 0);
});

test('外部が落ちている（例外・タイムアウト）: 落とさず found:false で返す', async () => {
  const { env, ctx } = createTestEnv();
  const boom = mockFetch({ 'rest/pug': 'boom' });
  const res = await withFetch(boom, () => lookupCompound(env, ctx, { type: 'smiles', q: 'CCO' }, NOW));
  assert.equal(res.status, 200);
  assert.equal(res.data.found, false);
});

test('物性が取れなかった場合も found:false（中途半端な行を返さない）', async () => {
  const { env, ctx } = createTestEnv();
  const partial = mockFetch({
    'name/ethanol/cids': { IdentifierList: { CID: [702] } },
    // property は用意しない＝404
  });
  const res = await withFetch(partial, () => lookupCompound(env, ctx, { type: 'name', q: 'ethanol' }, NOW));
  assert.equal(res.data.found, false);
});

test('CAS検索は登録番号(xref/RN)で空振りしたら名前検索へ落ちる', async () => {
  const { env, ctx } = createTestEnv();
  const fetchMock = mockFetch({
    // xref/RN は用意しない（404）
    'name/108-88-3/cids': { IdentifierList: { CID: [1140] } },
    'compound/cid/1140/property': {
      PropertyTable: { Properties: [{ CID: 1140, MolecularWeight: 92.14, IUPACName: 'toluene' }] },
    },
    'compound/cid/1140/synonyms': {
      InformationList: { Information: [{ CID: 1140, Synonym: ['toluene', '108-88-3'] }] },
    },
  });
  const res = await withFetch(fetchMock, () => lookupCompound(env, ctx, { type: 'cas', q: '108-88-3' }, NOW));
  assert.equal(res.data.found, true);
  assert.equal(res.data.compound.molecular_weight, 92.14);
  assert.ok(fetchMock.calls.some((u) => u.includes('xref/RN/108-88-3')), '先に登録番号で引いている');
  assert.ok(fetchMock.calls.some((u) => u.includes('name/108-88-3')), '空振りしたら名前へ落ちている');
});

test('SMILESの大文字小文字はキャッシュで潰れない（Cとcは別の分子）', async () => {
  const { env, ctx, DB } = createTestEnv();
  const fetchMock = mockFetch({
    'smiles/CCO/cids': { IdentifierList: { CID: [702] } },
    'compound/cid/702/property': {
      PropertyTable: { Properties: [{ CID: 702, MolecularWeight: 46.07, CanonicalSMILES: 'CCO' }] },
    },
    'compound/cid/702/synonyms': { InformationList: { Information: [{ CID: 702, Synonym: ['ethanol', '64-17-5'] }] } },
  });
  await withFetch(fetchMock, () => lookupCompound(env, ctx, { type: 'smiles', q: 'CCO' }, NOW));
  assert.equal(DB.__raw.prepare('SELECT query FROM pubchem_cache').get().query, 'CCO');
});

test('発行SQLはpubchem_cacheだけ（テナント別テーブルに触っていない）', async () => {
  const { env, ctx, DB } = createTestEnv();
  await withFetch(mockFetch(BENZOIC), () => lookupCompound(env, ctx, { type: 'cas', q: '65-85-0' }, NOW));
  assert.deepEqual(sqlMissingTenantScope(DB.__sql), []);
  for (const sql of DB.__sql) assert.match(sql, /pubchem_cache/);
});
