# Contributing to Erlen / 貢献の手引き

**日本語で書いていただいて構いません。Issue も Pull Request も日本語で受け付けます。**

*Japanese is welcome. Issues and pull requests may be written in Japanese or English.*

---

## 日本語

### まず知っておいてほしいこと

Erlenが預かっているのは**研究記録**です。配信事故と違い、失われた実験データは二度と戻りません。
そのため、この製品には他のWebアプリより厳しい掟が3つあります。
コードを書く前に [AI_CONSTITUTION.md](AI_CONSTITUTION.md) を一読してください
（AI向けに書いてありますが、中身は人にもそのまま当てはまります）。

1. **記録を消さない。** 改訂履歴（`page_revisions`）を畳む・削除済み行を消す・
   除名メンバーの記録を消す、といった変更は受け取れません
2. **`migrations/` は追記のみ。** 既存のmigrationを書き換えると、すでに導入した人の環境が壊れます
3. **テストの本数を減らさない。** 赤を消すためにテストを緩めるのは、この製品では不具合と同じ扱いです

### 開発環境を立ち上げる

必要なのは **Node.js 22.5以上** と npm だけです。データベースの用意もコンテナも要りません。

```bash
git clone https://github.com/erlen-eln/erlen.git
cd erlen
npm ci                 # 本体の依存（wrangler など）
npm --prefix web ci    # 画面の依存（React / TypeScript / Vite）
npm test               # ここが全緑なら準備完了
```

`npm test` は Cloudflare にもネットワークにも繋ぎません。D1もR2もテスト内で差し替えているので、
アカウントを持っていなくてもコードの改修とテストはできます
（実際に動かすところまで確かめたい場合だけ、[SETUP.md](SETUP.md) の手順で自分のCloudflareへ配置してください）。

画面を直すとき:

```bash
npm run typecheck:web      # TypeScriptの型検査（CIでも走ります）
npm run build:web          # web/ → public/app/ へビルド
```

画面を触りながら動かすときは端末を2つ使います（Viteの `/api` と `/auth` は
`wrangler dev` へ転送されます。`web/vite.config.ts` の `server.proxy` にその設定があります）。

```bash
npx wrangler dev           # 端末1: APIを http://127.0.0.1:8787 で動かす
npm --prefix web run dev   # 端末2: 画面のホットリロード
```

### テストの走らせ方

```bash
npm test                                    # 全部（node --test）
node --test test/reaction-calc.test.mjs     # 1ファイルだけ
node --test --test-name-pattern="収率"      # 名前で絞る
```

テストランナーは Node 標準の `node --test` です。追加のフレームワークは入れていません
（依存を増やさないための判断です）。新しいテストは `test/*.test.mjs` に置けば自動で拾われます。

出荷前の機械検査も `npm test` に入っています。

| テスト | 何を見張っているか |
|---|---|
| `test/tenant-scope.test.mjs` | テナント別テーブルを触るSQLに `tenant_id = ?` があるか |
| `test/dist-clean.test.mjs` | 配布物に開発者固有の文字列・個人メール・実IDが混ざっていないか |
| `test/licensing.test.mjs` | LICENSE / NOTICE と同梱物のライセンス表記が欠けていないか |
| `test/changelog.test.mjs` | `CHANGELOG.json` と `guides/update.html` が食い違っていないか |
| `test/wrangler-secrets.test.mjs` | コードが読む `env.*` が `wrangler.jsonc` の台帳に載っているか |
| `test/i18n-parity.test.mjs` | 日本語と英語の文言に抜けが無いか |

### 設計の掟

- **`src/api/*.mjs` は `Response` を作らない。** `{ status, data }` を返す素の関数のままにしてください。
  JSON化とHTTPの体裁は `src/worker.mjs` の仕事です（この境目があるからAPIを直接テストできます）
- **テナント別テーブルを触るSQLには必ず `tenant_id = ?` を付ける。** 機械検査があります
- **誰に何が見えるかは `src/access.mjs` 1本だけが決める。** 判定をあちこちに増やさないでください
- **`migrations/` は追記のみ。** 列を消したいときは、消さずに使わなくします
- **`public/ketcher/` と `public/rdkit/` は1バイトも触らない。** 上流のビルド成果物です
  （Ketcherの分子テンプレートはCRLFに依存していて、改行を正規化すると構造データが壊れます。
  `.gitattributes` の該当行も消さないでください）
- **`public/app/` はビルド成果物ですが、コミットが必要です。** 利用者がビルドせずに使えるように
  してあるためです。`web/` を直したら `npm run build:web` を実行し、`public/app/` も一緒に含めてください
- **秘密の値をファイル・ログ・コミットに書かない。** `wrangler secret put` だけで扱います
- 依存ライブラリを増やす提案は歓迎しますが、まずIssueで相談してください。
  `src/` は依存ゼロ（素のJS）で書いてあります

### Pull Requestの出し方

1. リポジトリをフォークして、ブランチを切る（例: `fix/print-report-margin`）
2. 直す。**テストを添える**（不具合なら「直る前は落ちるテスト」を先に書くのがいちばん確実です）
3. `npm test` を全緑にする。画面を触ったなら `npm run build:web` も実行する
4. 利用者から見た振る舞いが変わるなら、[CHANGELOG.json](CHANGELOG.json) の先頭 `unreleased` エントリに
   **ja と en を1行ずつ**足す（件数が揃っていないとテストが落ちます）。
   `unreleased` が無ければ、先頭に1つだけ作ってください
5. Pull Requestを出す。テンプレートのチェック項目を埋める
6. CI（GitHub Actions）が `npm test` と型検査を走らせます。赤いまま取り込むことはありません

コミットメッセージは日本語でも英語でも構いません。**何をしたかより、なぜそうしたかを書いてください。**

送っていただいた変更は、Apache License 2.0 §5（Submission of Contributions）に従って
本プロジェクトへ取り込まれます。CLA（貢献者ライセンス同意書）への署名は求めていません。

### Issueを出すとき

- 不具合・要望は <https://github.com/erlen-eln/erlen/issues> へ。テンプレートがあります
- **秘密の値と未公開の研究データを貼らないでください。** シークレット・セッションCookie・
  D1の `database_id`・ページ本文・添付は、報告に必要ありません
- **脆弱性はIssueにしないでください。** [SECURITY.md](SECURITY.md) の手順（GitHubの非公開の
  Security Advisories）でお願いします

翻訳（日本語↔英語）の直し、ドキュメントの誤りの指摘、プリセットの数値の訂正も立派な貢献です。

---

## English

### Before you start

Erlen holds **research records**. Unlike a broken deployment, lost experimental data cannot be
recreated, so this project keeps three rules that are stricter than a typical web app. Please read
[AI_CONSTITUTION.md](AI_CONSTITUTION.md) once — it is addressed to AI agents, but it applies to
humans word for word.

1. **Never destroy records.** Changes that compact revision history (`page_revisions`), purge
   soft-deleted rows, or erase the work of removed members cannot be accepted
2. **`migrations/` is append-only.** Editing an existing migration breaks every deployment that
   already applied it
3. **Never reduce the test count.** Weakening a test to turn it green is treated as a defect here

### Setting up

All you need is **Node.js 22.5+** and npm. No database to install, no containers.

```bash
git clone https://github.com/erlen-eln/erlen.git
cd erlen
npm ci                 # server dependencies (wrangler and friends)
npm --prefix web ci    # interface dependencies (React / TypeScript / Vite)
npm test               # green here means you are ready
```

`npm test` touches neither Cloudflare nor the network — D1 and R2 are substituted inside the tests,
so you can develop without an account. You only need [SETUP.md](SETUP.md) when you want to run the
real thing in your own Cloudflare account.

For interface work:

```bash
npm run typecheck:web      # TypeScript check (CI runs this too)
npm run build:web          # build web/ into public/app/
```

To work on the interface live, use two terminals — Vite forwards `/api` and `/auth` to
`wrangler dev` (see `server.proxy` in `web/vite.config.ts`).

```bash
npx wrangler dev           # terminal 1: the API on http://127.0.0.1:8787
npm --prefix web run dev   # terminal 2: the interface with hot reload
```

### Running the tests

```bash
npm test                                    # everything (node --test)
node --test test/reaction-calc.test.mjs     # a single file
node --test --test-name-pattern="yield"     # by test name
```

The runner is Node's built-in `node --test`; no test framework is installed, deliberately. Any new
`test/*.test.mjs` file is picked up automatically.

`npm test` also contains the shipping gates: tenant isolation (`tenant-scope`), leftover developer
strings and personal data (`dist-clean`), license notices (`licensing`), changelog consistency
(`changelog`), the secret ledger (`wrangler-secrets`) and translation parity (`i18n-parity`).

### Design rules

- **`src/api/*.mjs` never builds a `Response`.** It returns plain `{ status, data }`; turning that
  into HTTP and JSON is `src/worker.mjs`'s job. That seam is what makes the API directly testable
- **Every query against a tenant-scoped table carries `tenant_id = ?`.** A test enforces it
- **`src/access.mjs` is the only place that decides who can see which notebook.** Keep it that way
- **`migrations/` is append-only.** To retire a column, stop using it rather than dropping it
- **Do not modify `public/ketcher/` or `public/rdkit/`.** They are upstream build artifacts
  (Ketcher's molecule templates depend on CRLF; normalizing line endings corrupts them — the
  `.gitattributes` entries that protect them must stay)
- **`public/app/` is a build artifact that is committed on purpose**, so users never have to build.
  If you touch `web/`, run `npm run build:web` and include `public/app/` in the same commit
- **Never put secrets in files, logs or commits.** They live only in `wrangler secret put`
- Proposals to add a dependency are welcome, but open an issue first — `src/` is written with zero
  runtime dependencies

### Sending a pull request

1. Fork and branch (for example `fix/print-report-margin`)
2. Make the change, **with a test**. For a bug, the surest route is a test that fails before the fix
3. Get `npm test` fully green; run `npm run build:web` if you touched the interface
4. If users will notice the change, add one line to **both `ja` and `en`** in the `unreleased` entry
   at the top of [CHANGELOG.json](CHANGELOG.json) (the counts must match, and a test checks it)
5. Open the pull request and fill in the checklist
6. CI runs `npm test` and the type check. Nothing is merged red

Write the commit message in Japanese or English — **explain why, not just what.**

Contributions are taken into the project under Apache License 2.0 §5 (Submission of Contributions).
No CLA is required.

### Filing an issue

- Bugs and requests: <https://github.com/erlen-eln/erlen/issues> (templates provided)
- **Never paste secrets or unpublished research data** — not the client secret, not a session
  cookie, not the D1 `database_id`, not page contents or attachments
- **Vulnerabilities do not belong in issues.** Follow [SECURITY.md](SECURITY.md) and use GitHub's
  private Security Advisories

Translation fixes, documentation corrections and preset-value corrections are all real contributions.
