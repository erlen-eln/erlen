import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { health, VERSION } from '../src/api/health.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('healthはログイン不要で ok/version/demo を返す', () => {
  const r = health();
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true, version: VERSION, demo: false });
});

test('healthのdemoはDEMO_MODE="1"のときだけtrue（ログイン画面の案内の判定材料）', () => {
  assert.equal(health({ DEMO_MODE: '1' }).data.demo, true);
  for (const value of ['0', '', 'true', 'yes', undefined]) {
    assert.equal(health({ DEMO_MODE: value }).data.demo, false, `DEMO_MODE=${value}`);
  }
});

test('健康診断の版はpackage.jsonのversionと一致する', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('healthは秘密になり得る情報を返さない', () => {
  const r = health({ SESSION_SECRET: 'x'.repeat(48), OWNER_EMAIL: 'owner@example.com' });
  const body = JSON.stringify(r.data);
  assert.ok(!body.includes('owner@example.com'));
  assert.ok(!body.includes('xxxx'));
});
