-- Erlen 初期スキーマ。
-- 適用: npm exec -- wrangler d1 migrations apply erlen --remote
--
-- 設計の約束ごと（改造するときも守ること）
--   1. IDは全てTEXT。users.id だけはGoogleの sub、それ以外はULID（src/ulid.mjs）。
--   2. 時刻は全てISO8601のTEXT（例 2026-07-01T12:34:56.000Z）。
--   3. 削除は物理削除せず deleted_at に時刻を入れる（実験ノートは消さないのが原則）。
--   4. tenants を跨いだ参照は絶対にしない。アプリ側の全SQLに tenant_id = ? を付ける。

-- テナント（＝ノートの持ち主の組織。梅では1行だけできる）
CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 利用者。id はGoogleの sub（Googleアカウントの不変ID）をそのまま使う
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  email      TEXT NOT NULL,
  name       TEXT DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id, deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- ノートブック（実験ノートの冊子）
CREATE TABLE IF NOT EXISTS notebooks (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort_order  INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_notebooks_tenant ON notebooks (tenant_id, deleted_at, sort_order);
CREATE INDEX IF NOT EXISTS idx_notebooks_user ON notebooks (tenant_id, user_id, deleted_at);

-- ページ（1実験＝1ページ）。status='closed' は記録確定でロックされる
CREATE TABLE IF NOT EXISTS pages (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  notebook_id     TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft',
  experiment_date TEXT DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  CHECK (status IN ('draft', 'closed'))
);
CREATE INDEX IF NOT EXISTS idx_pages_notebook ON pages (tenant_id, notebook_id, deleted_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_pages_tenant_status ON pages (tenant_id, status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_pages_date ON pages (tenant_id, experiment_date, deleted_at);

-- 分子（そのページの試薬と生成物）。反応計算に必要な数値をそのまま保持する
CREATE TABLE IF NOT EXISTS molecules (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  page_id          TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'reactant',
  name             TEXT DEFAULT '',
  smiles           TEXT DEFAULT '',
  molfile          TEXT DEFAULT '',
  svg              TEXT DEFAULT '',
  cas_number       TEXT DEFAULT '',
  molecular_weight REAL,
  density          REAL,
  purity           REAL DEFAULT 100,
  equivalents      REAL DEFAULT 1.0,
  mass             REAL,
  moles            REAL,
  volume           REAL,
  molarity         REAL,
  is_reference     INTEGER DEFAULT 0,
  yield_percent    REAL,
  sort_order       INTEGER DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT,
  CHECK (role IN ('reactant', 'product'))
);
CREATE INDEX IF NOT EXISTS idx_molecules_page ON molecules (tenant_id, page_id, deleted_at, sort_order);
CREATE INDEX IF NOT EXISTS idx_molecules_cas ON molecules (tenant_id, cas_number);

-- 添付ファイル。実体はR2（ATTACHMENTSバインディング）、ここは台帳
CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  page_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  r2_key     TEXT NOT NULL,
  file_name  TEXT NOT NULL,
  file_size  INTEGER NOT NULL,
  mime_type  TEXT DEFAULT '',
  sha256     TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachments_page ON attachments (tenant_id, page_id, deleted_at);

-- ページの改訂履歴（追記専用）。実験ノートの証拠力はここが書き換わらないことで担保する。
-- 下のトリガでUPDATE/DELETEを禁止しているので、間違えても履歴は壊せない
CREATE TABLE IF NOT EXISTS page_revisions (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  page_id        TEXT NOT NULL,
  rev_no         INTEGER NOT NULL,
  author_user_id TEXT NOT NULL,
  snapshot       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (page_id, rev_no)
);
CREATE INDEX IF NOT EXISTS idx_page_revisions_page ON page_revisions (tenant_id, page_id, rev_no);

CREATE TRIGGER IF NOT EXISTS page_revisions_no_update
BEFORE UPDATE ON page_revisions
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS page_revisions_no_delete
BEFORE DELETE ON page_revisions
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- PubChem照会のキャッシュ（外部APIを叩く回数を減らす）。テナント共通でよい公開データ
CREATE TABLE IF NOT EXISTS pubchem_cache (
  query_type TEXT NOT NULL,
  query      TEXT NOT NULL,
  response   TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (query_type, query)
);

-- ページ全文検索。trigramトークナイザで日本語も部分一致できる（3文字以上が対象）
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  content,
  content='pages',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS pages_fts_ai AFTER INSERT ON pages
BEGIN
  INSERT INTO pages_fts (rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS pages_fts_ad AFTER DELETE ON pages
BEGIN
  INSERT INTO pages_fts (pages_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS pages_fts_au AFTER UPDATE ON pages
BEGIN
  INSERT INTO pages_fts (pages_fts, rowid, title, content)
  VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO pages_fts (rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
