// PubChem（米国NIHの化合物データベース）への照会。
// 画面からブラウザ直で pubchem.ncbi.nlm.nih.gov を叩かず、必ずこのWorkerを通す。理由は3つ。
//   1. CORSとレート制限に画面が振り回されない（外部との窓口をサーバ側1か所に集める）
//   2. pubchem_cache に貯めるので、同じ試薬を何度引いても外に出るのは最初の1回だけ
//   3. 外部が落ちていても found:false を 200 で返せる。画面は手入力のまま作業を続けられる
//
// 【注意】pubchem_cache は「誰にとっても同じ公開データ」のキャッシュなので tenant_id を持たない。
//         テナント別テーブル（notebooks/pages/molecules…）を触るSQLではないので鉄則の対象外。
//         逆に言うと、このファイルに他のテーブルを足すときは tenant_id = ? を必ず書くこと。

const BASE_URL = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';

// 外部が無応答のときに画面を待たせ続けないための打ち切り時間
const TIMEOUT_MS = 8000;

// キャッシュの寿命。化合物の物性値は動かないので長めでよい（30日）
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// 検索の入口は3種類。CAS番号・化合物名・SMILES
export const SEARCH_TYPES = ['cas', 'name', 'smiles'];

// PubChemから取り出す物性。プロパティ名はPUG RESTの正式名（大文字小文字まで一致が必要）
const PROPERTIES = [
  'MolecularFormula',
  'MolecularWeight',
  'CanonicalSMILES',
  'IsomericSMILES',
  'InChI',
  'ExactMass',
  'XLogP',
  'IUPACName',
].join(',');

export function normalizeQuery(value) {
  return String(value ?? '').trim().slice(0, 200);
}

// キャッシュの引き当てキー。CASと名前は大文字小文字を無視してよいが、
// SMILESは大文字小文字で別の分子になる（C=炭素 / c=芳香族炭素）ので、そのまま使う
export function cacheKey(type, query) {
  return type === 'smiles' ? query : query.toLowerCase();
}

// 同義語の並びからCAS番号を拾う（例 7647-14-5）。PubChemはCASを専用欄で返してくれない
export function extractCasNumber(synonyms) {
  const pattern = /^\d{2,7}-\d{2}-\d$/;
  for (const s of synonyms ?? []) {
    if (typeof s === 'string' && pattern.test(s)) return s;
  }
  return null;
}

// 文字列でも数値でも返ってくる欄を数値へ。数値にならないものはnull
export function parseNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

// 外部への唯一の出口。失敗（HTTPエラー・タイムアウト・JSON崩れ）は全部nullに畳む
async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null; // 404（該当なし）もここでnullになる
    return await res.json();
  } catch (e) {
    console.warn('erlen pubchem fetch failed', url, e?.name ?? e?.message);
    return null;
  }
}

async function fetchCid(path) {
  const data = await fetchJson(`${BASE_URL}/compound/${path}/cids/JSON`);
  const cid = data?.IdentifierList?.CID?.[0];
  return Number.isFinite(cid) ? cid : null;
}

// 検索語からCID（PubChem内部の化合物ID）を決める。
// CAS番号は登録番号（xref/RN）で引くのが正道だが、当たらないことがあるので名前検索へ落とす
async function resolveCid(type, query) {
  const encoded = encodeURIComponent(query);
  if (type === 'cas') {
    return (await fetchCid(`xref/RN/${encoded}`)) ?? (await fetchCid(`name/${encoded}`));
  }
  return await fetchCid(`${type}/${encoded}`);
}

async function fetchProperties(cid) {
  const data = await fetchJson(`${BASE_URL}/compound/cid/${cid}/property/${PROPERTIES}/JSON`);
  const p = data?.PropertyTable?.Properties?.[0];
  if (!p) return null;
  return {
    name: p.IUPACName || null,
    molecular_weight: parseNumber(p.MolecularWeight),
    // PubChemは版によって返す欄名が違う。実在した順に拾う
    smiles: p.IsomericSMILES || p.CanonicalSMILES || p.SMILES || p.ConnectivitySMILES || null,
    formula: p.MolecularFormula || null,
    inchi: p.InChI || null,
    exact_mass: p.ExactMass !== undefined && p.ExactMass !== null ? String(p.ExactMass) : null,
    xlogp: parseNumber(p.XLogP),
  };
}

async function fetchCasNumber(cid) {
  const data = await fetchJson(`${BASE_URL}/compound/cid/${cid}/synonyms/JSON`);
  return extractCasNumber(data?.InformationList?.Information?.[0]?.Synonym);
}

// 外部照会の本体。見つからなければnull
async function fetchCompound(type, query) {
  const cid = await resolveCid(type, query);
  if (!cid) return null;
  const [properties, cas] = await Promise.all([fetchProperties(cid), fetchCasNumber(cid)]);
  if (!properties) return null;
  return { cid, cas_number: cas, ...properties };
}

// GET /api/pubchem?type=cas|name|smiles&q=...
// 返り値は必ず200系（見つからない・外部が落ちている＝ found:false ）。
// 画面は「補完できたら埋める、駄目なら手入力のまま」で進めるので、エラーを投げない方が使いやすい。
export async function lookupCompound(env, ctx, params, nowIso = new Date().toISOString()) {
  const type = String(params?.type ?? '').trim().toLowerCase();
  if (!SEARCH_TYPES.includes(type)) return { status: 400, data: { error: 'invalid_type' } };
  const query = normalizeQuery(params?.q);
  if (!query) return { status: 400, data: { error: 'query_required' } };

  const key = cacheKey(type, query);
  const nowMs = Date.parse(nowIso);

  const cached = await env.DB.prepare(
    `SELECT response, fetched_at FROM pubchem_cache WHERE query_type = ? AND query = ?`
  ).bind(type, key).first();
  if (cached) {
    const age = nowMs - Date.parse(cached.fetched_at);
    // 期限内なら外部に出ない。壊れたキャッシュ行は無かったことにして引き直す
    if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) {
      try {
        return { status: 200, data: { ...JSON.parse(cached.response), cached: true } };
      } catch {
        console.warn('erlen pubchem cache broken', type, key);
      }
    }
  }

  const compound = await fetchCompound(type, query);
  // 見つからなかった照会はキャッシュしない（打ち間違いを30日覚え込まないため）
  if (!compound) return { status: 200, data: { found: false, cached: false } };

  const payload = { found: true, compound };
  await env.DB.prepare(
    `INSERT OR REPLACE INTO pubchem_cache (query_type, query, response, fetched_at)
     VALUES (?, ?, ?, ?)`
  ).bind(type, key, JSON.stringify(payload), nowIso).run();
  return { status: 200, data: { ...payload, cached: false } };
}
