// テスト用: Node標準の node:sqlite を Cloudflare D1 のAPI形（prepare/bind/all/first/run/batch）に包む。
// 外部パッケージは一切使わない（この製品のnpm依存は wrangler だけ）。
// 実SQLiteなので、UNIQUE制約・CHECK・トリガ（append-only、FTS同期）まで本番と同じ挙動で検証できる。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestR2 } from './r2-adapter.mjs';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));

// アプリが発行した全SQLを記録する（tenant_id条件の検査に使う）
export function createTestDb() {
  const raw = new DatabaseSync(':memory:');
  for (const sql of MIGRATIONS) raw.exec(sql);
  const log = [];

  const makeOps = (sql, args) => ({
    async run() {
      log.push(sql);
      const info = raw.prepare(sql).run(...args);
      return {
        success: true,
        meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
      };
    },
    async first() {
      log.push(sql);
      return raw.prepare(sql).get(...args) ?? null;
    },
    async all() {
      log.push(sql);
      return { results: raw.prepare(sql).all(...args) };
    },
  });

  return {
    prepare(sql) {
      return { bind: (...args) => makeOps(sql, args), ...makeOps(sql, []) };
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    // 検査用（D1本体には無い）
    __sql: log,
    __raw: raw,
  };
}

// テナント1件＋オーナー1人を作った状態のenv/ctxを返す。各テストの出発点
export function createTestEnv() {
  const DB = createTestDb();
  const nowIso = '2026-07-01T00:00:00.000Z';
  DB.__raw.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
    .run('T0000000000000000000000000', 'テスト研究室', nowIso);
  DB.__raw.prepare(
    `INSERT INTO users (id, tenant_id, email, name, role, created_at)
     VALUES (?, ?, ?, ?, 'owner', ?)`
  ).run('google-sub-1', 'T0000000000000000000000000', 'owner@example.com', '所有者', nowIso);
  // 別テナント（漏れ検査用のダミー）
  DB.__raw.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
    .run('T9999999999999999999999999', 'よその研究室', nowIso);

  const R2 = createTestR2();
  const env = {
    DB,
    ATTACHMENTS: R2,
    OWNER_EMAIL: 'owner@example.com',
    BASE_URL: 'https://erlen.example.workers.dev',
    SESSION_SECRET: 'x'.repeat(48),
    MAX_ATTACHMENT_MB: '25',
  };
  const ctx = {
    userId: 'google-sub-1',
    tenantId: 'T0000000000000000000000000',
    email: 'owner@example.com',
    name: '所有者',
    role: 'owner',
  };
  const otherCtx = { ...ctx, tenantId: 'T9999999999999999999999999' };
  return { env, ctx, otherCtx, DB, R2 };
}

// テナントへメンバーを1人足す（招待の受諾を経ずに、テストの前提として直に置く）。
// 返り値はそのままctxとして使える
export function addMember(env, { id, email, name = '', role = 'editor', tenantId = 'T0000000000000000000000000' }) {
  env.DB.__raw.prepare(
    `INSERT INTO users (id, tenant_id, email, name, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, email, name, role, '2026-07-02T00:00:00.000Z');
  return { userId: id, tenantId, email, name, role };
}

// tenant_idで絞らなければならないテーブル（users/tenants はテナントの入口なので対象外）
export const TENANT_TABLES = [
  'notebooks', 'pages', 'molecules', 'attachments', 'page_revisions', 'invitations',
  'reagent_masters', 'reagent_stocks', 'equipments', 'projects', 'project_members',
];

// 記録したSQLのうち、テナント別テーブルを触るものに tenant_id 条件が無いものを返す
export function sqlMissingTenantScope(log) {
  return log.filter((sql) => {
    const flat = sql.replace(/\s+/g, ' ');
    const touchesTenantTable = TENANT_TABLES.some((t) => new RegExp(`\\b${t}\\b`).test(flat));
    return touchesTenantTable && !/tenant_id/.test(flat);
  });
}
