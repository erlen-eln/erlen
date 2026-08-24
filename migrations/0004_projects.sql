-- プロジェクト（ノートブックの束）と、その閲覧範囲。あわせて複数オーナー。
-- 0001〜0003は変更せず、ここに追記する。
-- 適用: npm exec -- wrangler d1 migrations apply erlen --remote
--
-- 設計の約束ごと（0001と同じ）
--   1. IDはULID（src/ulid.mjs）のTEXT。
--   2. 時刻はISO8601のTEXT。
--   3. 削除は deleted_at に時刻を入れる論理削除。
--   4. 全ての行に tenant_id を持たせ、アプリ側の全SQLに tenant_id = ? を付ける。
--
-- 閲覧範囲の考え方（src/access.mjs が唯一の実装）
--   ・オーナーは全部見える。
--   ・notebooks.project_id が NULL のノートブックは、テナントの全員が見える（0003までと同じ挙動）。
--   ・project_id が入っているノートブックは、project_members に行がある人だけが見える。
--     見えない人には「存在しない」ように振る舞う（一覧に出ない・直接URLでも404）。
--
-- 複数オーナーの考え方（src/session.mjs / src/api/members.mjs）
--   ・主オーナー … vars.OWNER_EMAIL 本人。降格も除名もできない（オーナー不在を作らせない最後の砦）。
--   ・追加オーナー … オーナーが昇格させた人。owner_granted_at が入っている行だけが owner として通る。
--     users.role を直接 'owner' に書き換えただけでは通らない（0001以来の守りを維持するため）。

-- プロジェクト
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_tenant
  ON projects (tenant_id, deleted_at, updated_at);

-- 閲覧可能メンバー。ここに行が無い人には、そのプロジェクトのノートブックが存在しないように見える。
-- オーナーは行が無くても見えるので、ここに入れる必要はない。
CREATE TABLE IF NOT EXISTS project_members (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_members_uniq
  ON project_members (tenant_id, project_id, user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user
  ON project_members (tenant_id, user_id);

-- 誰がいつオーナーに引き上げたか。追記のためではなく、権限判定そのものに使う列
ALTER TABLE users ADD COLUMN owner_granted_by TEXT;
ALTER TABLE users ADD COLUMN owner_granted_at TEXT;

-- ノートブックの所属先。NULLは「プロジェクトなし＝全員が見える」
ALTER TABLE notebooks ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_notebooks_project
  ON notebooks (tenant_id, project_id, deleted_at);
