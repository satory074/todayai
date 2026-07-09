/**
 * フィード集約スクリプト。
 *
 * 7ソース（X / Zenn / Qiita / はてブ / Workspace / LayerX / GCP）を取得 → FeedItem に正規化 → 既存キャッシュとマージ
 * → 重複排除・ソート・トリム → src/data/feed.json に書き出す。
 *
 * 各ソースは個別に try/catch する。あるソースの取得に失敗した場合、
 * そのソースの「前回キャッシュ分」を維持し、他ソースだけ更新する（graceful degradation）。
 *
 * ローカル実行: `npm run aggregate`（.env を読む）
 * CI 実行    : GitHub Actions が Secrets を env に渡して実行。
 */
import { config as loadEnv } from "dotenv";

import { feedsConfig } from "../feeds.config";
import type { FeedData, FeedItem, FeedSource } from "../src/lib/feed";
import { readFeed } from "../src/lib/feedStore";
import { writeFeed } from "./lib/feedWrite";
import { fetchX, fetchXAccounts } from "./sources/x";
import { fetchRss } from "./sources/rss";
import { fetchHatena } from "./sources/hatena";
import { fetchLayerX } from "./sources/layerx";
import { fetchWorkspace } from "./sources/workspace";
import { fetchGcloud } from "./sources/gcloud";
import { enrichArticles } from "./sources/enrichArticles";
import { enrichLayerxThumbs } from "./sources/layerxThumb";
import { enrichTranslations } from "./sources/translate";

loadEnv();

/**
 * 翻訳/要約キャッシュ（state.translations）の生成ロジック版。
 * プロンプトや「翻訳→要約」などロジックを変えたら上げる → 旧キャッシュを破棄して再生成する。
 * v2: 記事系の summary を「翻訳」から「3行要約」に変更。
 * v3: 要約入力を RSS 抜粋から記事本文（enrichArticles の contentText）に変更＋プロンプト洗練。
 * v4: 要約を「最大2文・100字以内・要点1〜2点」に短縮（途中切れ解消＋スキャナビリティ）。
 */
const ENRICH_VERSION = "4";

// 読み書きは feedStore/feedWrite が GCS（GCS_BUCKET 設定時）/ローカルファイルを透過的に切替える。
// 集約開始時の読みはキャッシュバスタ不要（前回 run の書き込みは十分に古い）。
async function readCache(): Promise<FeedData> {
  const data = await readFeed<FeedData>({
    updatedAt: new Date(0).toISOString(),
    items: [],
    state: {},
  });
  if (!Array.isArray(data.items)) data.items = [];
  return data;
}

async function writeCache(data: FeedData): Promise<void> {
  await writeFeed(data);
}

/** 指定ソースの前回キャッシュ分。全ソースがこれを土台に蓄積する（全期間アーカイブ）。 */
function cachedFor(cache: FeedData, source: FeedSource): FeedItem[] {
  return cache.items.filter((i) => i.source === source);
}

/** ソース別の保持上限件数。未設定のソースでも安全なようフォールバック付き。 */
function retentionMaxFor(source: FeedSource): number {
  const cfg = feedsConfig[source] as { retentionMax?: number } | undefined;
  return cfg?.retentionMax ?? 1000;
}

async function run(): Promise<void> {
  const cache = await readCache();
  const state = cache.state ?? {};
  const collected: FeedItem[] = [];
  const errors: string[] = [];

  // ---- X ----
  // 前回キャッシュを土台にし、取れたソースだけ上書き/追記する。
  // ・ブックマーク: basecamp公開JSONが全件返すので毎回フレッシュに置換（dedupで更新）
  // ・外部アカウント: since_id増分なので前回分を保持しつつ新着を追記（重複課金回避）
  // 同一idはdedupで1件に集約される。
  if (feedsConfig.x.disabled) {
    console.log("[x] disabled");
    collected.push(...cachedFor(cache, "x"));
  } else {
    // 全期間アーカイブ: ブックマークも外部アカウントも前回分を土台に蓄積する（他ソースと統一）。
    // fresh 取得分は dedup（id）で更新される。上流から消えたブックマークも残り続ける
    // （毎回フレッシュ置換していた頃の purge は無くなる＝アーカイブ方針として一貫）。
    const xItems: FeedItem[] = [...cachedFor(cache, "x")];

    // (a) 自分のブックマーク等（basecamp 公開JSON、トークン不要）
    try {
      const r = await fetchX({
        sourceUrl: feedsConfig.x.sourceUrl,
        username: feedsConfig.x.username,
        categories: feedsConfig.x.categories,
        ogCache: state.xOgImages ?? {},
        authorCache: state.xAuthors ?? {},
      });
      state.xOgImages = r.ogCache;
      state.xAuthors = r.authorCache;
      xItems.push(...r.items);
      const withThumb = r.items.filter((i) => i.thumbnail).length;
      const withAvatar = r.items.filter((i) => i.avatarUrl).length;
      console.log(`[x] basecamp公開JSON: ${r.items.length} items (${feedsConfig.x.categories.join("/") || "なし"}, サムネ ${withThumb}, アバター ${withAvatar})`);
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`x(json): ${msg}`);
      console.error("[x] 公開JSON取得失敗（前回分維持）:", msg);
    }

    // (b) 外部アカウントのポスト（X API App-only Bearer + since_id 増分）
    if (feedsConfig.x.accounts.length > 0) {
      const bearer = process.env.X_BEARER_TOKEN;
      if (!bearer) {
        errors.push("x(accounts): X_BEARER_TOKEN 未設定");
        console.error("[x] X_BEARER_TOKEN 未設定（外部アカウント取得スキップ・前回分維持）");
      } else {
        const r = await fetchXAccounts({
          accounts: feedsConfig.x.accounts,
          bearer,
          maxResults: feedsConfig.x.accountMaxResults,
          sinceIds: state.xAccountSinceIds ?? {},
          userIds: state.xAccountUserIds ?? {},
        });
        state.xAccountSinceIds = r.sinceIds;
        state.xAccountUserIds = r.userIds;
        xItems.push(...r.items);
        for (const e of r.errors) errors.push(e);
        console.log(`[x] 外部アカウント: +${r.items.length} new (${feedsConfig.x.accounts.join(",")})`);
      }
    }

    collected.push(...xItems);
  }

  // ---- Zenn「AI」トピック / Qiita「AI」タグ（公開 RSS を直接取得。トークン不要）----
  // 取得窓（limit）が狭く RSS は最新数十件しか返さないので、前回分を土台に蓄積して過去分を保持する
  // （全期間アーカイブ。dedup=id で重複は集約）。取得失敗/disabled でも蓄積済みの過去分は残る。
  for (const source of ["zenn", "qiita"] as const) {
    const cfg = feedsConfig[source];
    collected.push(...cachedFor(cache, source));
    if (cfg.disabled) {
      console.log(`[${source}] disabled`);
      continue;
    }
    try {
      const items = await fetchRss({ rssUrl: cfg.rssUrl, source, limit: cfg.limit });
      collected.push(...items);
      console.log(`[${source}] ${items.length} items (＋過去 ${cachedFor(cache, source).length} 件を保持)`);
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${source}: ${msg}`);
      console.error(`[${source}] 取得失敗（前回キャッシュを維持）:`, msg);
    }
  }

  // ---- はてブ ----
  // 人気エントリーRSSは「今まさに人気の約30件」しか返さないので、前回分を土台に蓄積して過去分を保持する
  // （全ソース共通の全期間アーカイブ。dedup=id で重複は集約、後段で retentionMax まで保持）。
  collected.push(...cachedFor(cache, "hatena"));
  if (feedsConfig.hatena.disabled) {
    console.log("[hatena] disabled");
  } else {
    try {
      const items = await fetchHatena({ rssUrl: feedsConfig.hatena.rssUrl });
      collected.push(...items);
      console.log(`[hatena] ${items.length} items (＋過去 ${cachedFor(cache, "hatena").length} 件を保持)`);
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`hatena: ${msg}`);
      console.error("[hatena] 取得失敗（前回キャッシュを維持）:", msg);
    }
  }

  // ---- Google Workspace Updates（Blogger Atom を直接取得。トークン不要）----
  // 前回分を土台に蓄積（全期間アーカイブ）。取得失敗/disabled でも過去分は残る。
  collected.push(...cachedFor(cache, "workspace"));
  if (feedsConfig.workspace.disabled) {
    console.log("[workspace] disabled");
  } else {
    try {
      const items = await fetchWorkspace({
        rssUrl: feedsConfig.workspace.rssUrl,
        perFeedLimit: feedsConfig.workspace.perFeedLimit,
      });
      collected.push(...items);
      console.log(`[workspace] ${items.length} items (＋過去 ${cachedFor(cache, "workspace").length} 件を保持)`);
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`workspace: ${msg}`);
      console.error("[workspace] 取得失敗（前回キャッシュを維持）:", msg);
    }
  }

  // ---- Google Cloud リリースノート（Atom を直接取得。トークン不要）----
  // 前回分を土台に蓄積（全期間アーカイブ）。取得は直近60日分だが、それより古い日も過去分として残る。
  collected.push(...cachedFor(cache, "gcloud"));
  if (feedsConfig.gcloud.disabled) {
    console.log("[gcloud] disabled");
  } else {
    try {
      const items = await fetchGcloud({
        rssUrl: feedsConfig.gcloud.rssUrl,
        limit: feedsConfig.gcloud.limit,
      });
      collected.push(...items);
      console.log(`[gcloud] ${items.length} items (＋過去 ${cachedFor(cache, "gcloud").length} 件を保持)`);
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`gcloud: ${msg}`);
      console.error("[gcloud] 取得失敗（前回キャッシュを維持）:", msg);
    }
  }

  // ---- LayerX AI・LLM Newsletter（Gmail 経由）----
  // 前回分を土台に蓄積（全期間アーカイブ）。取得は直近 newerThanDays 日分のメールだが、
  // それより古いトピックも過去分として残る。取得失敗/未設定/disabled でも過去分は残る。
  collected.push(...cachedFor(cache, "layerx"));
  if (feedsConfig.layerx.disabled) {
    console.log("[layerx] disabled");
  } else {
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) {
      errors.push("layerx: GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN 未設定");
      console.error("[layerx] GMAIL_* 未設定（取得スキップ・前回キャッシュを維持）");
    } else {
      try {
        const items = await fetchLayerX({
          sender: feedsConfig.layerx.sender,
          newerThanDays: feedsConfig.layerx.newerThanDays,
          maxResults: feedsConfig.layerx.maxResults,
          clientId,
          clientSecret,
          refreshToken,
        });
        collected.push(...items);
        console.log(`[layerx] ${items.length} items (＋過去 ${cachedFor(cache, "layerx").length} 件を保持)`);
      } catch (e) {
        const msg = (e as Error).message;
        errors.push(`layerx: ${msg}`);
        console.error("[layerx] 取得失敗（前回キャッシュを維持）:", msg);
      }
    }
  }

  // ---- 重複排除 → ソート → トリム ----
  const byId = new Map<string, FeedItem>();
  for (const item of collected) {
    // 同一IDは新しい publishedAt のものを優先
    const prev = byId.get(item.id);
    if (!prev || new Date(item.publishedAt) > new Date(prev.publishedAt)) {
      byId.set(item.id, item);
    }
  }
  let items = [...byId.values()].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

  // 件数トリム（全期間アーカイブ・ソース別枠）: 年齢トリムは廃止。ソースごとに retentionMax まで保持し、
  // 物量の多いソース（LayerX）が他ソースを押し出さない。items は publishedAt 降順なので、
  // ソース別バケットも降順が保たれ slice(0,cap) で newest を残す。最後に日付順へ統合。
  const bySource = new Map<FeedSource, FeedItem[]>();
  for (const item of items) {
    const arr = bySource.get(item.source);
    if (arr) arr.push(item);
    else bySource.set(item.source, [item]);
  }
  items = [...bySource.entries()]
    .flatMap(([source, arr]) => arr.slice(0, retentionMaxFor(source)))
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  // ---- 翻訳/要約キャッシュを先に確定（enrichArticles が本文取得の要否を判定するため）----
  // 生成ロジック（ENRICH_VERSION）を変えたら、実際に再生成できる（キーがある）ときだけ旧キャッシュを破棄。
  let translations = state.translations ?? {};
  const geminiKey = process.env.GEMINI_API_KEY;
  const willSummarize = !feedsConfig.translate.disabled && !!geminiKey;
  if (willSummarize && state.enrichVersion !== ENRICH_VERSION) {
    translations = {};
    console.log(`[translate] enrichVersion 更新 (${state.enrichVersion ?? "なし"} → ${ENRICH_VERSION})・キャッシュ再生成`);
  }

  // ---- 記事系を1回 fetch で og:image＋本文を補完（トリム後の最終アイテムのみ＝無駄fetch回避）----
  // X は basecamp 公開JSON 経由で補完済み。記事系（zenn/qiita/hatena/workspace）は og:image に加え、
  // これから要約する item には本文プレーンテキストを `contentText`（一時）として載せる（要約入力用）。
  const ogImages = state.ogImages ?? {};
  try {
    const r = await enrichArticles(items, ogImages, translations, new Set(["zenn", "qiita", "hatena", "workspace"]), {
      extractText: willSummarize,
      maxLen: 2000, // 短い要約に長文は不要。入力トークンを抑え 429(無料枠TPM超過)・コストを緩和。
    });
    console.log(`[article] og:image +${r.ogResolved} / 本文 +${r.textResolved} (fetch ${r.fetched})`);
  } catch (e) {
    console.error("[article] 記事エンリッチでエラー（スキップ）:", (e as Error).message);
  }
  // LayerX サムネ。掲載リンクの多くが x.com（ツイート）に解決されるので、syndication で
  // ツイートのメディア（無ければ本文リンク先の og:image）を取得するハイブリッド。
  // ⚠️ 新規解決は CI では不可: 全リンクが通る substack.com/redirect が CI(datacenter IP)を
  // 403 で弾く（実測 s403×40・x.com 到達前）。residential IP のローカル `npm run enrich:layerx`
  // では ~70% 解決できる。memory: todayai-gemini-quota-429 参照。
  // → CI（既定）は maxNew:0＝ネット取得せず、ローカルで埋めた state.ogImages のサムネを
  //   毎回フレッシュ取得される LayerX 項目に **再適用するだけ**（ローカル補完分を永続化）。
  //   env ENRICH_LAYERX_THUMBS を立てたときだけ新規解決も行う。
  const layerxMaxNew = process.env.ENRICH_LAYERX_THUMBS ? 40 : 0;
  try {
    const r = await enrichLayerxThumbs(items, ogImages, { maxNew: layerxMaxNew, concurrency: 3 });
    if (layerxMaxNew > 0) {
      console.log(`[ogp] サムネ補完(LayerX): +${r.resolved} 件解決 (試行 ${r.attempted})`);
    }
  } catch (e) {
    console.error("[ogp] サムネ補完(LayerX)でエラー（スキップ）:", (e as Error).message);
  }
  // 現存 item id 分だけ残して負キャッシュの無限増殖を防ぐ。
  const liveIds = new Set(items.map((i) => i.id));
  state.ogImages = Object.fromEntries(
    Object.entries(ogImages).filter(([id]) => liveIds.has(id)),
  );
  if (state.xAuthors) {
    state.xAuthors = Object.fromEntries(
      Object.entries(state.xAuthors).filter(([id]) => liveIds.has(id)),
    );
  }

  // ---- 機械翻訳／3行要約で日本語を補完（GEMINI_API_KEY 任意・未設定ならスキップ）----
  // 記事系は contentText（記事本文）を3行要約、その他は summary を翻訳。既処理は state.translations
  // から再適用。translations / version 破棄は上（enrichArticles 前）で確定済み。
  if (willSummarize && geminiKey) {
    try {
      const r = await enrichTranslations(items, translations, geminiKey, {
        model: feedsConfig.translate.model,
        batchSize: feedsConfig.translate.batchSize,
        concurrency: feedsConfig.translate.concurrency,
        summarizeSources: feedsConfig.translate.summarizeSources,
        summaryMinLen: feedsConfig.translate.summaryMinLen,
      });
      console.log(
        `[translate] +${r.translated} 翻訳/要約 (試行 ${r.attempted}, バッチ ${r.batches})`,
      );
      state.enrichVersion = ENRICH_VERSION;
    } catch (e) {
      console.error("[translate] エラー（スキップ）:", (e as Error).message);
    }
  } else if (!feedsConfig.translate.disabled) {
    console.log("[translate] GEMINI_API_KEY 未設定（翻訳/要約スキップ）");
  }
  // 現存 item id 分だけ残してキャッシュの無限増殖を防ぐ。
  state.translations = Object.fromEntries(
    Object.entries(translations).filter(([id]) => liveIds.has(id)),
  );

  // 要約入力用の記事本文は一時フィールド＝永続化しない（feed.json を肥大化させない）。
  for (const it of items) delete it.contentText;

  const out: FeedData = {
    updatedAt: new Date().toISOString(),
    items,
    state,
  };
  await writeCache(out);

  const counts = { x: 0, zenn: 0, qiita: 0, hatena: 0, layerx: 0, workspace: 0, gcloud: 0 } as Record<
    FeedSource,
    number
  >;
  for (const i of items) counts[i.source]++;
  const withThumb = items.filter((i) => i.thumbnail).length;
  const withJa = items.filter((i) => i.titleJa).length;
  console.log(
    `\n✅ feed.json 更新: 計 ${items.length} 件 (X=${counts.x} / Zenn=${counts.zenn} / Qiita=${counts.qiita} / はてブ=${counts.hatena} / LayerX=${counts.layerx} / Workspace=${counts.workspace} / GCP=${counts.gcloud}) サムネ ${withThumb} 件 / 翻訳 ${withJa} 件`,
  );
  if (errors.length) {
    console.warn(`⚠️  ${errors.length} 件のソースでエラー:\n  - ${errors.join("\n  - ")}`);
  }
}

run().catch((e) => {
  console.error("致命的エラー:", e);
  process.exit(1);
});
