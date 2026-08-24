import test from 'node:test';
import assert from 'node:assert/strict';
import { ulid, isUlid } from '../src/ulid.mjs';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test('ULIDは26文字のCrockford Base32', () => {
  for (let i = 0; i < 200; i++) {
    const id = ulid();
    assert.match(id, CROCKFORD, `不正な形式: ${id}`);
    assert.ok(isUlid(id));
  }
});

test('isUlidは長さ・文字種の違うものを弾く', () => {
  assert.equal(isUlid(''), false);
  assert.equal(isUlid(null), false);
  assert.equal(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FA'), false);   // 25文字
  assert.equal(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAVX'), false); // 27文字
  assert.equal(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI'), false);  // 除外文字I
});

test('連続生成は必ず単調増加（同一ミリ秒でも順序が保たれる）', () => {
  let prev = ulid();
  for (let i = 0; i < 5000; i++) {
    const next = ulid();
    assert.ok(next > prev, `単調でない: ${prev} -> ${next}`);
    prev = next;
  }
});

test('時刻部は経過時間で増える（辞書順＝作成順）', () => {
  // 巻き戻り防止のため過去時刻は直前の時刻へ丸められる。ここは未来の時刻で比べる
  const base = Date.now() + 3600_000;
  const older = ulid(base);
  const newer = ulid(base + 86400_000);
  assert.ok(newer.slice(0, 10) > older.slice(0, 10));
  assert.ok(newer > older);
});

test('時計が巻き戻っても順序は壊れない', () => {
  const base = Date.parse('2026-07-01T00:00:00Z');
  const first = ulid(base);
  const second = ulid(base - 60000); // NTP補正で1分戻った想定
  assert.ok(second > first);
});

test('同じ時刻でも重複しない', () => {
  const at = Date.parse('2026-07-01T00:00:00Z');
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(ulid(at));
  assert.equal(ids.size, 1000);
});
