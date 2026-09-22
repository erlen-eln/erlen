// 監査証跡（audit_events）の連鎖を検査するコマンド。
//   node scripts/verify-audit.mjs --file <erlen.sql のパス>
//   node scripts/verify-audit.mjs --remote
//
// 検査は3つ:
//   ① seq がテナントごとに 1 から連続している（欠番・重複が無い）
//   ② prev_hash が直前の行の hash と一致している
//   ③ hash が内容から再計算した値と一致している（改ざん検出）
// ハッシュの計算は src/audit.mjs の hashEvent を import して使う（実装を2か所に持たない）。
//
// 検査の本体は verifyChain として export してある（test/verify-audit.test.mjs が直接呼ぶ）。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashEvent } from '../src/audit.mjs';
import { runWrangler } from './lib-wrangler.mjs';

const CHUNK = 5000;

// ---- 検査の本体 ------------------------------------------------------
// rows: audit_events の行配列（順不同でよい。ここで tenant_id, seq 順に並べ直す）。
// 戻り値: 全通しなら { ok: true, count }。
// 壊れていたら最初の1件で { ok: false, seq, reason }（seq は壊れた行の連番を名指しする）
export async function verifyChain(rows) {
  const sorted = [...rows].sort((a, b) => (
    String(a.tenant_id).localeCompare(String(b.tenant_id)) || Number(a.seq) - Number(b.seq)
  ));
  // テナントごとの連番・連鎖なので、tenant_id で区切ってから見る
  const byTenant = new Map();
  for (const row of sorted) {
    const list = byTenant.get(row.tenant_id) ?? [];
    list.push(row);
    byTenant.set(row.tenant_id, list);
  }

  let count = 0;
  for (const [tenantId, list] of byTenant) {
    let prevHash = '';
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      const expected = i + 1;
      // ① seq が 1 から連続していること
      if (Number(row.seq) !== expected) {
        return {
          ok: false, seq: Number(row.seq),
          reason: `tenant ${tenantId}: seq は ${expected} のはずが ${row.seq}（欠番または重複）`,
        };
      }
      // ② prev_hash が直前の行の hash と一致していること
      if (String(row.prev_hash ?? '') !== prevHash) {
        return {
          ok: false, seq: row.seq,
          reason: `tenant ${tenantId}: seq=${row.seq} の prev_hash が直前の行の hash と一致しない`,
        };
      }
      // ③ hash が内容の再計算と一致していること
      const actual = await hashEvent(row);
      if (actual !== row.hash) {
        return {
          ok: false, seq: row.seq,
          reason: `tenant ${tenantId}: seq=${row.seq} の hash が内容の再計算と一致しない（改ざんの疑い）`,
        };
      }
      prevHash = row.hash;
      count += 1;
    }
  }
  return { ok: true, count };
}

// ---- 行の取り出し ----------------------------------------------------
// --file: wrangler d1 export で落としたSQLダンプをインメモリDBへ流して読む
// （test/d1-adapter.mjs が同じ手を使っている）
function rowsFromFile(file) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(file, 'utf8'));
  return db.prepare('SELECT * FROM audit_events ORDER BY tenant_id, seq').all();
}

// wrangler d1 execute --json の出力から行配列を取り出す
function remoteQuery(command) {
  const res = runWrangler(['d1', 'execute', 'erlen', '--remote', '--json', '--command', command]);
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`wrangler d1 execute が失敗しました: ${res.stderr || res.stdout}`);
  }
  return JSON.parse(res.stdout)?.[0]?.results ?? [];
}

// --remote: 本番D1を読む。d1 execute の出力上限とメモリ対策のため、
// テナントごとに seq の範囲を区切って CHUNK 件ずつ取る
function rowsFromRemote() {
  const tenants = remoteQuery('SELECT DISTINCT tenant_id FROM audit_events ORDER BY tenant_id');
  const rows = [];
  for (const { tenant_id: tenantId } of tenants) {
    const safe = String(tenantId).replace(/'/g, "''");
    for (let after = 0; ; ) {
      const chunk = remoteQuery(
        `SELECT * FROM audit_events
          WHERE tenant_id = '${safe}' AND seq > ${after}
          ORDER BY seq LIMIT ${CHUNK}`
      );
      if (!chunk.length) break;
      rows.push(...chunk);
      after = Math.max(...chunk.map((r) => Number(r.seq)));
      if (chunk.length < CHUNK) break;
    }
  }
  return rows;
}

// ---- CLI -------------------------------------------------------------
async function main(argv) {
  const fileIdx = argv.indexOf('--file');
  let rows;
  if (fileIdx >= 0) {
    const file = argv[fileIdx + 1];
    if (!file) throw new Error('--file のあとにSQLダンプのパスを指定してください');
    rows = rowsFromFile(file);
  } else if (argv.includes('--remote')) {
    rows = rowsFromRemote();
  } else {
    throw new Error('使い方: node scripts/verify-audit.mjs --file <erlen.sql> | --remote');
  }

  const verdict = await verifyChain(rows);
  if (!verdict.ok) {
    console.error(`NG: seq=${verdict.seq} — ${verdict.reason}`);
    process.exit(1);
  }
  console.log(`OK: ${verdict.count} 件の監査証跡は連番・連鎖・ハッシュすべて一致しています`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`NG: ${e?.message ?? e}`);
    process.exit(1);
  });
}
