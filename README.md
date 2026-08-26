# Erlen

**サーバーも、インストールするデータベースも、月額もいらない、化学者のためのオープンソース電子実験ノート。自分のクラウドアカウントへ置くだけで、記録はそこから外へ出ません。**

*An open-source electronic lab notebook for chemists that needs no server, no database to install, and no monthly bill — you deploy it into your own cloud account, and the records never leave it.*

> **Erlen（エルレン）** — 名前はエルレンマイヤーフラスコ（三角フラスコ）に由来します。
> つづりの **E**r**L**e**N** には、電子実験ノートを指す **ELN**（Electronic Lab Notebook）の
> 3文字がこの順で入っています。

構造式エディタ・反応の自動計算・試薬在庫・機器台帳・全文検索・印刷レポート・監査証跡が
**1つに入っていて、日本語と英語で使えます**。追加のコンテナも別サービスも要りません。

導入は **AIコーディングエージェントに「セットアップしてください」と頼むだけ**です。
コンテナも仮想マシンもシステム管理者も必要ありません。必要なのは自分のクラウドアカウントだけです。

- リポジトリ: <https://github.com/erlen-eln/erlen>
- ライセンス: **Apache License 2.0**（[LICENSE](LICENSE) / [NOTICE](NOTICE)）

---

## 日本語

### 何ができるか

| 機能 | 中身 |
|---|---|
| **実験ノート** | ノートブック → ページの2階層。自動保存。ページごとに目的・操作・考察を記録 |
| **構造式** | Ketcher（EPAM Systems 製・Apache-2.0）を同梱。ページ内で描いてそのまま保存。SMILES / molfile |
| **構造式の自動描画** | RDKit.js（BSD 3-Clause）を同梱。SMILESしか無い行も構造式が出る。オフラインで動作 |
| **反応の自動計算** | 反応テーブルに試薬を並べると、モル数・当量・理論収量・収率を自動計算 |
| **PubChem補完** | 化合物名・CASから分子式・分子量などを自動取得（30日キャッシュ・失敗しても手入力で続行） |
| **添付ファイル** | スペクトル画像・PDF・生データをページに添付（1ファイル既定25MBまで） |
| **全文検索** | SQLite FTS5による日本語対応の全文検索 |
| **印刷レポート** | ページを1枚のHTMLに整形。ブラウザの印刷でPDF化・製本できる。日英切替あり |
| **試薬マスタ / 在庫** | 試薬の台帳と、ロット単位の在庫管理。溶媒プリセット41件を同梱 |
| **機器管理** | 機器の台帳（メーカー・型番・管理番号・点検）。サンプルプリセット同梱 |
| **Googleログイン** | 招待制のマルチユーザー。owner / editor / viewer の3権限 |
| **プロジェクト** | ノートブックを束ね、**閲覧できる人を絞る**。外した人には、そのノートブックが「無い」ように見える（一覧にも検索結果にも印刷レポートにも出ない）。プロジェクトに入れないノートブックは全員が見られる |
| **複数オーナー** | オーナーは何人でも置ける。設置者（`OWNER_EMAIL` 本人）だけは降格も除名もできないので、管理者が居なくなることがない |
| **監査証跡** | ページの改訂履歴（`page_revisions`）を自動記録。誰がいつ何を変えたかが残る |
| **日英UI** | 画面ヘッダの `JA` / `EN` で切替。印刷レポートも `?lang=en` で英語になる |

**データは全部あなたのものです。** 提供者のサーバーを一切経由しません。
記録はあなたのCloudflareアカウントのD1（データベース）とR2（ファイル置き場）にだけ置かれます。

### 必要なもの

- **自分のCloudflareアカウント** — 無料プランで動きます（Workers / D1 / R2）
- **Googleアカウント** — ログインに使います。研究室で使うなら代表者のもの
- **AIコーディングエージェント**（Claude Code など） — セットアップと運用を任せます
- **Node.js 22.5以上** と npm — AIがコマンドを実行するために必要です
- モダンブラウザ（Chrome / Edge / Safari / Firefox の最新版）

自分でコマンドを打ちたい人向けの手順も同じ内容で [SETUP.md](SETUP.md) に書いてあります。

### セットアップの流れ

1. このリポジトリを取得する（`git clone`、または [Releases](https://github.com/erlen-eln/erlen/releases) のzip）
2. そのフォルダでAIコーディングエージェントを開き、**「Erlenをセットアップしてください」**と頼む
3. あなたがすることは3つだけです
   1. Cloudflare と Google に**ログインする**
   2. 画面に出た内容を**承認する**
   3. Googleのクライアントシークレットを**貼り付ける**

コマンドはすべてAIが実行します。ターミナルを覚える必要はありません。
人向けの案内ページ [guides/setup.html](guides/setup.html) には、AIへ渡す依頼文がコピーボタン付きで置いてあります。

- **更新するとき**: [guides/update.html](guides/update.html) を開いて、依頼文をAIへ渡す
- **AIが読む技術手順**: [SETUP.md](SETUP.md)
- **AIに運用を任せる前に**: [AI_CONSTITUTION.md](AI_CONSTITUTION.md)（AI憲法）を読ませてください

同梱スキル（AIコーディングエージェントから呼べます）:

| スキル | 使いどき | 呼び方の例 |
|---|---|---|
| `erlen-setup` | 初回セットアップ | 「Erlenをセットアップしてください」 |
| `erlen-update` | 新しい版が出たとき | 「新しい版を適用してください」 |
| `erlen-backup` | バックアップ・復元 | 「ノートのバックアップを取ってください」 |

### 構成

```text
ブラウザ（あなた・研究室のメンバー）
        │  Googleログイン（IDトークン検証・自前実装）
        ▼
┌─────────────────────────────────────────────┐
│  Cloudflare Workers  （あなたのアカウント）      │
│    src/worker.mjs      … HTTPの入口・権限ガード   │
│    src/auth.mjs        … Googleログイン（純関数） │
│    src/session.mjs     … テナント・権限の解決     │
│    src/api/*.mjs       … 業務ロジック（12本）     │
│    public/             … 画面＋Ketcher＋RDKit.js  │
└──────────┬──────────────────────┬───────────┘
           │                      │
      ┌────▼─────┐          ┌─────▼──────┐
      │  D1       │          │  R2         │
      │ 実験記録   │          │ 添付ファイル │
      │ 試薬・在庫 │          │             │
      │ 機器      │          │             │
      │ 監査証跡   │          │             │
      └───────────┘          └─────────────┘
```

主なフォルダ:

| パス | 中身 |
|---|---|
| `src/` | Workerのサーバーコード（依存ライブラリなし・素のJS） |
| `web/` | 画面のソース（React + TypeScript + Vite） |
| `public/` | 配信される静的アセット。`public/app/` はビルド済み画面、`public/ketcher/` は構造式エディタ、`public/rdkit/` は構造式を描くRDKit.js |
| `src/access.mjs` | 誰にどのノートブックが見えるかの判定。**ここ1本だけ**が閲覧範囲を決める |
| `migrations/` | D1のスキーマ（**追記のみ**。既存ファイルは書き換えない） |
| `scripts/` | `doctor.mjs`（公開前検査）・`package.mjs`（配布zip作成）・`copy-rdkit.mjs`（RDKit.jsの取り込み） |
| `test/` | ユニットテスト（`npm test` で全部走る） |
| `guides/` | 人向けのセットアップ・更新ガイド（HTML） |
| `.claude/skills/` | 同梱スキル（erlen-setup / erlen-update / erlen-backup） |

### よく使うコマンド

```bash
npm test                     # 全ユニットテスト
npm run doctor               # ローカルの設定検査
npm run doctor:remote        # Cloudflare側（secret・migrations）も含めた公開前検査
npm run build:web            # 画面を直したときのビルド（web/ → public/app/）
npm exec -- wrangler deploy  # 固定済みWranglerで本体をデプロイ
node scripts/package.mjs     # 配布zipを作る（テストが緑のときだけ）
```

### 質問・不具合の報告

手引きは [CONTRIBUTING.md](CONTRIBUTING.md)、脆弱性の報告先は [SECURITY.md](SECURITY.md)、
これからの見通しは [ROADMAP.md](ROADMAP.md) にあります。**日本語で書いていただいて構いません。**

用途で窓口を分けています。

| 相談したいこと | 行き先 |
|---|---|
| 使い方の質問・導入の相談・雑談 | Discordのコミュニティ「創星」の `🧪｜erlen` 部屋: <https://discord.gg/VzKjRGtzm> |
| 不具合の報告・機能の要望 | GitHub Issues: <https://github.com/erlen-eln/erlen/issues>（日本語で構いません） |
| 脆弱性の報告 | GitHubのSecurity Advisory（公開Issueにする前に、非公開でお知らせください） |

「創星」はAIで研究や仕事を効率化する人たちのコミュニティで、その中にErlen専用の部屋があります。
入れてみたいが最初の一歩で詰まりそう、というくらいの話から歓迎です。
ただし **実験データそのもの（化合物名・反応条件・生データ）は貼らないでください。**
画面をお見せいただくときは、写っている記録にマスクをお願いします。

- Pull Request も歓迎します。送っていただいた変更は Apache License 2.0 の
  §5（Submission of Contributions）に従って本プロジェクトへ取り込まれます
- 送る前に **`npm test` が全緑**であることを確認してください。テストの本数は減らさない約束です
- 画面（`web/`）を直したときは `npm run build:web` を実行し、`public/app/` も一緒にコミットしてください
  （利用者はビルドせずに使えるようにしてあります）

### ライセンス

- **本体は Apache License 2.0** です。全文は [LICENSE](LICENSE)、帰属表記は [NOTICE](NOTICE) にあります。
  Copyright 2026 Satoshi Kobayashi
- 同梱している**構造式エディタ Ketcher は EPAM Systems 製で Apache License 2.0** です
  （`public/ketcher/` 以下。全文は `public/ketcher/LICENSE`、上流の帰属表記は `public/ketcher/NOTICE`。
  バンドルに含まれる各OSSの表記は `public/ketcher/static/js/*.LICENSE.txt`）
- 同梱している**構造式の描画エンジン RDKit.js は BSD 3-Clause** です
  （`public/rdkit/` 以下。全文は `public/rdkit/LICENSE`、版は `public/rdkit/VERSION.txt`。
  取り込みは `npm run prepare:rdkit`）
- 化合物情報の照会先である PubChem は米国NIH/NLMの公開サービスです。
  取得したデータの利用条件は PubChem のポリシーに従ってください
- **CAS登録番号は同梱していません。** 溶媒プリセットの `cas_number` は空欄で配布しています
  （CAS登録番号は American Chemical Society の登録商標で、公開再配布にライセンスを求めているため）。
  必要な場合は画面のPubChem補完で埋めるか、手で入力してください
- 機器プリセットのメーカー名・型番は記入例です。実在の製品名は各社の商標なので同梱していません

### 免責

本ソフトウェアは Apache License 2.0 の定めるとおり、**現状有姿（AS IS）で、明示・黙示を問わず
いかなる保証もなく提供されます。** 使用によって生じた損害について、著作権者および貢献者は責任を負いません。

**研究記録は取り返しがつきません。** 運用に載せる前に必ず一度バックアップ手順
（`erlen-backup` スキル / SETUP.md §14）を試し、定期的なバックアップを習慣にしてください。
本ソフトウェアが生成する記録が、所属機関の規程や各種ガイドライン（研究データ管理・電子記録の要件等）を
満たすかどうかの判断は利用者が行うものとします。

同梱のプリセット（溶媒の密度・沸点・融点など）は初期値であり、グレード・供給元によって変わります。
**業務で使う前に必ずSDS／CoAで確認してください。**

**本プロジェクトは個人の私的プロジェクトであり、所属組織とは無関係です。**

### 責任者

**Satoshi Kobayashi（小林 学史）**

---

## English

**An open-source electronic lab notebook for chemists that needs no server, no database to install,
and no monthly bill — you deploy it into your own cloud account, and the records never leave it.**

The name comes from the Erlenmeyer flask; the spelling **E**r**L**e**N** also carries the three
letters of **ELN** (Electronic Lab Notebook) in order.

### What it does

Structure editor, reaction table with automatic stoichiometry, reagent and stock ledgers, equipment
ledger, full-text search, printable reports and an append-only audit trail — **all in one deployment,
in Japanese and English**. No extra containers, no extra services.

| Feature | What you get |
|---|---|
| **Lab notebook** | Notebooks → pages, autosaved. Purpose, procedure and discussion per page |
| **Structures** | Ketcher (by EPAM Systems, Apache-2.0) is bundled. Draw in the page, save as SMILES / molfile |
| **Structure rendering** | RDKit.js (BSD 3-Clause) is bundled, so rows that only have SMILES still render. Works offline |
| **Reaction calculations** | Moles, equivalents, theoretical yield and percent yield are computed as you fill the table |
| **PubChem lookup** | Formula, molecular weight and more from a name or CAS number (cached 30 days; manual entry still works if the lookup fails) |
| **Attachments** | Spectra, PDFs and raw data attached to a page (25 MB per file by default) |
| **Full-text search** | SQLite FTS5, tuned so Japanese text is searchable too |
| **Print reports** | Pages rendered into one HTML file; print to PDF from the browser. Japanese or English |
| **Reagents / stock** | Reagent master and lot-level stock. 41 solvent presets bundled |
| **Equipment** | Equipment ledger (maker, model, asset number, inspections) with sample presets |
| **Google sign-in** | Invitation-based multi-user with owner / editor / viewer roles |
| **Projects** | Group notebooks and restrict who can see them. To everyone else the notebook simply does not exist — not in lists, not in search, not in reports. Notebooks outside any project stay visible to the whole tenant |
| **Multiple owners** | Any number of owners; the installer (`OWNER_EMAIL`) can never be demoted or removed, so you cannot end up without an administrator |
| **Audit trail** | Every page revision is recorded (`page_revisions`): who changed what, and when |
| **Bilingual UI** | `JA` / `EN` in the header; reports accept `?lang=en` |

**The data is yours.** Nothing passes through anyone else's server. Records live only in the D1
database and R2 bucket of *your* Cloudflare account.

### What you need

- **Your own Cloudflare account** — the free plan is enough (Workers / D1 / R2)
- **A Google account** — used for sign-in; in a lab, use the principal investigator's
- **An AI coding agent** (such as Claude Code) — it performs the setup and the upgrades
- **Node.js 22.5+** and npm — the agent needs them to run commands
- A modern browser (current Chrome / Edge / Safari / Firefox)

If you would rather type the commands yourself, [SETUP.md](SETUP.md) contains the same procedure.

### Getting started

1. Get the repository (`git clone`, or the zip from [Releases](https://github.com/erlen-eln/erlen/releases))
2. Open your AI coding agent in that folder and ask it to **"set up Erlen"**
3. You only do three things:
   1. **Sign in** to Cloudflare and Google
   2. **Approve** what the agent shows you
   3. **Paste** your Google client secret

The agent runs every command; you do not need to learn the terminal.
[guides/setup.html](guides/setup.html) holds the request text with a copy button, and
[guides/update.html](guides/update.html) does the same for upgrades. Before you let an agent operate
the notebook, have it read [AI_CONSTITUTION.md](AI_CONSTITUTION.md).

Bundled skills: `erlen-setup` (first install), `erlen-update` (apply a new version),
`erlen-backup` (back up and restore).

### Common commands

```bash
npm test                     # all unit tests
npm run doctor               # local configuration check
npm run doctor:remote        # pre-flight check including secrets and migrations
npm run build:web            # rebuild the interface (web/ → public/app/)
npm exec -- wrangler deploy  # deploy with the pinned Wrangler
node scripts/package.mjs     # build a distributable zip (only when tests are green)
```

### Questions and contributions

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide, [SECURITY.md](SECURITY.md) for reporting
vulnerabilities and [ROADMAP.md](ROADMAP.md) for what is being considered next.
**Japanese is welcome** in issues and pull requests.

| What you want | Where to go |
|---|---|
| Questions, setup help, bugs, feature requests | GitHub Issues: <https://github.com/erlen-eln/erlen/issues> |
| Security problems | GitHub's private Security Advisory, never a public issue |

**In English, GitHub Issues is the place** — for questions as much as for bugs. A blank issue is fine;
"I would like to run this and I expect to get stuck at the first step" is a perfectly good one.
There is also a Japanese-speaking community on Discord with a room for Erlen
(<https://discord.gg/VzKjRGtzm>), but it is run in Japanese.

Wherever you write, please do not paste real experimental data — compound names, conditions or raw
records. Mask anything visible in a screenshot.

- Pull requests are welcome. Contributions are taken into the project under
  Apache License 2.0 §5 (Submission of Contributions)
- Make sure **`npm test` is fully green** before you send one; the test count is never reduced
- If you change the interface (`web/`), run `npm run build:web` and commit `public/app/` as well,
  so users never have to build

### License

- **Erlen is licensed under the Apache License, Version 2.0.** Full text in [LICENSE](LICENSE),
  attributions in [NOTICE](NOTICE). Copyright 2026 Satoshi Kobayashi
- **Ketcher** (structure editor, by EPAM Systems) is bundled under the Apache License 2.0 —
  see `public/ketcher/LICENSE` and `public/ketcher/NOTICE`, plus
  `public/ketcher/static/js/*.LICENSE.txt` for the libraries inside its bundle
- **RDKit.js** (structure rendering) is bundled under the BSD 3-Clause License —
  see `public/rdkit/LICENSE`; the version is recorded in `public/rdkit/VERSION.txt`
- PubChem, used for compound lookup, is a public service of the U.S. NIH/NLM; data you retrieve
  through it is subject to PubChem's policies
- **CAS Registry Numbers are not redistributed here.** The `cas_number` field of the bundled solvent
  presets ships empty ("CAS Registry Number" is a trademark of the American Chemical Society, which
  licenses public redistribution). Fill it in from PubChem in the app, or by hand
- Maker and model names in the equipment presets are placeholders; real product names are the
  trademarks of their owners and are not bundled

### Disclaimer

As stated in the Apache License 2.0, this software is provided **"AS IS", WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND**, either express or implied. The copyright holder and contributors are not
liable for any damages arising from its use.

**Research records cannot be recreated.** Before you rely on it, run the backup procedure once
(`erlen-backup` skill / SETUP.md §14) and make backups a habit. Whether the records this software
produces satisfy your institution's rules or any research-data / electronic-records guideline is for
you to determine.

Bundled preset values (densities, boiling and melting points) are starting points that vary with
grade and supplier. **Always confirm against the SDS / CoA before using them in real work.**

**This is a personal project and is not affiliated with any organization.**

### Maintainer

**Satoshi Kobayashi**
