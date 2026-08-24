---
name: erlen-update
description: 電子実験ノート（Erlen）の新しい版を、運用中の環境へ安全に適用するスキル。持ち主の資産（wrangler.jsoncの★値・D1の実験記録・R2の添付ファイル・投入済みsecret）を壊さずに、migrations追記→テスト→deploy→doctorの順で更新する。「新しい版を適用して」「アップデートして」「バージョンを上げて」「erlen update」などで起動する。
---

# erlen-update（新版の適用）

**運用中のフォルダで**実行するスキルです。新版フォルダ側で走らせない。
手順の正本は `SETUP.md` §15。このファイルは実行順と禁止事項を締めたものです。

## 起動したら最初にやること（省略禁止）

1. `AI_CONSTITUTION.md` を全文読む（特に第一条=データ保護・第二条=追記主義・第三条=持ち主の資産）
2. `SETUP.md` の §15「更新の適用」を読む
3. **新版フォルダの場所を利用者に確認する**（聞かずに探し回らない）
4. 版を比べる: 運用中の `package.json` の `version` と、新版の `package.json` の `version`
   - 新版が**同じか古い**なら、**適用しない**。その旨を報告して終わる

## 絶対に上書き・初期化しないもの（持ち主の資産）

| 対象 | 中身 | 守り方 |
|---|---|---|
| `wrangler.jsonc` | ★の値（`database_id` / `BASE_URL` / `OWNER_EMAIL` / `MAX_ATTACHMENT_MB`） | 退避して戻す。新版側の差分だけ手で移す |
| D1 | 実験記録・分子・試薬・在庫・機器・**改訂履歴** | 触らない。migrationsの**追加適用**だけ |
| R2 | 添付ファイルの実体 | 触らない |
| Cloudflare secrets | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `SESSION_SECRET` | 触らない（フォルダ差し替えの影響を受けない） |
| `backups/` `logs/` `.dev.vars` | 利用者のローカル資産 | コピーしない・消さない |
| `CLAUDE.md` | 利用者が書き足した運用メモがあり得る | **退避して戻す**。新版の本文へ、退避した追記だけを移す |

**新版で置き換えるのは上記以外の全部**:
`src/` `web/` `public/` `test/` `migrations/` `scripts/` `guides/` `.claude/`
`SETUP.md` `README.md` `AI_CONSTITUTION.md` `LICENSE` `NOTICE` `CHANGELOG.json`
`package.json` `package-lock.json` `.gitignore` `.gitattributes`。

`CLAUDE.md` は新版にも入っています。**利用者が何も書き足していなければ、そのまま新版で置き換えてよい**
（差分を見て判断する）。書き足しがあれば、その段落だけを新版の末尾へ移して戻す。

## 実行順（この順で・飛ばさない）

### 1. 控えを取る（ここを飛ばしたら以降すべて禁止）

- 運用中フォルダを丸ごとコピーして退避（例: 同階層に `<フォルダ名>-backup-<日付>`）
- **D1のバックアップを取る**: `erlen-backup` スキルを実行する
  （最低でも `npm exec -- wrangler d1 export erlen --remote --output backups/erlen-<日付>.sql`）
- 添付が増えているなら、R2側の退避も `erlen-backup` に任せる

### 2. 差し替える

1. 運用中の `wrangler.jsonc` と `CLAUDE.md` を安全な場所へ退避する
2. 「置き換えるもの」を新版の中身で上書きする
3. 退避した `wrangler.jsonc` を戻し、`CLAUDE.md` は退避した追記だけを新版の本文へ移す
4. **新旧の `wrangler.jsonc` を diff で突き合わせる**。★以外に変更があれば
   （新しいバインディング・`compatibility_date` の更新・新しい `vars` など）、
   **その差分だけを手で移植する**。★の値は運用中のものを維持する
5. 新版で `vars` や secret が増えていた場合は、`SETUP.md` を読んで設定を足す
   （secretの投入が要るなら、値は**利用者に入力してもらう**）。
   例: v1.3.0 で `vars.DEMO_MODE` が増えた。**自分のノートでは `"0"` のままにする**
   （`"1"` は展示用の公開デモ機だけ。詳しくは SETUP.md §16）
6. その版で何が変わったかは `CHANGELOG.json` の先頭（または `guides/update.html` の「変更履歴」）を読み、
   **完了報告に要点を書く**

### 3. 検査する

```bash
npm ci
npm test
```

- **赤が1件でもあればここで止まる。** deployへ進まない。内容を利用者に報告して判断を仰ぐ
- `npm ci` は `package-lock.json` が新版のものになっている前提。`npm install` で代用しない

### 4. スキーマを追加適用する

```bash
npm exec -- wrangler d1 migrations apply erlen --remote
```

- **増えたmigrationの適用だけ**。既存の `.sql` を書き換えない・消さない（第二条）
- 適用前に `npm exec -- wrangler d1 migrations list erlen --remote` で何が増えるかを確認し、
  **スキーマ変更の内容を利用者に一言伝えてから**実行する
- 破壊的なDDL（DROP / 列削除 / データ移行を伴うもの）が含まれていたら、
  **実行前に必ず利用者の明示承認を取る**

### 5. 反映して確かめる

```bash
npm exec -- wrangler deploy
npm run doctor:remote
```

- `doctor:remote` が**全項目 ✓**で、表示される版番号が新しくなっていること
- 反映直後の十数秒は旧版に当たることがある。少し待ってから確認する

### 6. 目視確認（利用者と一緒に）

- ブラウザでログインできる
- **更新前に書いたページがそのまま見える**（ノート一覧・ページ本文・構造式）
- 添付ファイルが開ける
- 検索がヒットする

## 画面（web/）を触った場合の追加手順

新版を当てるだけなら不要（`public/app/` にビルド済みが入っている）。
更新のついでに画面を改造した場合だけ:

```bash
npm run build:web   # web/ → public/app/ を焼き直す
npm test
npm exec -- wrangler deploy
```

ソースだけ直して「直りました」と言わない（AI_CONSTITUTION 第四条）。

## 失敗したときの戻し方

1. 手順1で取ったフォルダの控えへ戻す
2. `npm ci` → `npm test` → `npm exec -- wrangler deploy`
3. **D1は原則そのままでよい**（migrationsは追記なので、旧コードでも動くことが多い）。
   どうしてもDBを戻す必要がある場合は、**破壊的操作なので利用者の明示承認**を取り、
   `erlen-backup` の復元手順に従う

## 完了報告に必ず含めるもの

- 旧版 → 新版の版番号
- 取った控えの場所（フォルダのコピー先・D1バックアップのファイル名）
- 適用したmigrationの一覧（無ければ「なし」）
- `npm test` の結果と `doctor:remote` の全項目
- 目視確認の結果（「更新前のページが見えた」まで含める）
