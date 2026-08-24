# Security Policy / セキュリティ方針

**日本語で書いていただいて構いません。** *Japanese is welcome.*

---

## 日本語

### 脆弱性の報告先

**公開Issueにしないでください。** GitHubの非公開の報告窓口（Private vulnerability reporting /
Security Advisories）を使ってください。

- 報告フォーム: <https://github.com/erlen-eln/erlen/security/advisories/new>
- リポジトリの **Security** タブ → **Report a vulnerability** からも開けます

やり取りはその非公開スレッドの中だけで行います。メールでの受付はしていません
（窓口を1つにしておかないと、報告が埋もれるためです）。

### 書いていただきたいこと

- 影響（何ができてしまうか。他人の実験記録が読める／書ける、権限昇格、認証の回避、など）
- 再現手順。可能なら最小の手順で
- 影響する版（`package.json` の `version`、または `guides/update.html` の表示）
- 直し方の心当たりがあれば、その案

**報告に秘密の値と実データを含めないでください。** クライアントシークレット・セッション鍵・
Cookie・D1の `database_id`・未公開の研究データは、脆弱性の説明に必要ありません。
どうしても必要なときは、その旨だけ書いて送ってください。

### 対応の目安

個人が運営している私的プロジェクトです。**応答時間の保証（SLA）はしません。**
そのうえで、次を目安に動きます。

| 段階 | 目安 |
|---|---|
| 受け取ったことの返事 | おおむね数日以内 |
| 事実確認と、影響範囲・深刻度の共有 | おおむね2週間以内 |
| 修正版の公開 | 深刻なものから順に。日付の約束はしません |

修正は GitHub Releases で配ります。深刻なものは Security Advisory を公開し、
[CHANGELOG.json](CHANGELOG.json) にも記載します。
**報告者のお名前は、希望があればAdvisoryに掲載します**（不要ならその旨をお書きください）。

### 対象になる版

サポートするのは**最新のリリース版1つだけ**です。古い版への個別のバックポートはしていません。
更新は `erlen-update` スキル（`guides/update.html`）で当てられます。

| 版 | 状態 |
|---|---|
| 最新のリリース版 | サポート対象 |
| それ以前 | 対象外（最新版へ更新してください） |

### この製品の前提

Erlenは**利用者自身のCloudflareアカウントの中だけ**で動きます。提供者のサーバーはありません。
したがって次は利用者の責任範囲です。

- Cloudflare / Googleのアカウントとその2段階認証
- `wrangler secret put` で入れた値（`GOOGLE_CLIENT_SECRET` / `SESSION_SECRET` など）の管理
- `OWNER_EMAIL` に置いたアカウントの管理と、招待するメンバーの選定
- バックアップ（`erlen-backup` スキル / SETUP.md §14）

一方、**次はこちらの責任範囲**であり、脆弱性の報告対象です。

- テナント分離の破れ（他のテナントの記録が見える・書ける）
- プロジェクトの閲覧制限の破れ（`src/access.mjs` の判定漏れ）
- 権限の破れ（viewer が書ける、editor がメンバー管理をできる、など）
- セッション・Googleログイン（IDトークン検証）の欠陥
- 添付ファイルの取り違え・権限を無視した取得
- 監査証跡（`page_revisions`）を残さずにページを書き換えられること

### 対象外

- 利用者自身の設定ミス（招待していい相手を間違えた、`OWNER_EMAIL` の取り違え、
  secretを共有してしまった、など）
- Cloudflare・Googleそのものの問題（各社へ報告してください）
- 同梱している第三者OSS（Ketcher / RDKit.js）の脆弱性。上流へ報告してください。
  ただし**同梱している版が古いために危ない**という指摘は歓迎します
- 実証を伴わない、自動スキャナの出力の転載

---

## English

### Where to report

**Please do not open a public issue.** Use GitHub's private vulnerability reporting:

- <https://github.com/erlen-eln/erlen/security/advisories/new>
- or the repository's **Security** tab → **Report a vulnerability**

Everything is handled inside that private thread. There is no email intake — keeping a single
channel is what stops reports from being lost.

### What to include

- Impact (what an attacker can actually do — read or write someone else's records, escalate a role,
  bypass sign-in, and so on)
- Steps to reproduce, as minimal as you can make them
- Affected version (`version` in `package.json`, or the version shown in `guides/update.html`)
- A suggested fix, if you have one

**Do not include secrets or real data.** The client secret, the session key, cookies, the D1
`database_id` and unpublished research data are never needed to explain a vulnerability.

### Response targets

This is a personal project run by one person. **No response-time SLA is promised.** As a guide:

| Stage | Target |
|---|---|
| Acknowledgement | usually within a few days |
| Confirmation, with impact and severity | usually within two weeks |
| Fixed release | most severe first; no date is promised |

Fixes ship through GitHub Releases. Serious issues get a published Security Advisory and an entry in
[CHANGELOG.json](CHANGELOG.json). **Reporters are credited in the advisory on request** — say so if
you would rather not be.

### Supported versions

Only the **latest release** is supported; there are no backports to older versions. Upgrading is
what the `erlen-update` skill (`guides/update.html`) is for.

### Where the boundary sits

Erlen runs entirely inside **your own** Cloudflare account; there is no vendor server. So your
Cloudflare and Google accounts, the values you place with `wrangler secret put`, the account in
`OWNER_EMAIL`, who you invite, and your backups are yours to look after.

In scope for a report: tenant isolation failures, project visibility failures (`src/access.mjs`),
role enforcement failures, defects in session handling or Google ID-token verification, attachments
served to the wrong person, and any way to change a page without leaving a `page_revisions` entry.

Out of scope: your own misconfiguration, issues in Cloudflare or Google themselves, vulnerabilities
in bundled third-party software (report those upstream — although "the bundled version is outdated
and vulnerable" is a welcome report here), and raw automated-scanner output without a demonstration.
