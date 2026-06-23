# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

today.ai — AI関連情報を **5ソース（X / Feedly / はてブ / Workspace / LayerX）** から自動集約し、時系列タイムラインで表示する Astro 5 + Tailwind v4 の静的サイト（GitHub Pages、base path `/todayai`）。公開 URL: `https://satory074.github.io/todayai/`

## Commands

```bash
npm install
npm run aggregate   # 5ソースを取得 → src/data/feed.json を再生成（.env を読む。トークン無いソースは自動スキップ）
npm run dev         # http://localhost:4321/todayai/（feed.json をそのまま表示。集約はしない）
npm run build       # 本番ビルド。Astro グラフの型チェック込み
npm run typecheck   # astro check。tsconfig が **/* を含むので scripts/ も型検査される
```

- **テストフレームワークは無い。** 検証は `npm run build` / `npm run typecheck` と、`npm run aggregate` の実行ログ（`✅ feed.json 更新: 計N件 (X=.. / Feedly=.. / はてブ=.. / LayerX=.. / Workspace=..)`）で行う。
- **型チェックの落とし穴**: `npm run build` は Astro が import するファイルしか型検査しない。`scripts/aggregate.ts` と `scripts/sources/*` は Astro グラフ外なので、scripts を変更したら **`npm run typecheck`（astro check）で確認する**こと（tsconfig の `include: ["**/*"]` が拾う）。scripts は `tsx` で実行され、tsx は型を消すだけで検査しない。
- ローカルで X/LayerX 取得を試すには `cp .env.example .env` してトークンを記入。未記入でも他ソースは動く。

## Architecture（大きな流れ）

**2フェーズ構成。ビルド時集約と実行時表示が分離している。**

1. **集約（Node/tsx、ビルド前）**: GitHub Actions の cron（6時間ごと、`.github/workflows/update-and-deploy.yml`）が `scripts/aggregate.ts` を実行。5ソースを `FeedItem` に正規化 → 既存 `src/data/feed.json` とマージ → id で重複排除 → publishedAt 降順ソート → `maxAgeDays`/`maxItems` でトリム → `feed.json` を上書き。CI がそれをコミットして Pages デプロイ。
2. **表示（Astro、完全静的）**: `src/pages/index.astro` が `src/data/feed.json` を **import** して描画する。サイトは実行時に一切フェッチしない。`feed.json` がレンダリングの単一の真実。

**graceful degradation**: 各ソースは `aggregate.ts` 内で個別 try/catch。失敗 or トークン未設定なら `cachedFor(cache, source)` で**前回キャッシュ分を維持**し、他ソースだけ更新する。1ソースが落ちても run 全体は成功する。

**`feed.json` の `state`**: run をまたいで持ち越す状態。X 外部アカウントの `since_id`（重複課金回避）、`userIds` キャッシュ、`xOgImages`（OGP画像URLの解決キャッシュ）。

### ソースの登録は `src/lib/feed.ts` の `FeedSource` 型 + `SOURCES` 配列が中心レジストリ

新ソースを足すときの定型（既存の追加コミットが参考）:
1. `src/lib/feed.ts`: `FeedSource` ユニオンに追加 + `SOURCES` にエントリ（`key`/`label`/`badgeClass`）。← これで `FeedCard` / `SourceFilter` は `SOURCES` 駆動なので自動対応。
2. `src/styles/globals.css`: `.src-<key>` クラス + `@theme` に `--color-<key>` / `--color-<key>-bg`。
3. `feeds.config.ts`: `FeedsConfig` インターフェース + `feedsConfig` に設定。トークン類はここに書かず env/Secrets。
4. `scripts/sources/<key>.ts`: 取得して `FeedItem[]` を返す関数（`hatena.ts` が最小の手本）。
5. `scripts/aggregate.ts`: `disabled` とクレデンシャルを見て try/catch する取得ブロックを追加。末尾 `counts` とログにも `<key>` を足す。

### ソース別の要点（なぜ普通の RSS じゃないか）

- **X**: X API を**叩かない**。自分のデータは basecamp 公開 JSON（`storage.googleapis.com/basecamp-feeds/x-tweets.json`）を読むだけ（トークン・課金不要、basecamp の OAuth と競合しない）。`x.accounts` の外部アカウントのみ X API **App-only Bearer**（`X_BEARER_TOKEN`）+ `since_id` 増分。OGP サムネは `scripts/sources/ogp.ts` で解決し `state.xOgImages` にキャッシュ。表示は `TweetCard.astro`（ツイート風）。
- **Feedly**: Feedly 開発者 API トークンが Enterprise 限定になったため API は使わず、`feedly.rssUrls` の各 RSS を `rss-parser` で直接取得。`perFeedLimit` で1フィードの占有を抑制、フィード毎 try/catch（全滅時のみキャッシュへフォールバック）。RSS 一覧は Feedly の OPML エクスポートから拾える。
- **はてブ**: 公開 RSS（`b.hatena.ne.jp/hotentry/it.rss`）を直接パース。トークン不要。
- **Workspace**: Google Workspace Updates ブログ（Blogger 製）の Atom を `rss-parser` で直接取得。トークン不要。既定の `/feeds/posts/default` は FeedBurner（http）へ 302 するため `?redirect=false` を付けて Google ドメインから https Atom を取得（`workspace.rssUrl`）。`perFeedLimit` で件数を抑制。サムネは `media:thumbnail` 優先＋本文 HTML の最初の `<img>` をフォールバック抽出。表示は `source: "workspace"`（青バッジ「Workspace」）。
- **LayerX**: Substack 公開 RSS が invite-only のため、毎週届くメール（`layerxnews@substack.com`）を **Gmail REST API** で読む（`GMAIL_CLIENT_ID`/`_SECRET`/`_REFRESH_TOKEN`、scope `gmail.readonly`）。**本文(text/plain)に列挙された各トピックリンク = 1アイテム**（1通 ~190件）。`<タイトル> [ substack redirect url ]` が**行末**にある行だけ採用＝「View this post」/Unsubscribe/文中プロモを自然に除外。id は redirect UUID で安定（再取得しても dedup で増えない）。1通の物量が大きいので `maxItems` は 1000。インフラ設定とトークン失効の注意は memory `todayai-layerx-gmail-infra` 参照。

## 重要な制約・gotcha

- **内部リンクは必ず `src/lib/url.ts` の `siteLink()`（host 必須なら `absUrl()`）を通す。** base path が `/todayai` なので素の絶対パスは壊れる。カスタムドメインにするなら `astro.config.mjs` の `base` を空に。
- **CI の push イベントは集約とコミットをスキップ**する（既存 `feed.json` でビルドのみ）。集約が走るのは `schedule` / `workflow_dispatch` のみ。これが無いと「feed-bot のコミット → push → 再集約 → …」のループになる。
- **`feed.json` は CI（feed-bot）が main に直接コミットする。** ローカルで `npm run aggregate` するとライブ取得で `feed.json` が書き換わる。検証目的なら後で `git checkout -- src/data/feed.json` で戻す。リベース時にこのファイルが衝突したら、自動生成キャッシュなのでどちらかを採用すれば次回 cron で再生成される。
- **Tailwind v4 の Vite プラグインは Astro と型が合わない**ため `astro.config.mjs` で `any` キャスト済み。
- パスエイリアス `@/*` → `src/*`（tsconfig）。
- ソースバッジのフィルタは純粋なクライアント DOM 操作（`SourceFilter.astro` の `<script>` が `.is-hidden` をトグル）。`index.astro` は日付ごとにグルーピングして表示。
