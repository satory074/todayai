# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

today.ai — AI関連情報を **5ソース（X / Feedly / はてブ / Workspace / LayerX）** から自動集約し、時系列タイムラインで表示する Astro 5 + Tailwind v4 の静的サイト（GitHub Pages、base path `/todayai`）。公開 URL: `https://satory074.github.io/todayai/`

## Commands

```bash
npm install
npm run aggregate   # 5ソースを取得 → src/data/feed.json を再生成（.env を読む。トークン無いソース・GEMINI 翻訳は自動スキップ）
npm run dev         # http://localhost:4321/todayai/（feed.json をそのまま表示。集約はしない）
npm run build       # 本番ビルド。Astro グラフの型チェック込み
npm run typecheck   # astro check。tsconfig が **/* を含むので scripts/ も型検査される
```

- **テストフレームワークは無い。** 検証は `npm run build` / `npm run typecheck` と、`npm run aggregate` の実行ログ（`✅ feed.json 更新: 計N件 (X=.. / Feedly=.. / はてブ=.. / LayerX=.. / Workspace=..)`）で行う。
- **型チェックの落とし穴**: `npm run build` は Astro が import するファイルしか型検査しない。`scripts/aggregate.ts` と `scripts/sources/*` は Astro グラフ外なので、scripts を変更したら **`npm run typecheck`（astro check）で確認する**こと（tsconfig の `include: ["**/*"]` が拾う）。scripts は `tsx` で実行され、tsx は型を消すだけで検査しない。
- ローカルで X/LayerX 取得・機械翻訳を試すには `cp .env.example .env` してトークン（`X_BEARER_TOKEN` / `GMAIL_*` / `GEMINI_API_KEY`）を記入。未記入でも他ソース・原文表示は動く。

## Architecture（大きな流れ）

**2フェーズ構成。ビルド時集約と実行時表示が分離している。**

1. **集約（Node/tsx、ビルド前）**: GitHub Actions の cron（6時間ごと、`.github/workflows/update-and-deploy.yml`）が `scripts/aggregate.ts` を実行。5ソースを `FeedItem` に正規化 → 既存 `src/data/feed.json` とマージ → id で重複排除 → publishedAt 降順ソート → `maxAgeDays`/`maxItems` でトリム → **トリム後の最終アイテムに OGP サムネ補完 → 機械翻訳で日本語補完（いずれも後述）** → `feed.json` を上書き。CI がそれをコミットして Pages デプロイ。
2. **表示（Astro、完全静的）**: `src/pages/index.astro` が `src/data/feed.json` を **import** して描画する。サイトは実行時に一切フェッチしない。`feed.json` がレンダリングの単一の真実。

**graceful degradation**: 各ソースは `aggregate.ts` 内で個別 try/catch。失敗 or トークン未設定なら `cachedFor(cache, source)` で**前回キャッシュ分を維持**し、他ソースだけ更新する。1ソースが落ちても run 全体は成功する。

**`feed.json` の `state`**: run をまたいで持ち越す状態。X 外部アカウントの `since_id`（重複課金回避）、`userIds` キャッシュ、`xOgImages`（X由来 OGP画像の解決キャッシュ）、`ogImages`（X以外 OGP画像の解決キャッシュ。`""`＝確認済み画像なしの負キャッシュ含む）、`translations`（id→`{titleJa, summaryJa}` の翻訳キャッシュ。毎回フレッシュ取得されるソースでも再翻訳しないための永続化）。

**OGP サムネ補完（`scripts/sources/enrichOgp.ts`）**: `feed.json` 全体でサムネ付きは少数のため、トリム後の最終アイテムのうち**サムネが無く `feedly`/`hatena`/`workspace` のもの**だけ、記事 URL から og:image を `resolveOgImage()`（`scripts/sources/ogp.ts` を再利用）で解決して補完する。`state.ogImages` で既知分は再取得せず（負キャッシュ込み）、実行後に現存 id 分だけへ prune。**X は basecamp 公開JSON 経由で `xOgImages` により補完済み・LayerX は Substack リダイレクト＆物量大のため対象外。** 並列プールは `scripts/sources/util.ts` の `mapLimit`（x.ts と共有）。

**機械翻訳で日本語補完（`scripts/sources/translate.ts`）**: `enrichOgp.ts` と同じ「state 永続キャッシュ＋毎回再適用＋トリム後対象」パターン。トリム後の最終アイテムのうち**翻訳キャッシュが無く、原文（title/summary）が日本語でない**ものだけ、Gemini REST API（`generateContent`、`fetch` のみで依存追加なし）で `titleJa`/`summaryJa` を補完する。日本語判定は `isJapanese()`（かな・カタカナ・漢字を含めば日本語＝翻訳不要でスキップ）。`feeds.config.ts` の `translate.batchSize` ごとにまとめて1回の API 呼び出し（`responseSchema` で JSON 配列を堅牢に受け取る）、`mapLimit` で `translate.concurrency` 並列。バッチ失敗（network/parse/件数不一致）はそのバッチをスキップし次回 run で再試行。結果は `state.translations` に保存し実行後に現存 id 分だけへ prune。**`GEMINI_API_KEY` 未設定なら丸ごとスキップ＝カードは原文のまま（graceful degradation）。** X bookmark/feedly 等が毎回フレッシュ取得され `titleJa` を失っても `state.translations` から再適用するので再翻訳しない。

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
- **X が古い日付で止まったとき（取得漏れの典型）は上流を疑う。** todayai は basecamp 公開 JSON（`x-tweets.json`）を読むだけなので、その生成元 basecamp の `update-x-feed.yml` が **X API 月間クレジット枯渇（HTTP 402 `CreditsDepleted`）** で 0 件取得に陥ると、run は緑のままサイレントに stale 化する。直し方: ①basecamp 側でクレジット回復＋手動 `workflow_dispatch`（`fetch_pages`/`fetch_max_results` を増やしてバックフィル）→ ②todayai を `workflow_dispatch` で再集約。調査時は GCS の `x-tweets.json` が `Cache-Control: max-age=300` で**古いエッジキャッシュを返す**ので `?cb=<unique>` でキャッシュバスタすること（committed feed の確認は `git show origin/main:src/data/feed.json | jq` が確実）。詳細は memory `todayai-x-feed-staleness`。
- **Tailwind v4 の Vite プラグインは Astro と型が合わない**ため `astro.config.mjs` で `any` キャスト済み。
- パスエイリアス `@/*` → `src/*`（tsconfig）。
- **ビジュアルは「朝刊（Daily Briefing）」ライトテーマ**（ペーパー白 `#f6f7f9` ＋白カード ＋ インク文字 ＋ コバルト `#2f5fff`）。配色トークンは `globals.css` の `@theme` に集約。見出しは Space Grotesk、時刻・ソース名は IBM Plex Mono（ティッカー風）。
- **カードはハイブリッド分岐**（`FeedCard.astro`）: X は `TweetCard`、それ以外は `item.thumbnail` の有無で **ヒーローカード** か **コンパクト行** に分かれる。ヒーローはモバイルで画像上＋本文下の縦積み、`sm:` 以上で `flex-row` の**画像左（`sm:w-[14rem]`）＋本文右**の横並びになる。OGP 補完でサムネ網羅率が上がるとヒーローが主役になる。
- **コンテナ幅**は `Layout.astro` の `max-w-[46rem] lg:max-w-[58rem]`（モバイル～タブレットは 46rem、`lg:`≥1024px で 58rem に広げて PC で横を使う）。ヘッダー/フィルタ/日付見出しもこの幅に従う。
- **二言語表示（日本語／原文トグル）**: `FeedItem` の `titleJa`/`summaryJa`（集約時に Gemini 補完）が原文と別に入る。表示は `BilingualText.astro`（`ja!==orig` のとき `.lang-ja` と `.lang-orig` の両 span を出力、翻訳なしは素テキスト）。`SourceFilter.astro` 右端の「日本語／原文」トグルが `:root.show-orig` クラスを切り替え、CSS（`globals.css` の `.lang-orig`/`:root.show-orig .lang-ja`）で全カードを一斉に出し分ける。選択は `localStorage("todayai:lang")` に永続。**フィルタ（`.is-hidden`）とは独立したクラストグルで競合しない。** 既定は日本語（クラス無し）。
- **`index.astro` は日付グルーピング＋タイムレール**: 各アイテムを `grid-cols-[auto_1fr]` で包み、左列に等幅 `HH:MM`＋縦ヘアライン（シグネチャ）。**この包み `div` に `data-feed-item`＋`data-source` を付け、フィルタ（`SourceFilter.astro` の `<script>`）はこのラッパに `.is-hidden` をトグルする**（`article` 単体ではなく行ごと出し分けるため。`[data-source].is-hidden{display:none}` がラッパも拾う）。
- **sticky オフセット**は手書きのマジックナンバー: ヘッダー直下のフィルタが `top-[57px]`、日付見出しが `top-[112px]`。ヘッダー/フィルタの高さを変えたら再計測する。
