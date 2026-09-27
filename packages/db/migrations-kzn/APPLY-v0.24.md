# kzn 本番 D1 を本家 v0.24（craval-v0.24）に上げる適用手順

対象: bkobu `line-harness-kzn`（database_id `d13fdca6-6e95-4084-8a34-b3709a0a92f7`）
現状: `kzn-bootstrap.sql`（本番 sbo の schema-only export＝本家 045 まで相当）＋ `046_kzn_webhook_inbox.sql`（= 本ディレクトリの `K001_webhook_inbox.sql`）適用済み。稼働 Worker は旧ブランチ `craval-security-hardening`（b52e95a）。
検証: `apps/worker/src/kzn-migration-v024.test.ts` が本番の再現 DB（kzn-bootstrap + K001 + 受信データ）で本手順を通し、データ保持・チャット統合・移行由来マイル 0・自動応答/ルール無効・スキーマ一致（=デプロイ前ゲート）を確認する。

## 基本方針: メンテナンス中は受信しない

migration 中に受信して 200 を返すと、失敗して bookmark に戻した時にその間の受信が消える（200 済みは LINE が再送しない）。
そこで `WEBHOOK_MAINTENANCE=1` の間は **署名検証後に 503 を返し D1 に一切書かない**（定期処理も停止）。非2xx なので「Webhookの再送」ON の LINE が後で再送する。

- **再送の保証はない**: LINE 公式は「再送の回数と間隔は非公開・予告なく変わる」「再送は確実な配信を保証しない」としている（developers.line.biz Messaging API「Receiving messages → Webhook redelivery」2026-09-28 確認）。上限時間の記載もない。
- → **メンテ時間は 15 分以内を目標**（①デプロイ〜⑥デプロイまで）。超えそうなら中断して「失敗時」に従う。
- 取りこぼしがあっても会話の正本は LINE OA チャット（人の返信はそこ）。⑦で OA チャットと突合する。
- 前提: LINE Developers の「Webhookの再送」が ON（kzn は ON 済み）。

旧 Worker へのパッチは不要: ①で**新 Worker を先にメンテナンスモードでデプロイ**する。メンテ中の新 Worker が D1 に触れるのは正しい署名時の `line_accounts` 読み取り 1 回だけ（旧スキーマにも存在・書き込みなし）で、定期処理は動かない。

## 手順

```bash
cd /c/dev/line-harness-oss && git checkout craval-v0.24 && pnpm install --frozen-lockfile
for p in @line-crm/shared @line-crm/line-sdk @line-harness/update-engine; do pnpm --filter "$p" build; done
cd apps/worker && cf-bkobu        # D1 Edit 権限のトークン（CF-BKO.BU-harness）
node ../../scripts/check-kzn-target.mjs
```

1. **メンテナンスで新 Worker をデプロイ**（ここから時計を回す・15分目標）
   `npx wrangler deploy -c wrangler.kzn.toml --var WEBHOOK_MAINTENANCE:1`
   確認: LINE Developers の「検証」が 503 になる／`wrangler tail -c wrangler.kzn.toml` に `maintenance mode` が出る。
2. **退避・③migration・④後処理・⑤検証ゲート** — 一括スクリプト（最初の失敗で全体停止・exit 1）
   `bash ../../scripts/kzn-apply-v024.sh`
   内容: bookmark 取得（`/c/temp/kzn/apply-*/bookmark.txt`）＋ export → 事前件数 → 本家 046〜047 → `kzn-pre-048.sql` → 本家 048〜072 → `kzn-post-v024.sql` → 事後件数が事前と一致 → `kzn-d1-gate.mjs`（期待スキーマ＝bootstrap.sql+K001 と一致・067 自動応答無効・有効マイルルール 0・available マイル 0）。
3. **メンテ解除で新 Worker をデプロイ**（⑥）
   `npx wrangler deploy -c wrangler.kzn.toml`（`--var` 無し＝`WEBHOOK_MAINTENANCE` 未設定）
   確認: 「検証」が 200。
4. **LINE 再送で溜まった分が入ることを確認**（⑦・30分程度見る）
   `curl -s -H "Authorization: Bearer $API_KEY" https://line-harness-kzn.bkobu-yd.workers.dev/api/webhook-inbox/status`
   `wrangler tail` で `maintenance` 以降の受信が 200 で処理されること、きずな /admin 受信箱に メンテ時間帯のメッセージが入ること、OA チャットのメンテ時間帯の受信と件数が合うことを確認。合わない分は OA チャットを正とし、受信箱には手入力しない（記録のみ欠落）。

## 失敗時（②〜④のどこで止まっても同じ）

1. それ以降は当てない。スクリプトの出力（どのファイルで止まったか）を保存。
2. D1 を戻す: `npx wrangler d1 time-travel restore line-harness-kzn -c wrangler.kzn.toml --bookmark=<bookmark.txt の値>`
3. 旧 Worker に戻す（メンテ解除）: `git checkout craval-security-hardening`（b52e95a）→ `pnpm install` → `pnpm --filter @line-crm/line-sdk build` → `node ../../scripts/check-kzn-target.mjs` → `npx wrangler deploy -c wrangler.kzn.toml`
4. 「検証」200 と ⑦ と同じ再送確認。メンテ中は D1 に書いていないので、restore で消える受信は無い。

⑥の後に問題が出た場合（新 Worker で受信済み）は bookmark に戻すと受信が消えるため restore しない。新 Worker を再度 `--var WEBHOOK_MAINTENANCE:1` で出して受信を止め、原因を直して前進修正する。

## 番号衝突と kzn 専用 migration の扱い

- 本家にも `046_affiliate_links.sql` / `046_link_tracking_controls.sql` があり、旧 `046_kzn_webhook_inbox.sql` と番号が衝突する。
- kzn 専用 migration は `packages/db/migrations-kzn/K001...` に移した（本家の `migrations/`・リリースバンドル・sbo/fzk には混ぜない）。SQL 本文は旧 046 と同一なので **kzn 本番で再実行しない**。
- kzn は wrangler の `d1 migrations` 管理テーブルを使っていない（手動 `d1 execute --file`）。

## 各ファイルの中身（kzn への影響）

| 範囲 | 内容 | kzn での注意 |
|---|---|---|
| 046〜047 | アフィリエイト・リンク計測設定 | 未使用機能。テーブル追加のみ |
| 048 | chats を friend 1行に統合＋一意インデックス | 事前に `kzn-pre-048.sql` で `last_incoming_event_at` を MAX に揃える |
| 049〜050 | tracked_links の short_code / 重複排除 | kzn は tracked_links 0件想定 |
| 051〜060 | 予約カレンダー・ウェビナー・Meet 相談 | 未使用。テーブル追加のみ |
| 061〜067 | マイレージ（ルール・キュー・台帳）＋既定データ | 062/063 は既存の受信等から台帳へ**移行由来の付与**を直接入れる（`history-mile-*`）→ 後処理で削除。067 は全アカウント共通の自動応答「マイル」を有効で投入 → 後処理で無効化。ルールも全停止 |
| 068〜072 | 問い合わせ・リッチメニュー選択・SSO jti・通数アラート・配信エラー | テーブル/列/インデックス追加 |

新 Worker は `EVENT_BUS_DISABLED=1` の間、マイレージの投入・実行・台帳書込を DB 層で止める（タグ報酬など rule に依存しない経路も含む）。
