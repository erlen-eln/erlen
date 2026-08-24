# Roadmap / これから

**この文書は約束ではありません。** 日付も、実装の保証もありません。
「いま何が土台で、次に何を考えているか」を共有するための1枚です。
順番も内容も、実際の要望（[Issues](https://github.com/erlen-eln/erlen/issues)）を見て変わります。

*This is not a commitment. No dates, no guarantees — just what the ground looks like and what is
being considered next. Priorities follow what people actually ask for in the issues.*

---

## いまの土台 / Where it stands

**v1.3.x を安定版の基点とします。** 実験ノート・構造式・反応の自動計算・添付・全文検索・
印刷レポート・試薬／在庫／機器の台帳・招待制のメンバー管理・監査証跡・日英UIまでが揃っていて、
これらは**すでに研究室で使える完成した機能**です。ここから先の変更は、
この土台を壊さないことを前提に積みます。

*v1.3.x is the stable base. The notebook, structures, stoichiometry, attachments, search, printable
reports, the reagent / stock / equipment ledgers, invitation-based membership, the audit trail and
the bilingual interface are done and usable. Everything after this is added on top without
disturbing that base.*

変わらない前提 / What will not change:

- **追加のサーバー・追加の常時課金サービスを増やさない。** 1つのデプロイで完結させる
- **記録を消さない。** 改訂履歴と削除済み行は残す（[AI_CONSTITUTION.md](AI_CONSTITUTION.md)）
- **データは利用者のアカウントの中だけに置く。** 提供者のサーバーを経由させない
- **`migrations/` は追記のみ。** 既存の導入者の環境を壊す変更をしない

---

## 検討中 / Under consideration

### リッチテキストエディタ（TipTap）の導入

いまのページ本文はプレーンテキストです。**太字・箇条書き・表・画像の貼り付け**が実験記録では
そのまま使えると嬉しい、という要望が最も多いところなので、TipTap（オープンソース）の導入を
候補として検討しています。

前提として外せない条件が2つあります。

- **既存のページが壊れないこと。** いま入っている本文はそのまま読めて、そのまま書けること
- **改訂履歴（`page_revisions`）が今までどおり残ること。** 書式が付いても
  「誰がいつ何を変えたか」の記録の粒度を落とさない

*A rich-text editor (TipTap) for page bodies — the most-requested gap. Two conditions are
non-negotiable: existing plain-text pages must keep working, and the revision trail must not lose
granularity.*

### そのほか、要望を見て決めるもの / Other candidates, demand-driven

- 印刷レポートの体裁の追加（署名欄・ページ番号の様式など、機関の規程に合わせやすくする）
- 台帳の入出力（CSVでの取り込み・書き出し）
- 日本語・英語以外のUI言語（翻訳を送っていただければ載せます）
- 検索の絞り込み（期間・作成者・プロジェクト）

**機能拡張を本格的に進めるのは、公開の告知とドキュメント整備が落ち着いてからです。**
それまでは、不具合の修正・ドキュメントの改善・翻訳の直しを優先します。

*Feature work ramps up once the launch announcements and documentation have settled. Until then,
bug fixes, documentation and translation corrections come first.*

---

## 要望の出し方 / How to influence this

<https://github.com/erlen-eln/erlen/issues> に **Feature request** で書いてください。
「こういう機能が欲しい」よりも、**「実験の記録でこういう手間がある」**と書いていただけると、
別のもっと良い解が見つかることがあります。日本語で構いません。

*Open a feature request. Describing the friction in your lab work beats describing the feature —
sometimes there is a better answer than the one either of us had in mind. Japanese is welcome.*
