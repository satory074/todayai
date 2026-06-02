# today.ai — AI情報フィード集約サイト

特定の **X(Twitter)アカウント**・**Feedlyフォルダ**・**はてなブックマーク 人気エントリー テクノロジー** から
AI関連情報を自動集約し、時系列の統合タイムラインとして表示する静的サイト（GitHub Pages）。

- 基盤: Astro 5 + Tailwind v4
- 更新: GitHub Actions（6時間ごと）でフィード取得 → `src/data/feed.json` をコミット → Pages へデプロイ
- 公開URL想定: `https://satory074.github.io/todayai/`

## ローカル開発

```bash
npm install
cp .env.example .env   # トークンを記入（X取得・Feedly取得をローカルで試す場合）
npm run aggregate      # 3ソースを取得して src/data/feed.json を生成
npm run dev            # http://localhost:4321/todayai/
npm run build          # 本番ビルド（型チェック込み）
```

`npm run aggregate` はトークンが無いソースを自動的にスキップし、前回キャッシュを維持します
（クラッシュしません）。トークン無しでも `npm run dev` でサンプルデータの表示確認が可能です。

## 設定

`feeds.config.ts` を編集します。

| 項目 | 内容 |
|------|------|
| `x.username` | 取得したい X アカウントのユーザー名（@なし） |
| `feedly.streamId` | Feedly カテゴリの streamId（下記参照） |
| `hatena.rssUrl` | 既定 `https://b.hatena.ne.jp/hotentry/it.rss` |
| `maxItems` / `maxAgeDays` | 保持件数・保持日数 |

各ソースは `disabled: true` で個別に無効化できます。

### Feedly の streamId の調べ方

形式は `user/<userId>/category/<categoryName>`。

1. [feedly.com](https://feedly.com) → Settings → Account → 「Manage access tokens」で**開発者アクセストークン**を発行
2. ユーザーID取得: `curl -H "Authorization: Bearer <TOKEN>" https://feedly.com/v3/profile` → `id`
3. カテゴリ一覧: `curl -H "Authorization: Bearer <TOKEN>" https://feedly.com/v3/categories` → 目的フォルダの `id`
4. その `id` をそのまま `streamId` に設定（`user/.../category/...` 形式になっている）

> Feedly のアクセストークンは **30日で失効**します。失効したら再発行して `FEEDLY_API_TOKEN` を更新してください。

### X(Twitter) API について

他人アカウントの読み取りは **Non-owned Read（$0.005/件）** です。本リポジトリは `since_id` による
**増分取得**で「同じ投稿の読み直し課金」を回避し、実コストを新着分のみに抑えています
（前回最新ID `state.xLastSeenId` を `feed.json` に保存）。

OAuth2 のリフレッシュトークンは X 側で毎回ローテーションします。CI では `GH_PAT` を使って
`gh secret set` で `X_REFRESH_TOKEN` を自動更新します（basecamp と同方式）。

## デプロイ（初回セットアップ）

1. このディレクトリを git 初期化し、GitHub に `todayai` リポジトリを作成して push
2. リポジトリ **Settings → Pages → Build and deployment → Source: GitHub Actions**
3. **Settings → Secrets and variables → Actions** に登録:
   - `X_CLIENT_ID` / `X_CLIENT_SECRET` / `X_REFRESH_TOKEN`（basecamp と同じ値で可）
   - `FEEDLY_API_TOKEN`
   - `GH_PAT`（`X_REFRESH_TOKEN` を書き戻すための PAT。`repo`/`secrets` 権限）
4. `feeds.config.ts` に `x.username` と `feedly.streamId` を記入してコミット
5. **Actions** タブ → 「Update feeds & Deploy」→ **Run workflow**（`workflow_dispatch`）で初回実行

以降は6時間ごとに自動更新・デプロイされます。

## 構成

```
feeds.config.ts            ソース定義（username / streamId / URL / 保持設定）
scripts/aggregate.ts       集約オーケストレータ（取得→正規化→マージ→trim→書き出し）
scripts/sources/           x.ts / feedly.ts / hatena.ts
src/data/feed.json         集約キャッシュ（CIがコミット）
src/lib/feed.ts            FeedItem 型・相対時刻などのヘルパ
src/components/            Layout / FeedCard / SourceFilter
src/pages/                 index / about / rss.xml
.github/workflows/         update-and-deploy.yml
```
