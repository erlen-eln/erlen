-- 研究室メンバー（招待制）。0001は変更せず、ここに追記する。
-- 適用: npm exec -- wrangler d1 migrations apply erlen --remote
--
-- 設計の約束ごと
--   1. テナントは1つ（オーナーのテナント）。招待は必ずそのtenant_idに紐づく。
--   2. 招待メールは送らない。招待済みのアドレスでGoogleログインすると、
--      /auth/callback が invitations の行を見つけて users を作る（受諾＝初回ログイン）。
--   3. users.id はGoogleの sub。招待の時点では sub が分からないので、
--      users への行作成は「受諾」のときにだけ行う（招待は email だけを持つ）。

CREATE TABLE IF NOT EXISTS invitations (
  id          TEXT PRIMARY KEY,             -- ULID
  tenant_id   TEXT NOT NULL,
  email       TEXT NOT NULL,                -- 小文字・trim済みで入れる
  role        TEXT NOT NULL DEFAULT 'editor',
  invited_by  TEXT NOT NULL,                -- 招待したユーザーのid（users.id）
  created_at  TEXT NOT NULL,
  accepted_at TEXT,                         -- 受諾（初回ログイン）した時刻
  revoked_at  TEXT,                         -- 取り消した時刻
  CHECK (role IN ('editor', 'viewer'))
);

-- 「受諾も取り消しもされていない招待」は、同じアドレスにつき1件だけ。
-- SQLiteの部分UNIQUEインデックスで、二重招待をDBの側で止める
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending
  ON invitations (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_invitations_tenant ON invitations (tenant_id, created_at);
-- ログイン時の引き当て（メールだけが手がかり）で使う
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations (email, accepted_at, revoked_at);
