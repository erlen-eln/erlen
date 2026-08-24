// ULID生成（依存ゼロ）。26文字＝時刻10文字＋乱数16文字のCrockford Base32。
// UUIDと違い文字列のまま時刻順に並ぶので、ORDER BY id が「作った順」になる。
// 同一ミリ秒内でも必ず昇順になるよう、乱数部を1つ繰り上げる（単調性）。
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // I,L,O,U を除いた32文字
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTimeMs = -1;
let lastRandom = new Uint8Array(RANDOM_LEN);

function encodeTime(ms) {
  let out = '';
  let t = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function newRandom() {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  // 1バイトを0-31に丸めてBase32の1文字に対応させる
  for (let i = 0; i < bytes.length; i++) bytes[i] &= 31;
  return bytes;
}

function bumpRandom(bytes) {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] < 31) {
      bytes[i] += 1;
      return bytes;
    }
    bytes[i] = 0;
  }
  // 16桁すべて繰り上がる（同一ミリ秒に32^16回生成）ことは現実には起きない
  return bytes;
}

export function ulid(nowMs = Date.now()) {
  // 時計の巻き戻り（NTP補正）でも順序が壊れないよう、過去時刻は直前の時刻に丸める
  const ms = nowMs <= lastTimeMs ? lastTimeMs : nowMs;
  if (ms === lastTimeMs) lastRandom = bumpRandom(lastRandom);
  else lastRandom = newRandom();
  lastTimeMs = ms;
  let out = encodeTime(ms);
  for (const v of lastRandom) out += ENCODING[v];
  return out;
}

// 形式チェック（外から来たIDをそのままSQLに渡す前に使う）
export function isUlid(value) {
  return typeof value === 'string'
    && value.length === TIME_LEN + RANDOM_LEN
    && [...value].every((c) => ENCODING.includes(c));
}
