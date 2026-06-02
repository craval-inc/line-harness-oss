# Craval Security Hardening Notes

このフォーク（craval-inc/line-harness-oss）の本家からの差分と、本番デプロイ前の運用面チェックリスト。

## このフォークで対応済みの差分

`craval-security-hardening` ブランチで以下を修正済み。コミットメッセージで grep 可能（`[Craval security C-X]` `[Craval security M-X]`）。

### Critical対応

| # | 対応 | ファイル |
|---|---|---|
| C-1 | `/api/meet-callback` ルートマウント削除（完全無認証で任意Flexメッセージ送信可能だった） | `apps/worker/src/index.ts` |
| C-2 | webhook不正シグネチャを200OK→401で返す（CFメトリクス検知＋LINE再送機構復活） | `apps/worker/src/routes/webhook.ts` |
| C-3 | CORS originを `ADMIN_ORIGIN` env varで制限可能に（未設定時は'*'フォールバック） | `apps/worker/src/index.ts` |

### Medium対応

| # | 対応 | ファイル |
|---|---|---|
| M-5 | PII（line_user_id, displayName）のconsole.log出力をhash prefix化 or 削除 | `apps/worker/src/routes/webhook.ts`, `forms.ts` |

## 本番デプロイ前 残対応チェックリスト

このフォークでは未対応 or 運用設定で対応すべき項目。

### コード修正で対応必要（次のcommitで対応推奨）

- [ ] **C-4**: `apps/web/src/lib/api.ts` の `lh_api_key` localStorage保管 → HttpOnly Cookie化（or 最低限CSP strict）
- [ ] **C-4**: `packages/db/src/staff.ts` の `api_key` 平文保管 → SHA-256ハッシュ保管
- [ ] **C-5**: Form/Outgoing webhookのURLでprivate IP拒否（`validateHttpsUrl` 拡張）
- [ ] **H-1, H-2**: OAuth state にCSRF nonce + redirect URLホワイトリスト
- [ ] **H-4**: Stripe webhook secret 未設定時に検証スキップ→503で拒否
- [ ] **H-7**: `/api/liff/profile` にLIFF idToken検証必須化
- [ ] **M-1**: DB保管の channel_access_token / channel_secret を AES-GCM暗号化（暗号鍵はCF Secrets）
- [ ] **M-2**: `ADMIN_API_KEY` constant-time比較 + リリースbundle署名検証
- [ ] **M-6**: forms/scenarios/broadcasts に `requireRole('owner', 'admin')` 適用

### 運用設定で対応（Cloudflare Dashboard / wrangler）

- [ ] **C-3**: `wrangler secret put ADMIN_ORIGIN` で自社管理画面URL設定 例: `https://harness-admin.craval.workers.dev`
- [ ] **H-3**: CF Dashboard で WAF Rate Limiting Rule追加
  - `/webhook` per-IP 60req/min
  - `/auth/*` per-IP 30req/min
  - `/api/forms/*/submit` per-IP 30req/min
- [ ] **H-4**: Stripeを使うなら `STRIPE_WEBHOOK_SECRET` 設定。使わないなら `apps/worker/src/index.ts` の `app.route('/', stripe)` 削除
- [ ] **M-2**: `ADMIN_API_KEY` は32byte hex（`openssl rand -hex 32`）でBitwarden保管。`MANIFEST_URL` を自社GitHubリリースに差し替え（OSS upstream自動アップデート無効化）
- [ ] **M-4**: Cloudflare Logpush 有効化 → ログ集約サービス（Axiom等）→ Slack通知
- [ ] CSP strict（`script-src 'self'`）を `apps/web/next.config.js` のheaders設定で投入
- [ ] APIキー定期ローテーション運用（月1回 `regenerate-key`）

### Cravalの候補者個人情報保護観点で必須

- [ ] 候補者・稼働者の line_user_id / displayName が含まれるログは Cloudflare Logpush 対象外（PII保管期間ルール明示）
- [ ] D1の `friends` テーブルに保存するPII列を明示し、保管期間ポリシー策定
- [ ] アップロード画像 (`R2 IMAGES bucket`) は公開URL生成される。身分証等は絶対に上げない運用ルール明示

## 本家との同期方針

- `git remote add upstream https://github.com/Shudesu/line-harness-oss.git`
- 本家更新の取り込み: `git fetch upstream && git merge upstream/main`（自動マージ）
- セキュリティ差分は `craval-security-hardening` ブランチで継続管理
- 本家追従後、各 `[Craval security X-X]` コメントが残存するか確認（コンフリクト時は再適用）

## 参考

- レビュー実施日: 2026-06-02
- レビュー時点 base commit: `git log --oneline -1` で確認可
- 上位脆弱性レビュー方針: SECURITY.md (本家)
