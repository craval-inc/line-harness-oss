# kzn 本番 D1 に K003（受信メディアの非公開保全）を当てる手順

対象: bkobu `line-harness-kzn`（d13fdca6-6e95-4084-8a34-b3709a0a92f7）。前提: v0.24 手順（APPLY-v0.24.md）適用済み。

K003 は `line_media`（メディアの状態）と `line_media_writes`（R2 書込みの先行ログ＝孤立オブジェクトの回収用）の**追加だけ**（既存テーブル・既存行に触れない）。
**K003 は 2026-09-28 時点でどの DB にも未適用**。未適用の段階で列・テーブルを数回書き換えている（lease_token・line_media_writes 等）ので、本番には最新の K003 をそのまま当てる。以後の変更は追記（K004〜）のみ。
ただし `LINE_MEDIA_STORE=1` の Worker は受信の保存 batch で `line_media` に書くため、**Worker より先に D1 へ当てる**
（逆順だと保存 batch が失敗して 500 → LINE が再送するので受信は失われないが、エラーが出続ける）。

## 手順（きずな側 → ハーネスの順。全体は kizuna-shonin/docs/unified-inbox-plan.md Phase B）

1. きずな: D1 migration `0020_line_media.sql` を適用 → Pages デプロイ（`/api/line-harness-event` が `media` イベントを受けられる状態にする）
2. ハーネス D1 に K003:
   `npx wrangler d1 execute line-harness-kzn --remote -c wrangler.kzn.toml --file ../../packages/db/migrations-kzn/K003_line_media.sql`
3. 検証ゲート: `node ../../scripts/kzn-d1-gate.mjs`（期待スキーマ＝bootstrap + K001〜K003）
4. `node ../../scripts/check-kzn-target.mjs` → `npx wrangler deploy -c wrangler.kzn.toml`
   （`[[r2_buckets]] LINE_MEDIA → kizuna-shonin-uploads` と `LINE_MEDIA_STORE="1"` が入った toml）
5. 確認: 画像を1枚送る → `GET /api/webhook-inbox/status` の `media.done` が増える／きずな受信箱で画像が表示される

## 戻し方

- Worker を `LINE_MEDIA_STORE` 無し（toml の該当行を外す）で再デプロイすれば、取得・転送は止まる（`line_media` は残るだけで無害）。
- R2 の `line-media/` 配下は、きずな管理画面からだけ参照される非公開オブジェクト。公開 URL は作っていない。
