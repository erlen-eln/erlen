<!--
  日本語で書いていただいて構いません / Japanese is welcome.
  下のチェックは「レビューする側が確かめようのないこと」を、出す側が保証するためのものです。
  当てはまらない項目は、消さずに理由を書いてください（例: 画面は触っていないので該当なし）。
-->

## この変更でやること / What this changes

<!-- 何を直すのか、なぜそれが要るのか。関連Issueがあれば `Fixes #123` -->

## 確かめ方 / How to verify

<!-- レビュー側が同じ結果に辿り着ける手順。画面の変更ならスクリーンショットを -->

---

## チェック / Checklist

- [ ] **`npm test` が全緑**（テストの本数を減らしていない・既存のテストを緩めていない）
      `npm test` passes in full; no test was removed or weakened
- [ ] **`src/api/*.mjs` は `Response` を作っていない**（`{ status, data }` を返す素の関数のまま。JSON化は `src/worker.mjs` の仕事）
      The api layer still returns plain `{ status, data }` and never builds a `Response`
- [ ] **テナント別テーブルを触るSQLに `tenant_id = ?` が入っている**
      Every query against a tenant-scoped table carries `tenant_id = ?`
- [ ] **`migrations/` は追記のみ**（既存ファイルの書き換え・削除・番号の詰め直しをしていない）
      `migrations/` is append-only; no existing migration was edited, deleted or renumbered
- [ ] **画面（`web/`）を直したなら `npm run build:web` 済みで、`public/app/` も一緒にコミットしている**
      If `web/` changed, `npm run build:web` was run and `public/app/` is committed with it
- [ ] **`public/ketcher/` と `public/rdkit/` を1バイトも触っていない**（`.gitattributes` の該当行も含む）
      Nothing under `public/ketcher/` or `public/rdkit/` was modified
- [ ] **秘密の値・個人情報・実際の `database_id` を混ぜていない**（`test/dist-clean.test.mjs` が見張っています）
      No secrets, personal data or a real `database_id` are included
- [ ] **利用者から見た振る舞いが変わるなら `CHANGELOG.json` の先頭（`unreleased`）に ja / en を1行ずつ足した**
      User-visible changes are listed in `CHANGELOG.json` under `unreleased`, in both ja and en

<!--
  Pull Request を送っていただいた内容は、Apache License 2.0 §5（Submission of Contributions）に
  従って本プロジェクトへ取り込まれます。
  Contributions are taken into the project under Apache License 2.0 §5.
-->
