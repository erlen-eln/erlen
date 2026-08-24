---
name: erlen-backup
description: 電子実験ノート（Erlen）のバックアップと復元を行うスキル。D1（実験記録・試薬・在庫・機器・改訂履歴）を wrangler d1 export で、R2の添付ファイルを attachments テーブルの台帳をもとに1件ずつローカルへ退避する。復元手順（破壊的なので必ず人の承認を取る）も含む。「バックアップを取って」「ノートを退避して」「復元して」「erlen backup」などで起動する。
---

# erlen-backup（バックアップと復元）

研究記録は取り返しがつきません。**このスキルは、消える前に走らせるためのものです。**

対象は2つ。**片方だけでは復元できません。**

| 対象 | 中身 | 保存先 |
|---|---|---|
| **D1** | 実験記録・分子・添付の台帳・改訂履歴・試薬・在庫・機器・メンバー | `backups/<日付>/erlen.sql` |
| **R2** | 添付ファイルの実体（スペクトル画像・PDF・生データ） | `backups/<日付>/files/` |

`backups/` は `.gitignore` 済み。**gitにコミットしない。**

---

## A. バックアップを取る

### 0. 前提

- `npm exec -- wrangler whoami` が通ること（切れていたら `wrangler login`）
- 保存先を作る: `backups/<YYYYMMDD>/files/`
- **バックアップは読み取りだけの操作**なので、人の承認は不要。いつ走らせてもよい

### 1. D1を書き出す

```bash
npm exec -- wrangler d1 export erlen --remote --output backups/<YYYYMMDD>/erlen.sql
```

- 出力された `.sql` の**サイズが0でないこと**と、`CREATE TABLE pages` などが
  含まれていることを確認する（空ファイルを「取れた」と言わない）
- 行数が多くて止まる場合はテーブルを分ける: `--table pages --table molecules` のように指定して複数回

### 2. 添付ファイルの台帳を引く

R2にはCLIの一覧コマンドがありません。**D1の `attachments` テーブルが台帳です。**

```bash
npm exec -- wrangler d1 execute erlen --remote --json \
  --command "SELECT r2_key, file_name, file_size FROM attachments WHERE deleted_at IS NULL ORDER BY r2_key"
```

返ってきたJSONの `results` が、退避すべきオブジェクトの全リストです。件数を控える。

### 3. 実体を1件ずつ落とす

`r2_key` ごとに実行する（AIがループを組んでよい）。

```bash
npm exec -- wrangler r2 object get erlen-attachments/<r2_key> --file=backups/<YYYYMMDD>/files/<r2_keyを平坦化した名前>
```

- 保存名は `r2_key` の `/` を `_` に置き換えるなど、**元のキーが復元できる形**にする。
  対応表を `backups/<YYYYMMDD>/files/index.json`（`{ r2_key, saved_as, file_name, file_size }` の配列）
  として必ず一緒に残す。**これが無いと復元できない**
- 件数が多い場合は、失敗した分だけ再実行できるよう、成功したキーを記録しながら進める

### 4. 検算する（省略禁止）

- ダウンロードできたファイル数 = 手順2の件数 か
- 各ファイルのバイト数が `file_size` と一致するか
- 一致しないものがあれば、**「取れた」と言わずに**利用者へ名指しで報告する

### 5. 保管する

- `backups/` はローカルのまま放置しない。**別の場所（外付け・機関のストレージ等）へコピー**するよう案内する
- 添付には未公開データが入っている。**暗号化した保管**をすすめる
- **四半期に1回、復元テストを行う**（下のB-3）

---

## B. 復元する（**破壊的操作・人の明示承認が必須**）

### B-0. 復元の前に必ず行うこと

1. **いま本番に入っているデータのバックアップを先に取る**（上のA。今日の分がまだなら必ず）
2. 利用者へ次を提示し、**明示的な承認を得る**。承認が無ければ実行しない
   - 何を、どの時点の状態へ戻すのか
   - 復元によって**失われる可能性のある記録**（バックアップ以後に書かれた分）
   - 戻せなかった場合にどうするか
3. 復元先のデータベース名を**声に出して確認する**（本番か、テスト用か）

### B-1. D1を戻す

```bash
npm exec -- wrangler d1 execute erlen --remote --file=backups/<YYYYMMDD>/erlen.sql
```

- エクスポートしたSQLには `CREATE TABLE` と `INSERT` が入っている。
  **既にテーブルがある本番へそのまま流すと衝突する**。原則は次のどちらか
  - **（推奨）新しいD1を作って流し込み**、中身を確認してから `wrangler.jsonc` の
    `database_id` を差し替えて `deploy` する（元のDBは消さずに残す）
  - 本番へ直接戻す場合は、**利用者の明示承認のうえ**で、
    衝突するテーブルの扱い（DROPして作り直すか、部分復元か）を先に決めてから実行する
- 流し終えたら `npm exec -- wrangler d1 migrations list erlen --remote` で
  migrationsの適用状態を確認し、未適用があれば適用する

### B-2. R2を戻す

`index.json` を読み、`saved_as` のファイルを元の `r2_key` へ戻す。

```bash
npm exec -- wrangler r2 object put erlen-attachments/<r2_key> --file=backups/<YYYYMMDD>/files/<saved_as>
```

- **`r2_key` は必ず台帳どおりに戻す**。キーが変わるとD1の `attachments` から実体を引けなくなる
- 全件終わったら、画面で添付を1つ開いてダウンロードできることを確認する

### B-3. 復元テスト（四半期に1回・本番に触らない）

1. `npm exec -- wrangler d1 create erlen-restore-test` で使い捨てのDBを作る
2. `wrangler d1 execute erlen-restore-test --remote --file=backups/<日付>/erlen.sql` で流す
3. `wrangler d1 execute erlen-restore-test --remote --command "SELECT COUNT(*) FROM pages"` などで件数を確認
4. 確認できたら `wrangler d1 delete erlen-restore-test`（**この削除だけは、
   名前が `-restore-test` で終わることを2回確認してから**）

---

## 掟

- **バックアップの結果を水増ししない。** 落とせなかったファイルは正直に報告する（第六条）
- **`page_revisions`（改訂履歴）を除外しない。** 監査証跡はバックアップの一部
- **添付の中身を読まない・外部へ送らない**（未公開データが入っている）
- **削除系のコマンドは、対象名を確認してから**。`d1 delete` / `r2 bucket delete` は
  人の明示承認なしに実行しない（AI_CONSTITUTION 第一条）
