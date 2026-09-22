-- 監査証跡。全ての書き込み操作を1件1行で残す（21 CFR 11.10(e) / ER-ES 真正性）。
-- 追記専用。UPDATE と DELETE はトリガで拒否する。
-- 改ざんの識別は (1) tenant_id ごとの seq の連番 (2) prev_hash → hash の連鎖 の2つ。
CREATE TABLE IF NOT EXISTS audit_events (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_email   TEXT NOT NULL DEFAULT '',
  action        TEXT NOT NULL,
  target_type   TEXT NOT NULL DEFAULT '',
  target_id     TEXT NOT NULL DEFAULT '',
  page_id       TEXT,
  before_json   TEXT,
  after_json    TEXT,
  reason        TEXT NOT NULL DEFAULT '',
  request_id    TEXT NOT NULL DEFAULT '',
  at            TEXT NOT NULL,
  prev_hash     TEXT NOT NULL DEFAULT '',
  hash          TEXT NOT NULL,
  UNIQUE (tenant_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_seq ON audit_events (tenant_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_target     ON audit_events (tenant_id, target_type, target_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_page       ON audit_events (tenant_id, page_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_actor      ON audit_events (tenant_id, actor_user_id, seq);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
