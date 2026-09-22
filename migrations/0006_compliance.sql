-- 規制対応（コンプライアンス）の器。プロジェクト単位で「どの規制対応を掛けるか」を選べるようにする。
-- 0001〜0005は変更せず、ここに追記する。
-- 適用: npm exec -- wrangler d1 migrations apply erlen --remote
--
-- 設計の約束ごと（0001と同じ）
--   1. IDはULID（src/ulid.mjs）のTEXT。
--   2. 時刻はISO8601のTEXT。
--   3. 削除は deleted_at に時刻を入れる論理削除。
--   4. テナント別テーブルは tenant_id を持ち、アプリ側の全SQLに tenant_id = ? を付ける。

-- 規制対応の方針。管理者（オーナー）が項目ごとに選んで名前を付ける。
-- 機能そのものは COMPLIANCE_MODE="1" の環境でのみ有効（src/compliance.mjs の元栓）。
CREATE TABLE IF NOT EXISTS compliance_policies (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL,
  name                   TEXT NOT NULL,
  require_reason         INTEGER NOT NULL DEFAULT 0,
  require_review_signoff INTEGER NOT NULL DEFAULT 0,
  approval_workflow      INTEGER NOT NULL DEFAULT 0,
  require_esign          INTEGER NOT NULL DEFAULT 0,
  require_reauth         INTEGER NOT NULL DEFAULT 0,
  session_max_min        INTEGER,
  idle_logout_min        INTEGER,
  is_tenant_default      INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  deleted_at             TEXT,
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_policies_tenant ON compliance_policies (tenant_id, deleted_at);

-- 変更理由の選択肢。導入者が自分で登録する（製品は既定リストを持たない）
CREATE TABLE IF NOT EXISTS reason_codes (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  code       TEXT NOT NULL,
  label_ja   TEXT NOT NULL,
  label_en   TEXT NOT NULL DEFAULT '',
  sort_no    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_reason_codes_tenant ON reason_codes (tenant_id, deleted_at, sort_no);

-- プロジェクトへの方針の割り当て。NULL は「方針なし」
ALTER TABLE projects ADD COLUMN compliance_policy_id TEXT;

-- 監査証跡の拡張。新しい列をハッシュの正規形に含めると v1.4.0 までに書かれた
-- 既存の行が検証に通らなくなるので、正規形に「版」を持たせて分岐する（src/audit.mjs）。
--   hash_version = 1 … 新しい列を含めない正規形（既存の行。並びは絶対に変えない）
--   hash_version = 2 … 末尾に policy, reason_code を足した正規形（これから書く行）
ALTER TABLE audit_events ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE audit_events ADD COLUMN policy TEXT;
ALTER TABLE audit_events ADD COLUMN reason_code TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_reason_code ON audit_events (tenant_id, reason_code, seq);
