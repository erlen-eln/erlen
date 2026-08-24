# Erlen メンテナ手引き

このリポジトリを**GitHubで公開して運用する人**（＝メンテナ）のための1枚です。
利用者向けの案内は [README.md](../README.md)、外部から貢献する人向けは
[CONTRIBUTING.md](../CONTRIBUTING.md) にあります。ここは**内側の運用**だけを書きます。

目指しているのは「**作って push するだけ**」です。テストもzipもリリースノートも機械が作るので、
人の手が要るのは「何を直すか」と「いつ版を上げるか」の2つだけになります。

- 公開先: <https://github.com/erlen-eln/erlen>（Org `erlen-eln` / リポジトリ `erlen`）（**2026-08-24 公開済み**。履歴は新しい初期コミットからの再出発＝旧履歴と個人メールアドレスは持ち込んでいない。公開前までの全開発履歴はローカルの `history-private` ブランチにある）
- ライセンス: Apache License 2.0
- 安定版の基点: **v1.3.0**

---

## 1. ブランチ戦略

**`main` 一本。`main` は常に安定（テストが全緑で、そのままデプロイできる状態）。**

作業の進め方は2通りあり、**どちらでも構いません**。門番はCIなので、どちらを選んでも
「赤いものが `main` に居座る」ことは起きません。

| 流儀 | やること | 向いている場面 |
|---|---|---|
| **直push** | `main` で直接直して push | 自分ひとりの修正。文書の直し。急ぎの不具合 |
| **ブランチ→PR** | `fix/xxx` を切って push → Pull Request → マージ | 大きい改修。人からの貢献。あとで経緯を読み返したいもの |

- 外部からの貢献は必ずフォーク＋PRで来ます（それがGitHubの既定）
- 長生きするブランチを作らないこと。`oss` のような準備用ブランチは、`main` に入れたら消します
- リリースはブランチではなく**タグ**（`v1.3.0`）で切ります

---

## 2. 日常のフロー

```bash
# 1. 直す
#    画面（web/）を触ったなら忘れずに:
npm run build:web            # public/app/ を焼き直す（成果物もコミットする）

# 2. 手元で検査（任意。CIでも同じものが走る）
npm test                     # 全緑であること。本数は減らさない

# 3. コミットして push
git add -A
git commit -m "何を・なぜ直したか"
git push
```

push すると GitHub Actions の **CI**（`.github/workflows/ci.yml`）が走ります。

- ジョブ1 `npm test` … Node 22 で `npm ci` → `npm test`
- ジョブ2 `typecheck web` … `npm --prefix web ci` → `npm run typecheck:web`

**赤くなったら直してから次へ進む**。CIの結果はコミット一覧の緑チェック／赤バツで見えます。

### 利用者に見える変更をしたとき

[CHANGELOG.json](../CHANGELOG.json) の先頭にある `"version": "unreleased"` のエントリに、
**`ja` と `en` を1行ずつ**足しておきます（件数が揃っていないと `npm test` が落ちます）。
`unreleased` が無ければ、先頭に1つだけ作ります。

```json
{
  "version": "unreleased",
  "date": "2026-09-01",
  "ja": ["直した内容を1行で"],
  "en": ["One line describing the change"]
}
```

リリースのときに、このエントリの `version` を版番号へ書き換えるだけで済みます。

---

## 3. リリース手順

**タグを push したら、あとは全部自動**です（`.github/workflows/release.yml`）。
やることは版を上げる4行だけ。

### 手順

1. **`CHANGELOG.json` の先頭を仕上げる**
   `"version": "unreleased"` → `"version": "1.4.0"` に書き換え、`date` を公開日にする。
   足りない行があればここで足す（`ja` と `en` の件数を揃える）

2. **版番号を2か所上げる**（食い違うとテストが落ちます）
   - `package.json` の `"version"`
   - `src/api/health.mjs` の `export const VERSION`

3. **`npm run changelog`**
   `CHANGELOG.json` から `guides/update.html` の変更履歴節を焼き直します。
   手で書かないこと（配布物と食い違います）

4. **検査してコミット**

   ```bash
   npm test
   git add -A
   git commit -m "v1.4.0: <この版の要点>"
   ```

5. **タグを打って push**

   ```bash
   git tag -a v1.4.0 -m "Erlen v1.4.0"
   git push origin main --tags
   ```

### ここから先は機械の仕事

`v*` のタグが届くと Release ワークフローが動きます。

1. `npm ci`
2. `node scripts/release-notes.mjs "$GITHUB_REF_NAME" --out release-notes.md`
   — **タグ・`package.json`・`CHANGELOG.json` の3つが一致しているかの検算**。
   1つでもズレていたらここで落ちて、Releaseは作られません
3. `npm test`
4. `node scripts/package.mjs` → `dist-zip/erlen-1.4.0.zip`（このスクリプト自身もテストの門を持つ）
5. GitHub Release を作成し、zipを添付。本文は `CHANGELOG.json` から生成した ja / en の箇条書き

数分後に <https://github.com/erlen-eln/erlen/releases> に出ます。**本文の手直しは不要**です。

### タグを打ち間違えたら

まだ誰も落としていないうちなら、消して打ち直せます。

```bash
git push origin :refs/tags/v1.4.0   # リモートのタグを消す
git tag -d v1.4.0                   # 手元のタグを消す
# 直してから、もう一度 git tag -a v1.4.0 ... && git push origin v1.4.0
```

すでにReleaseが公開されている場合は、GitHubの画面からReleaseを削除してからタグを消します。
**配ってしまった版番号を作り直すのは最後の手段**です。基本はパッチ版（`1.4.1`）で前へ進みます。

### リリースノートを手元で確認したいとき

```bash
node scripts/release-notes.mjs v1.4.0        # 本文を標準出力に出す（何も書き換えない）
node scripts/package.mjs                     # zipも手元で作れる（テストが緑のときだけ）
```

---

## 4. 初回公開の手順

**まだリモートは設定されていません**（`git remote -v` が空）。ここが最初の1回です。

### 4-1. 公開前の最終確認（手元）

```bash
npm test                      # 全緑であること
git status                    # 未コミットの取りこぼしが無いこと
git log --oneline | head -5   # 履歴が意図どおりであること
```

そして**著者メールの扱いを決める**（→ §6）。**履歴の書き換えは公開前にしかできません。**
公開後にやるとクローンやフォークが全部ずれます。ここが最後の分岐点です。

さらに、次の3点を目視で確認します（機械検査もありますが、公開は取り返しがつきません）。

- `wrangler.jsonc` の★が **`REPLACE_WITH_...` のまま**であること
  （自分の運用インスタンスの `database_id` や `OWNER_EMAIL` を書き戻していないこと）
- `.env` / `.dev.vars` / `backups/` / `logs/` が `.gitignore` に入っていて、追跡されていないこと
  （`git ls-files | grep -E "\.env|\.dev\.vars"` が空であること）
- `git ls-files` に、公開したくないファイルが無いこと

### 4-2. GitHub側を作る（ブラウザ）

1. Organization **`erlen-eln`** を作る（Free プランでよい）
2. その中に Public リポジトリ **`erlen`** を作る。
   **README・.gitignore・ライセンスの自動生成は全部オフ**（空のリポジトリにする。
   1ファイルでも入ると、こちらの `main` を push するときに衝突します）

### 4-3. main を push する

`oss` ブランチで準備したものを `main` に入れてから push します。

```bash
git switch main
git merge --no-ff oss -m "OSS公開の準備を main へ取り込む"

git remote add origin https://github.com/erlen-eln/erlen.git
git push -u origin main
```

push した直後に **Actions タブでCIが緑になること**を確認します。ここが赤いと、
公開初日の第一印象が「テストが落ちているリポジトリ」になります。

準備用の `oss` ブランチは、`main` に入ったら消します（push しない）。

```bash
git branch -d oss
```

### 4-4. v1.3.0 のタグを打つ

```bash
git tag -a v1.3.0 -m "Erlen v1.3.0"
git push origin v1.3.0
```

Release ワークフローが走り、**`erlen-1.3.0.zip` を添付したReleaseが自動で作られます。**

> 注意: いまの `CHANGELOG.json` の先頭は `"unreleased"`（OSS化の準備）です。
> **`v1.3.0` のタグを打つ前に、この `unreleased` エントリをどうするか決めてください。**
> - OSS化の準備内容を v1.3.0 の一部として配るなら → `unreleased` の行を `1.3.0` のエントリへ
>   混ぜてから（または `"version": "1.3.0"` に書き換えて日付を直してから）タグを打つ
> - 次の版に回すなら → `unreleased` のまま置いておけばよい（配布物には出ません）
>
> どちらでも、タグ・`package.json`・`CHANGELOG.json` の**最新のリリース版が一致**していれば
> リリースは通ります。ズレていれば `scripts/release-notes.mjs` が止めます。

### 4-5. 公開後にすぐ見るところ

- <https://github.com/erlen-eln/erlen/releases> にzipが添付されているか
- リポジトリのトップでライセンスが **Apache-2.0** と表示されているか
- Issue を新規作成しようとしたとき、テンプレート（Bug report / Feature request）と
  公式サイト・デモへのリンクが出るか

---

## 5. GitHub側の設定チェックリスト（ブラウザでポチる）

コマンドでは済まない、**人がクリックする**設定です。公開直後に一度やれば終わりです。

### 必須

- [ ] **Settings → General**: Description を入れる／Website に `https://erlen.jp`／
      Topics に `electronic-lab-notebook` `eln` `chemistry` `cloudflare-workers` など
- [ ] **Settings → Actions → General → Actions permissions**:
      Actions が有効であること。**「Allow all actions and reusable workflows」**（または
      サードパーティ製を許可する設定）にしておく。
      Release で `softprops/action-gh-release@v2` を使っているので、GitHub製に限定すると落ちます
- [ ] **Settings → Actions → General → Workflow permissions**:
      既定の「Read repository contents permission」のままでよい。
      Release ワークフローは自分で `permissions: contents: write` を宣言しています
- [ ] **Settings → Code security → Private vulnerability reporting: Enable**
      SECURITY.md がここへ誘導しています。**無効のままだと報告フォームが開けません**
- [ ] **Settings → General → Features**: Issues をオン（Wiki・Projects は使わないならオフでよい）

### 推奨

- [ ] **Settings → Code security → Dependabot alerts** をオン（`web/` のReact/Viteの警告が来る）
- [ ] **Settings → General → Pull Requests**: 「Allow squash merging」だけ残すと履歴が読みやすい
- [ ] **Settings → Rules → Rulesets**（または Branches → Branch protection）で `main` に:
      **Do not allow force pushes** / **Do not allow deletions** の2つ。これは直pushを妨げません
- [ ] Releases の説明欄（右カラムの About）に「更新は guides/update.html から」と一言

### 「CIを必須にする」を入れるかは流儀次第

`main` に **Require status checks to pass** を掛けると、CIが緑になるまで**直pushもできなくなります**
（PR経由が必須になる、という意味ではなく、pushそのものがブロックされます）。

- ひとりで直pushを続けるなら → **掛けない**（掛けると自分の作業が止まります）
- 貢献者が増えて、`main` を絶対に汚したくなくなったら → **掛ける**。同時に
  「Require a pull request before merging」も入れて、PR運用へ切り替える

いまは**掛けない**設定を薦めます。CIは「壊れたことに気づくため」に十分機能しています。

---

## 6. 未決事項: git履歴の著者メールをどうするか

**この判断だけは持ち主のものです。AIが勝手に決めません。**

### いまの状態

このリポジトリの履歴は、**ほぼ全てのコミットの著者メールが個人のGmailアドレス**になっています。
件数はこれで数えられます（作業を続ければ増えます）。

```bash
git log --format='%an <%ae>' | sort | uniq -c
```

GitHubで公開すると、**コミット履歴のページで誰でもそのアドレスを読めます。**

ファイルの中身にはアドレスは1つも入っていません（`test/dist-clean.test.mjs` が見張っています）。
**問題になるのはgitのメタデータだけ**です。

### 選択肢

| 案 | やること | 向き・不向き |
|---|---|---|
| **A. そのまま公開** | 何もしない | 楽。ただし迷惑メールの的になる可能性は上がる。あとから消せない |
| **B. 履歴を書き換えてから公開** | `git filter-repo` で全コミットの著者を付け替える | 公開前の**いましかできない**。全コミットのハッシュが変わる |
| **C. 今後だけ変える** | 手元の設定を変え、過去はそのまま | 中途半端（既存の全コミットに残る） |

**公開前なら B のコストはほぼゼロ**です（誰もクローンしていないので、ハッシュが変わっても
困る人が居ない）。公開後は、フォークやクローンが全部ずれるので実質やり直せません。

### 付け替え先に使うアドレス

GitHubが用意している **noreply アドレス**を使うのが定石です。

```text
<数字ID>+<GitHubユーザー名>@users.noreply.github.com
```

- 数字IDと正確な綴りは **GitHub → Settings → Emails** の
  「Keep my email addresses private」の欄に表示されています。そこからコピーします
- このアドレス宛のメールは届きません（受信箱を晒さずに、コミットとアカウントの紐付けは保たれます）
- 同じ画面の **「Block command line pushes that expose my email」** も入れておくと、
  うっかり本アドレスで push するのを GitHub 側が止めてくれます

### B をやる場合の手順

`git filter-repo` を使います（`git filter-branch` は遅くて事故りやすいので使わない）。

```bash
# 0. 道具を入れる（Pythonが要る）
pip install git-filter-repo

# 1. 【重要】バックアップ。作業前に丸ごと複製しておく
#    （filter-repo は元に戻せない。複製はリポジトリの外へ置く）
git clone --mirror . ../erlen-backup-before-rewrite.git
```

次に **mailmap を作ります。旧アドレスを書くファイルなので、絶対にリポジトリの中に置かないこと**
（置いたまま commit すると `test/dist-clean.test.mjs` が落ちますし、そもそも本末転倒です）。
リポジトリの1つ上の階層など、**gitの管理外**に置きます。

```text
# ../erlen-mailmap.txt  ← リポジトリの外。使い終わったら消す
Gakushi Kobayashi <新しいnoreplyアドレス> <いまの個人アドレス>
```

```bash
# 2. 付け替える（著者もコミッターもまとめて書き換わる）
git filter-repo --mailmap ../erlen-mailmap.txt

# 3. 確認（個人アドレスが1件も残っていないこと）
git log --format='%an <%ae>' | sort | uniq -c

# 4. 使い終わった mailmap を消す
rm ../erlen-mailmap.txt
```

mailmapを使わず、コールバックで書く手もあります（旧アドレスをファイルに残さずに済む）。

```bash
git filter-repo --email-callback '
  return b"<数字ID>+<ユーザー名>@users.noreply.github.com" if b"<旧アドレスのローカル部>" in email else email
'
```

**注意点**

- `git filter-repo` は既定で `origin` を消します。**公開前（remote未設定）にやるなら好都合**です。
  すでに remote を足したあとに走らせるなら、終わってから `git remote add origin ...` をやり直します
- 実行後は**全コミットのハッシュが変わります**。この文書やスキルに書いたコミットハッシュがあれば
  読み替えてください
- 著者が `Claude` になっている3件はそのままで構いません（返信不可のアドレスで、受信箱ではありません）

### 今後のコミットを noreply にする（A/B/Cどれを選んでも入れておく）

このリポジトリだけに効く設定にしておくと、他のプロジェクトに影響しません。

```bash
git config user.name "Gakushi Kobayashi"
git config user.email "<数字ID>+<GitHubユーザー名>@users.noreply.github.com"
git config user.email        # 確認
```

---

## 7. 変更してはいけないもの（作業前に思い出す用）

うっかり触ると、ライセンス違反・利用者の環境破壊・出荷停止のどれかになります。

| 対象 | 理由 | 見張り |
|---|---|---|
| `LICENSE` / `NOTICE` | Apache-2.0 §4。欠けると再配布そのものが違反 | `test/licensing.test.mjs` |
| `public/ketcher/**` / `public/rdkit/**` | 上流の成果物。CRLF依存で改行を触ると構造データが壊れる | `.gitattributes` / `test/licensing.test.mjs` |
| `migrations/` の既存ファイル | 適用済みの利用者の環境が壊れる | AI_CONSTITUTION.md 第二条 |
| `wrangler.jsonc` の★ | 自分の値を焼き込むと全利用者に配ってしまう | `test/dist-clean.test.mjs` |
| テストの本数 | 緩めて緑にするのは不具合と同じ扱い | 人（レビュー） |

EULA は復活させません（Apache-2.0 と真正面から矛盾し、`test/licensing.test.mjs` が落ちます）。

---

## 8. 困ったとき

| 症状 | 見るところ |
|---|---|
| CIが赤い | Actions タブ → 落ちたジョブのログ。手元の `npm test` と同じものが走っています |
| `typecheck web` だけ赤い | `npm --prefix web ci && npm run typecheck:web` を手元で再現する |
| タグを push したのにReleaseが出ない | Actions タブに Release の実行があるか。無ければタグ名が `v` 始まりか確認 |
| Release が「リリースの前提が揃っていません」で落ちた | タグ・`package.json`・`CHANGELOG.json` の版が食い違っています。§3 の手順1〜3 をやり直す |
| Release で `softprops/...` が拒否された | Settings → Actions → General でサードパーティ製のActionが許可されているか（§5） |
| zipの中身が心配 | 手元で `node scripts/package.mjs` を実行して、`dist-zip/` の中を展開して見る |
| 配布物に個人情報が混ざっていないか | `npm test`（`test/dist-clean.test.mjs` が全テキストを走査しています） |

### 配布zipに入らないもの

`scripts/package.mjs` の除外リストにあるもの（`.git` / `node_modules` / `.wrangler` / `dist-zip` /
`backups` / `logs` / `.env` / `.dev.vars`）に加えて、**`.github/` も入りません**。
CI・Issueテンプレートは上流リポジトリの運営のためのもので、
利用者が展開して使うキットには関係がないためです。
（全部入りのソースが欲しい人には、GitHubがReleaseに自動で付ける
"Source code (zip)" があります。そちらには `.github/` も入っています）

---

## 9. この文書のメンテナンス

運用の流儀を変えたら、**この文書と `.github/workflows/` の両方**を直します。
片方だけ直すと、次に開いたときに嘘を読むことになります。

Erlenのプロジェクト進行そのもの（何を作るか・いつ告知するか）は、この文書ではなく
プロジェクトスキル側で管理しています。
