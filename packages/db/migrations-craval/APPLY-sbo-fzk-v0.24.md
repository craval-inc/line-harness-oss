# sbo（セールスキャスト）/ fzk（フゾカテ）本番を本家 v0.24（craval-v0.24）に上げる手順

作成: 2026-09-28（調査・準備のみ。本番未実施）/ Craval OS `task_caf9e1d8a31843d08519`
kzn（きずな）で実施済みの手順（`migrations-kzn/APPLY-v0.24.md`）を sbo/fzk 向けにしたもの。kzn 専用の前後処理（kzn-pre-048・K001〜K004・受信箱/ミラー/送信禁止）は**入れない**＝sbo/fzk は「本家の挙動＋Craval セキュリティ修正（C-1/C-2/M-2/M-5/H-4/C-5）」のみ。

## 1. 現状（2026-09-28 実測・cf-craval 48cf2f856a84ba4baca7b9e4484b50c1）

| | sbo（line-harness-sbo） | fzk（line-harness-fzk） |
|---|---|---|
| 稼働コード | `1e73e7d`（2026-06-02 デプロイ・本家 v0.14.1 土台＋Craval C-1/C-2/C-3/M-5） | `456bc59`（2026-07-19・上記＋M-2/H-4/C-5/H-7） |
| D1 | `c8a9c07f-ae70-4d3a-8f22-86fa0828238e`（67 テーブル・本家 045 相当） | `d85dd5d0-7bc3-43ea-8f8a-a4eda6d82709`（同スキーマ） |
| 業務データ | friends 1・messages_log 0・chats 0・scenarios 3・auto_replies 2（お問い合わせ／応募）・tags 7・line_accounts 1・traffic_pools 1。ほかは account_health_logs 34,301 行 | friends 0・messages_log 0・scenarios 1（あいさつ・step 1）・その他 0 |
| 重複チャット（048 の統合対象） | 0 | 0 |
| Worker 設定 | 下記 toml に転記（D1/R2 IMAGES/ASSETS・Cron `*/5` と `0 */6`・vars・secret 名） | 同左 |
| 管理画面 Pages | `line-harness-sbo-admin`（06-02・旧 localStorage 認証） | `line-harness-fzk-admin`（07-19・同） |
| LIFF Pages | **無し**（`LIFF_PUBLIC_URL` は存在しないプロジェクトを指す） | `line-harness-fzk-liff`（07-19） |
| 本番 wrangler 設定 | リポジトリに無かった（本番値から `apps/worker/wrangler.sbo.toml` を新規作成） | 旧 `wrangler.fzk.toml` は未追跡のまま放置されていた→作り直してコミット |
| LINE「Webhookの再送」 | **要確認**（API で取得できない。LINE Developers で確認） | **要確認** |

## 2. dry-run 結果（本番 export をローカル SQLite に入れて本家 046〜072 を適用）

`node scripts/craval-dryrun-v024.mjs <export.sql> [post.sql]`

- sbo・fzk とも **27 本すべて成功**・適用後スキーマは本家 `bootstrap.sql` と**完全一致**（不足・余分 0）。
- データの変化は **067 の自動応答「マイル」追加（有効）** と **マイル付与ルール 22 件が有効** の2点のみ。移行由来のマイル付与（062/063）は 0 件（受信履歴が無いため）。重複チャット統合（048）・tracked_links 一意化（049/050）の対象も 0。
- 後処理 `migrations-craval/craval-post-v024-mileage-off.sql` を当てると、マイル自動応答 無効・有効ルール 0・残高 0。

## 3. 加藤さんの判断が要る点

1. **マイル機能（本家 v0.24 の新機能）を使うか** — 既定の手順は「止める」（`craval-post-v024-mileage-off.sql` を当てる）。
   - 止めないと、LINE で「マイル」と送った友だちに本家の残高案内 Flex が自動返信され、友だち追加・タグ等でポイントが付き始める。セールスキャスト（営業 BPO の応募・問い合わせ）・フゾカテ（家庭教師）に対応するポイント制度は無いので、止める推奨。
   - 使う場合は `--keep-mileage` で実行（本家既定のまま）。
2. **実施タイミング** — sbo はセールスキャスト再始動中（2026-09-28）。友だち 1・受信 0 なので影響は小さいが、LINE 集客を始める前にやるのが最も安全。メンテ中（約 20 分＝旧版の実行が上限15分で終わるのを待つため）は Worker 全体が 503（受信・管理画面・LIFF・公開フォームすべて）になり、LINE の受信は LINE の再送に頼る。**「Webhookの再送」ON が実施の必須条件**（LINE Developers で加藤さんが確認・ON にする）。ON でも LINE は到達を保証しないので、取りこぼしゼロが必須なら実施しない判断もあり得る（sbo/fzk は受信実績ほぼ 0 なので実害は小さい）。
3. **管理画面の Safari 対応** — 本家 v0.24 の管理画面は httpOnly Cookie 認証。`*.pages.dev`（管理画面）と `*.workers.dev`（Worker）が別サイトのため `ADMIN_ALLOW_CROSS_SITE=true` が必要で、**Chrome のみ**（Safari 不可）。Safari でも使うならカスタムドメインで同一サイトにする（DNS 権限が要る）。

## 4. 手順（テナントごと。sbo→fzk の順でも逆でもよい。1 テナント 15〜20 分）

```bash
cd /c/dev/line-harness-oss && git checkout craval-v0.24 && git pull && pnpm install --frozen-lockfile
for p in @line-crm/shared @line-crm/line-sdk @line-harness/update-engine; do pnpm --filter "$p" build; done
cd apps/worker && npx vite build            # dist/client（Worker が配信する LIFF 画面）を v0.24 で作る
source ~/.bashrc && cf-craval               # cf-craval（48cf2f…）
T=sbo                                        # または fzk
node ../../scripts/check-craval-target.mjs $T   # 取り違え防止（account / name / D1 / R2 / kzn 専用 env 無し）
```
**注意**: `vite build` は `.wrangler/deploy/config.json`（既定 wrangler.toml 向けのリダイレクト）を作る。`wrangler deploy` は**必ず `-c wrangler.$T.toml` を付ける**（付ければ正しいテナントに出ることを dry-run で確認済み）。

0. **事前（メンテ前に全部済ませる）**
   - LINE Developers で「Webhookの再送」が **ON**（必須。OFF なら実施しない）
   - **戻し用の旧版を先にビルドし dry-run まで通す**（失敗時に restore 後すぐ出せるように）:
     ```bash
     OLD=$([ $T = sbo ] && echo 1e73e7d || echo 456bc59)
     git -C /c/dev/line-harness-oss worktree add /c/temp/lh-old-$T $OLD
     cp /c/dev/line-harness-oss/apps/worker/wrangler.$T.toml /c/temp/lh-old-$T/apps/worker/
     cd /c/temp/lh-old-$T && pnpm install --frozen-lockfile && pnpm -r --filter "./packages/*" build
     cd apps/worker && npx vite build && npx wrangler deploy --dry-run -c wrangler.$T.toml --outdir /c/temp/lh-old-$T-dry   # 成功を確認
     cd /c/dev/line-harness-oss/apps/worker
     ```
   - 疎通テスト用の関数（HTTP ではなく **JSON の statusCode** で判定。テスト API 自体は常に HTTP 200 を返す）:
     ```bash
     LT=<Bitwarden のチャネルアクセストークン>   # sbo=line-harness-sbo-api-key 等・値は表示しない
     whtest() { curl -s -X POST -H "Authorization: Bearer $LT" -H 'Content-Type: application/json' -d '{}' https://api.line.me/v2/bot/channel/webhook/test | python -c "import sys,json;d=json.load(sys.stdin);print(d);sys.exit(0 if d.get('statusCode')==int(sys.argv[1]) else 1)" "$1"; }
     ```
1. **メンテナンスで新 Worker をデプロイ**（ここから時計・メンテ窓は約 20 分）
   `npx wrangler deploy -c wrangler.$T.toml --var WEBHOOK_MAINTENANCE:1 && export MAINT_STARTED=$(date +%s)`
   確認: `whtest 503`（`success=false`・`statusCode=503`）。管理画面・LIFF も 503 になる（本手順の Worker は `WEBHOOK_MAINTENANCE=1` で /webhook 以外を全て 503 にする＝移行中の書き込みを作らない）。
2. **退避・③migration・④後処理・⑤検証ゲート** — 一括スクリプト（最初の失敗で全体停止）
   `bash ../../scripts/craval-apply-v024.sh $T`（マイルを使う判断なら `--keep-mileage`）
   内容: 未適用確認 → **メンテ開始から 16 分待つ**（メンテ前に始まった旧版の実行は Cloudflare の上限で最長15分＝それ以降に退避すれば restore で消える書き込みが無い）→ 静止確認（念のため）→ bookmark＋export → 事前件数 → 本家 046〜072 → マイル停止 → 事後件数一致（chats は重複統合分だけ減ってよい）→ `craval-d1-gate.mjs`。
3. **メンテ解除で新 Worker をデプロイ**
   `npx wrangler deploy -c wrangler.$T.toml` → `whtest 200`（`success=true`・`statusCode=200`）。
4. **管理画面を v0.24 で作り直す**（旧画面は localStorage 認証なので新 Worker ではログインできない）
   ```bash
   printf 'https://line-harness-%s-admin.pages.dev' $T | npx wrangler secret put ADMIN_ORIGIN -c wrangler.$T.toml   # 念のため再設定
   # 検査とデプロイを set -e の一塊で実行＝他テナントの URL が1つでもあればデプロイせず終了
   #（apps/web/.env.production は sbo の URL なので env で必ず上書き）
   bash -euo pipefail -c '
     T=$1; cd ../web && rm -rf out .next
     NEXT_PUBLIC_API_URL=https://line-harness-$T.craval.workers.dev NEXT_PUBLIC_UPDATE_BANNER_ENABLED=false npx next build
     grep -rqF "line-harness-$T.craval.workers.dev" out || { echo "NG: 自テナント URL が無い"; exit 1; }
     for o in kzn sbo fzk; do [ "$o" = "$T" ] && continue; if grep -rqF "line-harness-$o" out; then echo "NG: $o の URL が混入"; exit 1; fi; done
     npx wrangler pages deploy out --project-name=line-harness-$T-admin --branch=main --commit-dirty=true
   ' _ "$T"
   ```
   確認: 管理画面に API_KEY でログインできる（Chrome）。
5. **（fzk のみ）LIFF を v0.24 で作り直す**
   `cd ../liff && VITE_API_BASE=https://line-harness-fzk.craval.workers.dev VITE_DEFAULT_LIFF_ID=2010756572-22JdKNon npx vite build && npx wrangler pages deploy dist --project-name=line-harness-fzk-liff --branch=main --commit-dirty=true`
6. 確認: 自分の LINE から友だち追加・1 通送信 → 管理画面の友だち・チャットに出る。fzk はあいさつシナリオが1通届く。sbo は自動応答（お問い合わせ／応募）が動く。「マイル」と送っても反応しない（止めた場合）。

## 5. 失敗時

- **②〜⑤で止まった（メンテ中＝Worker 全体が 503 で D1 に何も書いていない）**: 以降は当てない → `npx wrangler d1 time-travel restore line-harness-$T -c wrangler.$T.toml --bookmark=<bookmark.txt の値>` → **手順0で用意済みの旧版**を出す: `cd /c/temp/lh-old-$T/apps/worker && npx wrangler deploy -c wrangler.$T.toml`（旧コードに `ADMIN_ALLOW_CROSS_SITE` 等の新しい vars があっても無害）→ `whtest 200` → 旧管理画面は触っていないのでそのまま使える。
- **③の後（新 Worker で受信済み）に問題**: bookmark に戻すと受信が消えるので restore しない。`--var WEBHOOK_MAINTENANCE:1` で受信を止めて前進修正。

## 6. 所要時間（見込み）

1 テナント: 準備（ビルド・旧版 dry-run）15 分・メンテ窓 約 20 分（16 分待機＋適用数分）・管理画面/LIFF 10 分・確認 5 分 ＝ 約 50 分。2 テナントは準備を並行すれば約 1.5 時間。
