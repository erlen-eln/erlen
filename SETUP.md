# Erlen セットアップ手順書（一本道）

この手順書は、作業AI（Claude Codeなど）に「SETUP.mdの通りにセットアップして」と渡すための
**AI向け技術手順**です。人にコマンド入力や管理画面の設定を求めず、AIが実行してください。

**役割分担（この手順書の前提・冒頭宣言）**

- **人が行うのは3つだけ**: ①各サービスへの**ログインと承認**（Cloudflare・Google）
  ②2段階認証・CAPTCHAなど本人にしかできない操作
  ③**秘密値の貼り付け**（Googleのクライアントシークレットを`wrangler secret put`の入力欄へ）
- **コマンドはすべてAIが実行する**。人にターミナルを打たせない
- ブラウザで進み具合を確認したい人は、先に[初回セットアップガイド](guides/setup.html)を開く
  （AIへ渡す依頼文がコピーボタン付きで置いてあります）

**運用・改造をAIに任せるときは、[AI_CONSTITUTION.md](AI_CONSTITUTION.md)（AI憲法）を必ず読ませてください。**
研究データ保護・migrations追記主義・秘密の扱いの掟です。

上から順に進めれば、Googleログインつきの電子実験ノートが自分のCloudflareアカウント上に立ち上がります。
所要時間の目安は30〜60分（うち大半はGoogle OAuthの画面操作）。

---

## 0. この手順書の読み方

各章は「やること → コマンド → **つまずいたら**」の3点セットです。
**章を飛ばさないこと。** 特に §3（D1）→ §5（migrations）→ §7（OAuth）→ §9（★埋め）→ §10（deploy）は
順序に依存があります。

この製品が使うCloudflareのサービスは3つ。すべて**無料枠**の範囲で動きます。

| サービス | 用途 | 無料枠の目安 |
|---|---|---|
| Workers | アプリ本体と画面の配信 | 10万リクエスト/日 |
| D1 | 実験記録・試薬・在庫・機器・監査証跡 | 5GB・500万行読み取り/日 |
| R2 | 添付ファイル（スペクトル画像・PDF等） | 10GB保存・下り無料 |

**つまずいたら**: 「無料枠を超えないか」と聞かれたら、研究室1つ分（数人・数千ページ）なら
まず超えないと答える。R2は下り転送が無料なので、添付を多く置いても課金は保存量だけ。

---

## 1. 前提の確認

まずローカルで完結する検査を通します。ここが緑にならないまま先へ進まないこと。

```bash
node -v                 # v22.5.0 以上であること
npm ci                  # 固定済みのWranglerを含めて再現可能にインストール
npm test                # 全テストが緑であることを確認
npm run doctor          # ローカル分の設定検査（この時点では★未置換で赤が出て正常）
```

- `npm ci` は `package-lock.json` を使う。`npm install` ではなく `ci` を使うこと
  （配布zipには `node_modules` が入っていないので、展開後は必ず1回必要）
- この時点の `npm run doctor` は「wrangler.jsoncに未置換値があります」で落ちる。**それが正常**。
  §9まで進めば緑になる

**必要なもの**（無ければここで止まって人に案内する）

- Node.js 22.5以上 と npm
- Cloudflareアカウント（無料プランでよい。未取得ならサインアップを案内する）
- Googleアカウント（ログインに使う。研究室で共有するなら代表者のもの）

### つまずいたら

- **Node.jsが古い**: 22.5未満だと `node --test` のglob解決とWorkers互換に差が出る。
  先にNode.jsを更新する。`nvm` / `fnm` があればそれで、無ければ公式インストーラを案内する
- **`npm ci` が `package-lock.json` が無いと言う**: zipの展開先ではなく別の場所にいる。
  `package.json` と同じ階層で実行しているか確認する
- **`npm test` が0件で緑に見える**: Windowsのcmdでglobが展開されていない。
  `package.json` の test スクリプトが**ダブルクォート**の `"test/**/*.test.mjs"` であることを確認する
  （このリポジトリは対策済み。書き換えないこと）

---

## 2. Cloudflareにログインする（人: ブラウザ承認）

```bash
npm exec -- wrangler login
```

- ブラウザが開いて Cloudflare の許可画面が出る。**ここは人が「Allow」を押す**
- AIはコマンドを実行したら「ブラウザで承認してください」と伝えて待つ。勝手に別の手を打たない
- 済んだら確認する:

```bash
npm exec -- wrangler whoami
```

アカウントのメールと Account ID が表示されれば成功。

### つまずいたら

- **ブラウザが開かない（SSH越し・ヘッドレス）**: 表示されたURLを人に渡して開いてもらう。
  それも無理ならAPIトークン方式（`CLOUDFLARE_API_TOKEN` 環境変数）に切り替える。
  トークンは「Edit Cloudflare Workers」テンプレートに D1 Edit と R2 Edit を足したものが必要
- **複数アカウントに所属していて選べと言われる**: `wrangler whoami` でAccount IDを確認し、
  使いたい方の `CLOUDFLARE_ACCOUNT_ID` を環境変数に入れてから再実行する
- **数時間後にまた認証を求められる**: OAuthセッションの有効期限。`wrangler login` をやり直せばよい

---

## 3. D1データベースを作る

```bash
npm exec -- wrangler d1 create erlen
```

出力に `database_id = "xxxxxxxx-xxxx-..."` が出る。この値を `wrangler.jsonc` の
`REPLACE_WITH_YOUR_D1_DATABASE_ID` と**差し替える**（★印の1つめ）。

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "erlen",
    "database_id": "ここに出力されたIDを貼る"
  }
]
```

- `database_id` は秘密ではない（Cloudflareアカウントの中でしか使えない）。ファイルに書いてよい
- **`database_name` は `erlen` のまま変えない**。以降のコマンド・doctorがこの名前を使う

### つまずいたら

- **「already exists」**: 以前に作ってある。`npm exec -- wrangler d1 list` でIDを引いて貼る
- **貼ったのにdoctorが未置換と言う**: `REPLACE_WITH_YOUR_D1_DATABASE_ID` の文字列が
  コメント行にも残っていないか確認する（doctorはコメントを除去してから見るので、
  値側に残っている場合だけ落ちる）
- **JSONが壊れた**: `wrangler.jsonc` はコメント付きJSON。カンマの過不足に注意。
  `npm run doctor` が「wrangler.jsoncを読めません」と言ったらここ

---

## 4. R2バケットを作る（添付ファイルの置き場）

```bash
npm exec -- wrangler r2 bucket create erlen-attachments
```

- バケット名は `wrangler.jsonc` の `r2_buckets[].bucket_name` と**完全一致**させる（既定 `erlen-attachments`）
- 初回だけ「R2を有効化してください」と言われることがある。その場合はCloudflareダッシュボードの
  R2ページで有効化する（**支払い方法の登録を求められるが、無料枠の範囲なら課金は発生しない**）。
  この確認は人の承認事項なので、AIは説明してから依頼する

### つまずいたら

- **バケット名の重複**: R2のバケット名はアカウント内で一意。既にあるなら作らずそのまま使う
- **添付が413で弾かれる**: 仕様。1ファイルの上限は `wrangler.jsonc` の `MAX_ATTACHMENT_MB`（既定25MB）。
  大きな生データを載せたい場合だけ、人に相談してから引き上げる
- **R2を作らずにdeployした**: バインディングが解決できずデプロイが失敗する。先にバケットを作る

---

## 5. D1のmigrationsを適用する

```bash
npm exec -- wrangler d1 migrations apply erlen --remote
```

`migrations/` の `.sql` を番号順に本番D1へ流します（実験ノート・分子・添付・監査証跡・
メンバー・試薬・在庫・機器のテーブルが作られます）。

- **`--remote` を必ず付ける**。付けないとローカルの `.wrangler/` の中の仮DBに当たり、本番は空のまま
- 適用済みのものは自動でスキップされる（何度実行しても安全）

### つまずいたら

- **「Couldn't find DB」**: §3の `database_id` が空か間違い。`wrangler.jsonc` を見直す
- **途中で失敗した**: `npm exec -- wrangler d1 migrations list erlen --remote` で
  どこまで通ったか確認する。**失敗したmigrationファイルを手で書き換えない**
  （番号を追記して直すのが原則。AI_CONSTITUTION 第二条）
- **本番のデータを消してやり直したくなった**: 実験記録が入っている場合は絶対にやらない。
  空のうちだけ、人の明示承認を取ってから `d1 delete` → §3からやり直す

---

## 6. 公開URL（サブドメイン）を確定する

Google OAuthのリダイレクトURIを登録するには、**先にURLが決まっている必要があります**。
Workers の URL は `https://<Worker名>.<あなたのサブドメイン>.workers.dev` の形。
Worker名は `wrangler.jsonc` の `"name"`（既定 `erlen`）です。

サブドメインの確定方法（どちらでもよい）:

```bash
npm exec -- wrangler whoami        # アカウント情報を確認
npm exec -- wrangler deploy        # 一度デプロイすると、出力に本番URLがそのまま出る
```

**この時点でのデプロイは「URLを確定させるための空撃ち」で問題ありません。**
ログインに必要なsecretがまだ無いので、`/auth/login` は503を返します（設計どおり・後で直る）。

確定したURL（例: `https://erlen.<あなたのサブドメイン>.workers.dev`）を控えて §7 へ進みます。

### つまずいたら

- **workers.dev のサブドメインをまだ作っていない**: 初回デプロイ時に登録を求められる。
  好きな名前を1つ決める（アカウントに1つだけ・後から変更は面倒なので素直な名前に）
- **Worker名を変えたい**: `wrangler.jsonc` の `"name"` を変えてよい。ただし
  **変えたらURLも変わる**ので、§7のリダイレクトURIと §9 の BASE_URL も同じ値に揃える
- **独自ドメインを使いたい**: 可能だが初回は workers.dev で通し切ること。
  独自ドメインは後から Custom Domain を足して BASE_URL を差し替える（§16参照）

---

## 7. Google OAuthを設定する（**人の手が必要な箇所あり**）

セットアップ全体で一番迷いやすい工程です。**ブラウザ操作ができるAIは代行してください。**
人にGoogle Cloud Consoleを自力で触らせると、ほぼ確実にどこかで詰まります。

**人が行うこと**: Googleへのログイン（2段階認証まで）、同意画面の作成承認、
そして最後に**クライアントシークレットの貼り付け**（§8）。それ以外はAIが操作します。

### この製品のOAuthの性質（重要・テストモードのままでよい理由）

- この製品は**IDトークンでログインするだけ**（スコープは `openid email` のみ）
- **refresh tokenを使いません**。Googleの「テストモード（公開ステータス: テスト中）」で
  問題になるのは refresh token の7日期限であって、IDトークンのログインには影響しません
- したがって**アプリを「本番公開」に切り替える必要はありません**。テストモードのまま恒久的に使えます
  （審査も不要）。テストユーザーは最大100人まで登録できます

### 手順

1. **AI**: ブラウザで `https://console.cloud.google.com` を開き、人にログインを依頼して待つ
2. **人**: Googleにログインする（パスワード・2段階認証は本人だけが扱う。AIに読み上げない）
3. **AI**: ここから画面操作を代行する
   - **プロジェクトを作る**: 上部のプロジェクト選択 →「新しいプロジェクト」→ 名前は例 `erlen-notebook`
   - **OAuth同意画面**: 「APIとサービス」→「OAuth同意画面」
     - User Type = **外部（External）**
     - アプリ名（例: `電子実験ノート`）、ユーザーサポートメール = 本人、デベロッパー連絡先 = 本人
     - スコープの追加は**不要**（`openid` と `email` は既定で使える）
     - **公開ステータスは「テスト中」のまま**にする
     - **テストユーザーに、ログインに使う自分のGoogleメールを追加する**
       （これを忘れると `403: access_denied` でログインできない）
     - 研究室メンバーを招待する予定があるなら、**その人たちのGoogleメールもテストユーザーに追加**する
   - **OAuthクライアントIDを作る**: 「認証情報」→「認証情報を作成」→「OAuthクライアントID」
     - アプリケーションの種類 = **ウェブアプリケーション**
     - 名前は任意（例: `erlen web`）
     - **承認済みのリダイレクトURI** に §6 で確定したURLを使って次を追加:

       ```text
       https://<Worker名>.<あなたのサブドメイン>.workers.dev/auth/callback
       ```

       **httpsで始まる完全一致・末尾スラッシュなし**。1文字でも違うと `redirect_uri_mismatch` になる
     - 「承認済みのJavaScript生成元」は**空でよい**（この製品はサーバー側で交換するため）
4. **AI**: 表示された**クライアントID**と**クライアントシークレット**をそのまま §8 のsecret登録へ渡す。
   **チャットやファイルに書き残さない**

### つまずいたら

- **`redirect_uri_mismatch`**: リダイレクトURIの不一致。次を順に疑う
  ①`http` になっていないか ②末尾に `/` が付いていないか ③Worker名・サブドメインの綴り
  ④`/auth/callback` のパス ⑤登録直後は反映に数分かかることがある（5分待って再試行）
- **「このアプリはGoogleで確認されていません」**: テストモードの正常な警告。
  「詳細」→「（アプリ名）に移動」で進んでよい（自分のアプリなので問題ない）
- **`403: access_denied`**: OAuth同意画面の**テストユーザー**に、そのメールが入っていない
- **`invalid_client`**: クライアントIDかシークレットの取り違え・貼り間違い。§8を入れ直す
- **人が自力で進めたがっている**: 迷いやすい工程なので、先回りして
  「この設定はブラウザ操作で代行します。Googleへのログインだけお願いします」と提案する

---

## 8. secretsを3つ入れる

値は `wrangler.jsonc` に書かず、Cloudflareのsecretとして預けます。

```bash
npm exec -- wrangler secret put GOOGLE_CLIENT_ID
npm exec -- wrangler secret put GOOGLE_CLIENT_SECRET
npm exec -- wrangler secret put SESSION_SECRET
```

| secret | 中身 | 誰が用意するか |
|---|---|---|
| `GOOGLE_CLIENT_ID` | §7で作ったクライアントID | Google（AIが画面から取得可） |
| `GOOGLE_CLIENT_SECRET` | 同シークレット | **人が入力欄へ貼る**（チャットに出さない） |
| `SESSION_SECRET` | ログインCookieの署名鍵。**32文字以上**のランダム文字列 | **AIが生成してよい** |

`SESSION_SECRET` の作り方（どれでもよい・AIが実行してよい）:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

- **32文字未満は未設定扱い**になり、ログインが通らない安全設計（`src/auth.mjs` の `validSessionSecret`）
- この値を後から変えると、**全員のログインセッションが即座に無効**になる（再ログインすれば直る）
- 3つとも**ファイルにもgitにも書かない**。`wrangler secret put` の入力欄だけで完結させる

### つまずいたら

- **`wrangler secret put` が対話入力を受け付けない（無人実行）**: 標準入力へ渡す。
  ただし**シェル履歴に残る**ので、GOOGLE_CLIENT_SECRETはこの方法を使わず人に貼ってもらうのが基本
- **【Windows実事故】PowerShellのパイプ（`"値" | wrangler secret put ...`）は値の先頭に
  UTF-8 BOM（EF BB BF）を混入させる。** GOOGLE_CLIENT_IDにBOMが付くとGoogleが
  `エラー401: invalid_client`（The OAuth client was not found）を返し、原因が極めて分かりにくい。
  標準入力で渡すときは必ず **Git Bash** で `printf '%s' "<値>" | npm exec -- wrangler secret put <名前>`
  を使う（printfはBOMも改行も付けない）。PowerShellしか無い環境では対話入力（人が貼る）にする。
  ログインで invalid_client が出たら、まずこのBOM混入を疑い、3つのsecretsを入れ直す
- **入れ直したい**: 同じコマンドをもう一度実行すれば上書きされる
- **入っているか確認したい**: `npm exec -- wrangler secret list`（名前だけ出る。値は出ない）。
  `npm run doctor:remote`（§11）も同じ検査を自動で行う

---

## 9. wrangler.jsonc の残りの★を埋める

★印は全部で3つ。§3で1つ埋めたので、残り2つです。

```jsonc
"vars": {
  // ★ §6で確定したURL。末尾スラッシュなし
  "BASE_URL": "https://<Worker名>.<あなたのサブドメイン>.workers.dev",
  // ★ このノートの持ち主のGoogleアカウント（§7でテストユーザーに入れたメール）
  "OWNER_EMAIL": "you@example.com",
  "MAX_ATTACHMENT_MB": "25"
}
```

- **`BASE_URL`**: `/auth/callback` の土台になる。**末尾スラッシュを付けない**
  （付けるとリダイレクトURIが二重スラッシュになり `redirect_uri_mismatch`。doctorが検出する）
- **`OWNER_EMAIL`**: このアドレスのGoogleアカウントだけが最初にログインでき、
  ログインした瞬間に「研究室（テナント）」とオーナーユーザーが作られます。
  以降はオーナーが画面からメンバーを招待します。
  **`OWNER_EMAIL` を後から書き換えると、旧オーナーは即座に締め出されます**（設計どおり）
- **`MAX_ATTACHMENT_MB`**: 添付1ファイルの上限。既定25で足りなければ人と相談して変える

### つまずいたら

- **どのメールを入れるか迷う**: §7で**テストユーザーに登録したのと同じアドレス**を入れる。
  大文字小文字は無視される（内部で小文字化して照合する）が、綴り違いは弾かれる
- **BASE_URLとデプロイURLがずれた**: ログインは通るが `/auth/callback` で失敗する。
  `wrangler deploy` の出力URLをそのまま貼り直して再デプロイする

---

## 10. デプロイする

```bash
npm exec -- wrangler deploy
```

出力される `https://...workers.dev` が **§9 の BASE_URL と一致していること**を確認します。
違っていたら BASE_URL を直して deploy をやり直します。

### つまずいたら

- **「Asset too large」**: `public/` に25MiB以上のファイルがある。
  `npm test` の `asset-size.test.mjs` が出荷前に検出する設計なので、まずテストを走らせる
- **デプロイ直後に古い版が返る**: 反映まで十数秒かかることがある。少し待ってから確認する
- **`curl` で叩くと弾かれる**: workers.dev への素の `curl` は Cloudflare にブロックされることがある。
  `-A` でUser-Agentを付けるか、ブラウザで確認する

---

## 11. 公開前検査（doctor:remote）に合格する

```bash
npm run doctor:remote
```

検査するもの:

1. Node.jsの版（22.5以上）
2. `wrangler.jsonc` に未置換の★が残っていないか
3. `BASE_URL` / `OWNER_EMAIL` の中身（末尾スラッシュ・`@`の有無）
4. D1 / R2 / ASSETS のバインディング
5. **Cloudflare側のsecret 3種が実在するか**
6. **D1のmigrationsが適用済みか**（未適用があれば適用コマンドを名指しで出す）

**1件でも `✗` が出たら、直してから先へ進むこと。** 「後で直す」をしない。

### つまずいたら

- **「Cloudflareのsecret一覧を取得できません」**: `wrangler login` が切れている（§2をやり直す）
- **「未適用のmigrationがあります」**: §5をもう一度（`--remote` を忘れていないか）
- **`△`（警告）が出る**: 警告は止めない。ただし内容は人に伝える

---

## 12. ブラウザで動作確認する（人と一緒に）

`BASE_URL` を開いて、次の順に確認します。ここは**人が実際に触る**工程です。

1. **ログイン**: トップ（`/`）は `/app/` へ飛びます。「Googleでログイン」を押す →
   §7でテストユーザーに入れたアカウントを選ぶ → ノート一覧が出れば成功
2. **ノートを作る**: 「ノート」タブ → ノートブックを1つ作り、ページを1枚追加する
3. **構造式**: ページ内で構造式エディタ（Ketcher）を開き、適当な分子を描いて保存できるか。
   描かなくても、SMILESが入っている行（PubChem補完・溶媒プリセット）は
   同梱のRDKit.jsが自動で構造式を描く（初回だけ数MBのWASMを読むので1〜2秒かかる）
4. **反応の自動計算**: 反応テーブルに試薬を足し、当量・収率が自動計算されるか
5. **PubChem補完**: 化合物名やCASを入れて、分子量などが引けるか（外部APIなので数秒かかる）
6. **添付**: 画像かPDFを1つアップロード → 一覧に出る → ダウンロードできる
7. **検索**: 検索ボックスにページ本文の語を入れてヒットするか（FTS5全文検索）
8. **印刷レポート**: ページから印刷用レポートを開き、ブラウザの印刷でPDFにできるか
9. **プリセットの読み込み**（初回にやっておくと楽）:
   - 「試薬」タブ →「プリセットを読み込む」→ 溶媒41件が入る
   - 「機器」タブ →「プリセットを読み込む」→ 機器のサンプルが入る
   - **取り込んだ後は自由に編集・削除できます**。メーカー名・型番・管理番号は例なので、
     自分の機器に書き換えるよう人に伝える

### つまずいたら

- **`?login=denied` で戻される**: `OWNER_EMAIL` とログインしたアカウントのメールが違う。
  §9を確認する（招待されていないアドレスもここに来る）
- **ログインボタンを押すと503**: secretが揃っていない。§8 → §11
- **構造式エディタが白紙**: Ketcherの静的ファイルが欠けている。`npm test` の
  `asset-size.test.mjs` が実在チェックをするので、まずテストを走らせる。
  `public/ketcher/**` は**1バイトも改変しない**（`.gitattributes` で改行変換も止めてある）
- **SMILESがあるのに構造式が出ない**: RDKit.jsの同梱物（`public/rdkit/`）が欠けている。
  `npm test` の `asset-size.test.mjs` が実在チェックをする。復旧は `npm run prepare:rdkit`
- **印刷レポートだけ構造式が空欄**: レポートはサーバ側で組むのでRDKitが動かない。
  「試薬」タブの「構造式を一括生成」を押すと、SMILESから画像を作って保存する
  （反応テーブルの行はPubChem補完・マスタ挿入の時点で自動保存される）
- **PubChemが引けない**: 外部サービス側の一時障害。**手入力で作業は続けられる設計**なので止まらない
- **添付が失敗する**: R2バケット名の不一致（§4）か、上限超え（`MAX_ATTACHMENT_MB`）

---

## 13. メンバーを招待する（任意・研究室で使う場合）

オーナーでログイン → 右上のユーザーメニュー →「メンバー」→「+ メンバーを招待」。

- 権限は **editor（書ける）** と **viewer（読むだけ）** の2種類。オーナーは常に全権
- **招待メールは送られません**（この製品はメール送信基盤を持ちません）。
  招待を作ると画面に案内文が出るので、それをコピーして相手に渡してもらう
- 相手は**招待したアドレスのGoogleアカウント**で `<BASE_URL>/auth/login` を開くと、そのまま参加できる
- **相手のGoogleメールも、§7のOAuth同意画面のテストユーザーに追加しておくこと**（100人まで）

### つまずいたら

- **相手が `?login=denied` になる**: ①招待したアドレスとログインしたアドレスが違う
  ②OAuth同意画面のテストユーザーに入っていない — のどちらか
- **間違えて招待した**: 「招待を取り消す」で失効する（記録は残る）
- **メンバーを外したい**: 「メンバーから外す」で論理削除。**その人が書いた記録は消えません**
  （実験記録は研究室の資産・監査証跡として残す設計）

---

## 14. バックアップと復元

研究記録は取り返しがつきません。**運用に載せる前に、1回はバックアップを取って手順を確かめること。**

```bash
# D1（実験記録・試薬・在庫・機器・監査証跡）
npm exec -- wrangler d1 export erlen --remote --output backups/erlen-YYYYMMDD.sql

# 添付ファイル（R2）は、D1のattachmentsテーブルのr2_keyが台帳
npm exec -- wrangler d1 execute erlen --remote --command "SELECT r2_key FROM attachments WHERE deleted_at IS NULL" --json
npm exec -- wrangler r2 object get erlen-attachments/<r2_key> --file=backups/files/<保存名>
```

同梱スキル `.claude/skills/erlen-backup/` に、この一連の手順（と復元手順）がまとまっています。
AIには「erlen-backupのスキルでバックアップを取って」と頼めば通ります。

- `backups/` と `logs/` は `.gitignore` 済み。**gitにコミットしない**
- 四半期に1回、**別のD1へ復元してみる**こと（取れているつもりが取れていない、が一番怖い）

### つまずいたら

- **exportが途中で止まる**: 行数が多い場合はテーブルを絞れる（`--table pages` など）
- **復元先を間違えそう**: 復元は `wrangler d1 execute <DB名> --remote --file=<sql>`。
  **本番DBへの復元は破壊的操作**なので、必ず人の明示承認を取る（AI_CONSTITUTION 第三条）

---

## 15. 更新の適用（新しい版が届いたら）

新しい版を取得したとき（`git pull`、または GitHub Releases のzip）の手順。
人向けの案内ページは [guides/update.html](guides/update.html)。
AIには同梱スキル `.claude/skills/erlen-update/` があります。

**上書きしないもの（この環境の持ち主の資産）**:

- `wrangler.jsonc`（★を埋めた本人の設定：database_id / BASE_URL / OWNER_EMAIL / MAX_ATTACHMENT_MB）
- Cloudflareに投入済みのsecret 3種（フォルダ差し替えの影響を受けない）
- D1のデータ・R2の添付（同上）
- `backups/` `logs/` `.dev.vars`（あれば）

**新版で置き換えるもの**: 上記以外の全部
（`src/` `web/` `public/` `test/` `migrations/` `scripts/` `guides/` `.claude/`
`SETUP.md` `README.md` `AI_CONSTITUTION.md` `LICENSE` `NOTICE` `package.json` `package-lock.json`）。

**手順（この順で・飛ばさない）**:

1. 現行版を確認する: `package.json` の `version`（`npm run doctor` でも表示される）。
   新版が同じか古ければ**適用不要**
2. 控えを取る: 運用中フォルダを丸ごとコピー ＋ D1バックアップ（§14）
3. `wrangler.jsonc` を退避 → 新版の中身でフォルダを置き換え → 退避した `wrangler.jsonc` を戻す
   （新版の `wrangler.jsonc` に★以外の変更が入っている場合は、**差分だけを手で移す**。
   新版で増えたバインディングや `compatibility_date` の更新を取り込み忘れない）
4. `npm ci` → `npm test` が全緑になることを確認（**赤のまま先へ進まない**）
5. 増えたmigrationsを適用: `npm exec -- wrangler d1 migrations apply erlen --remote`
6. `npm exec -- wrangler deploy`
7. `npm run doctor:remote` で全項目の緑と新しい版番号を確認
8. ブラウザでログイン → ノートが今までどおり見えることを目視

### つまずいたら

- **新版の `wrangler.jsonc` で上書きしてしまった**: ★3つを入れ直せば復旧できる
  （`database_id` は `wrangler d1 list`、BASE_URLは `wrangler deploy` の出力、OWNER_EMAILは本人）。
  **D1のデータは消えていない**
- **migrationsが「未適用」と言われ続ける**: `--remote` 忘れ
- **テストが赤い**: そのままdeployしない。赤の内容を人に報告して判断を仰ぐ

---

## 16. 運用の掟（事故防止）とその先

- **migrationsは追記のみ**。既存の `.sql` を書き換えない・消さない（AI_CONSTITUTION 第二条）
- **Ketcher（`public/ketcher/` 以下）は改変しない**（Apache-2.0のEPAM製ビルド成果物。中の分子テンプレートが
  CRLFに依存しているため、改行を正規化すると構造データが壊れる）
- **RDKit.js（`public/rdkit/` 以下）も改変しない**（BSD 3-Clauseのビルド成果物。
  版を上げるときは `npm i -D @rdkit/rdkit@<版> && npm run prepare:rdkit && npm test`）
- **秘密値をファイル・チャット・ログに書かない**。`wrangler secret put` だけで扱う
- **破壊的操作（D1削除・一括DELETE・R2バケット削除・OWNER_EMAIL変更）は人の明示承認を取ってから**
- **テストが赤いままデプロイしない**
- 画面を直したら `npm run build:web`（`web/` のViteビルド → `public/app/` を更新）→
  `npm test` → `deploy` の順で反映する

**デモモード（`DEMO_MODE`）**: `wrangler.jsonc` の `vars.DEMO_MODE` を `"1"` にすると、
招待していない人のGoogleログインも**閲覧専用（viewer）として通ります**。展示・体験版として
URLを配るためのスイッチで、**あなたのノートは既定の `"0"` のままにしてください**（`"1"` の間は、
ログインできた誰もがそのテナントの全データを閲覧できます。書き込みはサーバが403で断り、
デモの利用者は `users` テーブルに1行も作られません）。`"0"` に戻して `deploy` すれば、
発行済みのデモのログインCookieはその場で全部失効します。`npm run doctor` は `"1"` のとき
注意を1行出します（失敗にはしません）。

**独自ドメインで運用したくなったら**: Cloudflareダッシュボードの Workers → 該当Worker →
Settings → Domains & Routes で Custom Domain を足し、`wrangler.jsonc` の `BASE_URL` を
そのURLへ変更 → §7のリダイレクトURIにも新URLの `/auth/callback` を追加（古い方も残しておくと安全）→
`deploy` → `doctor:remote`。

**AIに運用を任せるときは、毎回 [AI_CONSTITUTION.md](AI_CONSTITUTION.md) を読ませること。**
