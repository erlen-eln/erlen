// テナント越境の作り込み防止。
// この製品の最重要ルールは「テナント別テーブルを触るSQLには必ず tenant_id = ? を書く」。
// 実行時（各api-*.test.mjs）だけでなく、ソースの字面でも検査して、
// 「テストで通らない経路にうっかり書いた越境SQL」を出荷前に止める。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TENANT_TABLES } from './d1-adapter.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function srcFiles() {
  const out = [path.join(ROOT, 'src/session.mjs'), path.join(ROOT, 'src/worker.mjs')];
  for (const f of readdirSync(path.join(ROOT, 'src/api'))) {
    if (f.endsWith('.mjs')) out.push(path.join(ROOT, 'src/api', f));
  }
  return out;
}

// バッククオートのテンプレートリテラルからSQLらしきものを拾う。
// ${...} の中は入れ子のテンプレート（`${f} = ?` など）が来るので、波括弧の数を数えて読み飛ばす。
export function sqlLiterals(source) {
  const literals = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] !== '`') { i++; continue; }
    let j = i + 1;
    let depth = 0;
    let buf = '';
    while (j < source.length) {
      const c = source[j];
      if (depth === 0) {
        if (c === '`') break;
        if (c === '$' && source[j + 1] === '{') { depth = 1; j += 2; continue; }
        buf += c;
        j++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      j++;
    }
    literals.push(buf);
    i = j + 1;
  }
  return literals.filter((s) => /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(s));
}

test('SQL抜き出しが空振りしていない（検査が偽緑にならないことの確認）', () => {
  // 入れ子のテンプレート（`${f} = ?`）を含むSQLもちゃんと1本として拾えること
  const sample = 'const q = `UPDATE molecules SET ${F.map((f) => `${f} = ?`).join(\', \')}'
    + ' WHERE id = ? AND tenant_id = ?`;';
  const found = sqlLiterals(sample);
  assert.equal(found.length, 1);
  assert.match(found[0], /tenant_id/);
  // tenant_idの無いSQLは検出できること
  assert.equal(sqlLiterals('const q = `SELECT * FROM pages WHERE id = ?`;')[0].includes('tenant_id'), false);

  let total = 0;
  for (const file of srcFiles()) total += sqlLiterals(readFileSync(file, 'utf8')).length;
  assert.ok(total >= 15, `src内のSQLが少なすぎる（抜き出し失敗の疑い）: ${total}本`);
});

test('src内のSQLは、テナント別テーブルを触るなら必ず tenant_id を含む', () => {
  const offenders = [];
  for (const file of srcFiles()) {
    for (const sql of sqlLiterals(readFileSync(file, 'utf8'))) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      const touches = TENANT_TABLES.some((t) => new RegExp(`\\b${t}\\b`).test(flat));
      if (touches && !/tenant_id/.test(flat)) {
        offenders.push(`${path.basename(file)}: ${flat.slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `tenant_idの無いSQL:\n${offenders.join('\n')}`);
});

// テナントの入口＝「tenant_id = ? で絞れない引き当て」。
// ログイン時のusers/invitationsの引き当てだけが該当し、それは session.mjs に閉じ込める。
// メンバー管理（api/members.mjs）はctx.tenantIdを持っているので、必ず tenant_id = ? を付ける。
test('tenant_idで絞らないusers/invitationsの引き当てはsession.mjsだけ（テナント判定の起点を増やさない）', () => {
  const offenders = [];
  for (const file of srcFiles()) {
    if (path.basename(file) === 'session.mjs') continue;
    for (const sql of sqlLiterals(readFileSync(file, 'utf8'))) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (!/\b(users|invitations)\b/i.test(flat)) continue;
      // INSERTは列にtenant_idを載せる形なので = ? にはならない
      if (/^INSERT\b/i.test(flat)) {
        if (!/\btenant_id\b/.test(flat)) offenders.push(`${path.basename(file)}: ${flat.slice(0, 120)}`);
        continue;
      }
      if (!/tenant_id\s*=\s*\?/.test(flat)) offenders.push(`${path.basename(file)}: ${flat.slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], `テナントで絞っていないusers/invitationsのSQL:\n${offenders.join('\n')}`);
});

test('api層はResponseを組み立てない（{status, data}を返す素の関数に保つ）', () => {
  for (const f of readdirSync(path.join(ROOT, 'src/api'))) {
    if (!f.endsWith('.mjs')) continue;
    const src = readFileSync(path.join(ROOT, 'src/api', f), 'utf8');
    assert.ok(!src.includes('new Response('), `${f}: api層はResponseを作らない（worker.mjsの役目）`);
  }
});
