# Erlen — このフォルダを開いたAIへ

化学者のための電子実験ノート。Cloudflare Workers + D1 + R2 の上で、**この持ち主のアカウントの中だけ**で動きます。

1. **まず [AI_CONSTITUTION.md](AI_CONSTITUTION.md) を全文読む。** 記録を消さない・migrationsは追記のみ・
   持ち主の資産（★値・D1・R2・`backups/`）は触らない、が最上位のルールです。
2. 何をするかで読む場所が決まります。
   - **初回セットアップ** → スキル `erlen-setup`（手順の正本は [SETUP.md](SETUP.md)）
   - **新しい版を当てる** → スキル `erlen-update`（SETUP.md §15）
   - **バックアップ・復元** → スキル `erlen-backup`（SETUP.md §14）
   - 機能を直す・足す → `npm test` → `npm run build:web`（画面を触ったとき）→ `npm exec -- wrangler deploy`
3. **秘密値をファイル・チャット・ログに書かない。** `wrangler secret put` だけで扱います。
   Windowsでは `printf '%s' "<値>" | npx wrangler secret put <名前>`（PowerShellのパイプはBOMを混ぜます）。
4. **テストが正本。** `npm test` が赤いままデプロイしない。テストの本数は減らさない。
5. **`api/*.mjs` は Response を作らない**（`{status, data}` を返す素の関数。JSON化は `worker.mjs` の仕事）。
   テナント別テーブルを触るSQLには必ず `tenant_id = ?` を付ける。
6. 破壊的操作（D1削除・一括DELETE・R2バケット削除・`OWNER_EMAIL` 変更）は**持ち主の明示承認**を取ってから。
7. 変更履歴は [CHANGELOG.json](CHANGELOG.json) が正本（`guides/update.html` は
   `node scripts/render-changelog.mjs` で生成）。**最新版と履歴は https://erlen.jp/changelog でも公開**しています。
   公開MCP `https://erlen.jp/mcp` を登録しておけば、手順書・スキル本文・最新版情報をAIが直接取り寄せられます
   （`claude mcp add --transport http erlen https://erlen.jp/mcp`）。新しい版は GitHub Releases でも配布しています。
8. このリポジトリ**そのもの**を直すとき（機能追加・修正を送る／版を上げる）は
   [CONTRIBUTING.md](CONTRIBUTING.md) を読む。GitHubで公開・リリースする側の手順は
   [docs/MAINTAINING.md](docs/MAINTAINING.md)（メンテナ向け）。脆弱性は [SECURITY.md](SECURITY.md) の窓口へ。
9. **ライセンスは Apache License 2.0**（[LICENSE](LICENSE) / [NOTICE](NOTICE)）。
   同梱物（Ketcher = Apache-2.0 / RDKit.js = BSD-3）の LICENSE・NOTICE を消さない。
   欠けると再配布そのものが違反になります（`test/licensing.test.mjs` が見張っています）。

このファイルは持ち主が自由に追記して構いません（更新時は退避して書き戻されます）。
