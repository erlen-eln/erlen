// Googleログイン（純関数側）。ライブラリ不使用・WebCryptoだけで実装している。
// セッション = b64url(JSON{email,exp}) + '.' + HMAC-SHA256署名。これをCookieに入れる。
// ここはHTTPに触らないので、そのままユニットテストできる（test/auth.test.mjs）。
const enc = new TextEncoder();
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
let googleJwksCache = null;
let googleJwksExpiresAt = 0;

// Cookie名。他のアプリと同じWorkerドメインに同居しても衝突しないよう erlen_ を付ける
export const SESSION_COOKIE = 'erlen_session';
export const STATE_COOKIE = 'erlen_oauth_state';
export const NEXT_COOKIE = 'erlen_login_next';
export const SESSION_TTL_MS = 30 * 86400000; // 30日

function b64urlFromBytes(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacB64url(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64urlFromBytes(new Uint8Array(sig));
}

// 文字列比較にかかる時間を一定にする（タイミング攻撃対策）
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// SESSION_SECRETが短すぎると総当たりで偽造できるので、32文字未満は未設定扱いにする
export function validSessionSecret(value) {
  return typeof value === 'string' && value.length >= 32;
}

// demo:true を渡すと「デモセッション」になる（公開デモ用・users行を持たない閲覧者）。
// 既存の {email, exp} だけのCookieはそのまま有効（demoキーは付けない）
export async function signSession({ email, expMs, demo = false }, secret) {
  const claims = { email, exp: expMs };
  if (demo) claims.demo = true;
  const payload = b64urlFromBytes(enc.encode(JSON.stringify(claims)));
  return `${payload}.${await hmacB64url(secret, payload)}`;
}

// 正当なら {email}（デモセッションなら {email, demo:true}）、
// 署名不一致・期限切れ・形式不正は null
export async function verifySession(value, nowMs, secret) {
  if (typeof value !== 'string') return null;
  if (!validSessionSecret(secret)) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!safeEqual(sig, await hmacB64url(secret, payload))) return null;
  let claims;
  try {
    claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
  if (typeof claims.email !== 'string' || typeof claims.exp !== 'number') return null;
  if (claims.exp <= nowMs) return null;
  // demo は「true のときだけ」通す。他の値（'1'・1・{}）を真と見なさない
  return claims.demo === true ? { email: claims.email, demo: true } : { email: claims.email };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function googleAuthUrl({ clientId, redirectUri, state, nonce = state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state,
    nonce,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

function b64urlBytes(value) {
  const s = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function decodeJwtJson(value) {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(value)));
}

async function googleJwks({ nowMs, fetchImpl }) {
  if (googleJwksCache && nowMs < googleJwksExpiresAt) return googleJwksCache;
  const res = await fetchImpl('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) throw new Error(`google_jwks_${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.keys)) throw new Error('google_jwks_invalid');
  const maxAge = Number((res.headers?.get?.('cache-control') ?? '').match(/max-age=(\d+)/)?.[1] ?? 3600);
  googleJwksCache = body;
  googleJwksExpiresAt = nowMs + Math.min(Math.max(maxAge, 60), 86400) * 1000;
  return body;
}

// GoogleのID tokenを署名・issuer・audience・期限・nonceまで検証する。
// 成功時はclaims、検証不成立はnull。JWKS取得障害は呼び出し側でログイン失敗として扱う。
export async function verifyGoogleIdToken(idToken, {
  clientId,
  expectedNonce,
  nowMs = Date.now(),
  fetchImpl = fetch,
  jwks = null,
} = {}) {
  try {
    const parts = String(idToken ?? '').split('.');
    if (parts.length !== 3) return null;
    const header = decodeJwtJson(parts[0]);
    const claims = decodeJwtJson(parts[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    const keys = jwks ?? await googleJwks({ nowMs, fetchImpl });
    const jwk = keys.keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    const signed = enc.encode(`${parts[0]}.${parts[1]}`);
    const signatureOk = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), signed
    );
    if (!signatureOk || !GOOGLE_ISSUERS.has(claims.iss)) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(clientId)) return null;
    if (audiences.length > 1 && claims.azp !== clientId) return null;
    const nowSec = Math.floor(nowMs / 1000);
    if (!Number.isFinite(claims.exp) || claims.exp <= nowSec) return null;
    if (!Number.isFinite(claims.iat) || claims.iat > nowSec + 300) return null;
    if (expectedNonce && claims.nonce !== expectedNonce) return null;
    return claims;
  } catch {
    return null;
  }
}

// ログイン後の戻り先。許可リスト外は/appへ丸める（オープンリダイレクト防止）。
// 画面を増やしたらここに足す。外部URLを通さないため、必ず完全一致で判定する
const ALLOWED_NEXT_PATHS = new Set(['/app']);
export function safeNextPath(value) {
  return ALLOWED_NEXT_PATHS.has(value) ? value : '/app';
}

// ランダムなstate/nonce（12バイト=96bit）
export function newToken() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
