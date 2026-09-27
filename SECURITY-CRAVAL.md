# Craval Security Hardening Notes（v0.24 系）

このフォーク（craval-inc/line-harness-oss）の本家（Shudesu/line-harness-oss）からの差分と、本番デプロイ前の運用チェックリスト。
ブランチ `craval-v0.24` は本家 `5386460`（v0.24.1 + #350 broadcast safety）を土台に、Craval の差分を載せ直したもの。
旧ブランチ `craval-security-hardening`（本家 v0.14.1 ベース）からの移行記録は末尾。

## このフォークで対応済みの差分（`[Craval security X-n]` で grep 可能）

| # | 対応 | ファイル | 本家 v0.24 の状況 |
|---|---|---|---|
| C-1 | `/api/meet-callback` のマウント削除（完全無認証で任意 Flex を送信できる） | `apps/worker/src/index.ts`, `middleware/auth.ts` | 未解決（無認証のまま） |
| C-2 | webhook の不正署名を 200 → 401、パース不能を 400 | `routes/webhook.ts` | 未解決（200） |
| M-2 | API キー照合を定数時間比較（env API_KEY / LEGACY_API_KEY / ADMIN_API_KEY） | `middleware/auth.ts`, `routes/admin-update.ts`, `utils/pii-hash.ts` | 未解決（`===`） |
| M-5 | PII（line_user_id・表示名）をログに出さず SHA-256 prefix 化 | `routes/webhook.ts`, `routes/forms.ts`, `routes/line-proxy.ts` | 未解決 |
| H-4 | `STRIPE_WEBHOOK_SECRET` 未設定時は検証スキップせず 503 | `routes/stripe.ts` | 未解決（未設定なら無検証で処理） |
| C-5 | 送信 Webhook URL の private/loopback/link-local/metadata ホスト拒否 | `routes/webhooks.ts` | 未解決（https のみ検査） |

## 本家で解決済みのため捨てた差分

| # | 旧フォークの対応 | 本家での解決 |
|---|---|---|
| C-3 | `ADMIN_ORIGIN` で CORS を制限（未設定時 `*`） | 本家は Cookie 認証化に伴い `resolveCorsOrigin`（同一 origin + `ADMIN_ORIGIN` 許可リスト、`*` なし）。本家の方が厳しい |
| H-7 | `/api/liff/profile` の idToken 検証必須化 | 本家 `verifyCallerLineUserId` で idToken 検証済み |
| C-4（一部） | 管理画面の `lh_api_key` localStorage 保管 | 本家が httpOnly Cookie + CSRF double-submit に移行済み |

## 本番デプロイ前 残対応

- [ ] C-4: `packages/db/src/staff.ts` の staff `api_key` 平文保管 → ハッシュ保管（staff 行を作る前に）
- [ ] M-1: DB 保管の channel_access_token / channel_secret の暗号化（env 運用なら不要）
- [ ] M-6: forms/scenarios/broadcasts への role guard
- [ ] H-1/H-2: OAuth state の CSRF nonce + redirect ホワイトリスト（LINE Login を使う場合）
- [ ] H-3: WAF レート制限（カスタムドメイン配下のみ可。workers.dev では不可）
- [ ] `MANIFEST_URL=""`（本家自動アップデート無効）/ `ADMIN_API_KEY` 32byte hex を Bitwarden 保管

## kzn（きずな）固有の env ゲート機能

`apps/worker/wrangler.kzn.toml`・設計 `kizuna-shonin/docs/line-harness-kzn-design.md`。全て未設定なら本家と同一挙動。
`PUBLIC_PATHS_ALLOW` / `INCOMING_IMAGE_STORE` / `WEBHOOK_INBOX` / `LINE_SEND_DISABLED` / `EVENT_BUS_DISABLED` / `MIRROR_URL`+`MIRROR_SECRET`。

## 本家との同期方針

- `git remote add upstream https://github.com/Shudesu/line-harness-oss.git`
- 追従は「本家の新しい土台に Craval 差分を載せ直す」（rebase ではなく再適用）。各差分は本家で解決済みか毎回確認し、解決済みなら捨てる。
- kzn 専用 migration は `packages/db/migrations-kzn/`（本家の番号体系・リリースバンドルに混ぜない）。
