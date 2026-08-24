-- 試薬マスタ・試薬在庫・機器の台帳。0001/0002は変更せず、ここに追記する。
-- 適用: npm exec -- wrangler d1 migrations apply erlen --remote
--
-- 設計の約束ごと（0001と同じ）
--   1. IDはULID（src/ulid.mjs）のTEXT。
--   2. 時刻はISO8601のTEXT。
--   3. 削除は deleted_at に時刻を入れる論理削除。
--   4. 全ての行に tenant_id を持たせ、アプリ側の全SQLに tenant_id = ? を付ける。
--
-- 3つの台帳の関係
--   reagent_masters … 「その研究室で使う試薬の定義」（分子量・CAS・構造式）。ページを跨いで使い回す。
--   reagent_stocks  … 「棚にある現物のボトル1本」。マスタに紐づけてもよいし、
--                     マスタに無い試薬なら custom_reagent_name に名前だけ書いてもよい。
--   equipments      … 「研究室の機器」。反応の記録に「どの機器を使ったか」を書くための一覧。

-- 試薬マスタ（試薬の定義。反応テーブルへ引き写す元になる）
CREATE TABLE IF NOT EXISTS reagent_masters (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  name             TEXT NOT NULL,
  cas_number       TEXT DEFAULT '',
  molecular_weight REAL,
  purity           REAL,
  density          REAL,
  smiles           TEXT DEFAULT '',
  -- 構造式。molfileが正本（Ketcherへ描き戻せる形）、svgは一覧に出す描画済みの絵。
  -- どちらも public/ketcher/editor.html が作る（moleculesテーブルと同じ扱い）
  molfile          TEXT DEFAULT '',
  svg              TEXT DEFAULT '',
  notes            TEXT DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_reagent_masters_tenant
  ON reagent_masters (tenant_id, deleted_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_reagent_masters_cas
  ON reagent_masters (tenant_id, cas_number);

-- 試薬在庫（棚の現物1本＝1行）。
-- reagent_master_id はNULL可。マスタに無い試薬は custom_reagent_name だけで登録できる
-- （姉妹アプリ elnectmobile のmigration 5と同じ判断。現物の記録を「マスタ登録待ち」で止めない）。
CREATE TABLE IF NOT EXISTS reagent_stocks (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  reagent_master_id   TEXT,
  custom_reagent_name TEXT DEFAULT '',
  manufacturer        TEXT DEFAULT '',
  lot_number          TEXT DEFAULT '',
  received_date       TEXT DEFAULT '',
  is_opened           INTEGER DEFAULT 0,
  storage_location    TEXT DEFAULT '',
  remaining_amount    REAL,
  remaining_unit      TEXT DEFAULT '',
  notes               TEXT DEFAULT '',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_reagent_stocks_tenant
  ON reagent_stocks (tenant_id, deleted_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_reagent_stocks_master
  ON reagent_stocks (tenant_id, reagent_master_id, deleted_at);

-- 機器
CREATE TABLE IF NOT EXISTS equipments (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  name              TEXT NOT NULL,
  category          TEXT DEFAULT '',
  capacity          TEXT DEFAULT '',
  temperature_range TEXT DEFAULT '',
  pressure_range    TEXT DEFAULT '',
  manufacturer      TEXT DEFAULT '',
  model_number      TEXT DEFAULT '',
  management_number TEXT DEFAULT '',
  notes             TEXT DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_equipments_tenant
  ON equipments (tenant_id, deleted_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_equipments_category
  ON equipments (tenant_id, category, deleted_at);
